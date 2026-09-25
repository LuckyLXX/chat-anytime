import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { listSessionSummaries, readSessionHeaderLine, summarizeEntries, summarizeLiveSession, type SessionFileSummary } from "./session-summary-cache.js";

/**
 * 会话摘要缓存（2026-09-25 性能 P0）的回归网。
 *
 * 这个模块替换的是 Pi 的 `SessionManager.listAll` 在 `refreshSessions` 里的位置，
 * 所以最关键的用例是**与 Pi 对拍**：同一夹具目录上，本模块产出的字段必须与
 * `SessionManager.listAll` 的 `buildSessionInfo` 逐字段相等——字段口径漂了会直接
 * 变成侧边栏标题/排序/计数错，而且只在某些会话形态下才暴露。其余用例锁定缓存
 * 纪律本身（命中不重读、负缓存、prune、live 零 I/O）。
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pidesktop-session-summary-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

/** 用 Pi 自己的写盘 API 造真实会话文件（而不是手写 JSONL，避免夹具与上游格式脱节）。 */
function writeRealSession(dir: string, cwd: string, build: (manager: SessionManager) => void): string {
  const manager = SessionManager.create(cwd, dir);
  build(manager);
  const file = manager.getSessionFile();
  expect(file, "会话文件未落盘（夹具缺少 assistant 消息？）").toBeTruthy();
  return file!;
}

function writeRaw(dir: string, name: string, lines: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n", "utf8");
  return path;
}

/** 与 Pi 对拍：只比较本模块保留的字段。 */
function compareWithPi(dirs: string[], summaries: SessionFileSummary[], piSessions: Awaited<ReturnType<typeof SessionManager.listAll>>): void {
  const piByPath = new Map(piSessions.map((session) => [resolve(session.path).toLowerCase(), session]));
  expect(summaries).toHaveLength(piSessions.length);
  for (const summary of summaries) {
    const pi = piByPath.get(resolve(summary.path).toLowerCase());
    expect(pi, `Pi 列表里没有 ${summary.path}`).toBeTruthy();
    expect({
      path: summary.path,
      id: summary.id,
      cwd: summary.cwd,
      name: summary.name,
      created: String(summary.created),
      modified: String(summary.modified),
      messageCount: summary.messageCount,
      firstMessage: summary.firstMessage
    }).toEqual({
      path: pi!.path,
      id: pi!.id,
      cwd: pi!.cwd,
      name: pi!.name,
      created: String(pi!.created),
      modified: String(pi!.modified),
      messageCount: pi!.messageCount,
      firstMessage: pi!.firstMessage
    });
  }
}

