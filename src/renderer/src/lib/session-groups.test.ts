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
});
