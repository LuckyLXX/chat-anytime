import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutomationRunRecord } from "../shared/protocol.js";
import { appendAutomationRun, automationRunsPath, MAX_RUNS, normalizeAutomationRun, readAutomationRuns } from "./automation-runs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-automation-runs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRun(overrides: Partial<AutomationRunRecord> = {}): AutomationRunRecord {
  return {
    id: "run-1",
    taskId: "task-1",
    taskName: "每日巡检",
    agentId: "default",
    agentName: "默认助手",
    sessionId: "sess-1",
    startedAt: 2000,
    durationMs: 60_000,
    status: "ok",
    trigger: "cron",
    ...overrides
  };
}

describe("automationRunsPath", () => {
  it("points at the shared full-agent runs.jsonl", () => {
    expect(automationRunsPath(dir)).toBe(join(dir, "pidesktop-automation", "runs.jsonl"));
  });
});

describe("normalizeAutomationRun", () => {
  it("accepts a complete valid record", () => {
    const record = makeRun({ startedAt: 1000, durationMs: 500, status: "error", trigger: "manual", modelId: "deepseek-v4", preview: "ok", error: "boom" });
    expect(normalizeAutomationRun(record)).toEqual(record);
  });

  it("drops entries missing required fields", () => {
    const base = makeRun();
    expect(normalizeAutomationRun({ ...base, id: "" })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, taskId: " " })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, taskName: undefined })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, agentId: "" })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, agentName: "" })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, sessionId: "" })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, startedAt: "2000" })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, startedAt: Number.NaN })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, durationMs: undefined })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, status: "running" })).toBeUndefined();
    expect(normalizeAutomationRun({ ...base, trigger: "hourly" })).toBeUndefined();
  });

  it("keeps optional fields only when non-empty strings", () => {
    const normalized = normalizeAutomationRun(makeRun({ modelId: "", preview: "text", error: "" }));
    expect(normalized?.modelId).toBeUndefined();
    expect(normalized?.preview).toBe("text");
    expect(normalized?.error).toBeUndefined();
  });

  it("returns undefined for non-objects and nulls", () => {
    expect(normalizeAutomationRun(null)).toBeUndefined();
    expect(normalizeAutomationRun("run")).toBeUndefined();
    expect(normalizeAutomationRun(42)).toBeUndefined();
  });

  it("accepts the aborted status (中止不是失败，与 ok/error 并列的第三态)", () => {
    const record = makeRun({ status: "aborted", error: "This operation was aborted" });
    expect(normalizeAutomationRun(record)).toEqual(record);
    expect(normalizeAutomationRun({ ...makeRun(), status: "cancelled" })).toBeUndefined();
  });
});

describe("readAutomationRuns", () => {
  it("returns an empty list for a missing or empty file", () => {
    expect(readAutomationRuns(dir)).toEqual([]);
  });

  it("parses lines and sorts by startedAt descending", () => {
    mkdirSync(dirname(automationRunsPath(dir)), { recursive: true });
    writeFileSync(automationRunsPath(dir), [
      JSON.stringify(makeRun({ id: "old", startedAt: 1000 })),
      JSON.stringify(makeRun({ id: "new", startedAt: 3000 })),
      JSON.stringify(makeRun({ id: "mid", startedAt: 2000 }))
    ].join("\n") + "\n", "utf8");
    expect(readAutomationRuns(dir).map((run) => run.id)).toEqual(["new", "mid", "old"]);
  });

  it("skips corrupt lines and invalid records without failing", () => {
    mkdirSync(dirname(automationRunsPath(dir)), { recursive: true });
    writeFileSync(automationRunsPath(dir), [
      "{ not json",
      JSON.stringify(makeRun({ id: "valid" })),
      JSON.stringify({ id: "bad", taskName: "no required fields" }),
      "   ",
      JSON.stringify(makeRun({ id: "second", startedAt: 5000 }))
    ].join("\n") + "\n", "utf8");
    expect(readAutomationRuns(dir).map((run) => run.id)).toEqual(["second", "valid"]);
  });
});

describe("appendAutomationRun", () => {
  it("appends a line and returns the full latest list", () => {
    const first = appendAutomationRun(dir, makeRun({ startedAt: 1000 }));
    expect(first.map((run) => run.id)).toEqual(["run-1"]);
    const second = appendAutomationRun(dir, makeRun({ id: "run-2", startedAt: 2000 }));
    expect(second.map((run) => run.id)).toEqual(["run-2", "run-1"]);
    const rawLines = readFileSync(automationRunsPath(dir), "utf8").split("\n").filter((line) => line.trim() !== "");
    expect(rawLines).toHaveLength(2);
  });

  it("trims to the latest MAX_RUNS entries when exceeded", () => {
    const start = Date.now();
    for (let index = 0; index < MAX_RUNS + 25; index += 1) {
      appendAutomationRun(dir, makeRun({ id: `run-${index}`, startedAt: start + index }));
    }
    const runs = readAutomationRuns(dir);
    expect(runs).toHaveLength(MAX_RUNS);
    // 保留的是 startedAt 最新的 200 条（即最后追加的 200 条）。
    const firstId = runs[0]!.id;
    expect(firstId).toBe(`run-${MAX_RUNS + 24}`);
    expect(runs.some((run) => run.id === "run-0")).toBe(false);
    // 裁剪后文件就是最新 200 条（坏行也会随裁剪被丢弃）。
    const rawLines = readFileSync(automationRunsPath(dir), "utf8").split("\n").filter((line) => line.trim() !== "");
    expect(rawLines).toHaveLength(MAX_RUNS);
  });

  it("keeps the file readable through the trim path (tmp+rename)", () => {
    for (let index = 0; index < MAX_RUNS + 3; index += 1) {
      appendAutomationRun(dir, makeRun({ id: `run-${index}`, startedAt: index }));
    }
    expect(readAutomationRuns(dir)).toHaveLength(MAX_RUNS);
    expect(readFileSync(automationRunsPath(dir), "utf8")).toContain("run-202");
  });
});