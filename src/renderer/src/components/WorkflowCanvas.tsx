import { AlertTriangle, ArrowRight, CheckSquare2, FileText, Focus, GitBranch, Maximize2, Minus, Plus, Rows3, Sparkles, Trash2, Workflow } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { WorkflowDefinition, WorkflowDiagnostic, WorkflowExecutionStatus, WorkflowNode, WorkflowNodeKind, WorkflowNodePosition } from "../../../shared/workflow";
import {
  WORKFLOW_EXECUTION_STATUS_LABELS,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_KIND_LABELS,
  WORKFLOW_NODE_WIDTH,
  attemptText,
  groupWorkflowIssues,
  isEditableTarget,
  reworkRegionNodeIds,
  workflowIssueText,
  workflowNodeModelLabel,
  workflowNodeSourceLabel,
  type WorkflowRect
} from "../lib/workflow-canvas";
import { fitWorkflowScale, projectWorkflowCanvas, workflowLayoutMode } from "../lib/workflow-layout";
import { useElementSize } from "../lib/use-element-size";

/** 运行时叠加层只着色和显示轮号。 */
export interface WorkflowRunOverlay {
  nodeStates: Record<string, WorkflowExecutionStatus>;
  currentNodeId?: string;
  attempt: number;
  maxAttempts: number;
}

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  selectedNodeId?: string;
  selectedEdgeId?: string;
  issues: readonly WorkflowDiagnostic[];
  run?: WorkflowRunOverlay;
  readOnly?: boolean;
  inspectorControl?: ReactNode;
  onSelectNode(nodeId: string | undefined): void;
  onSelectEdge(edgeId: string | undefined): void;
  onMoveNode(nodeId: string, position: WorkflowNodePosition, displayed: readonly WorkflowNode[]): void;
  onAutoLayout(): void;
  onAddNode(kind?: WorkflowNodeKind): void;
  onDeleteNode(nodeId: string): void;
  onDeleteEdge(edgeId: string): void;
  onConnect(fromId: string, toId: string): void;
}

interface DragState {
  node: WorkflowNode;
  nodes: readonly WorkflowNode[];
  pointerId: number;
  startX: number;
  startY: number;
  scrollX: number;
  scrollY: number;
  bounds: WorkflowRect;
  scale: number;
  position?: WorkflowNodePosition;
}

const KIND_ICON = { task: Rows3, review: CheckSquare2, gate: GitBranch, output: FileText };
const MAX_ZOOM = 2;

