import { describe, expect, it } from "vitest";
import type { JevObserveItem, JevObservePage } from "../shared/protocol.js";
import {
  buildActionSpace,
  buildJevRequest,
  resolveDecision,
  selectTargetKey,
  validateChoice
} from "./jev-action-space.js";

function item(overrides: Partial<JevObserveItem> & { nodeId: number; role: string }): JevObserveItem {
  return { label: `元素${overrides.nodeId}`, sig: `sig-${overrides.nodeId}`, x: 10, y: 20, ...overrides };
}

function page(items: JevObserveItem[], scroll: Partial<JevObservePage["scroll"]> = {}): JevObservePage {
  return { url: "https://example.com/", title: "示例", pageText: "页面文本", items, scroll: { y: 0, height: 1000, viewH: 800, canDown: true, ...scroll } };
}

const choice = (keys: string[], selected: string) => ({
  choice: selected,
  confidence: 1,
  probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0]))
});

describe("jev action space", () => {
  it("gives one index per element even when it supports several operations", () => {
    const space = buildActionSpace(page([
      item({ nodeId: 7, role: "textbox", editable: true, label: "搜索" })
    ]));
    expect(space.elements).toHaveLength(1);
    expect(space.elements[0]!.index).toBe("1");
    // 一个元素同时出现在 CLICK 与 TYPE_TEXT 的候选里，但只占一个索引——
    // 这正是 jev「一个节点一个索引、操作各自的 target head」的取舍。
    expect(Object.keys(space.targets.CLICK!)).toEqual(["1"]);
    expect(Object.keys(space.targets.TYPE_TEXT!)).toEqual(["1"]);
    expect(space.elements[0]!.operations).toEqual(["TYPE_TEXT", "CLICK"]);
  });

  it("does not offer TYPE_TEXT for a plain button", () => {
    const space = buildActionSpace(page([item({ nodeId: 3, role: "button", label: "提交" })]));
    expect(space.targets.TYPE_TEXT).toBeUndefined();
    expect(space.elements[0]!.operations).toEqual(["CLICK"]);
  });

  it("expands a select into one target per option with an index:option key", () => {
    const space = buildActionSpace(page([
      item({ nodeId: 9, role: "combobox", label: "城市", value: "上海", options: [
        { index: "e1:1", label: "北京", value: "bj" },
        { index: "e1:2", label: "广州", value: "gz" }
      ] })
    ]));
    expect(Object.keys(space.targets.SELECT!).sort()).toEqual([selectTargetKey(1, 1), selectTargetKey(1, 2)].sort());
    expect(space.targets.SELECT![selectTargetKey(1, 2)]!.action).toEqual({ kind: "select", optionIndex: 2 });
    expect(space.targets.SELECT![selectTargetKey(1, 1)]!.label).toContain("北京");
  });

  it("keeps an obstructed element out of every target head", () => {
    const space = buildActionSpace(page([
      item({ nodeId: 4, role: "button", label: "被盖住的按钮", obstructedBy: "div.mask" })
    ]));
    // 元素仍在表里（模型看得到它、也知道它被挡住），但没有可执行目标：
    // 给它目标只会白烧一次模型往返，执行阶段必定被拒。
    expect(space.elements).toHaveLength(1);
    expect(space.targets.CLICK).toBeUndefined();
  });

  it("offers scroll operations from the observed scroll state", () => {
    expect(buildActionSpace(page([item({ nodeId: 1, role: "button" })], { y: 0 })).operations.SCROLL_UP).toBeUndefined();
    const down = buildActionSpace(page([item({ nodeId: 1, role: "button" })], { y: 200, canDown: true }));
    expect(down.operations.SCROLL_UP).toBeDefined();
    expect(down.operations.SCROLL_DOWN).toBeDefined();
    // viewH 缺失也不能把「已在底部」误判成可下滚：判据只看页面侧算好的 canDown。
    const noView = buildActionSpace({ ...page([item({ nodeId: 1, role: "button" })]), scroll: { y: 200, height: 1000, canDown: false } });
    expect(noView.operations.SCROLL_DOWN).toBeUndefined();
    const bottom = buildActionSpace(page([item({ nodeId: 1, role: "button" })], { y: 200, canDown: false }));
    expect(bottom.operations.SCROLL_DOWN).toBeUndefined();
  });

  it("always offers WAIT / DONE / BLOCKED", () => {
    const space = buildActionSpace(page([]));
    expect(space.operations.WAIT).toBeDefined();
    expect(space.operations.DONE).toBeDefined();
    expect(space.operations.BLOCKED).toBeDefined();
  });
});

