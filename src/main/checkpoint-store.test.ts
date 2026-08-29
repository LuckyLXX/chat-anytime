import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCheckpoint,
  checkpointPathFor,
  compressEntries,
  formatCheckpointEntry,
  parseCheckpointEntry,
  readCheckpoints,
  resetCheckpointState,
  selectRollbackPlan,
  sweepCheckpoints,
  type CheckpointEntry
} from "./checkpoint-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetCheckpointState();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function entry(overrides: Partial<CheckpointEntry> & { toolCallId: string; relativePath: string }): CheckpointEntry {
  return { ts: "2026-08-29T00:00:00.000Z", toolName: "write", existed: true, content: "before", ...overrides };
}

describe("checkpoint-store helpers", () => {
  it("round-trips entries through format/parse and drops malformed lines", () => {
    const line = formatCheckpointEntry(entry({ toolCallId: "t1", relativePath: "a.txt" }));
    expect(line).not.toContain("\n");
    expect(parseCheckpointEntry(line)).toEqual(entry({ toolCallId: "t1", relativePath: "a.txt" }));
    expect(parseCheckpointEntry("not json")).toBeUndefined();
    expect(parseCheckpointEntry(JSON.stringify({ ts: "x" }))).toBeUndefined();
    // truncated 标记与缺省 content 的形状保真。
    const truncated = parseCheckpointEntry(formatCheckpointEntry({ ts: "2026-08-29T00:00:00.000Z", toolCallId: "t", toolName: "edit", relativePath: "b.txt", existed: true, truncated: true }));
    expect(truncated?.truncated).toBe(true);
    expect(truncated?.content).toBeUndefined();
  });

  it("selectRollbackPlan keeps the earliest snapshot per file and filters by toolCallIds", () => {
    const entries = [
      entry({ toolCallId: "call-1", relativePath: "a.txt", content: "first" }),
      entry({ toolCallId: "call-2", relativePath: "a.txt", content: "second" }),
      entry({ toolCallId: "call-2", relativePath: "b.txt", existed: false }),
      entry({ toolCallId: "call-3", relativePath: "c.txt", content: "unrelated" })
    ];
    const plan = selectRollbackPlan(entries, ["call-1", "call-2"]);
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ relativePath: "a.txt", content: "first" });
    expect(plan[1]).toMatchObject({ relativePath: "b.txt", existed: false });
    expect(selectRollbackPlan(entries, ["call-3"])).toHaveLength(1);
    expect(selectRollbackPlan(entries, ["missing"])).toHaveLength(0);
  });

  it("compressEntries drops expired items first, then trims to the keep limit", () => {
    const now = Date.parse("2026-08-29T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const old = entry({ toolCallId: "old", relativePath: "old.txt", ts: new Date(now - 20 * day).toISOString() });
    const fresh = entry({ toolCallId: "fresh", relativePath: "fresh.txt", ts: new Date(now - day).toISOString() });
    expect(compressEntries([old, fresh], now)).toEqual([fresh]);
    // 未过期但超过 keepLines：保留最近的 N 条。
    const many = Array.from({ length: 10 }, (_, index) => entry({ toolCallId: `c${index}`, relativePath: `f${index}.txt`, ts: new Date(now - day).toISOString() }));
    expect(compressEntries(many, now, 14, 4)).toHaveLength(4);
    expect(compressEntries(many, now, 14, 4)[0]!.toolCallId).toBe("c6");
    // 非法时间戳按过期处理（丢弃）。
    expect(compressEntries([entry({ toolCallId: "bad", relativePath: "x.txt", ts: "nope" })], now)).toHaveLength(0);
  });
});

