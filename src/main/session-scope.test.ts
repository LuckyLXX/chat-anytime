import { describe, expect, it } from "vitest";
import { agentWorkspaceSessionDir, backfillUnpersistedSessions, mergeSessionSummary, resolveNewSessionDefaults, sessionListReadyFor, workspaceHash, type LiveSessionSeed } from "./session-scope.js";

describe("Agent workspace session scope", () => {
  it("keeps agents and workspaces in separate deterministic directories", () => {
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).toBe(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo"));
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).not.toBe(agentWorkspaceSessionDir("C:/pi", "coder", "C:/projects/demo"));
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).not.toBe(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/other"));
    expect(workspaceHash("C:/projects/demo")).toHaveLength(20);
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
