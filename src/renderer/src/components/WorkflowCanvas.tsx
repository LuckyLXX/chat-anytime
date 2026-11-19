import { AlertTriangle, CornerDownRight, GitBranch, Maximize2, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { WorkflowDefinition, WorkflowDiagnostic, WorkflowExecutionStatus, WorkflowNode, WorkflowNodeKind, WorkflowNodePosition } from "../../../shared/workflow";
import {
  WORKFLOW_EXECUTION_STATUS_LABELS,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_KIND_LABELS,
  WORKFLOW_NODE_WIDTH,
  attemptText,
  edgeGeometry,
  groupWorkflowIssues,
  isEditableTarget,
  reworkGeometry,
  reworkRegionNodeIds,
  stageSize,
  workflowIssueText,
  workflowNodeModelLabel,
  workflowNodeSourceLabel
} from "../lib/workflow-canvas";

/** 运行时叠加层：只着色与显示轮号，不参与任何编辑语义。 */
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
  onSelectNode(nodeId: string | undefined): void;
  onSelectEdge(edgeId: string | undefined): void;
  onMoveNode(nodeId: string, position: WorkflowNodePosition): void;
  onAddNode(kind?: WorkflowNodeKind): void;
  onDeleteNode(nodeId: string): void;
  onDeleteEdge(edgeId: string): void;
  onConnect(fromId: string, toId: string): void;
}

