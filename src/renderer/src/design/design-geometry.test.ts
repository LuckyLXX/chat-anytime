import { describe, expect, it } from "vitest";
import { absoluteRects, boundingBox, snapDelta, type NodeRect } from "./design-geometry.js";

function rect(id: string, x: number, y: number, w: number, h: number): NodeRect {
  return { id, x, y, w, h };
}

describe("absoluteRects", () => {
  it("把相对坐标展开成 world 绝对坐标", () => {
    const tree = [
      { type: "frame" as const, id: "root", x: 100, y: 50, w: 200, h: 200, children: [
        { type: "rect" as const, id: "child", x: 10, y: 20, w: 50, h: 40 },
        { type: "frame" as const, id: "mid", x: 0, y: 0, w: 100, h: 100, children: [
          { type: "text" as const, id: "deep", x: 5, y: 5, w: 20, h: 10 }
        ] }
      ] }
    ];
    const map = absoluteRects(tree);
    expect(map.get("root")).toEqual({ id: "root", x: 100, y: 50, w: 200, h: 200 });
    expect(map.get("child")).toEqual({ id: "child", x: 110, y: 70, w: 50, h: 40 });
    expect(map.get("deep")).toEqual({ id: "deep", x: 105, y: 55, w: 20, h: 10 });
  });
});

describe("boundingBox", () => {
  it("空集 undefined；非空取外接矩形", () => {
    expect(boundingBox([])).toBeUndefined();
    const box = boundingBox([rect("a", 0, 0, 10, 10), rect("b", 30, 40, 20, 20)]);
    expect(box).toEqual({ id: "", x: 0, y: 0, w: 50, h: 60 });
  });
});

describe("snapDelta", () => {
  it("边缘 6px 内吸附到兄弟的左/上边缘并产出参考线", () => {
    const siblings = [rect("a", 100, 100, 80, 60)];
    const dragged = rect("d", 95, 200, 50, 40); // 左缘 95 距 a 左缘 100 差 5（y 轴远离无干扰）
    const snap = snapDelta(dragged, siblings, 6);
    expect(snap.dx).toBe(5);
    expect(snap.guides.some((guide) => guide.axis === "x" && guide.value === 100)).toBe(true);
  });

  it("中心线吸附", () => {
    const siblings = [rect("a", 0, 0, 100, 100)];
    // e 中心 52 vs a 中心 50 → 吸回 -2；其余候选边距均超阈值。
    const snap2 = snapDelta(rect("e", 22, 300, 60, 20), siblings, 6);
    expect(snap2.dx).toBe(-2);
    expect(snap2.guides[0]).toMatchObject({ axis: "x", value: 50 });
  });

  it("阈值外不吸附", () => {
    const snap = snapDelta(rect("d", 200, 200, 10, 10), [rect("a", 0, 0, 50, 50)], 6);
    expect(snap.dx).toBe(0);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toHaveLength(0);
  });
});
