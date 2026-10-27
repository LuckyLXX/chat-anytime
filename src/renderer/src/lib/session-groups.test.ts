import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/protocol";
import { groupSessionsByWorkspace, workspaceDisplayLabel } from "./session-groups";

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "path" | "workspace" | "title">): SessionSummary {
  return {
    agentId: "default",
    modifiedAt: 1,
    messageCount: 1,
    ...overrides
  };
}

describe("session workspace groups", () => {
  it("groups sessions by workspace and keeps each group newest first", () => {
    const groups = groupSessionsByWorkspace([
      session({ id: "old", path: "old.jsonl", workspace: "C:\\Projects\\PiDesktop", title: "旧话题", modifiedAt: 10 }),
      session({ id: "new", path: "new.jsonl", workspace: "C:/Projects/PiDesktop", title: "新话题", modifiedAt: 30 }),
      session({ id: "other", path: "other.jsonl", workspace: "C:/Projects/Other", title: "另一个话题", modifiedAt: 20 })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.workspace).toBe("C:\\Projects\\PiDesktop");
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("searches both topic titles and workspace names", () => {
    expect(groupSessionsByWorkspace([
      session({ id: "one", path: "one.jsonl", workspace: "C:/Projects/PiDesktop", title: "检查渲染" }),
      session({ id: "two", path: "two.jsonl", workspace: "C:/Projects/Other", title: "其他", modifiedAt: 2 })
    ], "pidesktop").flatMap((group) => group.sessions.map((item) => item.id))).toEqual(["one"]);
  });

  it("searches resolved assistant names across agents", () => {
    const groups = groupSessionsByWorkspace([
      session({ id: "default-one", path: "a.jsonl", workspace: "C:/Projects/A", title: "检查渲染", agentId: "default" }),
      session({ id: "reviewer-one", path: "b.jsonl", workspace: "C:/Projects/A", title: "审查代码", agentId: "reviewer", modifiedAt: 2 }),
      session({ id: "reviewer-two", path: "c.jsonl", workspace: "C:/Projects/B", title: "另一件事", agentId: "reviewer", modifiedAt: 3 })
    ], "审查助手", [], undefined, { default: "默认助手", reviewer: "审查助手" });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.sessions.map((item) => item.id)).sort()).toEqual(["reviewer-one", "reviewer-two"]);
  });

  it("ignores unknown assistant ids when searching by agent name", () => {
    const groups = groupSessionsByWorkspace([
      session({ id: "one", path: "one.jsonl", workspace: "C:/Projects/A", title: "普通话题", agentId: "ghost" })
    ], "已归档助手", [], undefined, { default: "默认助手" });
    expect(groups).toEqual([]);
  });

  it("pins sessions to the top of their group regardless of modified time", () => {
    const groups = groupSessionsByWorkspace([
      session({ id: "fresh", path: "fresh.jsonl", workspace: "C:/Projects/PiDesktop", title: "最新", modifiedAt: 30 }),
      session({ id: "starred", path: "starred.jsonl", workspace: "C:/Projects/PiDesktop", title: "置顶", modifiedAt: 5, pinned: true }),
      session({ id: "mid", path: "mid.jsonl", workspace: "C:/Projects/PiDesktop", title: "中间", modifiedAt: 20 })
    ]);

    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["starred", "fresh", "mid"]);
  });

  it("ranks a group by its newest activity, not by the pinned row on top", () => {
    // 回归网：置顶行排第一后 groups[0].sessions[0] 是那条**旧的**置顶话题，
    // 旧实现拿它当分组时间戳 → 「置顶一个老话题」会把整个工作区分组往列表
    // 下方拖（新会话所在的组反超到它上面）。组排名应看组内真正最新的活动。
    const groups = groupSessionsByWorkspace([
      session({ id: "a-pinned", path: "a/p.jsonl", workspace: "C:/Projects/A", title: "置顶的老话题", modifiedAt: 10, pinned: true }),
      session({ id: "a-new", path: "a/n.jsonl", workspace: "C:/Projects/A", title: "A 新话题", modifiedAt: 900 }),
      session({ id: "b-new", path: "b/n.jsonl", workspace: "C:/Projects/B", title: "B 新话题", modifiedAt: 500 }),
      session({ id: "c-new", path: "c/n.jsonl", workspace: "C:/Projects/C", title: "C 新话题", modifiedAt: 100 })
    ]);

    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/A", "C:/Projects/B", "C:/Projects/C"]);
    // 组内顺序仍是置顶优先，但组的排名由 a-new（900）决定。
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["a-pinned", "a-new"]);
  });

  it("shows every empty recent workspace, not just the active one", () => {
    const groups = groupSessionsByWorkspace([], "", [
      { path: "C:/Projects/Older", openedAt: 30 },
      { path: "C:\\Projects\\Fresh", openedAt: 40 }
    ], "c:/projects/fresh");

    expect(groups.map((group) => group.workspace)).toEqual(["C:\\Projects\\Fresh", "C:/Projects/Older"]);
    expect(groups.every((group) => group.sessions.length === 0)).toBe(true);
  });

  it("shows empty recent workspaces even when no workspace is active", () => {
    // 新建助手：全局最近工作区仍应上屏，而不是只显示当前激活的空工作区。
    const groups = groupSessionsByWorkspace([], "", [
      { path: "C:/Projects/Older", openedAt: 30 },
      { path: "C:/Projects/Fresh", openedAt: 40 }
    ]);

    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Fresh", "C:/Projects/Older"]);
  });

  it("ranks recent empty workspaces against session groups by recency", () => {
    const groups = groupSessionsByWorkspace(
      [session({ id: "one", path: "one.jsonl", workspace: "C:/Projects/Used", title: "标题", modifiedAt: 20 })],
      "",
      [
        { path: "C:/Projects/Used", openedAt: 10 },
        { path: "C:/Projects/Fresh", openedAt: 50 }
      ],
      "C:/Projects/Fresh"
    );

    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Fresh", "C:/Projects/Used"]);
  });

  it("adds an active workspace that is missing from recents", () => {
    const groups = groupSessionsByWorkspace([], "", [
      { path: "C:/Projects/Older", openedAt: 30 }
    ], "C:/Projects/Active");

    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Active", "C:/Projects/Older"]);
    expect(groups[0]?.sessions).toEqual([]);
  });

  it("hides a workspace removed from recents even when it still has sessions (non-destructive forget)", () => {
    const groups = groupSessionsByWorkspace(
      [session({ id: "kept", path: "kept.jsonl", workspace: "C:/Projects/Kept", title: "保留" }),
       session({ id: "forgotten", path: "forgotten.jsonl", workspace: "C:/Projects/Forgotten", title: "从列表移除但会话仍在" })],
      "",
      [{ path: "C:/Projects/Kept", openedAt: 20 }],
      "C:/Projects/Kept"
    );
    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Kept"]);
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["kept"]);
  });

  it("does not duplicate a workspace already covered by a session group", () => {
    const groups = groupSessionsByWorkspace(
      [session({ id: "one", path: "one.jsonl", workspace: "C:/Projects/PiDesktop", title: "标题", modifiedAt: 20 })],
      "",
      [{ path: "C:/Projects/PiDesktop", openedAt: 50 }]
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions).toHaveLength(1);
  });

  it("filters every empty workspace by the search query", () => {
    const groups = groupSessionsByWorkspace([], "fresh", [
      { path: "C:/Projects/Other", openedAt: 20 },
      { path: "C:/Projects/Fresh", openedAt: 10 }
    ], "C:/Projects/Other");

    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Fresh"]);
  });

  it("carries missing from RecentWorkspace to empty and non-empty groups", () => {
    const groups = groupSessionsByWorkspace(
      [session({ id: "one", path: "one.jsonl", workspace: "C:/Projects/Gone", title: "历史", modifiedAt: 5 })],
      "",
      [{ path: "C:/Projects/Gone", openedAt: 10, missing: true }]
    );

    expect(groups[0]?.missing).toBe(true);
    const empty = groupSessionsByWorkspace([], "", [{ path: "C:/Projects/EmptyGone", openedAt: 10, missing: true }]);
    expect(empty[0]?.missing).toBe(true);
  });
});

