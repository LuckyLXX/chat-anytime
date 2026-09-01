import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  automationPathFor,
  deleteAutomation,
  normalizeAutomation,
  readAllAutomations,
  readAutomation,
  recordAutomationRun,
  toggleAutomation,
  upsertAutomation,
  writeAutomation
} from "./automation-store.js";
import type { AutomationTask } from "../shared/protocol.js";
import { dirname } from "node:path";

let dir: string;
let agentDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-automation-"));
  agentDir = join(dir, "agent");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeTask(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: "task-1",
    name: "每日巡检",
    schedule: { cron: "0 9 * * 1-5" },
    prompt: "巡检仓库并汇报",
    agentId: "default",
    accessMode: "full",
    enabled: true,
    createdAt: 1000,
    ...overrides
  };
}

describe("automationPathFor", () => {
  it("scopes the store under pidesktop-automation/<agentId>.json", () => {
    expect(automationPathFor(agentDir, "alice")).toBe(join(agentDir, "pidesktop-automation", "alice.json"));
  });
});

describe("normalizeAutomation", () => {
  it("requires name, prompt and a valid cron; drops invalid entries", () => {
    expect(normalizeAutomation({ name: "", prompt: "x", schedule: { cron: "0 9 * * *" } })).toBeUndefined();
    expect(normalizeAutomation({ name: "x", prompt: "", schedule: { cron: "0 9 * * *" } })).toBeUndefined();
    expect(normalizeAutomation({ name: "x", prompt: "y", schedule: { cron: "not a cron" } })).toBeUndefined();
    expect(normalizeAutomation({ name: "x", prompt: "y", schedule: { cron: "0 9 * * *" } })).toBeDefined();
  });

  it("defaults accessMode to full, enabled to true, and agents to default", () => {
    const task = normalizeAutomation({ name: "x", prompt: "y", schedule: { cron: "0 9 * * *" } });
    expect(task?.accessMode).toBe("full");
    expect(task?.enabled).toBe(true);
    expect(task?.agentId).toBe("default");
  });

  it("generates an id when missing and keeps a provided one", () => {
    const generated = normalizeAutomation({ name: "x", prompt: "y", schedule: { cron: "0 9 * * *" } });
    expect(generated?.id).toBeTruthy();
    const withId = normalizeAutomation({ id: "keep", name: "x", prompt: "y", schedule: { cron: "0 9 * * *" } });
    expect(withId?.id).toBe("keep");
  });

  it("validates the model shape and drops malformed models", () => {
    const good = normalizeAutomation({ name: "x", prompt: "y", schedule: { cron: "0 9 * * *" }, model: { provider: "p", id: "m" } });
    expect(good?.model).toEqual({ provider: "p", id: "m" });
    const bad = normalizeAutomation({ name: "x", prompt: "y", schedule: { cron: "0 9 * * *" }, model: { provider: "", id: "m" } });
    expect(bad?.model).toBeUndefined();
  });

  it("drops an invalid timezone (avoids silent never-fire) but keeps the cron", () => {
    const bad = normalizeAutomation({ name: "x", prompt: "y", schedule: { cron: "0 9 * * *", timezone: "Bad/Zone" } });
    expect(bad?.schedule.timezone).toBeUndefined();
    const good = normalizeAutomation({ name: "x", prompt: "y", schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" } });
    expect(good?.schedule.timezone).toBe("Asia/Shanghai");
  });

  it("trims whitespace and carries a bare timezone when present", () => {
    const task = normalizeAutomation({ name: "  x  ", prompt: "  y  ", schedule: { cron: " 0 9 * * * ", timezone: "Asia/Shanghai" } });
    expect(task?.name).toBe("x");
    expect(task?.prompt).toBe("y");
    expect(task?.schedule).toEqual({ cron: "0 9 * * *", timezone: "Asia/Shanghai" });
  });
});

describe("readAllAutomations", () => {
  it("merges tasks from every agent file, sorted by agentId then createdAt", () => {
    const agentDir = join(dir, "multi-agent");
    upsertAutomation(automationPathFor(agentDir, "alice"), makeTask({ id: "a-1", agentId: "alice", createdAt: 500 }));
    upsertAutomation(automationPathFor(agentDir, "bob"), makeTask({ id: "b-1", agentId: "bob", createdAt: 100 }));
    upsertAutomation(automationPathFor(agentDir, "alice"), makeTask({ id: "a-2", agentId: "alice", createdAt: 200 }));
    expect(readAllAutomations(agentDir).map((task) => task.id)).toEqual(["a-2", "a-1", "b-1"]);
  });

  it("returns an empty list when the directory is missing or empty", () => {
    expect(readAllAutomations(join(dir, "no-dir"))).toEqual([]);
    expect(readAllAutomations(join(dir, "empty-dir"))).toEqual([]);
  });
});

describe("read/write/upsert/delete/toggle/record", () => {
  it("round-trips tasks through the JSON file (atomic write)", () => {
    const file = automationPathFor(agentDir, "default");
    writeAutomation(file, [makeTask()]);
    expect(readAutomation(file)).toEqual([makeTask()]);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { tasks: AutomationTask[] };
    expect(raw.tasks).toHaveLength(1);
  });

  it("returns an empty list for a missing/corrupt file", () => {
    const file = automationPathFor(agentDir, "default");
    expect(readAutomation(file)).toEqual([]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");
    expect(readAutomation(file)).toEqual([]);
  });

  it("upserts by id (append new, overwrite existing) and returns the list", () => {
    const file = automationPathFor(agentDir, "default");
    const first = upsertAutomation(file, makeTask());
    expect(first).toHaveLength(1);
    const updated = upsertAutomation(file, { ...makeTask(), name: "改名" });
    expect(updated).toHaveLength(1);
    expect(updated[0]!.name).toBe("改名");
  });

  it("deletes by id", () => {
    const file = automationPathFor(agentDir, "default");
    upsertAutomation(file, makeTask());
    const rest = deleteAutomation(file, "task-1");
    expect(rest).toEqual([]);
    expect(readAutomation(file)).toEqual([]);
  });

  it("toggles enabled", () => {
    const file = automationPathFor(agentDir, "default");
    upsertAutomation(file, makeTask());
    const toggled = toggleAutomation(file, "task-1", false);
    expect(toggled[0]!.enabled).toBe(false);
  });

  it("records a run summary", () => {
    const file = automationPathFor(agentDir, "default");
    upsertAutomation(file, makeTask());
    const run = { sessionId: "sess-1", startedAt: 2000, status: "ok" as const, preview: "完成" };
    const updated = recordAutomationRun(file, "task-1", run);
    expect(updated[0]!.lastRun).toEqual(run);
  });

  it("normalizes legacy/corrupt entries on read", () => {
    const file = automationPathFor(agentDir, "default");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ tasks: [makeTask(), { name: "bad" }] }), "utf8");
    expect(readAutomation(file)).toEqual([makeTask()]);
  });
});
