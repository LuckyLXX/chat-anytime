import { AlertTriangle, CircleStop, ListTree, ShieldQuestion, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { WorkflowRunSummary } from "../../../shared/protocol";
import { formatElapsed } from "../lib/automation-task-view";
import { WORKFLOW_RUN_STATUS_LABELS, attemptText, isTerminalRunStatus } from "../lib/workflow-canvas";
import { stopWorkflowRun, workflowFailureMessage, type WorkflowApi } from "../lib/workflow-client";

/**
 * 终态行被用户点掉的记录：**跨 pane 重挂载**保持（切话题/分屏重建 ConversationPane 时
 * 组件会重新挂载，纯组件内 state 会让关掉的终态行又冒出来）。
 *
 * 为什么不进 store：这只是一份「本窗口内看过就收起」的展示记忆，不需要持久化、不需要
 * 跨窗口同步；放模块级有界集合里，重挂载即恢复，越界时丢最早的（runId 唯一且单调）。
 */
const dismissedRunIds = new Set<string>();
const MAX_DISMISSED_RUNS = 64;

function rememberDismissed(runId: string): void {
  dismissedRunIds.add(runId);
  while (dismissedRunIds.size > MAX_DISMISSED_RUNS) {
    const oldest = dismissedRunIds.values().next().value;
    if (oldest === undefined) break;
    dismissedRunIds.delete(oldest);
  }
}

/** 测试钩子：清掉跨挂载的关闭记忆（生产路径不需要调用）。 */
export function resetWorkflowRunStripDismissed(): void {
  dismissedRunIds.clear();
}

export interface WorkflowRunStripProps {
  /** 当前 owner 会话的运行摘要（分屏各看各的，由调用方按 ownerSessionId 过滤）。 */
  runs: WorkflowRunSummary[];
  onDetails(runId: string): void;
  /** 有待决权限/需要看 owner 时定位会话（方案 §7.2）。 */
  onLocateOwner?(run: WorkflowRunSummary): void;
  /** 终态行被用户关掉时通知宿主（宿主要同步自己的「已关闭」记录）。 */
  onDismiss?(runId: string): void;
  /** 测试注入点；默认用 window.piDesktop。 */
  api?: WorkflowApi;
}

/**
 * composer 上方的运行条：当前节点 + 第 k/m 轮 + 状态 + 详情 + 精确停止。
 *
 * 语义与团队状态条一致（方案 §6.3）：
 * - **停止走 `workflow.stop`**，不是 owner 的 `session.abort`——后者会连带打断
 *   owner 自己的回合，而工作流收尾必须在 run 自己的清理路径上（幂等、只落一次终态）。
 * - 终态保留到用户点掉（`onDismiss`）或下一次运行覆盖；main 回合结束不会让它消失。
 *   点掉的记录落在模块级有界集合里，ConversationPane 重挂载（切话题/分屏重建）后
 *   不会再次出现；下一次运行是新 runId，不受影响。
 * - 「待确认」显示待决权限数量并可直接定位 owner 会话；10 分钟未处理由后端自动拒绝，
 *   运行条不负责计时。
 *
 * 时间读数不自己起定时器：运行中每帧摘要都会推过来，够了；多一个 interval 只会在
 * 隐藏窗口里白烧 CPU。
 */
export function WorkflowRunStrip({ runs, onDetails, onLocateOwner, onDismiss, api }: WorkflowRunStripProps): ReactNode {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set(dismissedRunIds));
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [error, setError] = useState<string | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stop = useCallback(async (runId: string): Promise<void> => {
    setError(undefined);
    setStopping((current) => new Set(current).add(runId));
    const client = api ?? window.piDesktop;
    const outcome = await stopWorkflowRun(client, runId);
    if (!mountedRef.current) return;
    setStopping((current) => {
      const next = new Set(current);
      next.delete(runId);
      return next;
    });
    // 停止回执是「已受理（stopping）」，真正收场由快照推过来；失败才需要在这里说。
    if (!outcome.ok) setError(workflowFailureMessage(outcome, "停止工作流失败"));
  }, [api]);

  function dismiss(runId: string): void {
    // 先落跨挂载记忆再改本地 state：两条路径都要有，否则重挂载后又会冒出来。
    rememberDismissed(runId);
    setDismissed((current) => new Set(current).add(runId));
    onDismiss?.(runId);
  }

  const visible = runs.filter((run) => !dismissed.has(run.runId));
  if (visible.length === 0) return null;

  return (
    <div className="composer-workflow-strip" data-composer-zone="workflow" data-pane="workflow-run-strip" role="status" aria-label="工作流运行状态">
      {visible.map((run) => {
        const terminal = isTerminalRunStatus(run.status);
        const pending = run.pendingPermissionIds.length;
        const stopped = run.status === "stopping" || stopping.has(run.runId);
        return (
          <div className={`composer-workflow-row status-${run.status}`} key={run.runId} data-run-id={run.runId} data-run-status={run.status}>
            <span className="composer-workflow-title" title={run.workflowName}>{run.workflowName}</span>
            <span className={`workflow-run-status status-${run.status}`}>{WORKFLOW_RUN_STATUS_LABELS[run.status]}</span>
            {run.currentNodeTitle && <span className="composer-workflow-node">当前：{run.currentNodeTitle}</span>}
            {run.maxAttempts > 1 && <span className="composer-workflow-attempt">{attemptText(run.currentAttempt, run.maxAttempts)}</span>}
            {pending > 0 && (
              <button
                type="button"
                className="composer-workflow-pending"
                data-control="workflow-pending-locate"
                title="节点在等你的权限确认：定位到 owner 会话处理（10 分钟未处理会自动拒绝）"
                onClick={() => onLocateOwner?.(run)}
              >
                <ShieldQuestion size={11} />待确认 {pending}
              </button>
            )}
            {!terminal && <span className="composer-workflow-elapsed">{formatElapsed(Date.now() - run.startedAt)}</span>}
            {run.error && terminal && <span className="composer-workflow-error" title={run.error}><AlertTriangle size={11} />{run.error.slice(0, 48)}</span>}
            <span className="composer-workflow-spacer" />
            <button type="button" className="composer-workflow-details" data-control="workflow-run-details" title="查看这次运行的节点、轮次与产物" onClick={() => onDetails(run.runId)}>
              <ListTree size={11} />详情
            </button>
            {!terminal ? (
              <button
                type="button"
                className="composer-workflow-stop"
                data-control="workflow-stop"
                disabled={stopped}
                title="停止这次工作流：先取消本 run 的权限等待，再收尾当前节点；不影响 owner 会话自己的回合"
                onClick={() => void stop(run.runId)}
              >
                <CircleStop size={11} />{stopped ? "停止中…" : "停止"}
              </button>
            ) : (
              <button type="button" className="composer-workflow-dismiss" data-control="workflow-run-dismiss" title="从运行条移除（历史仍在工作流中心）" aria-label="关闭运行条" onClick={() => dismiss(run.runId)}>
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}
      {error && <p className="composer-workflow-strip-error">{error}</p>}
    </div>
  );
}