describe("session summary cache: parity with Pi SessionManager.listAll", () => {
  it("matches Pi field by field across real and hand-written session shapes", async () => {
    const dir = tempDir("parity");
    const cwd = "C:/work/demo";
    // ① 普通会话：字符串 content 的 user + parts 数组的 assistant。
    writeRealSession(dir, cwd, (manager) => {
      manager.appendMessage({ role: "user", content: "第一条消息" } as never);
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "收到" }] } as never);
    });
    // ② rename + 显式清空标题（最新一条 session_info 赢）。
    writeRealSession(dir, cwd, (manager) => {
      manager.appendMessage({ role: "user", content: "带标题的会话" } as never);
      manager.appendMessage({ role: "assistant", content: "回复" } as never);
      manager.appendSessionInfo("改过的标题");
      manager.appendSessionInfo("");
    });
    // ③ 手写：缺 message.timestamp、message.timestamp 是数字、坏行、空行、非 message 条目。
    writeRaw(dir, "2026-09-01T00-00-00-000Z_handwritten.jsonl", [
      { type: "session", version: 3, id: "handwritten", timestamp: "2026-09-01T00:00:00.000Z", cwd },
      "",
      "{不是 JSON",
      // 助手先说话（压缩后重启的会话形态）：firstMessage 必须取第一条 **user** 消息。
      { type: "message", id: "h0", parentId: null, timestamp: "2026-09-01T00:00:00.500Z", message: { role: "assistant", content: "助手先说话" } },
      { type: "message", id: "h1", parentId: "h0", timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: "手写第一条" } },
      { type: "model_change", id: "h2", parentId: "h1", timestamp: "2026-09-01T00:00:02.000Z", provider: "p", modelId: "m" },
      { type: "message", id: "h3", parentId: "h2", timestamp: "2026-09-01T00:00:03.000Z", message: { role: "toolResult", content: "工具输出" } },
      { type: "message", id: "h4", parentId: "h3", timestamp: "2026-09-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "手写回复" }], timestamp: 1_700_000_000_000 } }
    ]);
    // ④ 非会话文件（tool-audit.jsonl / checkpoints 同形）与空文件：必须被两边同时拒绝。
    writeRaw(dir, "tool-audit.jsonl", [
      { type: "tool_execution", tool: "read", at: "2026-09-01T00:00:00.000Z" },
      { type: "tool_execution", tool: "bash", at: "2026-09-01T00:00:01.000Z" }
    ]);
    mkdirSync(join(dir, "checkpoints"), { recursive: true });
    writeRaw(join(dir, "checkpoints"), "session-1.jsonl", [{ type: "checkpoint", sessionId: "x", index: 0 }]);
    writeFileSync(join(dir, "empty.jsonl"), "", "utf8");

    const summaries = await listSessionSummaries([dir, join(dir, "checkpoints")]);
    const piSessions = await SessionManager.listAll(dir);
    // 夹具非空且包含手写会话（防止两边都返回空数组而「全绿」）。
    expect(summaries.length).toBeGreaterThanOrEqual(3);
    expect(summaries.some((summary) => summary.id === "handwritten")).toBe(true);
    expect(summaries.every((summary) => summary.id !== "session-1")).toBe(true);
    compareWithPi([dir, join(dir, "checkpoints")], summaries, piSessions);
  });

  it("keeps the first user text and the latest activity time for parts-array content", () => {
    const entries = [
      { id: "a", type: "message", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "assistant", content: "助手先说话" } },
      { id: "b", type: "message", parentId: "a", timestamp: "2026-09-01T00:00:02.000Z", message: { role: "user", content: [{ type: "image", data: "x" }, { type: "text", text: "图文消息" }] } },
      { id: "c", type: "session_info", parentId: "b", timestamp: "2026-09-01T00:00:03.000Z", name: "  标题  " }
    ] as unknown as SessionEntry[];
    const summary = summarizeEntries(entries, { timestamp: "2026-09-01T00:00:00.000Z" }, { mtime: new Date(1) });
    expect(summary.name).toBe("标题");
    expect(summary.messageCount).toBe(2);
    expect(summary.firstMessage).toBe("图文消息");
    // message.timestamp 缺失 → 回退条目时间戳。
    expect(summary.modified.getTime()).toBe(Date.parse("2026-09-01T00:00:02.000Z"));
    expect(summary.created.getTime()).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
  });

  it("falls back to \"(no messages)\" and stat.mtime when nothing is usable", () => {
    const mtime = new Date("2026-09-02T00:00:00.000Z");
    const summary = summarizeEntries([], { timestamp: undefined }, { mtime });
    expect(summary.firstMessage).toBe("(no messages)");
    expect(summary.messageCount).toBe(0);
    expect(summary.modified.getTime()).toBe(mtime.getTime());
    // 与 Pi 的 `new Date(header.timestamp)` 同口径：头部时间戳缺失 → Invalid Date。
    expect(Number.isNaN(summary.created.getTime())).toBe(true);
  });
});

describe("readSessionHeaderLine", () => {
  it("reads a normal header, with or without a trailing newline", () => {
    const dir = tempDir("header");
    const header = { type: "session", version: 3, id: "s-1", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/work/demo" };
    const path = join(dir, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(header)}\n{"type":"message"}\n`, "utf8");
    expect(readSessionHeaderLine(path)).toEqual({ id: "s-1", cwd: "C:/work/demo", timestamp: header.timestamp, createdAt: Date.parse(header.timestamp) });
    writeFileSync(path, JSON.stringify(header), "utf8");
    expect(readSessionHeaderLine(path)?.id).toBe("s-1");
  });

  it("rejects files whose first parsed entry is not a session header", () => {
    const dir = tempDir("header-not-session");
    const path = join(dir, "tool-audit.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "tool_execution", tool: "read" })}\n`, "utf8");
    expect(readSessionHeaderLine(path)).toBeUndefined();
    // 头部缺 id / id 类型不对同样不算会话。
    const noId = join(dir, "no-id.jsonl");
    writeFileSync(noId, `${JSON.stringify({ type: "session", cwd: "C:/x" })}\n`, "utf8");
    expect(readSessionHeaderLine(noId)).toBeUndefined();
  });

  it("returns undefined for empty files and for a first line longer than the scan window", () => {
    const dir = tempDir("header-edges");
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "", "utf8");
    expect(readSessionHeaderLine(empty)).toBeUndefined();
    // 300 KB 无换行的单行：超出 256 KB 有界读 → 放弃（真会话头部只有几百字节）。
    const huge = join(dir, "huge.jsonl");
    writeFileSync(huge, "x".repeat(300 * 1024), "utf8");
    expect(readSessionHeaderLine(huge)).toBeUndefined();
    // 窗口内有换行、但换行前是垃圾：按行跳过，最终放弃。
    const junk = join(dir, "junk.jsonl");
    writeFileSync(junk, `${"y".repeat(1024)}\n`, "utf8");
    expect(readSessionHeaderLine(junk)).toBeUndefined();
  });
});

