import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/protocol";
import { archivedSessionCount, selectSessionPaths, selectedPathsInView, sessionsForView, toggleSessionSelection } from "./session-view";

function session(overrides: Partial<SessionSummary> & { path: string }): SessionSummary {
  return { id: overrides.path, workspace: "C:/work", title: "话题", modifiedAt: 1, messageCount: 1, ...overrides };
}

const active = session({ path: "C:/pi/sessions/a.jsonl" });
const archived = session({ path: "C:/pi/sessions/b.jsonl", archived: true });
const alsoArchived = session({ path: "C:/pi/sessions/c.jsonl", archived: true });
const all = [active, archived, alsoArchived];

describe("session view projection", () => {
  it("splits archived and active sessions (缺省视为未归档)", () => {
    expect(sessionsForView(all, "active").map((item) => item.path)).toEqual([active.path]);
    expect(sessionsForView(all, "archived").map((item) => item.path)).toEqual([archived.path, alsoArchived.path]);
  });

  it("counts only archived sessions", () => {
    expect(archivedSessionCount(all)).toBe(2);
    expect(archivedSessionCount([active])).toBe(0);
    expect(archivedSessionCount([])).toBe(0);
  });
});

describe("session selection", () => {
  it("toggles a path on and off without mutating the input", () => {
    const empty = {};
    const one = toggleSessionSelection(empty, active.path);
    expect(one).toEqual({ [active.path]: true });
    expect(empty).toEqual({});
    expect(toggleSessionSelection(one, active.path)).toEqual({});
    // 两个键各留一份（不共享同一个引用被误删）
    const two = toggleSessionSelection(one, archived.path);
    expect(Object.keys(two).sort()).toEqual([active.path, archived.path].sort());
    expect(toggleSessionSelection(two, active.path)).toEqual({ [archived.path]: true });
  });

  it("selects a whole list at once (全选)", () => {
    expect(selectSessionPaths([active.path, archived.path])).toEqual({ [active.path]: true, [archived.path]: true });
    expect(selectSessionPaths([])).toEqual({});
  });

  it("returns only selected paths that still exist in the current view", () => {
    const selected = selectSessionPaths([active.path, archived.path, "C:/pi/sessions/gone.jsonl"]);
    // 陈旧键（列表里已不存在）与另一视图的项都不进操作入参
    expect(selectedPathsInView(selected, all, "active")).toEqual([active.path]);
    expect(selectedPathsInView(selected, all, "archived")).toEqual([archived.path]);
    expect(selectedPathsInView(selected, [archived], "active")).toEqual([]);
    expect(selectedPathsInView({}, all, "archived")).toEqual([]);
  });
});
