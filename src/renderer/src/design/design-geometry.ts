/**
 * 设计画布几何工具：绝对坐标展开、包围盒、拖动吸附参考线。纯函数、可单测。
 * 坐标系：节点 x/y 相对父节点；absoluteRects 展开成 world 坐标（画布坐标系）。
 */

import type { DesignNode } from "../../../shared/design-schema.js";

export interface NodeRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 深度优先展开整棵树的 world 坐标（id → 绝对矩形）。 */
export function absoluteRects(nodes: readonly DesignNode[], parentX = 0, parentY = 0, into: Map<string, NodeRect> = new Map()): Map<string, NodeRect> {
  for (const node of nodes) {
    const x = parentX + node.x;
    const y = parentY + node.y;
    into.set(node.id, { id: node.id, x, y, w: node.w, h: node.h });
    if (node.children) absoluteRects(node.children, x, y, into);
  }
  return into;
}

/**
 * 绘图工具落点命中的目标 frame（新建节点的父容器）：包含该点的可见、未锁定
 * frame 中取最深（同点取文档序靠后）的一个；都不命中返回 undefined（落到文档根）。
 */
export function findDropFrameAt(nodes: readonly DesignNode[], worldX: number, worldY: number, parentX = 0, parentY = 0, depth = 0): DesignNode | undefined {
  let best: { node: DesignNode; depth: number; order: number } | undefined;
  let order = 0;
  const visit = (children: readonly DesignNode[], absX: number, absY: number, level: number): void => {
    for (const node of children) {
      const index = order++;
      if (node.visible === false) continue;
      const x = absX + node.x;
      const y = absY + node.y;
      if (node.type === "frame" && !node.locked && worldX >= x && worldX <= x + node.w && worldY >= y && worldY <= y + node.h) {
        // 同深度取文档序靠后（渲染在上层）的 frame。
        if (!best || level >= best.depth) best = { node, depth: level, order: index };
      }
      if (node.children) visit(node.children, x, y, level + 1);
    }
  };
  visit(nodes, parentX, parentY, depth);
  return best?.node;
}

/** 矩形集合的包围盒；空集返回 undefined。 */
export function boundingBox(rects: readonly NodeRect[]): NodeRect | undefined {
  if (rects.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { id: "", x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 吸附参考线（画布上的一条竖/横线段）。 */
export interface SnapGuide {
  axis: "x" | "y";
  /** world 坐标中线段的位置。 */
  value: number;
  /** 线段起点（另一轴）。 */
  start: number;
  /** 线段终点。 */
  end: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

const AXES = ["x", "y"] as const;

/**
 * 拖动吸附：被拖矩形的左/中/右（x 轴）与上/中/下（y 轴）对齐兄弟矩形的
 * 对应线时，把位移吸附到线上（±threshold 内）；返回修正后的位移与参考线。
 */
export function snapDelta(dragged: NodeRect, siblings: readonly NodeRect[], threshold = 6): SnapResult {
  const result: SnapResult = { dx: 0, dy: 0, guides: [] };
  for (const axis of AXES) {
    let best: { delta: number; guide: SnapGuide } | undefined;
    const draggedEdges = axis === "x"
      ? [dragged.x, dragged.x + dragged.w / 2, dragged.x + dragged.w]
      : [dragged.y, dragged.y + dragged.h / 2, dragged.y + dragged.h];
    for (const sibling of siblings) {
      if (sibling.id === dragged.id) continue;
      const edges = axis === "x"
        ? [sibling.x, sibling.x + sibling.w / 2, sibling.x + sibling.w]
        : [sibling.y, sibling.y + sibling.h / 2, sibling.y + sibling.h];
      const start = axis === "x" ? sibling.y : sibling.x;
      const end = axis === "x" ? sibling.y + sibling.h : sibling.x + sibling.w;
      for (const draggedEdge of draggedEdges) {
        for (const edge of edges) {
          const delta = edge - draggedEdge;
          if (Math.abs(delta) > threshold) continue;
          if (best && Math.abs(best.delta) <= Math.abs(delta)) continue;
          best = { delta, guide: { axis, value: edge, start, end } };
        }
      }
    }
    if (best) {
      if (axis === "x") result.dx = best.delta;
      else result.dy = best.delta;
      result.guides.push(best.guide);
    }
  }
  return result;
}
