import { describe, expect, it } from "vitest";
import { agentWorkspaceSessionDir, backfillUnpersistedSessions, mergeSessionSummary, pruneVanishedSessions, resolveNewSessionDefaults, sameSessionDir, sessionFileMatchesId, sessionListReadyFor, workspaceHash, type LiveSessionSeed } from "./session-scope.js";

describe("Agent workspace session scope", () => {
  it("keeps agents and workspaces in separate deterministic directories", () => {
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).toBe(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo"));
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).not.toBe(agentWorkspaceSessionDir("C:/pi", "coder", "C:/projects/demo"));
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).not.toBe(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/other"));
    expect(workspaceHash("C:/projects/demo")).toHaveLength(20);
  });

  it("matches Pi's timestamp-prefixed session file names by session id", () => {
    // 真机文件名（Pi SessionManager 落盘命名）：<ISO 时间戳>_<sessionId>.jsonl
    const id = "01a07e88-18bb-7668-801b-e9b169ffab65";
    expect(sessionFileMatchesId(`2026-09-08T01-00-43-601Z_${id}.jsonl`, id)).toBe(true);
    // 裸 <sessionId>.jsonl（旧文件/手工复制）同样命中
    expect(sessionFileMatchesId(`${id}.jsonl`, id)).toBe(true);
    expect(sessionFileMatchesId(`2026-09-08T01-00-43-601Z_${id.toUpperCase()}.JSONL`, id)).toBe(true);
  });

  it("rejects ids that merely overlap another session id or file name", () => {
    const id = "01a07e88-18bb-7668-801b-e9b169ffab65";
    // id 是另一 id 的后缀：_ 锚点拦住（否则 -e9b169ffab65 会误命中）
    expect(sessionFileMatchesId(`2026-09-08T01-00-43-601Z_${id}.jsonl`, "e9b169ffab65")).toBe(false);
    // 另一 id 以本 id 结尾但没有 _ 分隔
    expect(sessionFileMatchesId("2026-09-08T01-00-43-601Z_zz01a07e88.jsonl", "01a07e88")).toBe(false);
    expect(sessionFileMatchesId(`2026-09-08T01-00-43-601Z_${id}.jsonl.tmp`, id)).toBe(false);
    expect(sessionFileMatchesId(`2026-09-08T01-00-43-601Z_${id}.jsonl`, "")).toBe(false);
  });

  it("uses Agent defaults for new sessions and leaves history to Pi restoration", () => {
    expect(resolveNewSessionDefaults(false, "agent-model", "global-model", "high", "low")).toEqual({ model: "agent-model", thinkingLevel: "high" });
    expect(resolveNewSessionDefaults(true, "agent-model", "global-model", "high", "low")).toEqual({ model: undefined, thinkingLevel: undefined });
  });

  it("merges a fresh session into the sidebar list without touching existing entries", () => {
    const known = { id: "old", path: "C:/pi/sessions/old.jsonl", workspace: "C:/work", title: "旧话题", modifiedAt: 100, messageCount: 3 };
    const incoming = { id: "new", path: "C:/pi/sessions/new.jsonl", workspace: "C:/work", title: "新会话", modifiedAt: 500, messageCount: 0 };
    const merged = mergeSessionSummary([known], incoming);
    // New session is prepended (newest first), existing entry unchanged.
    expect(merged.map((item) => item.id)).toEqual(["new", "old"]);
    expect(merged[1]).toEqual(known);
  });

  it("merges an upgraded summary over the same path (optionally with open cursor)", () => {
    const base = { id: "old-id", path: "C:/work/sessions/same.jsonl", workspace: "C:/work", title: "旧标题", modifiedAt: 100, messageCount: 3 };
    const incoming = { id: "old-id", path: "c:/work/sessions/SAME.jsonl", workspace: "C:/work", title: "新标题", modifiedAt: 200, messageCount: 0 };
    // Path comparison is case-insensitive and absolute; the incoming row wins.
    expect(mergeSessionSummary([base], incoming)).toEqual([incoming]);
  })

  it("keeps a mixed list sorted by modifiedAt descending", () => {
    const a = { id: "a", path: "C:/pi/sessions/a.jsonl", workspace: "C:/work", title: "a", modifiedAt: 30, messageCount: 1 };
    const b = { id: "b", path: "C:/pi/sessions/b.jsonl", workspace: "C:/work", title: "b", modifiedAt: 60, messageCount: 1 };
    const c = { id: "c", path: "C:/pi/sessions/c.jsonl", workspace: "C:/work", title: "c", modifiedAt: 10, messageCount: 1 };
    expect(mergeSessionSummary([a, b], c).map((item) => item.id)).toEqual(["b", "a", "c"]);
  });

  it("treats a non-empty session list from another agent as stale after an agent switch", () => {
    // Same agent, populated list: the cached list stays valid.
    expect(sessionListReadyFor(3, "coder", "coder")).toBe(true);
    // The previous agent's list is non-empty but out of scope: must re-list.
    expect(sessionListReadyFor(3, "default", "coder")).toBe(false);
    // Empty lists are never ready, even for the same agent.
    expect(sessionListReadyFor(0, "coder", "coder")).toBe(false);
    expect(sessionListReadyFor(0, undefined, undefined)).toBe(false);
  });
});