describe("workspaceDisplayLabel", () => {
  it("returns the basename when it is unique", () => {
    expect(workspaceDisplayLabel("C:\\Projects\\PiDesktop", ["C:\\Projects\\PiDesktop", "C:\\Projects\\Other"])).toBe("PiDesktop");
  });

  it("appends parent folders when basenames collide", () => {
    const paths = ["C:\\Projects\\Alpha\\src", "D:\\Work\\Beta\\src", "C:\\Projects\\Unique"];
    expect(workspaceDisplayLabel(paths[0]!, paths)).toBe("Alpha\\src");
    expect(workspaceDisplayLabel(paths[1]!, paths)).toBe("Beta\\src");
    expect(workspaceDisplayLabel(paths[2]!, paths)).toBe("Unique");
  });

  it("keeps adding parents until the label is unique", () => {
    const paths = ["C:/root/one/shared/src", "C:/root/two/shared/src"];
    expect(workspaceDisplayLabel(paths[0]!, paths)).toBe("one/shared/src");
    expect(workspaceDisplayLabel(paths[1]!, paths)).toBe("two/shared/src");
  });

  it("falls back to a basename when allPaths is omitted", () => {
    expect(workspaceDisplayLabel("C:/Projects/PiDesktop")).toBe("PiDesktop");
  });
});
