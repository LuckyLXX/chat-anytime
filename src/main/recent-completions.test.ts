import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../shared/protocol.js";
import {
  applyRecentCompletions,
  loadRecentCompletions,
  RECENT_COMPLETIONS_KEEP,
  recentCompletionsPath,
  recordRecentCompletion,
  saveRecentCompletions,
  type RecentCompletion
} from "./recent-completions.js";

function completion(overrides: Partial<RecentCompletion> & Pick<RecentCompletion, "path">): RecentCompletion {
  return { completedAt: 1, outcome: "completed", ...overrides };
}

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "path">): SessionSummary {
  return {
    workspace: "C:/Projects/A",
    agentId: "default",
    title: overrides.id,
    modifiedAt: 1,
    messageCount: 1,
    ...overrides
  };
}

describe("recent completions store", () => {
  it("records a completion at the front and dedupes by normalized path", () => {
    let list = recordRecentCompletion([], { path: "C:/Sessions/one.jsonl", completedAt: 100, outcome: "completed" });
    list = recordRecentCompletion(list, { path: "C:/Sessions/two.jsonl", completedAt: 200, outcome: "failed" });
    list = recordRecentCompletion(list, { path: "c:\\sessions\\ONE.jsonl", completedAt: 300, outcome: "aborted" });

    expect(list.map((entry) => entry.path)).toEqual([resolve("c:\\sessions\\ONE.jsonl"), resolve("C:/Sessions/two.jsonl")]);
    // 同一会话连续多轮只有一条，时间与结局都取最新。
    expect(list[0]).toMatchObject({ completedAt: 300, outcome: "aborted" });
  });

  it("caps the retained entries (UI only shows the newest five)", () => {
    let list: RecentCompletion[] = [];
    for (let index = 0; index < RECENT_COMPLETIONS_KEEP + 5; index += 1) {
      list = recordRecentCompletion(list, { path: `C:/Sessions/s-${index}.jsonl`, completedAt: index, outcome: "completed" });
    }
    expect(list).toHaveLength(RECENT_COMPLETIONS_KEEP);
    expect(list[0]?.path).toBe(resolve(`C:/Sessions/s-${RECENT_COMPLETIONS_KEEP + 4}.jsonl`));
  });

  it("ignores blank paths instead of writing an unusable entry", () => {
    const list = [completion({ path: "C:/Sessions/one.jsonl" })];
    expect(recordRecentCompletion(list, { path: "   ", outcome: "completed" })).toEqual(list);
  });

  it("loads nothing (never throws) for a missing or corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pidesktop-completions-"));
    expect(loadRecentCompletions(join(dir, "missing.json"))).toEqual([]);
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ not json", "utf8");
    expect(loadRecentCompletions(broken)).toEqual([]);
    const wrongShape = join(dir, "wrong-shape.json");
    await writeFile(wrongShape, JSON.stringify({ version: 1, entries: "nope" }), "utf8");
    expect(loadRecentCompletions(wrongShape)).toEqual([]);
  });

  it("skips malformed entries, dedupes by path and sorts newest first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pidesktop-completions-"));
    const filePath = join(dir, "recent.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      entries: [
        { path: "C:/Sessions/old.jsonl", completedAt: 100, outcome: "completed" },
        { path: "C:/Sessions/new.jsonl", completedAt: 300, outcome: "failed" },
        { path: "c:\\sessions\\OLD.jsonl", completedAt: 200, outcome: "aborted" },
        { path: "", completedAt: 400, outcome: "completed" },
        { path: "C:/Sessions/no-time.jsonl", outcome: "completed" },
        { path: "C:/Sessions/bad-outcome.jsonl", completedAt: 500, outcome: "running" }
      ]
    }), "utf8");

    const loaded = loadRecentCompletions(filePath);
    expect(loaded.map((entry) => entry.path)).toEqual([resolve("C:/Sessions/new.jsonl"), resolve("c:\\sessions\\OLD.jsonl")]);
    expect(loaded[1]).toMatchObject({ completedAt: 200, outcome: "aborted" });
  });

  it("round-trips through the JSON file at the agent-dir location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pidesktop-completions-"));
    const filePath = recentCompletionsPath(dir);
    expect(filePath.endsWith("pidesktop-recent-completions.json")).toBe(true);
    const list = [
      completion({ path: resolve("C:/Sessions/one.jsonl"), completedAt: 200, outcome: "failed" }),
      completion({ path: resolve("C:/Sessions/two.jsonl"), completedAt: 100, outcome: "aborted" })
    ];
    saveRecentCompletions(filePath, list);
    expect(loadRecentCompletions(filePath)).toEqual(list);
  });
});

describe("applyRecentCompletions", () => {
  it("stamps only the sessions that have a record, keeping their other fields", () => {
    const sessions = [
      summary({ id: "one", path: "C:/Sessions/one.jsonl", title: "跑完的" }),
      summary({ id: "two", path: "C:/Sessions/two.jsonl", title: "没跑过的" })
    ];
    const next = applyRecentCompletions(sessions, [
      completion({ path: "C:/Sessions/one.jsonl", completedAt: 900, outcome: "failed" })
    ]);

    expect(next[0]).toMatchObject({ id: "one", completedAt: 900, completedOutcome: "failed" });
    expect(next[1]).toEqual(sessions[1]);
    // 未命中记录的那条保持同一引用（避免无意义的整表重渲染）。
    expect(next[1]).toBe(sessions[1]);
  });

  it("keeps the same array reference when nothing changes", () => {
    const sessions = [summary({ id: "one", path: "C:/Sessions/one.jsonl", completedAt: 900, completedOutcome: "completed" })];
    const next = applyRecentCompletions(sessions, [completion({ path: "C:/Sessions/one.jsonl", completedAt: 900, outcome: "completed" })]);
    expect(next).toBe(sessions);
  });

  it("clears a stale stamp when the record is gone (deleted / trimmed)", () => {
    const sessions = [summary({ id: "one", path: "C:/Sessions/one.jsonl", completedAt: 900, completedOutcome: "completed" })];
    const next = applyRecentCompletions(sessions, [completion({ path: "C:/Sessions/other.jsonl" })]);
    expect(next[0]?.completedAt).toBeUndefined();
    expect(next[0]?.completedOutcome).toBeUndefined();
    expect(next[0]?.title).toBe("one");
  });

  it("returns the input untouched when there are no records at all", () => {
    const sessions = [summary({ id: "one", path: "C:/Sessions/one.jsonl" })];
    expect(applyRecentCompletions(sessions, [])).toBe(sessions);
  });
});
