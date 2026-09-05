import { describe, expect, it } from "vitest";
import {
  applyDesignOps,
  cloneNodeWithNewIds,
  countNodes,
  createDesignDoc,
  findNode,
  indexNodes,
  makeNodeId,
  MAX_DESIGN_NODES,
  normalizeDesignDoc,
  normalizeDesignNode,
  sanitizeDesignName,
  summarizeNode,
  type DesignDoc,
  type DesignNode,
  type DesignOp
} from "./design-schema.js";

function frame(partial: Partial<DesignNode> & { id: string; children?: DesignNode[] }): DesignNode {
  return { type: "frame", x: 0, y: 0, w: 100, h: 100, ...partial };
}

function textNode(id: string, text: string, partial: Partial<DesignNode> = {}): DesignNode {
  return { type: "text", id, x: 0, y: 0, w: 80, h: 24, text, ...partial };
}

function sampleDoc(): DesignDoc {
  return {
    version: 1,
    id: "doc-1",
    name: "示例",
    canvas: { width: 1440, height: 1024 },
    nodes: [
      frame({
        id: "root",
        name: "登录卡片",
        x: 100,
        y: 80,
        w: 360,
        h: 280,
        layout: { direction: "column", gap: 12, padding: 24 },
        children: [textNode("title", "登录", { fontSize: 24 }), { type: "rect", id: "btn", x: 0, y: 0, w: 120, h: 40, fill: "#2563eb", radius: 8 }]
      }),
      textNode("loose", "游离文本", { x: 500, y: 100 })
    ],
    revision: 3
  };
}

describe("normalizeDesignDoc / normalizeDesignNode", () => {
  it("根不是对象时返回 undefined", () => {
    expect(normalizeDesignDoc(undefined)).toBeUndefined();
    expect(normalizeDesignDoc("nope")).toBeUndefined();
    expect(normalizeDesignDoc([1, 2])).toBeUndefined();
  });

  it("补缺失 id / version / revision，几何 clamp", () => {
    const doc = normalizeDesignDoc({
      name: "测试",
      canvas: { width: 99999999, height: -5 },
      nodes: [{ type: "rect", w: 0, h: "abc" }]
    });
    expect(doc).toBeDefined();
    expect(doc!.version).toBe(1);
    expect(doc!.id).toBeTruthy();
    expect(doc!.revision).toBe(1);
    expect(doc!.canvas.width).toBeLessThanOrEqual(100_000);
    expect(doc!.canvas.height).toBeGreaterThanOrEqual(1);
    expect(doc!.nodes).toHaveLength(1);
    const node = doc!.nodes[0]!;
    expect(node.id).toBeTruthy();
    expect(node.w).toBeGreaterThanOrEqual(1);
  });

  it("丢非法类型节点，children 只保留在 frame 上", () => {
    const node = normalizeDesignNode(
      { type: "rect", id: "r1", children: [{ type: "text", text: "孤儿" }] },
      { count: 0 }
    );
    expect(node).toBeDefined();
    expect(node!.children).toBeUndefined();
    expect(normalizeDesignNode({ type: "spinach" }, { count: 0 })).toBeUndefined();
    expect(normalizeDesignNode(null, { count: 0 })).toBeUndefined();
  });

  it("frame 保留 layout 与 children，数值字段夹取", () => {
    const node = normalizeDesignNode(
      {
        type: "frame",
        id: "f",
        x: "12.4",
        y: -3,
        layout: { direction: "column", gap: 8, padding: { top: 10, bottom: "x" }, justify: "space-between", align: "hacker" },
        children: [{ type: "text", text: "hi", fontSize: 9999, opacity: 7 }]
      },
      { count: 0 }
    );
    expect(node!.layout).toEqual({ direction: "column", gap: 8, padding: { top: 10 }, justify: "space-between" });
    expect(node!.children).toHaveLength(1);
    const child = node!.children![0]!;
    expect(child.fontSize).toBeLessThanOrEqual(400);
    expect(child.opacity).toBeUndefined(); // opacity >= 1 时删除字段
    expect(child.x).toBe(0);
  });

  it("image src 只接受 http(s)/data URL", () => {
    const ok = normalizeDesignNode({ type: "image", src: "https://a.example/x.png" }, { count: 0 });
    expect(ok!.src).toBe("https://a.example/x.png");
    const data = normalizeDesignNode({ type: "image", src: "data:image/png;base64,AAAA" }, { count: 0 });
    expect(data!.src).toBe("data:image/png;base64,AAAA");
    const bad = normalizeDesignNode({ type: "image", src: "file:///C:/x.png" }, { count: 0 });
    expect(bad!.src).toBeUndefined();
  });

  it("节点数超上限截断", () => {
    const nodes = Array.from({ length: MAX_DESIGN_NODES + 10 }, (_, index) => ({ type: "rect", id: `r${index}` }));
    const doc = normalizeDesignDoc({ name: "big", nodes });
    expect(doc!.nodes).toHaveLength(MAX_DESIGN_NODES);
  });

  it("sanitizeDesignName 净化文件名非法字符", () => {
    expect(sanitizeDesignName("a<b>:c/d")).toBe("a-b--c-d");
    expect(sanitizeDesignName("")).toBe("未命名设计");
    expect(sanitizeDesignName(undefined, "fallback")).toBe("fallback");
  });
});

