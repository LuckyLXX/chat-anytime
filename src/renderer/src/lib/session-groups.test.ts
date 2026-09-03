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

  it("shows only the active workspace when it has no session yet", () => {
    // 空工作区只在它是当前激活工作区时显示（刚打开还没建话题的项目）。歷史空工作区不再全部上屏。
    const groups = groupSessionsByWorkspace([], "", [
      { path: "C:/Projects/Older", openedAt: 30 },
      { path: "C:\\Projects\\Fresh", openedAt: 40 }
    ], "c:/projects/fresh");

    expect(groups.map((group) => group.workspace)).toEqual(["C:\\Projects\\Fresh"]);
    expect(groups[0]?.sessions).toEqual([]);
  });

  it("shows no empty workspace group when none is active (fresh assistant)", () => {
    // 新建助手：无会话 + 无激活工作区 → 话题栏应为空，而不是列出全局历史工作区。
    expect(groupSessionsByWorkspace([], "", [
      { path: "C:/Projects/Older", openedAt: 30 },
      { path: "C:/Projects/Fresh", openedAt: 40 }
    ])).toEqual([]);
  });

  it("ranks the active empty workspace against session groups by recency", () => {
    const groups = groupSessionsByWorkspace(
      [{ id: "one", path: "one.jsonl", workspace: "C:/Projects/Used", title: "标题", modifiedAt: 20, messageCount: 1 }],
      "",
      [
        { path: "C:/Projects/Used", openedAt: 10 },
        { path: "C:/Projects/Fresh", openedAt: 50 }
      ],
      "C:/Projects/Fresh"
    );

    // The freshly opened empty workspace ranks above the used one.
    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Fresh", "C:/Projects/Used"]);
  });

  it("hides a session-less workspace that is not the active one", () => {
    const groups = groupSessionsByWorkspace(
      [{ id: "one", path: "one.jsonl", workspace: "C:/Projects/Used", title: "标题", modifiedAt: 20, messageCount: 1 }],
      "",
      [
        { path: "C:/Projects/Used", openedAt: 10 },
        { path: "C:/Projects/Fresh", openedAt: 50 }
      ],
      "C:/Projects/Used"
    );

    // Fresh 已不在使用（无会话且非激活）→ 不再显示。
    expect(groups.map((group) => group.workspace)).toEqual(["C:/Projects/Used"]);
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

  it("filters the active empty workspace by search query", () => {
    const groups = groupSessionsByWorkspace([], "fresh", [
      { path: "C:/Projects/Other", openedAt: 20 },
      { path: "C:/Projects/Fresh", openedAt: 10 }
    ], "C:/Projects/Other");

    // 激活的是 Other，但搜索词只匹配 Fresh：空工作区要么非激活不显示，要么激活但搜不到。
    expect(groups).toEqual([]);
  });
});
