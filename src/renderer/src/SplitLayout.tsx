import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { clampRatio, type SplitNode } from "./lib/split-layout";

/** 分隔条最小可拖半宽（px）：两侧格子都不小于此宽度。 */
const MIN_PANE_PX = 280;
const RATIO_KEYBOARD_STEP = 0.02;

interface SplitLayoutProps {
  node: SplitNode;
  renderLeaf(sessionId: string): ReactNode;
  /** split 节点路径（0/1 序列，从根到该节点）上的比例变更。 */
  onRatioChange(path: readonly number[], ratio: number): void;
}

/**
 * 递归渲染分屏布局树：split 节点是 flex 容器（row=左右，column=上下），
 * 两个子树按 ratio 分配空间，中间一根可拖分隔条。拖拽按容器像素宽度夹取
 * 最小格宽，双击恢复均分，方向键微调。
 */
export function SplitLayout({ node, renderLeaf, onRatioChange }: SplitLayoutProps): ReactNode {
  return <SplitBranch node={node} path={[]} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />;
}

function SplitBranch({ node, path, renderLeaf, onRatioChange }: SplitLayoutProps & { path: readonly number[] }): ReactNode {
  if (node.kind === "leaf") return <>{renderLeaf(node.sessionId)}</>;
  return (
    <div className={`split-node ${node.direction}`}>
      <div className="split-child" style={{ flexGrow: node.ratio }}>
        <SplitBranch node={node.children[0]} path={[...path, 0]} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
      </div>
      <SplitDivider
        direction={node.direction}
        ratio={node.ratio}
        onRatio={(ratio) => onRatioChange(path, ratio)}
      />
      <div className="split-child" style={{ flexGrow: 1 - node.ratio }}>
        <SplitBranch node={node.children[1]} path={[...path, 1]} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
      </div>
    </div>
  );
}

function SplitDivider({ direction, ratio, onRatio }: { direction: "row" | "column"; ratio: number; onRatio(ratio: number): void }): ReactNode {
  const dividerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  function ratioFromPointer(clientX: number, clientY: number): number | undefined {
    const container = dividerRef.current?.parentElement;
    if (!container) return undefined;
    const bounds = container.getBoundingClientRect();
    const total = direction === "row" ? bounds.width : bounds.height;
    if (total <= 0) return undefined;
    // 像素最小格宽转比例夹取，避免拖出不可用的窄格。
    const minRatio = Math.min(0.5, MIN_PANE_PX / total);
    const raw = direction === "row" ? (clientX - bounds.left) / total : (clientY - bounds.top) / total;
    return Math.min(1 - minRatio, Math.max(minRatio, clampRatio(raw)));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const ratio = ratioFromPointer(event.clientX, event.clientY);
    if (ratio !== undefined) onRatio(ratio);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return;
    const ratio = ratioFromPointer(event.clientX, event.clientY);
    if (ratio !== undefined) onRatio(ratio);
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const forward = direction === "row" ? "ArrowRight" : "ArrowDown";
    const backward = direction === "row" ? "ArrowLeft" : "ArrowUp";
    if (event.key !== forward && event.key !== backward) return;
    event.preventDefault();
    onRatio(clampRatio(ratio + (event.key === forward ? RATIO_KEYBOARD_STEP : -RATIO_KEYBOARD_STEP)));
  }

  return (
    <div
      ref={dividerRef}
      className={`split-divider ${direction}`}
      role="separator"
      aria-orientation={direction === "row" ? "vertical" : "horizontal"}
      aria-label={direction === "row" ? "调整左右分屏宽度" : "调整上下分屏高度"}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={`${Math.round(ratio * 100)}% / ${Math.round((1 - ratio) * 100)}%`}
      title="拖动调整分屏，双击恢复均分"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => onRatio(0.5)}
    />
  );
}