interface DragState {
  nodeId: string;
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

/**
 * 可滚动画布：SVG 画依赖边，DOM 卡片画节点。
 *
 * 为什么边用 SVG、节点用 DOM：节点卡里有标题/来源/模型/状态/按钮，SVG 文本不会
 * 换行也不会自适应，做出来是「看得到但读不清」；而连线用 SVG 最省事（曲线、
 * 虚线回边、命中区）。两者共用同一套画布坐标，所以拖动节点时边会跟着动。
 *
 * 交互（与方案 §9 一致）：
 * - 拖动节点卡移动（pointer 事件 + 3px 死区，避免「想点选却挪了一像素」）；
 * - **两击连线**：点节点卡上的连线按钮选起点，再点目标节点落子，Esc 取消；
 * - 点边选中，Delete/Backspace 删边；选中节点后 Delete/Backspace 删节点
 *   （输入框/可编辑区域内的按键一律让给输入，绝不误删）；
 * - 返工区间只画虚线回边与区间标识，不允许在这里画出运行器不理解的 loop。
 *
 * 钩子命名：节点卡的种类/运行态用 `data-workflow-node-kind` / `data-workflow-node-state`，
 * **不能**复用时间线的公开钩子 `data-node-kind` / `data-node-state`——那是
 * thinking/tool-call/text 与 running/completed/error/aborted 的枚举，两种枚举混在一个
 * 属性上会让主题规则互相污染（也不扩展旧枚举）。
 */
export function WorkflowCanvas({
  definition,
  selectedNodeId,
  selectedEdgeId,
  issues,
  run,
  readOnly = false,
  onSelectNode,
  onSelectEdge,
  onMoveNode,
  onAddNode,
  onDeleteNode,
  onDeleteEdge,
  onConnect
}: WorkflowCanvasProps): ReactNode {
  const [pendingFrom, setPendingFrom] = useState<string | undefined>(undefined);
  const dragRef = useRef<DragState | undefined>(undefined);
  const grouped = groupWorkflowIssues(issues);
  const region = reworkRegionNodeIds(definition);
  const size = stageSize(definition.nodes);
  const entryNode = definition.rework ? definition.nodes.find((node) => node.id === definition.rework?.entryNodeId) : undefined;
  const gateNode = definition.rework ? definition.nodes.find((node) => node.id === definition.rework?.gateNodeId) : undefined;
  const selectedEdge = definition.edges.find((edge) => edge.id === selectedEdgeId);
  const pendingNode = pendingFrom ? definition.nodes.find((node) => node.id === pendingFrom) : undefined;
  const selectedEdgeGeometry = selectedEdge
    ? (() => {
      const from = definition.nodes.find((node) => node.id === selectedEdge.from);
      const to = definition.nodes.find((node) => node.id === selectedEdge.to);
      return from && to ? edgeGeometry(from, to) : undefined;
    })()
    : undefined;

  function clickNode(nodeId: string): void {
    if (readOnly) {
      onSelectNode(nodeId);
      return;
    }
    if (pendingFrom) {
      if (pendingFrom === nodeId) {
        setPendingFrom(undefined);
        return;
      }
      const from = pendingFrom;
      setPendingFrom(undefined);
      onConnect(from, nodeId);
      return;
    }
    onSelectNode(nodeId);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, node: WorkflowNode): void {
    if (event.button !== 0) return;
    // 卡片里的按钮自己处理点击：不在这里起拖拽。
    if ((event.target as HTMLElement | null)?.closest?.("button")) return;
    dragRef.current = {
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: node.position.x,
      originY: node.position.y,
      moved: false
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // happy-dom / 老环境没有 pointer capture：事件仍会在卡片上冒泡，拖拽照样可用。
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || readOnly) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.moved = true;
    onMoveNode(drag.nodeId, { x: Math.max(0, Math.round(drag.originX + dx)), y: Math.max(0, Math.round(drag.originY + dy)) });
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (!drag || drag.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // 同上：没有 capture 实现时无需释放。
    }
    if (!drag.moved) clickNode(drag.nodeId);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        if (!pendingFrom) return;
        event.preventDefault();
        event.stopPropagation();
        setPendingFrom(undefined);
        return;
      }
      if (readOnly) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      // 输入框里的 Delete 是删字符，绝不能当成删节点/删边。
      if (isEditableTarget(event.target)) return;
      if (selectedEdgeId) {
        event.preventDefault();
        onDeleteEdge(selectedEdgeId);
        return;
      }
      if (selectedNodeId) {
        event.preventDefault();
        onDeleteNode(selectedNodeId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDeleteEdge, onDeleteNode, pendingFrom, readOnly, selectedEdgeId, selectedNodeId]);

  return (
    <div className="workflow-canvas" data-pane="workflow-canvas">
      <div className="workflow-canvas-toolbar">
        <button type="button" className="workflow-canvas-add" data-control="workflow-node-add" disabled={readOnly} onClick={() => onAddNode("task")}>
          <Plus size={12} />新增节点
        </button>
        <span className="workflow-canvas-hint">
          {pendingNode
            ? `已选起点「${pendingNode.title}」：点击目标节点建立依赖，Esc 取消`
            : "拖动节点移动 · 点节点右侧箭头再点目标节点连线 · Delete 删除选中项 · 位置只影响视觉"}
        </span>
        <span className="workflow-canvas-count">{definition.nodes.length} 节点 · {definition.edges.length} 依赖</span>
      </div>

      <div className="workflow-canvas-scroll">
        <div
          className="workflow-canvas-stage"
          style={{ width: size.width, height: size.height }}
          onClick={(event) => {
            // 点空白处取消选中：节点卡片、边、边操作条自己的点击不穿到这里。
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("[data-workflow-node], [data-edge-id], .workflow-edge-actions, .workflow-rework-label")) return;
            onSelectNode(undefined);
            onSelectEdge(undefined);
          }}
        >
          <svg className="workflow-canvas-edges" width={size.width} height={size.height} aria-hidden="true">
            <defs>
              <marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="workflow-edge-arrow" />
              </marker>
            </defs>
            {definition.edges.map((edge) => {
              const from = definition.nodes.find((node) => node.id === edge.from);
              const to = definition.nodes.find((node) => node.id === edge.to);
              if (!from || !to) return null;
              const geometry = edgeGeometry(from, to);
              const edgeIssues = grouped.edges.get(edge.id) ?? [];
              return (
                <g key={edge.id} className="workflow-edge-group">
                  <path
                    d={geometry.d}
                    className={`workflow-edge${edge.id === selectedEdgeId ? " is-selected" : ""}${edgeIssues.length > 0 ? " has-issue" : ""}`}
                    markerEnd="url(#workflow-arrow)"
                    data-edge-id={edge.id}
                    onClick={() => onSelectEdge(edge.id === selectedEdgeId ? undefined : edge.id)}
                  >
                    <title>{`${from.title} → ${to.title}${edgeIssues.length > 0 ? `（${edgeIssues.map(workflowIssueText).join("；")}）` : ""}`}</title>
                  </path>
                </g>
              );
            })}
            {entryNode && gateNode && (
              <g className="workflow-rework-group">
                <path d={reworkGeometry(entryNode, gateNode).d} className="workflow-rework-edge" />
              </g>
            )}
          </svg>

          {entryNode && gateNode && (
            <div
              className="workflow-rework-label"
              style={{ left: reworkGeometry(entryNode, gateNode).midX, top: reworkGeometry(entryNode, gateNode).midY }}
              title={`返工区间：${entryNode.title} → ${gateNode.title}，最多 ${definition.rework?.maxAttempts ?? 1} 轮（返工 ${Math.max(0, (definition.rework?.maxAttempts ?? 1) - 1)} 次）`}
            >
              <GitBranch size={10} />
              返工区间 · 最多 {definition.rework?.maxAttempts ?? 1} 轮
            </div>
          )}

          {definition.nodes.map((node) => {
            const selected = node.id === selectedNodeId;
            const state = run?.nodeStates[node.id];
            const nodeIssues = grouped.nodes.get(node.id) ?? [];
            const inRegion = region.has(node.id);
            const statusText = state ? WORKFLOW_EXECUTION_STATUS_LABELS[state] : "";
            return (
              <div
                key={node.id}
                className={`workflow-node kind-${node.kind}${selected ? " is-selected" : ""}${run?.currentNodeId === node.id ? " is-current" : ""}${pendingFrom === node.id ? " is-connect-source" : ""}${pendingFrom && pendingFrom !== node.id ? " is-connect-target" : ""}${nodeIssues.length > 0 ? " has-issue" : ""}${state ? ` state-${state}` : ""}`}
                style={{ left: node.position.x, top: node.position.y, width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT }}
                data-workflow-node={node.id}
                data-workflow-node-kind={node.kind}
                data-node-selected={selected ? "true" : "false"}
                {...(state ? { "data-workflow-node-state": state } : {})}
                onPointerDown={(event) => handlePointerDown(event, node)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
              >
                <div className="workflow-node-head">
                  <span className="workflow-node-kind">{WORKFLOW_NODE_KIND_LABELS[node.kind]}</span>
                  <strong className="workflow-node-title" title={node.title}>{node.title || "未命名节点"}</strong>
                  <button
                    type="button"
                    className="workflow-node-connect"
                    data-control="workflow-connect"
                    title="从这里连一条依赖：点此再点目标节点（Esc 取消）"
                    aria-label={`从「${node.title}」连线`}
                    onClick={() => {
                      onSelectNode(node.id);
                      setPendingFrom(pendingFrom === node.id ? undefined : node.id);
                    }}
                  >
                    <CornerDownRight size={11} />
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      className="workflow-node-delete"
                      data-control="workflow-node-delete"
                      title="删除节点（连带删除相邻依赖）"
                      aria-label={`删除节点「${node.title}」`}
                      onClick={() => onDeleteNode(node.id)}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
                <p className="workflow-node-meta">
                  <span className="workflow-node-source">{workflowNodeSourceLabel(node)}</span>
                  {workflowNodeModelLabel(node) && <span className="workflow-node-model" title="节点设置的模型；未设置时运行前按来源解析">{workflowNodeModelLabel(node)}</span>}
                </p>
                <div className="workflow-node-foot">
                  {state && <span className={`workflow-node-state state-${state}`}>{statusText}</span>}
                  {run?.currentNodeId === node.id && <span className="workflow-node-attempt">{attemptText(run.attempt, run.maxAttempts)}</span>}
                  {inRegion && <span className="workflow-node-region">返工区间</span>}
                  {nodeIssues.length > 0 && (
                    <span className="workflow-node-issue" title={nodeIssues.map(workflowIssueText).join("\n")}>
                      <AlertTriangle size={10} />{nodeIssues.length}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {selectedEdge && selectedEdgeGeometry && (
            <div className="workflow-edge-actions" style={{ left: selectedEdgeGeometry.midX, top: selectedEdgeGeometry.midY }}>
              <span>{definition.nodes.find((node) => node.id === selectedEdge.from)?.title} → {definition.nodes.find((node) => node.id === selectedEdge.to)?.title}</span>
              <button type="button" data-control="workflow-edge-delete" title="删除这条依赖" onClick={() => onDeleteEdge(selectedEdge.id)}>
                <Trash2 size={11} />删除依赖
              </button>
            </div>
          )}

          {definition.nodes.length === 0 && (
            <div className="workflow-canvas-empty">
              <Maximize2 size={16} />
              <p>还没有节点。点「新增节点」开始，或用左侧「新建」直接得到六节点起步模板。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
