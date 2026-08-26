import { describe, expect, it } from "vitest";
import {
  addPane,
  clampRatio,
  countLeaves,
  firstLeafId,
  leafIds,
  parseStoredSplitLayout,
  pruneToIds,
  removePane,
  replaceLeaf,
  updateRatio,
  type SplitNode
} from "./split-layout";

const leaf = (sessionId: string): SplitNode => ({ kind: "leaf", sessionId });

describe("addPane", () => {
  it("无树时以焦点会话 + 新会话建根分割", () => {
    const tree = addPane(null, "a", "b", "row");
    expect(tree).toEqual({ kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("b")] });
  });

  it("对焦点叶递归再分割（新会话在右侧/下方 = 第二子树）", () => {
    let tree = addPane(null, "a", "b", "row");
    tree = addPane(tree, "a", "c", "column");
    expect(tree).toEqual({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      children: [
        { kind: "split", direction: "column", ratio: 0.5, children: [leaf("a"), leaf("c")] },
        leaf("b")
      ]
    });
    expect(leafIds(tree)).toEqual(["a", "c", "b"]);
  });

  it("焦点会话不在树中时回退到首个叶子", () => {
    const tree = addPane(leaf("a"), "zzz", "b", "row");
    expect(leafIds(tree)).toEqual(["a", "b"]);
  });
});

describe("removePane", () => {
  it("剪叶后单子塌缩", () => {
    let tree: SplitNode = { kind: "split", direction: "row", ratio: 0.5, children: [{ kind: "split", direction: "column", ratio: 0.5, children: [leaf("a"), leaf("c")] }, leaf("b")] };
    expect(removePane(tree, "c")).toEqual({ kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("b")] });
  });

  it("剪到只剩一个叶子时返回该叶子（退出分屏由调用方判定）", () => {
    const tree: SplitNode = { kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("b")] };
    expect(removePane(tree, "b")).toEqual(leaf("a"));
    expect(removePane(leaf("a"), "a")).toBeNull();
  });

  it("目标不在树中返回原树", () => {
    const tree: SplitNode = { kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("b")] };
    expect(removePane(tree, "zzz")).toEqual(tree);
  });
});

describe("replaceLeaf / updateRatio / pruneToIds", () => {
  it("replaceLeaf 只替换目标叶子", () => {
    const tree: SplitNode = { kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("b")] };
    expect(replaceLeaf(tree, "b", leaf("new"))).toEqual({ kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("new")] });
  });

  it("updateRatio 按路径定位并夹取范围", () => {
    const tree: SplitNode = { kind: "split", direction: "row", ratio: 0.5, children: [{ kind: "split", direction: "column", ratio: 0.5, children: [leaf("a"), leaf("c")] }, leaf("b")] };
    expect(updateRatio(tree, [0], 0.7)).toEqual({ ...tree, ratio: 0.7 });
    expect(updateRatio(tree, [0, 1], 0.05)).toEqual({ ...tree, children: [{ ...tree.children[0], ratio: clampRatio(0.05) }, tree.children[1]] });
    expect(updateRatio(tree, [9], 0.7)).toBe(tree);
  });

  it("pruneToIds 移除全部失效叶子并在仅剩一格时退出", () => {
    let tree: SplitNode = { kind: "split", direction: "row", ratio: 0.5, children: [{ kind: "split", direction: "column", ratio: 0.5, children: [leaf("a"), leaf("c")] }, leaf("b")] };
    expect(pruneToIds(tree, new Set(["a", "b", "c"]))).toEqual({ tree, removed: [] });
    expect(pruneToIds(tree, new Set(["a", "b"]))).toEqual({ tree: { kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("b")] }, removed: ["c"] });
    expect(pruneToIds(tree, new Set(["a"]))).toEqual({ tree: null, removed: ["c", "b"] });
    expect(pruneToIds(tree, new Set())).toEqual({ tree: null, removed: ["a", "c", "b"] });
  });
});

describe("parseStoredSplitLayout", () => {
  it("合法布局往返解析", () => {
    const tree = addPane(addPane(null, "a", "b", "row"), "a", "c", "column");
    const stored = JSON.stringify({ tree, focusedPane: "c" });
    expect(parseStoredSplitLayout(stored)).toEqual({ tree, focusedPane: "c" });
  });

  it("损坏 JSON / 非法结构 / 超上限 / 重复会话全部丢弃", () => {
    expect(parseStoredSplitLayout(null)).toBeUndefined();
    expect(parseStoredSplitLayout("not json")).toBeUndefined();
    expect(parseStoredSplitLayout('{"tree":{"kind":"weird"}}')).toBeUndefined();
    expect(parseStoredSplitLayout('{"tree":{"kind":"leaf","sessionId":"a"}}')).toEqual({ tree: leaf("a"), focusedPane: "a" });
    const five: SplitNode = {
      kind: "split", direction: "row", ratio: 0.5,
      children: [
        { kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("b")] },
        { kind: "split", direction: "row", ratio: 0.5, children: [leaf("c"), leaf("d")] }
      ]
    };
    expect(countLeaves(five)).toBe(4);
    expect(parseStoredSplitLayout(JSON.stringify({ tree: addPane(five, "a", "e", "row") }))).toBeUndefined();
    expect(parseStoredSplitLayout(JSON.stringify({ tree: { kind: "split", direction: "row", ratio: 0.5, children: [leaf("a"), leaf("a")] } }))).toBeUndefined();
  });

  it("focusedPane 缺省取首个叶子", () => {
    expect(parseStoredSplitLayout(JSON.stringify({ tree: { kind: "split", direction: "row", ratio: 0.5, children: [leaf("x"), leaf("y")] } }))).toEqual({ tree: { kind: "split", direction: "row", ratio: 0.5, children: [leaf("x"), leaf("y")] }, focusedPane: "x" });
  });
});

describe("firstLeafId", () => {
  it("深度优先取最左上叶子", () => {
    const tree = addPane(addPane(null, "a", "b", "row"), "a", "c", "column");
    expect(firstLeafId(tree)).toBe("a");
  });
});
