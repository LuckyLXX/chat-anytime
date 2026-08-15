import { describe, expect, it } from "vitest";
import { groupSessionsByWorkspace } from "./session-groups";

describe("session workspace groups", () => {
  it("groups sessions by workspace and keeps each group newest first", () => {
    const groups = groupSessionsByWorkspace([
      { id: "old", path: "old.jsonl", workspace: "C:\\Projects\\PiDesktop", title: "旧话题", modifiedAt: 10, messageCount: 1 },
      { id: "new", path: "new.jsonl", workspace: "C:/Projects/PiDesktop", title: "新话题", modifiedAt: 30, messageCount: 2 },
      { id: "other", path: "other.jsonl", workspace: "C:/Projects/Other", title: "另一个话题", modifiedAt: 20, messageCount: 3 }
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.workspace).toBe("C:\\Projects\\PiDesktop");
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["new", "old"]);
  });

  it("searches both topic titles and workspace names", () => {
    expect(groupSessionsByWorkspace([
      { id: "one", path: "one.jsonl", workspace: "C:/Projects/PiDesktop", title: "检查渲染", modifiedAt: 1, messageCount: 1 },
      { id: "two", path: "two.jsonl", workspace: "C:/Projects/Other", title: "其他", modifiedAt: 2, messageCount: 1 }
    ], "pidesktop").flatMap((group) => group.sessions.map((session) => session.id))).toEqual(["one"]);
  });

  it("pins sessions to the top of their group regardless of modified time", () => {
    const groups = groupSessionsByWorkspace([
      { id: "fresh", path: "fresh.jsonl", workspace: "C:/Projects/PiDesktop", title: "最新", modifiedAt: 30, messageCount: 1 },
      { id: "starred", path: "starred.jsonl", workspace: "C:/Projects/PiDesktop", title: "置顶", modifiedAt: 5, messageCount: 1, pinned: true },
      { id: "mid", path: "mid.jsonl", workspace: "C:/Projects/PiDesktop", title: "中间", modifiedAt: 20, messageCount: 1 }
    ]);

    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["starred", "fresh", "mid"]);
  });

  it("shows recently opened workspaces even without any session", () => {
    const groups = groupSessionsByWorkspace([], "", [
      { path: "C:/Projects/Older", openedAt: 30 },
      { path: "C:/Projects/Fresh", openedAt: 40 }
    ]);

    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Fresh", "C:/Projects/Older"]);
    expect(groups[0]?.sessions).toEqual([]);
  });

  it("merges empty workspaces with session groups by recency", () => {
    const groups = groupSessionsByWorkspace(
      [{ id: "one", path: "one.jsonl", workspace: "C:/Projects/Used", title: "标题", modifiedAt: 20, messageCount: 1 }],
      "",
      [
        { path: "C:/Projects/Used", openedAt: 10 },
        { path: "C:/Projects/Fresh", openedAt: 50 }
      ]
    );

    // The freshly opened empty workspace ranks above the used one.
    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Fresh", "C:/Projects/Used"]);
  });

  it("dedupes workspaces already covered by session groups", () => {
    const groups = groupSessionsByWorkspace(
      [{ id: "one", path: "one.jsonl", workspace: "C:/Projects/PiDesktop", title: "标题", modifiedAt: 20, messageCount: 1 }],
      "",
      [{ path: "C:/Projects/PiDesktop", openedAt: 50 }]
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions).toHaveLength(1);
  });

  it("filters empty workspaces by search query", () => {
    const groups = groupSessionsByWorkspace([], "fresh", [
      { path: "C:/Projects/Other", openedAt: 20 },
      { path: "C:/Projects/Fresh", openedAt: 10 }
    ]);

    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Fresh"]);
  });
});