describe("sameSessionDir", () => {
  it("compares absolute directories case-insensitively and rejects a missing expectation", () => {
    expect(sameSessionDir("C:/pi/sessions/hash-a", "c:\\pi\\sessions\\HASH-A")).toBe(true);
    expect(sameSessionDir("C:/pi/sessions/hash-a", "C:/pi/sessions/hash-b")).toBe(false);
    expect(sameSessionDir("C:/pi/sessions/hash-a", "C:/pi/sessions/hash-a/nested")).toBe(false);
    expect(sameSessionDir(undefined, "C:/pi/sessions/hash-a")).toBe(false);
  });
});

describe("pruneVanishedSessions", () => {
  const vanished = { id: "ghost", path: "C:/pi/sessions/ghost.jsonl", workspace: "C:/work", title: "新会话", modifiedAt: 500, messageCount: 0 };
  const persisted = { id: "disk", path: "C:/pi/sessions/disk.jsonl", workspace: "C:/work", title: "磁盘话题", modifiedAt: 100, messageCount: 5 };

  it("drops an empty topic whose file was never written and whose live record is gone", () => {
    const list = [vanished, persisted];
    expect(pruneVanishedSessions(list, [], () => false).map((item) => item.id)).toEqual(["disk"]);
  });

  it("keeps an unpersisted topic while its live record still exists", () => {
    const list = [vanished, persisted];
    expect(pruneVanishedSessions(list, ["c:/pi/sessions/GHOST.jsonl"], () => false)).toBe(list);
  });

  it("keeps an empty topic whose file does exist", () => {
    const list = [vanished];
    expect(pruneVanishedSessions(list, [], (path) => path === vanished.path)).toBe(list);
  });

  it("never prunes a non-empty topic or a pinned one", () => {
    const renamed = { ...vanished, messageCount: 2 };
    const pinned = { ...vanished, id: "pinned", pinned: true };
    expect(pruneVanishedSessions([renamed], [], () => false).map((item) => item.id)).toEqual(["ghost"]);
    expect(pruneVanishedSessions([pinned], [], () => false).map((item) => item.id)).toEqual(["pinned"]);
  });

  it("returns the list reference untouched when nothing is pruned", () => {
    const list = [persisted];
    expect(pruneVanishedSessions(list, [], () => false)).toBe(list);
  });
});

