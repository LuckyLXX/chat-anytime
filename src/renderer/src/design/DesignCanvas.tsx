import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import { designNodeStyle, designNodeStyleObject, exportDesignHtml } from "../../../shared/design-export.js";
import type { DesignDoc, DesignNode, DesignNodePatch } from "../../../shared/design-schema.js";
import { absoluteRects, snapDelta, type NodeRect, type SnapGuide } from "./design-geometry.js";

/**
 * 设计画布：无限画布（滚轮缩放 5%–400%、空格/中键/空白拖动平移）、节点递归渲染、
 * 点选/拖动（兄弟边缘与中心 6px 吸附 + 参考线）、8 手柄缩放（Shift 等比）、
 * 双击 text 行内编辑。编辑经 onNodePatch 上报（DesignStudio 负责本地应用 +
 * 变更收敛发送），画布本身不持有文档状态。
 */

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
const SNAP_THRESHOLD = 6;
const DRAG_THRESHOLD_PX = 3;

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface DesignCanvasProps {
  doc: DesignDoc;
  zoom: number;
  pan: { x: number; y: number };
  onPanChange(pan: { x: number; y: number }): void;
  onZoomChange(zoom: number, anchor?: { x: number; y: number }): void;
  selectedId: string | undefined;
  onSelect(nodeId: string | undefined): void;
  /** 节点属性变更（拖动/缩放/行内文本）；immediate=true 时调用方应立即收敛发送。 */
  onNodePatch(nodeId: string, patch: DesignNodePatch, immediate?: boolean): void;
  /** 一轮手势（拖动/缩放）结束：调用方 flush 待发送变更。 */
  onGestureEnd(): void;
}

interface WorldPoint {
  x: number;
  y: number;
}

/** 单节点递归渲染（div/img + 内联样式，与导出同构）。 */
const DesignNodeView = memo(function DesignNodeView({ node, onSelect, onDoubleClick }: {
  node: DesignNode;
  onSelect(nodeId: string, event: ReactPointerEvent<HTMLElement>): void;
  onDoubleClick(node: DesignNode): void;
}): ReactNode {
  if (node.visible === false) return null;
  const style = designNodeStyleObject(node);
  const handlers = {
    "data-node-id": node.id,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => onSelect(node.id, event),
    onDoubleClick: () => onDoubleClick(node)
  };
  if (node.type === "image") {
    return <img {...handlers} src={node.src} alt={node.name ?? ""} draggable={false} style={style} />;
  }
  return (
    <div {...handlers} style={style}>
      {node.type === "text" ? node.text : node.children?.map((child) => <DesignNodeView key={child.id} node={child} onSelect={onSelect} onDoubleClick={onDoubleClick} />)}
    </div>
  );
});