describe("session summary cache: cache discipline", () => {
  function countingDeps(cache: Map<string, any>): { openCalls: () => number; headerCalls: () => number; deps: any } {
    let opens = 0;
    let headers = 0;
    return {
      openCalls: () => opens,
      headerCalls: () => headers,
      deps: {
        cache,
        openSession: (path: string) => { opens++; return SessionManager.open(path); },
        readHeader: (path: string) => { headers++; return readSessionHeaderLine(path); },
        readdir,
        stat
      }
    };
  }

  it("does not re-read a file whose mtime and size are unchanged (negative cache included)", async () => {
    const dir = tempDir("cache-hit");
    writeRealSession(dir, "C:/work/demo", (manager) => {
      manager.appendMessage({ role: "user", content: "hi" } as never);
      manager.appendMessage({ role: "assistant", content: "ok" } as never);
    });
    writeRaw(dir, "tool-audit.jsonl", [{ type: "tool_execution", tool: "read" }]);
    const cache = new Map<string, any>();
    const counter = countingDeps(cache);
    const first = await listSessionSummaries([dir], counter.deps);
    expect(first).toHaveLength(1);
    // 非会话文件的首行判定走了注入的 readHeader（计数可观测）：两个 .jsonl 各判一次，
    // 但只有真会话被整文件打开。
    expect(counter.openCalls()).toBe(1);
    expect(counter.headerCalls()).toBe(2);

    const second = await listSessionSummaries([dir], counter.deps);
    expect(second).toHaveLength(1);
    expect(counter.openCalls()).toBe(1);
    expect(counter.headerCalls()).toBe(2);
    expect(second[0]).toBe(first[0]);
  });

  it("re-reads a file once its mtime/size changes", async () => {
    const dir = tempDir("cache-invalidate");
    const path = writeRaw(dir, "2026-09-01T00-00-00-000Z_s1.jsonl", [
      { type: "session", version: 3, id: "s1", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/work/demo" },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: "原始" } }
    ]);
    const cache = new Map<string, any>();
    const counter = countingDeps(cache);
    const first = await listSessionSummaries([dir], counter.deps);
    expect(first[0]?.firstMessage).toBe("原始");

    // 追加一条 assistant 消息（Pi 的 append-only 写入方式：size 变了）。
    writeFileSync(path, `${JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-01T00:00:02.000Z", message: { role: "assistant", content: "回复" } })}\n`, { flag: "a" });
    const second = await listSessionSummaries([dir], counter.deps);
    expect(second[0]?.messageCount).toBe(2);
    expect(counter.openCalls()).toBe(2);
  });

  it("prunes cache entries for files that disappeared", async () => {
    const dir = tempDir("cache-prune");
    const path = writeRaw(dir, "a.jsonl", [
      { type: "session", version: 3, id: "a", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/work/demo" }
    ]);
    const cache = new Map<string, any>();
    await listSessionSummaries([dir], { cache });
    expect(cache.size).toBe(1);
    rmSync(path);
    const summaries = await listSessionSummaries([dir], { cache });
    expect(summaries).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it("prefers an in-memory live summary over the file on disk (zero I/O)", async () => {
    const dir = tempDir("cache-live");
    const path = writeRealSession(dir, "C:/work/demo", (manager) => {
      manager.appendMessage({ role: "user", content: "磁盘上的旧标题" } as never);
      manager.appendMessage({ role: "assistant", content: "ok" } as never);
    });
    const live = summarizeLiveSession({
      path,
      id: "live-id",
      cwd: "C:/work/demo",
      entries: [
        { id: "l1", type: "message", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: "内存里的最新" } },
        { id: "l2", type: "message", parentId: "l1", timestamp: "2026-09-01T00:00:02.000Z", message: { role: "assistant", content: "ok" } }
      ] as unknown as SessionEntry[],
      fallbackTime: Date.parse("2026-09-01T00:00:03.000Z")
    });
    let opens = 0;
    const summaries = await listSessionSummaries([dir], {
      liveSummaries: [live],
      openSession: (target) => { opens++; return SessionManager.open(target); }
    });
    expect(opens).toBe(0);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe("live-id");
    expect(summaries[0]?.firstMessage).toBe("内存里的最新");
    expect(summaries[0]?.modified.getTime()).toBe(Date.parse("2026-09-01T00:00:02.000Z"));
  });

  it("skips unreadable directories and files deleted mid-scan", async () => {
    const dir = tempDir("cache-races");
    expect(await listSessionSummaries([join(dir, "does-not-exist")])).toEqual([]);
    writeRaw(dir, "vanishing.jsonl", [{ type: "session", version: 3, id: "v", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/x" }]);
    const summaries = await listSessionSummaries([dir], {
      stat: async (path: string) => {
        if (!existsSync(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return stat(path);
      }
    });
    expect(summaries.map((summary) => summary.id)).toEqual(["v"]);
  });
});

describe("session summary cache: real-world freshness", () => {
  it("sees a rename appended by Pi without touching the message list", async () => {
    const dir = tempDir("rename");
    const path = writeRealSession(dir, "C:/work/demo", (manager) => {
      manager.appendMessage({ role: "user", content: "原始" } as never);
      manager.appendMessage({ role: "assistant", content: "ok" } as never);
    });
    const before = await listSessionSummaries([dir]);
    expect(before[0]?.name).toBeUndefined();
    SessionManager.open(path).appendSessionInfo("改过的标题");
    const after = await listSessionSummaries([dir]);
    expect(after[0]?.name).toBe("改过的标题");
    expect(after[0]?.messageCount).toBe(2);
  });

  it("tracks live sessions through their own entries only", () => {
    const summary = summarizeLiveSession({ path: "C:/x/s.jsonl", id: "s", cwd: "C:/x", entries: [] as unknown as SessionEntry[], fallbackTime: 1_700_000_000_000 });
    expect(summary.modified.getTime()).toBe(1_700_000_000_000);
    expect(summary.messageCount).toBe(0);
    expect(summary.firstMessage).toBe("(no messages)");
  });

  it("keeps the cache key case-insensitive on Windows paths", async () => {
    const dir = tempDir("case");
    writeRaw(dir, "a.jsonl", [{ type: "session", version: 3, id: "a", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/x" }]);
    const cache = new Map<string, any>();
    await listSessionSummaries([dir], { cache });
    expect([...cache.keys()].every((key) => key === key.toLowerCase())).toBe(true);
    // 同一文件用不同大小写目录再列一次：命中同一缓存键，不重复解析。
    await listSessionSummaries([resolve(dir).toUpperCase()], { cache });
    expect(cache.size).toBe(1);
  });
});

describe("session summary cache: stat metadata is what drives staleness", () => {
  it("uses mtimeMs + size, not the summary's own modified time", async () => {
    const dir = tempDir("stat-fields");
    const path = writeRaw(dir, "a.jsonl", [{ type: "session", version: 3, id: "a", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/x" }]);
    // 把 mtime 推到过去：size 未变但 mtime 变了 → 仍应重解析（口径就是 mtime+size）。
    const past = new Date(1_600_000_000_000);
    utimesSync(path, past, past);
    const cache = new Map<string, any>();
    let opens = 0;
    await listSessionSummaries([dir], { cache, openSession: (target) => { opens++; return SessionManager.open(target); } });
    expect(opens).toBe(1);
    expect(cache.size).toBe(1);
    const entry = [...cache.values()][0];
    expect(entry.mtimeMs).toBe(statSync(path).mtimeMs);
    expect(entry.size).toBe(statSync(path).size);
  });
});