describe("checkpoint-store append/read", () => {
  it("appends entries as JSONL and reads them back in order", async () => {
    const dir = await makeTempDir("pi-desktop-cp-");
    const filePath = join(dir, "checkpoints", "session-1.jsonl");
    await appendCheckpoint({ filePath, entry: entry({ toolCallId: "c1", relativePath: "a.txt" }), warn: () => {} });
    await appendCheckpoint({ filePath, entry: entry({ toolCallId: "c2", relativePath: "b.txt", existed: false }), warn: () => {} });
    const entries = await readCheckpoints(filePath);
    expect(entries.map((item) => item.toolCallId)).toEqual(["c1", "c2"]);
    const raw = await readFile(filePath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("compresses lazily once the line threshold is exceeded", async () => {
    const dir = await makeTempDir("pi-desktop-cp-");
    const filePath = join(dir, "session.jsonl");
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // 3 条最新（未过期）+ 2 条过期，阈值 4：第 4 次追加触发压缩，过期条目被丢弃。
    const entries = [
      entry({ toolCallId: "old-1", relativePath: "old-1.txt", ts: new Date(now - 30 * day).toISOString() }),
      entry({ toolCallId: "old-2", relativePath: "old-2.txt", ts: new Date(now - 30 * day).toISOString() }),
      entry({ toolCallId: "fresh-1", relativePath: "fresh-1.txt", ts: new Date(now).toISOString() }),
      entry({ toolCallId: "fresh-2", relativePath: "fresh-2.txt", ts: new Date(now).toISOString() }),
      entry({ toolCallId: "fresh-3", relativePath: "fresh-3.txt", ts: new Date(now).toISOString() })
    ];
    for (const item of entries) {
      await appendCheckpoint({ filePath, entry: item, warn: () => {}, now, compressThreshold: 4 });
    }
    const remaining = await readCheckpoints(filePath);
    expect(remaining.map((item) => item.toolCallId)).toEqual(["fresh-1", "fresh-2", "fresh-3"]);
  });

  it("reports write failures through warn instead of rejecting", async () => {
    const warnings: string[] = [];
    // 把一个文件路径当目录用，追加必然失败。
    const dir = await makeTempDir("pi-desktop-cp-");
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a dir", "utf8");
    const filePath = join(blocker, "session.jsonl");
    await appendCheckpoint({ filePath, entry: entry({ toolCallId: "c", relativePath: "a.txt" }), warn: (message) => warnings.push(message) });
    expect(warnings).toHaveLength(1);
  });
});

describe("sweepCheckpoints", () => {
  it("deletes files past the mtime age and enforces the total budget from oldest", async () => {
    const agentDir = await makeTempDir("pi-desktop-sweep-");
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const make = async (root: string, agentId: string, sessionId: string, ageDays: number, size: number): Promise<string> => {
      const filePath = checkpointPathFor(join(root, "chatanytime-sessions", agentId), sessionId);
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(filePath, "x".repeat(size), "utf8");
      const time = new Date(now - ageDays * day);
      await utimes(filePath, time, time);
      return filePath;
    };
    const expired = await make(agentDir, "agent-a", "old", 40, 10);
    const mid = await make(agentDir, "agent-b", "mid", 2, 30);
    const newest = await make(agentDir, "agent-a", "new", 1, 10);
    // 预算 45 字节：现存 50 字节（10+30+10）超限；最旧的 40 字节文件同时过期先行删除，删后余 40 ≤ 45。
    const removed = await sweepCheckpoints(agentDir, now, () => {}, { fileAgeDays: 30, maxTotalBytes: 45 });
    expect(removed).toBe(1);
    await expect(stat(expired)).rejects.toThrow();
    await stat(mid);
    await stat(newest);

    // 纯预算路径：三个新文件 10+20+30=60，预算 25 → 从旧到新删到 10 ≤ 25（先删最旧 30B，再删 20B）。
    const agentDir2 = await makeTempDir("pi-desktop-sweep2-");
    const a = await make(agentDir2, "agent-x", "a", 1, 10);
    const b = await make(agentDir2, "agent-x", "b", 2, 20);
    const c = await make(agentDir2, "agent-x", "c", 3, 30);
    const removed2 = await sweepCheckpoints(agentDir2, now, () => {}, { fileAgeDays: 30, maxTotalBytes: 25 });
    expect(removed2).toBe(2);
    await expect(stat(c)).rejects.toThrow();
    await expect(stat(b)).rejects.toThrow();
    await stat(a);
  });
});