const HANDLES: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function DesignCanvas({ doc, zoom, pan, onPanChange, onZoomChange, selectedId, onSelect, onNodePatch, onGestureEnd }: DesignCanvasProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  // 拖动/缩放手势状态（ref 存，避免每帧重渲染）。
  const gesture = useRef<
    | { kind: "pan"; startPan: { x: number; y: number }; start: WorldPoint }
    | { kind: "drag"; id: string; start: WorldPoint; origin: { x: number; y: number }; moved: boolean; rect: NodeRect }
    | { kind: "resize"; id: string; handle: ResizeHandle; start: WorldPoint; origin: NodeRect; proportional: boolean }
    | undefined
  >(undefined);

  const rectsRef = useRef<Map<string, NodeRect>>(new Map());
  rectsRef.current = absoluteRects(doc.nodes);

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.code === "Space" && !isTextInput(document.activeElement)) setSpaceDown(true);
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const toWorld = useCallback((clientX: number, clientY: number): WorldPoint => {
    const rect = containerRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return { x: (clientX - left - pan.x) / zoom, y: (clientY - top - pan.y) / zoom };
  }, [pan, zoom]);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    const anchor = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    onZoomChange(zoom * factor, anchor);
  }, [zoom, onZoomChange]);

  const selectedRect = selectedId ? rectsRef.current.get(selectedId) : undefined;

  const handleNodePointerDown = useCallback((nodeId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (spaceDown || event.button === 1) return; // 空格/中键优先平移
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    onSelect(nodeId);
    const rect = rectsRef.current.get(nodeId);
    const node = findDeep(doc.nodes, nodeId);
    if (!rect || !node) return;
    gesture.current = { kind: "drag", id: nodeId, start: toWorld(event.clientX, event.clientY), origin: { x: node.x, y: node.y }, moved: false, rect };
  }, [spaceDown, doc.nodes, onSelect, toWorld]);

  const handleBackgroundPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (editingId) {
      setEditingId(undefined);
      onGestureEnd();
    }
    gesture.current = { kind: "pan", startPan: pan, start: { x: event.clientX, y: event.clientY } };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!spaceDown && event.button === 0) onSelect(undefined);
  }, [pan, spaceDown, editingId, onGestureEnd, onSelect]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (current.kind === "pan") {
      onPanChange({ x: current.startPan.x + (event.clientX - current.start.x), y: current.startPan.y + (event.clientY - current.start.y) });
      return;
    }
    if (current.kind === "drag") {
      const start = toWorld(event.clientX, event.clientY);
      let dx = start.x - current.start.x;
      let dy = start.y - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) * zoom < DRAG_THRESHOLD_PX) return;
      current.moved = true;
      const dragged: NodeRect = { ...current.rect, x: current.origin.x + dx, y: current.origin.y + dy };
      // 吸附对象 = 同父兄弟（相对坐标同层）；这里用全部矩形近似（父级绝对坐标不同层，
      // 阈值小影响有限）；拖动顶层节点时即是精确兄弟集。
      const siblings = [...rectsRef.current.values()];
      const snap = snapDelta(dragged, siblings, SNAP_THRESHOLD / zoom);
      dx += snap.dx;
      dy += snap.dy;
      setGuides(snap.guides);
      onNodePatch(current.id, { x: round2(current.origin.x + dx), y: round2(current.origin.y + dy) });
      return;
    }
    // resize
    const start = toWorld(event.clientX, event.clientY);
    let dx = start.x - current.start.x;
    let dy = start.y - current.start.y;
    const horizontal = current.handle.includes("e") || current.handle.includes("w");
    const vertical = current.handle.includes("n") || current.handle.includes("s");
    if (current.proportional && horizontal && vertical) {
      // 角手柄 + Shift：锁宽高比。
      dy = dx / (current.origin.w / Math.max(current.origin.h, 1));
    } else if (!horizontal) dx = 0;
    else if (!vertical) dy = 0;
    const origin = current.origin;
    let { x, y, w, h } = origin;
    if (current.handle.includes("e")) w = Math.max(1, origin.w + dx);
    if (current.handle.includes("s")) h = Math.max(1, origin.h + dy);
    if (current.handle.includes("w")) {
      w = Math.max(1, origin.w - dx);
      x = origin.x + (origin.w - w);
    }
    if (current.handle.includes("n")) {
      h = Math.max(1, origin.h - dy);
      y = origin.y + (origin.h - h);
    }
    onNodePatch(current.id, { x: round2(x), y: round2(y), w: round2(w), h: round2(h) });
  }, [gesture, onPanChange, toWorld, zoom, onNodePatch]);

  const handlePointerUp = useCallback(() => {
    const current = gesture.current;
    gesture.current = undefined;
    setGuides([]);
    if (!current) return;
    if (current.kind !== "pan") onGestureEnd();
  }, [onGestureEnd]);

  const startResize = useCallback((handle: ResizeHandle, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectedRect) return;
    event.stopPropagation();
    gesture.current = { kind: "resize", id: selectedRect.id, handle, start: toWorld(event.clientX, event.clientY), origin: selectedRect, proportional: event.shiftKey };
  }, [selectedRect, toWorld]);

  const editingNode = editingId ? findDeep(doc.nodes, editingId) : undefined;
  const editingRect = editingId ? rectsRef.current.get(editingId) : undefined;

  return (
    <div
      ref={containerRef}
      className="design-canvas"
      data-pane="design-canvas"
      style={{
        backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
        ...(spaceDown ? { cursor: "grab" } : {})
      }}
      onWheel={onWheel}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
      onScroll={(event) => event.preventDefault()}
    >
      <div
        className="design-canvas-world"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, width: doc.canvas.width, height: doc.canvas.height, background: doc.canvas.background }}
      >
        {doc.nodes.map((node) => (
          <DesignNodeView key={node.id} node={node} onSelect={handleNodePointerDown} onDoubleClick={(node) => { if (node.type === "text") setEditingId(node.id); }} />
        ))}
        {selectedRect && !editingId && (
          <>
            <div className="design-selection" style={{ left: selectedRect.x, top: selectedRect.y, width: selectedRect.w, height: selectedRect.h, borderWidth: 1 / zoom }} />
            {HANDLES.map((handle) => (
              <div
                key={handle}
                className="design-handle"
                data-handle={handle}
                style={{ ...handleStyle(selectedRect, handle), width: 8 / zoom, height: 8 / zoom }}
                onPointerDown={(event) => startResize(handle, event)}
              />
            ))}
          </>
        )}
        {guides.map((guide, index) => (
          <div
            key={`${guide.axis}-${guide.value}-${index}`}
            className={guide.axis === "x" ? "design-guide design-guide-x" : "design-guide design-guide-y"}
            style={guide.axis === "x"
              ? { left: guide.value, top: guide.start, height: guide.end - guide.start, width: 1 / zoom }
              : { top: guide.value, left: guide.start, width: guide.end - guide.start, height: 1 / zoom }}
          />
        ))}
        {editingNode && editingRect && (
          <textarea
            className="design-text-editor"
            autoFocus
            value={editingNode.text ?? ""}
            style={{
              left: editingRect.x,
              top: editingRect.y,
              width: Math.max(editingRect.w, 24),
              height: Math.max(editingRect.h, 24),
              fontSize: (editingNode.fontSize ?? 14),
              fontWeight: editingNode.fontWeight ?? 400,
              color: editingNode.color,
              textAlign: editingNode.align ?? "left",
              lineHeight: editingNode.lineHeight ?? 1.2
            }}
            onChange={(event) => onNodePatch(editingNode.id, { text: event.target.value })}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setEditingId(undefined);
                onGestureEnd();
              }
              event.stopPropagation();
            }}
            onBlur={() => {
              setEditingId(undefined);
              onGestureEnd();
            }}
          />
        )}
      </div>
    </div>
  );
}

function isTextInput(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (element as HTMLElement).isContentEditable;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 在整树中查找节点（含自身）。 */
function findDeep(nodes: readonly DesignNode[], id: string): DesignNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findDeep(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** 手柄定位：角落与边中点。 */
function handleStyle(rect: NodeRect, handle: ResizeHandle): { left: number; top: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  switch (handle) {
    case "nw": return { left: rect.x, top: rect.y };
    case "n": return { left: cx, top: rect.y };
    case "ne": return { left: right, top: rect.y };
    case "e": return { left: right, top: cy };
    case "se": return { left: right, top: bottom };
    case "s": return { left: cx, top: bottom };
    case "sw": return { left: rect.x, top: bottom };
    case "w": return { left: rect.x, top: cy };
  }
}