describe("findNode / countNodes / cloneNodeWithNewIds", () => {
  it("findNode 返回节点与活引用（含父子）", () => {
    const doc = sampleDoc();
    const found = findNode(doc.nodes, "btn");
    expect(found).toBeDefined();
    expect(found!.node.fill).toBe("#2563eb");
    expect(found!.parent!.id).toBe("root");
    expect(found!.siblings).toBe(found!.parent!.children);
    const loose = findNode(doc.nodes, "loose");
    expect(loose!.parent).toBeUndefined();
    expect(loose!.siblings).toBe(doc.nodes);
  });

  it("findNode 对深层节点的 parent 是直接父而非顶层祖先", () => {
    const doc = sampleDoc();
    const deep: DesignDoc = { ...doc, nodes: [frame({ id: "r", children: [frame({ id: "a", children: [{ type: "rect", id: "b", x: 0, y: 0, w: 5, h: 5 }] })] })] };
    const found = findNode(deep.nodes, "b");
    expect(found!.parent!.id).toBe("a");
    expect(found!.siblings).toBe(found!.parent!.children);
  });

  it("countNodes 统计整棵树", () => {
    const doc = sampleDoc();
    expect(countNodes(doc.nodes)).toBe(4);
  });

  it("cloneNodeWithNewIds 深拷贝且全部换新 id", () => {
    const root = sampleDoc().nodes[0]!;
    const clone = cloneNodeWithNewIds(root);
    expect(clone.id).not.toBe(root.id);
    expect(clone.children![0]!.id).not.toBe(root.children![0]!.id);
    expect(clone.children![0]!.text).toBe(root.children![0]!.text);
    expect(JSON.stringify(clone)).not.toContain(root.children![0]!.id);
  });

  it("makeNodeId 唯一性（抽样）", () => {
    const ids = new Set(Array.from({ length: 200 }, () => makeNodeId()));
    expect(ids.size).toBe(200);
  });
});