describe("backfillUnpersistedSessions", () => {
  const onDisk = { id: "disk", path: "C:/pi/sessions/disk.jsonl", workspace: "C:/work", title: "磁盘话题", modifiedAt: 100, messageCount: 5 };

  it("re-adds live sessions whose file is not on disk yet (fresh 新会话 not wiped by a full refresh)", () => {
    const seed: LiveSessionSeed = { sessionId: "fresh", path: "C:/pi/sessions/fresh.jsonl", workspace: "C:/work", agentId: "coder", activatedAt: 400 };
    const backfilled = backfillUnpersistedSessions([onDisk], [onDisk], [seed], "coder");
    expect(backfilled.map((item) => item.id)).toEqual(["fresh", "disk"]);
    expect(backfilled[0]).toMatchObject({ id: "fresh", title: "新会话", workspace: "C:/work", messageCount: 0 });
  });

  it("returns the list reference untouched when there is nothing to backfill", () => {
    const seed: LiveSessionSeed = { sessionId: "disk", path: "C:/pi/sessions/disk.jsonl", workspace: "C:/work", agentId: "coder", activatedAt: 400 };
    const list = [onDisk];
    expect(backfillUnpersistedSessions(list, [onDisk], [seed], "coder")).toBe(list);
    expect(backfillUnpersistedSessions(list, [onDisk], [], "coder")).toBe(list);
  });

  it("skips live records of another agent (agent-scoped listing) and records without a file", () => {
    const other: LiveSessionSeed = { sessionId: "other", path: "C:/pi/sessions/other.jsonl", workspace: "C:/work", agentId: "default", activatedAt: 400 };
    const fileless: LiveSessionSeed = { sessionId: "fileless", path: undefined, workspace: "C:/work", agentId: "coder", activatedAt: 400 };
    const list = [onDisk];
    expect(backfillUnpersistedSessions(list, [onDisk], [other, fileless], "coder")).toBe(list);
  });

  it("prefers the pre-refresh entry to preserve renames/pins and overlays the live runStatus", () => {
    const prior = { id: "fresh", path: "C:/pi/sessions/fresh.jsonl", workspace: "C:/work", title: "用户改过名", modifiedAt: 300, messageCount: 0, pinned: true };
    const seed: LiveSessionSeed = { sessionId: "fresh", path: "c:/pi/sessions/FRESH.jsonl", workspace: "C:/work", agentId: "coder", activatedAt: 400, title: undefined, runStatus: "running" };
    const backfilled = backfillUnpersistedSessions([onDisk], [prior], [seed], "coder");
    expect(backfilled.map((item) => item.id)).toEqual(["fresh", "disk"]);
    expect(backfilled[0]).toEqual({ ...prior, runStatus: "running" });
  });

  it("deduplicates against the disk list by path (case-insensitive)", () => {
    const seed: LiveSessionSeed = { sessionId: "disk", path: "c:/pi/sessions/DISK.jsonl", workspace: "C:/work", agentId: "coder", activatedAt: 400 };
    const backfilled = backfillUnpersistedSessions([onDisk], [onDisk], [seed], "coder");
    expect(backfilled.map((item) => item.id)).toEqual(["disk"]);
  });
});

describe("unpersisted session targets (the /new row opened from the sidebar)", () => {
  it("resolves a workspace session dir to the real file directory, case-insensitively", () => {
    // 守卫：sameSessionDir 必须与 agentWorkspaceSessionDir 的输出同形，否则 session.open
    // 的目录校验会把合法会话判成「路径与工作区不匹配」。期望值从函数自身派生——
    // 不硬编码 hash（hash 随平台 path.resolve 语义变化，硬编码会在 POSIX 上挂）。
    const dir = agentWorkspaceSessionDir("C:/pi", "coder", "C:/work/demo");
    const hashDir = dir.slice(dir.lastIndexOf("/") + 1 || dir.lastIndexOf("\\") + 1);
    expect(sameSessionDir(dir, dir)).toBe(true);
    expect(sameSessionDir(dir, dir.toUpperCase())).toBe(true);
    // 误传会话根、上一级目录或别的哈希目录必须判不匹配（否则校验形同虚设）
    expect(sameSessionDir(dir, dir.slice(0, dir.length - hashDir.length - 1))).toBe(false);
    expect(sameSessionDir(dir, agentWorkspaceSessionDir("C:/pi", "coder", "C:/work/other"))).toBe(false);
    expect(sameSessionDir(undefined, dir)).toBe(false);
  });
});
