import { describe, expect, it } from "vitest";
import { filterPaletteActions, groupPaletteActions, PALETTE_GROUP_ORDER, type PaletteAction } from "./command-palette";

const noop = (): void => undefined;

function action(overrides: Partial<PaletteAction> & { id: string; title: string; group: string }): PaletteAction {
  return { run: noop, ...overrides };
}

const actions: PaletteAction[] = [
  action({ id: "new", title: "新建话题", group: "会话", keywords: "new chat" }),
  action({ id: "search", title: "搜索会话内容", group: "会话", keywords: "search find" }),
  action({ id: "model-a", title: "切换模型：Claude Opus", group: "模型", keywords: "model claude" }),
  action({ id: "model-b", title: "切换模型：GPT-5", group: "模型", keywords: "model gpt" }),
  action({ id: "theme", title: "主题：深色", group: "主题", keywords: "theme dark" }),
  action({ id: "custom", title: "自定义动作", group: "未来分组" })
];

describe("filterPaletteActions", () => {
  it("returns everything (up to the limit) for an empty query", () => {
    expect(filterPaletteActions(actions, "   ").map((item) => item.id)).toEqual(actions.map((item) => item.id));
    expect(filterPaletteActions(actions, "", 2)).toHaveLength(2);
  });

  it("matches titles, keywords and groups", () => {
    expect(filterPaletteActions(actions, "新建").map((item) => item.id)).toEqual(["new"]);
    expect(filterPaletteActions(actions, "claude").map((item) => item.id)).toEqual(["model-a"]);
    expect(filterPaletteActions(actions, "主题").map((item) => item.id)).toEqual(["theme"]);
  });

  it("requires every whitespace-separated term", () => {
    expect(filterPaletteActions(actions, "切换 模型").map((item) => item.id)).toEqual(["model-a", "model-b"]);
    expect(filterPaletteActions(actions, "切换 深色")).toEqual([]);
  });

  it("ranks exact and prefix title matches above keyword-only matches", () => {
    const list = [
      action({ id: "keyword", title: "别的动作", group: "其他", keywords: "部署" }),
      action({ id: "contains", title: "重新部署", group: "其他" }),
      action({ id: "prefix", title: "部署清单", group: "其他" }),
      action({ id: "exact", title: "部署", group: "其他" })
    ];
    expect(filterPaletteActions(list, "部署").map((item) => item.id)).toEqual(["exact", "prefix", "contains", "keyword"]);
  });

  it("is case- and width-insensitive", () => {
    expect(filterPaletteActions(actions, "ＧＰＴ").map((item) => item.id)).toEqual(["model-b"]);
    expect(filterPaletteActions(actions, "CLAUDE").map((item) => item.id)).toEqual(["model-a"]);
  });
});

describe("groupPaletteActions", () => {
  it("uses the fixed group order and appends unknown groups last", () => {
    const groups = groupPaletteActions(actions);
    expect(groups.map((group) => group.title)).toEqual(["会话", "模型", "主题", "未来分组"]);
    // 命令面板不再提供思考等级切换（2026-10-27 用户要求）：分组顺序里也没有「思考」。
    expect(PALETTE_GROUP_ORDER.slice(0, 3)).toEqual(["会话", "模型", "权限"]);
    expect(groups[0]?.actions.map((item) => item.id)).toEqual(["new", "search"]);
  });

  it("keeps the action order inside a group", () => {
    const groups = groupPaletteActions([action({ id: "b", title: "B", group: "会话" }), action({ id: "a", title: "A", group: "会话" })]);
    expect(groups[0]?.actions.map((item) => item.id)).toEqual(["b", "a"]);
  });
});