/** HTML handles focus and editing. The SVG and positioned cards project the same world coordinates. */
export function WorkflowCanvas({
  definition,
  selectedNodeId,
  selectedEdgeId,
  issues,
  run,
  readOnly = false,
  inspectorControl,
  onSelectNode,
  onSelectEdge,
  onMoveNode,
  onAutoLayout,
  onAddNode,
  onDeleteNode,
  onDeleteEdge,
  onConnect
}: WorkflowCanvasProps): ReactNode {
  const [pendingFrom, setPendingFrom] = useState<string>();
  const [manualZoom, setManualZoom] = useState<number>();
  const [preview, setPreview] = useState<DragState>();
  const dragRef = useRef<DragState | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomCenter = useRef<WorkflowNodePosition | undefined>(undefined);
  const arrowId = useId();
  const viewport = useElementSize(scrollRef);
  const grouped = useMemo(() => groupWorkflowIssues(issues), [issues]);
  const region = useMemo(() => reworkRegionNodeIds(definition), [definition]);
  const layoutMode = workflowLayoutMode(definition);
  const projected = useMemo(() => projectWorkflowCanvas(definition, viewport), [definition, viewport]);
  const graph = useMemo(() => preview?.position ? projectWorkflowCanvas({
    ...definition,
    layout: "manual",
    nodes: preview.nodes.map((node) => node.id === preview.node.id ? { ...node, position: preview.position! } : node)
  }, viewport) : projected, [definition, preview, projected, viewport]);
  const bounds = preview?.bounds ?? graph.bounds;
  const fitScale = fitWorkflowScale(bounds, viewport);
  const scale = preview?.scale ?? manualZoom ?? fitScale;
  const insetX = Math.max(0, (viewport.width - bounds.width * scale) / 2);
  const insetY = Math.max(0, (viewport.height - bounds.height * scale) / 2);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const pendingNode = pendingFrom ? nodeById.get(pendingFrom) : undefined;
  const selectedEdge = definition.edges.find((edge) => edge.id === selectedEdgeId);
  const rework = graph.rework;
  const reworkTitle = `返工区间 · 最多 ${definition.rework?.maxAttempts ?? 1} 轮`;
  const zoomPercent = Math.max(1, Math.round(scale * 100));

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const center = zoomCenter.current;
    if (center) {
      zoomCenter.current = undefined;
      scroll.scrollLeft = (center.x - bounds.x) * scale + insetX - viewport.width / 2;
      scroll.scrollTop = (center.y - bounds.y) * scale + insetY - viewport.height / 2;
    } else if (manualZoom === undefined && !preview) {
      scroll.scrollLeft = 0;
      scroll.scrollTop = 0;
    }
  }, [bounds.x, bounds.y, insetX, insetY, manualZoom, preview, scale, viewport]);

  // Only a new selection needs revealing. Ordinary renders must not pull the scroll position back.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !selectedNodeId) return;
    const node = Array.from(scroll.querySelectorAll<HTMLElement>("[data-workflow-node]"))
      .find((item) => item.dataset.workflowNode === selectedNodeId);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    const right = view.left + scroll.clientWidth;
    const bottom = view.top + scroll.clientHeight;
    if (rect.left < view.left) scroll.scrollLeft += rect.left - view.left;
    else if (rect.right > right) scroll.scrollLeft += rect.right - right;
    if (rect.top < view.top) scroll.scrollTop += rect.top - view.top;
    else if (rect.bottom > bottom) scroll.scrollTop += rect.bottom - bottom;
  }, [selectedNodeId]);

  function setZoom(value: number | undefined): void {
    const scroll = scrollRef.current;
    if (value === undefined) {
      zoomCenter.current = undefined;
      if (scroll) { scroll.scrollLeft = 0; scroll.scrollTop = 0; }
    } else if (scroll && value !== scale) {
      zoomCenter.current = {
        x: bounds.x + (scroll.scrollLeft + viewport.width / 2 - insetX) / scale,
        y: bounds.y + (scroll.scrollTop + viewport.height / 2 - insetY) / scale
      };
    }
    setManualZoom(value);
  }

  function clickNode(nodeId: string): void {
    if (!readOnly && pendingNode) {
      setPendingFrom(undefined);
      if (pendingNode.id !== nodeId) onConnect(pendingNode.id, nodeId);
      return;
    }
    onSelectNode(nodeId);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, node: WorkflowNode): void {
    if (event.button !== 0 || dragRef.current || (event.target as HTMLElement).closest("button")) return;
    dragRef.current = {
      node, nodes: graph.nodes, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      scrollX: scrollRef.current?.scrollLeft ?? 0, scrollY: scrollRef.current?.scrollTop ?? 0, bounds, scale
    };
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Pointer may already be inactive. */ }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || readOnly || pendingNode) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.position && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    const position = {
      x: Math.round(drag.node.position.x + (dx + (scrollRef.current?.scrollLeft ?? 0) - drag.scrollX) / drag.scale),
      y: Math.round(drag.node.position.y + (dy + (scrollRef.current?.scrollTop ?? 0) - drag.scrollY) / drag.scale)
    };
    const next = { ...drag, position };
    dragRef.current = next;
    setPreview(next);
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    setPreview(undefined);
    if (event.type !== "pointerup") return;
    if (drag.position) onMoveNode(drag.node.id, drag.position, drag.nodes);
    else clickNode(drag.node.id);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && pendingNode) {
        event.preventDefault();
        event.stopPropagation();
        setPendingFrom(undefined);
        return;
      }
      if (readOnly || isEditableTarget(event.target) || (event.key !== "Delete" && event.key !== "Backspace")) return;
      if (selectedEdgeId) {
        event.preventDefault();
        onDeleteEdge(selectedEdgeId);
      } else if (selectedNodeId) {
        event.preventDefault();
        onDeleteNode(selectedNodeId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDeleteEdge, onDeleteNode, pendingNode, readOnly, selectedEdgeId, selectedNodeId]);

  return (
    <div className="workflow-canvas" data-pane="workflow-canvas">
      <div className="workflow-canvas-toolbar">
        <div className="workflow-canvas-tools">
          <button type="button" className="workflow-canvas-add" data-control="workflow-node-add" disabled={readOnly} onClick={() => onAddNode("task")}>
            <Plus size={15} />新增节点
          </button>
          <button type="button" data-control="workflow-layout-auto" disabled={readOnly || !graph.nodes.length} aria-pressed={layoutMode === "auto"}
            title="按依赖整理节点，随画布大小排版" onClick={() => { onAutoLayout(); setZoom(undefined); }}>
            <Sparkles size={14} />自动排版
          </button>
          {inspectorControl}
        </div>
        <div className="workflow-canvas-zoom" role="group" aria-label="画布缩放">
          <button type="button" data-control="workflow-view-fit" aria-label="适应全图" title="适应全图" onClick={() => setZoom(undefined)}><Focus size={15} /></button>
          <button type="button" data-control="workflow-zoom-out" aria-label="缩小" title="缩小" disabled={scale <= Math.min(fitScale, 0.2)}
            onClick={() => setZoom(Math.max(Math.min(fitScale, 0.2), scale / 1.25))}><Minus size={14} /></button>
          <button type="button" data-control="workflow-zoom-reset" aria-label={`缩放 ${zoomPercent}%，回到 100%`} title="回到 100%" onClick={() => setZoom(1)}>{zoomPercent}%</button>
          <button type="button" data-control="workflow-zoom-in" aria-label="放大" title="放大" disabled={scale >= MAX_ZOOM} onClick={() => setZoom(Math.min(MAX_ZOOM, scale * 1.25))}><Plus size={14} /></button>
        </div>
      </div>
      <div
        className="workflow-canvas-scroll" ref={scrollRef} aria-label="工作流画布" tabIndex={0}
        onClick={(event) => {
          if ((event.target as Element).closest("[data-workflow-node], .workflow-edge-group")) return;
          onSelectNode(undefined);
          onSelectEdge(undefined);
        }}
      >
        {graph.nodes.length === 0 ? (
          <div className="workflow-canvas-empty">
            <Workflow size={24} />
            <strong>画布还没有节点</strong>
            <p>新增第一个节点，然后用连线设置执行顺序。</p>
          </div>
        ) : (
          <div className="workflow-canvas-frame" style={{ width: Math.max(viewport.width, Math.ceil(bounds.width * scale)), height: Math.max(viewport.height, Math.ceil(bounds.height * scale)) }}>
            <div className="workflow-canvas-stage" style={{ left: insetX, top: insetY, width: bounds.width, height: bounds.height, transform: `scale(${scale})` }}>
              <svg className="workflow-canvas-edges" width={bounds.width} height={bounds.height} viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} aria-hidden="true">
                <defs>
                  <marker id={arrowId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 0 L 10 5 L 0 10 z" className="workflow-edge-arrow" />
                  </marker>
                </defs>
                {definition.edges.map((edge) => {
                  const edgePath = graph.edges.get(edge.id);
                  if (!edgePath) return null;
                  const edgeIssues = grouped.edges.get(edge.id) ?? [];
                  const from = nodeById.get(edge.from);
                  const to = nodeById.get(edge.to);
                  return (
                    <g key={edge.id} className="workflow-edge-group" onClick={() => onSelectEdge(edge.id === selectedEdgeId ? undefined : edge.id)}>
                      <title>{`${from?.title} → ${to?.title}${edgeIssues.length > 0 ? `（${edgeIssues.map(workflowIssueText).join("；")}）` : ""}`}</title>
                      <path className="workflow-edge-hit" d={edgePath.d} vectorEffect="non-scaling-stroke" />
                      <path className={`workflow-edge${edge.id === selectedEdgeId ? " is-selected" : ""}${edgeIssues.length > 0 ? " has-issue" : ""}`}
                        d={edgePath.d} vectorEffect="non-scaling-stroke" markerEnd={`url(#${arrowId})`} data-edge-id={edge.id} />
                    </g>
                  );
                })}
                {rework && <path d={rework.d} vectorEffect="non-scaling-stroke" className="workflow-rework-edge" />}
              </svg>
              {rework && <div className="workflow-rework-label" style={{ left: rework.label.x - bounds.x, top: rework.label.y - bounds.y }} title={reworkTitle}><GitBranch size={11} />{reworkTitle}</div>}
              {graph.nodes.map((node) => {
                const selected = node.id === selectedNodeId;
                const state = run?.nodeStates[node.id];
                const nodeIssues = grouped.nodes.get(node.id) ?? [];
                const isCurrent = run?.currentNodeId === node.id;
                const inRegion = region.has(node.id);
                const Icon = KIND_ICON[node.kind];
                const model = workflowNodeModelLabel(node);
                return (
                  <div key={node.id} tabIndex={0} role="group" aria-label={`${WORKFLOW_NODE_KIND_LABELS[node.kind]}：${node.title || "未命名节点"}`}
                    className={`workflow-node kind-${node.kind}${selected ? " is-selected" : ""}${isCurrent ? " is-current" : ""}${pendingNode?.id === node.id ? " is-connect-source" : ""}${pendingNode && pendingNode.id !== node.id ? " is-connect-target" : ""}${nodeIssues.length > 0 ? " has-issue" : ""}${state ? ` state-${state}` : ""}`}
                    style={{ left: node.position.x - bounds.x, top: node.position.y - bounds.y, width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT }}
                    data-workflow-node={node.id} data-workflow-node-kind={node.kind} data-node-selected={selected ? "true" : "false"}
                    {...(state ? { "data-workflow-node-state": state } : {})}
                    onPointerDown={(event) => handlePointerDown(event, node)} onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd} onPointerCancel={handlePointerEnd} onLostPointerCapture={handlePointerEnd}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        clickNode(node.id);
                      }
                    }}
                  >
                    <div className="workflow-node-head">
                      <span className="workflow-node-icon"><Icon size={15} /></span>
                      <span className="workflow-node-heading">
                        <span className="workflow-node-kind">{WORKFLOW_NODE_KIND_LABELS[node.kind]}</span>
                        <strong className="workflow-node-title" title={node.title}>{node.title || "未命名节点"}</strong>
                      </span>
                      {!readOnly && <button type="button" className="workflow-node-connect" data-control="workflow-connect"
                        title="点此再点目标节点建立依赖（Esc 取消）" aria-label={`从「${node.title}」连线`}
                        onClick={() => { onSelectNode(node.id); setPendingFrom(pendingFrom === node.id ? undefined : node.id); }}>
                        <ArrowRight size={14} />
                      </button>}
                      {!readOnly && <button type="button" className="workflow-node-delete" data-control="workflow-node-delete" title="删除节点（连带删除相邻依赖）"
                        aria-label={`删除节点「${node.title}」`} onClick={() => onDeleteNode(node.id)}><Trash2 size={13} /></button>}
                    </div>
                    <p className="workflow-node-meta">
                      <span className="workflow-node-source" title={workflowNodeSourceLabel(node)}>{workflowNodeSourceLabel(node)}</span>
                      {model && <span className="workflow-node-model" title={model}>{model}</span>}
                    </p>
                    {(isCurrent || state || inRegion || nodeIssues.length > 0) && <div className="workflow-node-foot">
                      {state && <span className={`workflow-node-state state-${state}`}>{WORKFLOW_EXECUTION_STATUS_LABELS[state]}</span>}
                      {isCurrent && run && <span className="workflow-node-attempt">{attemptText(run.attempt, run.maxAttempts)}</span>}
                      {inRegion && <span className="workflow-node-region" title="返工区间">返工区间</span>}
                      {nodeIssues.length > 0 && <span className="workflow-node-issue" title={nodeIssues.map(workflowIssueText).join("\n")}><AlertTriangle size={10} />{nodeIssues.length}</span>}
                    </div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div className="workflow-canvas-status">
        {selectedEdge ? <div className="workflow-edge-actions">
          <span title={`${nodeById.get(selectedEdge.from)?.title} → ${nodeById.get(selectedEdge.to)?.title}`}>{nodeById.get(selectedEdge.from)?.title} → {nodeById.get(selectedEdge.to)?.title}</span>
          {!readOnly && <button type="button" data-control="workflow-edge-delete" onClick={() => onDeleteEdge(selectedEdge.id)}><Trash2 size={12} />删除依赖</button>}
        </div> : <span className="workflow-canvas-hint" role="status">
          {pendingNode ? `已选起点「${pendingNode.title}」：点击目标节点建立依赖，Esc 取消` : layoutMode === "auto" ? "按依赖排版 · 拖动节点可手动布局" : "手动布局 · 拖动节点调整位置"}
        </span>}
        <span className="workflow-canvas-count">{definition.nodes.length} 节点 · {definition.edges.length} 依赖</span>
      </div>
    </div>
  );
}