describe("applyDesignOps", () => {
  it("空 ops / 非数组拒绝", () => {
    const doc = sampleDoc();
    const result = applyDesignOps(doc, []);
    expect(result.ok).toBe(false);
  });

  it("create 到根与到 frame 父（含 index 与 id 冲突检测）", () => {
    const doc = sampleDoc();
    const created: DesignNode = { type: "rect", id: "new-1", x: 1, y: 2, w: 30, h: 20 };
    const ok = applyDesignOps(doc, [
      { op: "create", node: created },
      { op: "create", parentId: "root", index: 0, node: { type: "text", id: "new-2", text: "标题" } }
    ]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.doc.nodes.at(-1)!.id).toBe("new-1");
    expect(findNode(ok.doc.nodes, "root")!.node.children![0]!.id).toBe("new-2");
    const duplicate = applyDesignOps(doc, [{ op: "create", node: created }, { op: "create", node: { type: "rect", id: "new-1" } }]);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.ok ? "" : duplicate.error).toContain("new-1");
  });

  it("create 到非 frame 父拒绝", () => {
    const result = applyDesignOps(sampleDoc(), [{ op: "create", parentId: "btn", node: { type: "rect" } }]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("frame");
  });

  it("update 应用 patch 且拒绝改 id/type/children", () => {
    const ok = applyDesignOps(sampleDoc(), [{ op: "update", id: "btn", patch: { fill: "#f00", x: 42, name: "按钮" } }]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const btn = findNode(ok.doc.nodes, "btn")!.node;
    expect(btn.fill).toBe("#f00");
    expect(btn.x).toBe(42);
    expect(btn.name).toBe("按钮");
    const bad = applyDesignOps(sampleDoc(), [{ op: "update", id: "btn", patch: { children: [] } as never }]);
    expect(bad.ok).toBe(false);
    const missing = applyDesignOps(sampleDoc(), [{ op: "update", id: "ghost", patch: { x: 1 } }]);
    expect(missing.ok).toBe(false);
  });

  it("update 可添加/修改/删除 layout", () => {
    const add = applyDesignOps(sampleDoc(), [{ op: "update", id: "btn", patch: { layout: { direction: "column", gap: 4 } } }]);
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect(findNode(add.doc.nodes, "btn")!.node.layout).toEqual({ direction: "column", gap: 4 });
    const remove = applyDesignOps(add.doc, [{ op: "update", id: "btn", patch: { layout: undefined } }]);
    expect(remove.ok).toBe(true);
    if (!remove.ok) return;
    expect(findNode(remove.doc.nodes, "btn")!.node.layout).toBeUndefined();
    // 非法 justify 被丢弃。
    const invalid = applyDesignOps(sampleDoc(), [{ op: "update", id: "btn", patch: { layout: { direction: "row", justify: "hacker" } } }]);
    expect(invalid.ok).toBe(true);
    if (!invalid.ok) return;
    expect(findNode(invalid.doc.nodes, "btn")!.node.layout).toEqual({ direction: "row" });
  });

  it("create/replace 拒绝子树内重复或与现有文档冲突的 id", () => {
    const duplicateSubtree = applyDesignOps(sampleDoc(), [{
      op: "create",
      node: { type: "frame", id: "new-frame", children: [{ type: "rect", id: "dup", x: 0, y: 0, w: 1, h: 1 }, { type: "rect", id: "dup", x: 0, y: 0, w: 1, h: 1 }] }
    }]);
    expect(duplicateSubtree.ok).toBe(false);
    expect(duplicateSubtree.ok ? "" : duplicateSubtree.error).toContain("子树内 id 重复");
    const conflict = applyDesignOps(sampleDoc(), [{ op: "create", node: { type: "rect", id: "btn", x: 0, y: 0, w: 1, h: 1 } }]);
    expect(conflict.ok).toBe(false);
    expect(conflict.ok ? "" : conflict.error).toContain("id 已存在");
    const replaceDuplicate = applyDesignOps(sampleDoc(), [{ op: "replace", nodes: [{ type: "frame", id: "r", children: [{ type: "rect", id: "r", x: 0, y: 0, w: 1, h: 1 }] }] }]);
    expect(replaceDuplicate.ok).toBe(false);
  });

  it("delete 删除子树", () => {
    const result = applyDesignOps(sampleDoc(), [{ op: "delete", id: "root" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findNode(result.doc.nodes, "root")).toBeUndefined();
    expect(findNode(result.doc.nodes, "btn")).toBeUndefined();
    expect(countNodes(result.doc.nodes)).toBe(1);
  });

  it("move 换父与排序，移动到自己子树内拒绝", () => {
    const ok = applyDesignOps(sampleDoc(), [{ op: "move", id: "loose", parentId: "root", index: 0 }]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(findNode(ok.doc.nodes, "root")!.node.children![0]!.id).toBe("loose");
    expect(findNode(ok.doc.nodes, "loose")!.parent!.id).toBe("root");
    const cycle = applyDesignOps(sampleDoc(), [{ op: "move", id: "root", parentId: "btn" }]);
    expect(cycle.ok).toBe(false);
    const self = applyDesignOps(sampleDoc(), [{ op: "move", id: "root", parentId: "root" }]);
    expect(self.ok).toBe(false);
  });

  it("replace 整树替换并 normalize", () => {
    const result = applyDesignOps(sampleDoc(), [{ op: "replace", nodes: [{ type: "text", text: "全新" }] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.nodes).toHaveLength(1);
    expect(result.doc.nodes[0]!.text).toBe("全新");
    expect(result.doc.nodes[0]!.id).toBeTruthy();
  });

  it("原子性：第二个 op 失败时整批拒绝，原文档不变", () => {
    const doc = sampleDoc();
    const result = applyDesignOps(doc, [
      { op: "update", id: "btn", patch: { fill: "#0f0" } },
      { op: "delete", id: "ghost" }
    ]);
    expect(result.ok).toBe(false);
    // 原文档未被半应用（不改动入参）。
    expect(findNode(doc.nodes, "btn")!.node.fill).toBe("#2563eb");
  });

  it("update patch 字符串数字容错", () => {
    const result = applyDesignOps(sampleDoc(), [{ op: "update", id: "btn", patch: { x: "33.7", h: -5 } as never }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const btn = findNode(result.doc.nodes, "btn")!.node;
    expect(btn.x).toBe(33.7);
    expect(btn.h).toBe(1);
  });
});

describe("createDesignDoc / indexNodes / summarizeNode", () => {
  it("createDesignDoc 生成空文档并 clamp 画布", () => {
    const doc = createDesignDoc("登录页", 800, 600);
    expect(doc.version).toBe(1);
    expect(doc.name).toBe("登录页");
    expect(doc.canvas).toEqual({ width: 800, height: 600 });
    expect(doc.nodes).toEqual([]);
    expect(doc.revision).toBe(1);
    expect(createDesignDoc("", 0, 0).canvas.width).toBe(1);
  });

  it("indexNodes 收集全部节点", () => {
    const doc = sampleDoc();
    const map = indexNodes(doc.nodes);
    expect(map.get("btn")!.fill).toBe("#2563eb");
    expect(map.get("loose")).toBeDefined();
    expect(map.size).toBe(4);
  });

  it("summarizeNode 输出紧凑 JSON（剔除冗余字段，text 截断）", () => {
    const root = sampleDoc().nodes[0]!;
    const summary = summarizeNode(root);
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(parsed.type).toBe("frame");
    expect(Array.isArray(parsed.children)).toBe(true);
    const title = (parsed.children as Record<string, unknown>[])[0]!;
    expect(title.text).toBe("登录");
    expect(parsed.visible).toBeUndefined();
    const long = textNode("t", "字".repeat(500));
    const parsedLong = JSON.parse(summarizeNode(long)) as { text: string };
    expect(parsedLong.text.length).toBeLessThanOrEqual(301);
  });
});
