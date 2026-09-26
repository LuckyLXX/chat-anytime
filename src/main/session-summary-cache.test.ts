import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { listSessionSummaries, loadSessionIndex, readSessionHeaderLine, saveSessionIndex, summarizeEntries, summarizeLiveSession, type SessionFileSummary } from "./session-summary-cache.js";

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

  it("keeps another directory's entries cached when a later round scans only one of them", async () => {
    // 助手的会话目录集随助手切换而变：全局 prune 会把另一个助手的缓存冲掉，
    // 于是「切换助手」来回切就反复付全量冷扫——prune 必须限定在本轮扫过的目录内。
    const dirA = tempDir("prune-scope-a");
    const dirB = tempDir("prune-scope-b");
    const pathA = writeRaw(dirA, "a.jsonl", [{ type: "session", version: 3, id: "a", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/a" }]);
    writeRaw(dirB, "b.jsonl", [{ type: "session", version: 3, id: "b", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/b" }]);
    const cache = new Map<string, any>();
    let opens = 0;
    const deps = { cache, openSession: (target: string) => { opens++; return SessionManager.open(target); } };
    await listSessionSummaries([dirA, dirB], deps);
    expect(cache.size).toBe(2);

    rmSync(pathA);
    const second = await listSessionSummaries([dirA], deps);
    expect(second).toEqual([]);
    expect(cache.size).toBe(1);
    expect([...cache.keys()][0]).toContain("b.jsonl");

    // 回到 dirB 仍是缓存命中（不重读）。
    const third = await listSessionSummaries([dirB], deps);
    expect(third.map((summary) => summary.id)).toEqual(["b"]);
    expect(opens).toBe(2);
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

/**
 * 磁盘索引（2026-09-26 P1）：把内存摘要缓存持久化，消掉「重启后第一轮全量重解析」。
 * 实测基线：本机一个助手 179 文件 / 264 MB 冷扫 1461 ms，全助手 439 文件 5159 ms，
 * 而这轮扫描纯同步 JSON.parse 压在 utility 事件循环上（表现为刚启动时点什么都卡一下）。
 */
describe("session summary cache: disk index", () => {
  function indexCountingDeps(cache: Map<string, any>): { openCalls: () => number; headerCalls: () => number; deps: any } {
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

  function makeFixture(dir: string): void {
    writeRealSession(dir, "C:/work/demo", (manager) => {
      manager.appendMessage({ role: "user", content: "第一个问题" } as never);
      manager.appendMessage({ role: "assistant", content: "第一个回答" } as never);
      manager.appendSessionInfo("会话标题");
    });
    writeRaw(dir, "tool-audit.jsonl", [{ type: "tool_execution", tool: "read" }]);
  }

  it("索引往返：日期复原、字段一致，且第二个进程不再重解析任何文件", async () => {
    const dir = tempDir("index-roundtrip");
    makeFixture(dir);
    const indexPath = join(dir, "pidesktop-session-index.json");

    // 第一遍：冷扫（构造索引）
    const firstCache = new Map<string, any>();
    const first = await listSessionSummaries([dir], indexCountingDeps(firstCache).deps);
    expect(first).toHaveLength(1);
    const saved = saveSessionIndex(indexPath, firstCache, { now: 1_700_000_000_000 });
    expect(saved.entries).toBe(2); // 真会话 + 非会话文件的负缓存

    // 第二遍：模拟重启（新进程只有磁盘索引）
    const loaded = loadSessionIndex(indexPath, { now: 1_700_000_000_000 });
    expect(loaded.size).toBe(2);
    const second = indexCountingDeps(loaded);
    const summaries = await listSessionSummaries([dir], second.deps);
    expect(summaries).toHaveLength(1);
    // 关键断言：一个文件都没打开，连首行都没读（负缓存也持久化了）
    expect(second.openCalls()).toBe(0);
    expect(second.headerCalls()).toBe(0);
    // 摘要内容与冷扫逐字段一致（日期经 JSON 往返后仍正确）
    expect(summaries[0]?.id).toBe(first[0]?.id);
    expect(summaries[0]?.messageCount).toBe(first[0]?.messageCount);
    expect(summaries[0]?.firstMessage).toBe(first[0]?.firstMessage);
    expect(summaries[0]?.modified.getTime()).toBe(first[0]?.modified.getTime());
    expect(summaries[0]?.created.getTime()).toBe(first[0]?.created.getTime());
    expect(summaries[0]?.name).toBe(first[0]?.name);
  });

  it("文件变了 → 只有那一个被重解析（索引不掩盖失效）", async () => {
    const dir = tempDir("index-invalidate");
    makeFixture(dir);
    const indexPath = join(dir, "pidesktop-session-index.json");
    const firstCache = new Map<string, any>();
    await listSessionSummaries([dir], indexCountingDeps(firstCache).deps);
    saveSessionIndex(indexPath, firstCache, { now: 1_700_000_000_000 });

    // 追加一条消息（Pi 追加写 → mtime 与 size 同时变）
    const sessionPath = (await readdir(dir)).map((name) => join(dir, name)).find((path) => path.endsWith(".jsonl") && !path.includes("audit"))!;
    const manager = SessionManager.open(sessionPath);
    manager.appendMessage({ role: "assistant", content: "追问后的回答" } as never);

    const loaded = loadSessionIndex(indexPath, { now: 1_700_000_000_000 });
    const counter = indexCountingDeps(loaded);
    const summaries = await listSessionSummaries([dir], counter.deps);
    expect(summaries).toHaveLength(1);
    expect(counter.openCalls()).toBe(1); // 只重解析变了的那一个
    expect(summaries[0]?.messageCount).toBe(3);
  });

  it("版本不符 / 损坏 / 非对象一律退化为空索引（绝不因此报错）", () => {
    const dir = tempDir("index-broken");
    const indexPath = join(dir, "index.json");
    for (const body of ["不是 JSON{{{", "{}", "[]", JSON.stringify({ version: 999, entries: [] }), JSON.stringify({ version: 1, entries: "nope" })]) {
      writeFileSync(indexPath, body, "utf8");
      expect(loadSessionIndex(indexPath).size).toBe(0);
    }
    expect(loadSessionIndex(join(dir, "根本不存在.json")).size).toBe(0);
  });

  it("非法条目被逐条剔除，合法条目照常保留", () => {
    const dir = tempDir("index-invalid-entries");
    const indexPath = join(dir, "index.json");
    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      entries: [
        { key: "c:/good.jsonl", mtimeMs: 1, size: 2, seenAt: 1_700_000_000_000, summary: { path: "C:/good.jsonl", id: "g", cwd: "C:/w", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-02T00:00:00.000Z", messageCount: 3, firstMessage: "hi" } },
        { key: "c:/bad-date.jsonl", mtimeMs: 1, size: 2, seenAt: 1_700_000_000_000, summary: { path: "C:/b.jsonl", id: "b", cwd: "C:/w", created: "not-a-date", modified: "2026-01-02T00:00:00.000Z", messageCount: 1, firstMessage: "x" } },
        { key: "c:/bad-shape.jsonl", mtimeMs: 1, size: 2, seenAt: 1_700_000_000_000, summary: { path: "C:/c.jsonl" } },
        { key: "c:/no-seen.jsonl", mtimeMs: 1, size: 2, summary: null }
      ]
    }), "utf8");
    const loaded = loadSessionIndex(indexPath, { now: 1_700_000_000_000 });
    expect([...loaded.keys()]).toEqual(["c:/good.jsonl"]);
  });

  it("超过 maxAge 的条目被丢弃（删掉的工作区不会永远留着）", () => {
    const dir = tempDir("index-expiry");
    const indexPath = join(dir, "index.json");
    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      entries: [
        { key: "c:/old.jsonl", mtimeMs: 1, size: 2, seenAt: 1_000, summary: null },
        { key: "c:/new.jsonl", mtimeMs: 1, size: 2, seenAt: 1_700_000_000_000, summary: null }
      ]
    }), "utf8");
    const loaded = loadSessionIndex(indexPath, { now: 1_700_000_000_000, maxAgeMs: 30 * 24 * 3600 * 1000 });
    expect([...loaded.keys()]).toEqual(["c:/new.jsonl"]);
  });

  it("超过条目上限时保留最新的（按 seenAt）", () => {
    const dir = tempDir("index-cap");
    const indexPath = join(dir, "index.json");
    const entries = Array.from({ length: 5 }, (_, index) => ({
      key: `c:/s${index}.jsonl`, mtimeMs: 1, size: 2, seenAt: 1_700_000_000_000 + index, summary: null
    }));
    writeFileSync(indexPath, JSON.stringify({ version: 1, entries }), "utf8");
    const loaded = loadSessionIndex(indexPath, { now: 1_700_000_000_010, maxEntries: 3 });
    expect(loaded.size).toBe(3);
    expect([...loaded.keys()].sort()).toEqual(["c:/s2.jsonl", "c:/s3.jsonl", "c:/s4.jsonl"]);
  });

  it("扫描命中会刷新 seenAt（陈旧淘汰因此只针对真正没人扫的条目）", async () => {
    const dir = tempDir("index-seenat");
    makeFixture(dir);
    const cache = new Map<string, any>();
    await listSessionSummaries([dir], { ...indexCountingDeps(cache).deps, now: () => 1_000 });
    for (const entry of cache.values()) expect(entry.seenAt).toBe(1_000);

    await listSessionSummaries([dir], { ...indexCountingDeps(cache).deps, now: () => 2_000 });
    for (const entry of cache.values()) expect(entry.seenAt).toBe(2_000);

    const indexPath = join(dir, "index.json");
    saveSessionIndex(indexPath, cache, { now: 2_000 });
    const reloaded = loadSessionIndex(indexPath, { now: 2_000 });
    expect([...reloaded.values()].every((entry) => entry.seenAt === 2_000)).toBe(true);
  });
});