describe("jev choice validation", () => {
  const ids = ["a", "b"];

  it("accepts a well-formed choice", () => {
    expect(validateChoice(choice(ids, "a"), ids).choice).toBe("a");
  });

  it.each([
    ["unknown 选项", { choice: "invented", confidence: 1, probabilities: { a: 1, b: 0 } }],
    ["NaN 概率", { choice: "a", confidence: 1, probabilities: { a: Number.NaN, b: 0 } }],
    ["缺一个概率键", { choice: "a", confidence: 1, probabilities: { a: 1 } }],
    ["负概率", { choice: "a", confidence: 1, probabilities: { a: 1, b: -1 } }],
    ["choice 不是最大概率项", { choice: "b", confidence: 1, probabilities: { a: 1, b: 0 } }],
    ["confidence 越界", { choice: "a", confidence: 5, probabilities: { a: 1, b: 0 } }],
    ["概率和不为 1", { choice: "a", confidence: 1, probabilities: { a: 0.5, b: 0.1 } }],
    ["不是对象", "nope"]
  ])("rejects %s", (_label, answer) => {
    // 无效响应必须**抛错**：调用方让异常终止本次操作，绝不拿可疑决策去点页面。
    expect(() => validateChoice(answer, ids)).toThrow(/无效的选择/);
  });
});

describe("jev decision resolution", () => {
  const withButton = () => buildActionSpace(page([item({ nodeId: 11, role: "button", label: "搜索" })]));

  it("consumes only the head of the selected operation", () => {
    const space = withButton();
    const answers = {
      operation: choice(Object.keys(space.operations), "CLICK"),
      // 一个形状完全错误的 text 头：选中 CLICK 时它必须被忽略（jev 同款取舍）。
      click_target: choice(Object.keys(space.targets.CLICK!), "1")
    };
    const decision = resolveDecision(answers, space);
    expect(decision.operation).toBe("CLICK");
    expect(decision.target!.nodeId).toBe(11);
    expect(decision.target!.action).toEqual({ kind: "click" });
  });

  it("rejects a response that selected an operation without a usable head", () => {
    const space = withButton();
    const answers = {
      operation: choice(Object.keys(space.operations), "TYPE_TEXT"),
      click_target: choice(["1"], "1")
    };
    // 页面没有可编辑元素 → TYPE_TEXT 不在 operations 里，选它本身就是非法响应。
    expect(() => resolveDecision(answers, space)).toThrow(/无效的选择/);
  });

  it("maps scroll / wait / terminal operations", () => {
    const space = buildActionSpace(page([item({ nodeId: 1, role: "button" })], { y: 100, canDown: true }));
    const ids = Object.keys(space.operations);
    expect(resolveDecision({ operation: choice(ids, "SCROLL_DOWN") }, space).scroll).toBe(1);
    expect(resolveDecision({ operation: choice(ids, "SCROLL_UP") }, space).scroll).toBe(-1);
    expect(resolveDecision({ operation: choice(ids, "WAIT") }, space).wait).toBe(true);
    expect(resolveDecision({ operation: choice(ids, "DONE") }, space).terminal).toBe("DONE");
    expect(resolveDecision({ operation: choice(ids, "BLOCKED") }, space).terminal).toBe("BLOCKED");
  });

  it("rejects a missing target head for a targeted operation", () => {
    const space = withButton();
    const answers = { operation: choice(Object.keys(space.operations), "CLICK") };
    expect(() => resolveDecision(answers, space)).toThrow(/无效的选择/);
  });
});

describe("jev request shape", () => {
  it("asks every target head in one request and keeps the goal with the rules", () => {
    const space = buildActionSpace(page([
      item({ nodeId: 1, role: "textbox", editable: true, label: "起点" }),
      item({ nodeId: 2, role: "button", label: "搜索" })
    ]));
    const body = buildJevRequest("从北京到上海", page([item({ nodeId: 1, role: "textbox", editable: true })]), space, [{ action: "点击", kind: "click" }]);
    expect(Object.keys(body.questions).sort()).toEqual(["click_target", "operation", "type_text_target"]);
    const operation = body.questions.operation as { criteria: Record<string, string>; instructions: { goal: string; rules: string } };
    expect(operation.instructions.goal).toBe("从北京到上海");
    expect(operation.instructions.rules).toContain("不可信数据");
    // 每个 target head 都必须带同一套「下一步」规则 + 目标规则（jev 的做法）。
    const head = body.questions.click_target as { instructions: { rules: string[] } };
    expect(head.instructions.rules).toHaveLength(2);
    expect(JSON.stringify(body.state)).toContain("recent_actions");
  });
});
