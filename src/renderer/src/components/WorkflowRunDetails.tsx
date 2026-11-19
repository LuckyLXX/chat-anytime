import { AlertTriangle, ChevronLeft, ChevronRight, CircleStop, FileCode2, LoaderCircle, MessageSquare, RefreshCw, RotateCcw, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { ChatMessage } from "../../../shared/protocol";
import type { WorkflowDefinition, WorkflowExecution, WorkflowRun } from "../../../shared/workflow";
import type { Artifact } from "../lib/content";
import { formatElapsed, formatShortTime, workspaceDisplayName } from "../lib/automation-task-view";
import { WORKFLOW_EXECUTION_STATUS_LABELS, WORKFLOW_RUN_STATUS_LABELS, attemptText, isTerminalRunStatus } from "../lib/workflow-canvas";
import { TranscriptTimeline } from "./DelegationTranscript";

/** 可回退的上一窗口起点（由宿主维护的有界游标栈，最近的在末尾）。 */
export interface WorkflowTranscriptWindow {
  /** 该窗口第一页的游标（从头开始的窗口是 "0"）。 */
  cursor: string;
  /** 该窗口第一页在整份记录里的页号（1 起）。 */
  pageStart: number;
}

export interface WorkflowNodeContent {
  loading?: boolean;
  error?: string;
  artifact?: string;
  truncated?: boolean;
  messages?: ChatMessage[];
  /**
   * 当前窗口末尾之后还有内容时的游标（服务端回执给出）。
   * 存在就**永远**能继续往前：窗口满时给「查看后续记录」，不拿页数上限冒充完整。
   */
  nextCursor?: string;
  /** 当前窗口里已载入的页数（首屏 1 页，每点一次「加载更多」+1，最多到窗口上限）。 */
  pages?: number;
  /** 正在读取（窗口内追加下一页，或推进/回退窗口）。与首次加载区分，避免整块换掉已看过的内容。 */
  loadingMore?: boolean;
  /** 窗口满了（页数到上限）且后面还有内容：给「查看后续记录」推进窗口（**替换**，不无限追加）。 */
  windowFull?: boolean;
  /** 当前窗口第一页在整份记录里的页号（1 起）；缺省按第 1 页算。 */
  windowStartPage?: number;
  /** 本窗口起点游标（缺省 = 从头开始）。 */
  windowStartCursor?: string;
  /** 前面还有被移出窗口的内容（当前窗口不是从第一页开始）。 */
  hasEarlier?: boolean;
  /** 可回退的上一窗口（有界栈）；「从头查看」不依赖它，永远可用。 */
  windowBack?: WorkflowTranscriptWindow[];
  /** 本窗口有消息因体积被响应截断（只省略长内容，原文未改）。 */
  transcriptTruncated?: boolean;
}

export interface WorkflowRunDetailsProps {
  /** 运行记录（含每次执行、轮号、gate 裁决）。 */
  run: WorkflowRun;
  /** 启动时冻结的定义快照——不是编辑中的草稿。 */
  definition: WorkflowDefinition;
  /** 当前选中的执行（按需读取产物/转写）。 */
  selectedExecutionId?: string;
  contents: Record<string, WorkflowNodeContent>;
  now?: number;
  loading?: boolean;
  error?: string;
  stopping?: boolean;
  onSelectExecution(executionId: string): void;
  onLoadArtifact(executionId: string): void;
  onLoadTranscript(executionId: string): void;
  /** 窗口内追加下一页完整记录（按 executionId 分页，不与其他轮次混游标）。 */
  onLoadMoreTranscript?(executionId: string): void;
  /** 推进到后续窗口：替换当前窗口（cached 页数有界），而不是无限追加。 */
  onLoadNextWindow?(executionId: string): void;
  /** 回退到上一窗口（按宿主保存的有界游标栈）。 */
  onLoadPreviousWindow?(executionId: string): void;
  /** 从头重新读取（只要前面还有移出的内容就给这个入口，至少能回到第一页）。 */
  onRestartTranscript?(executionId: string): void;
  onStop?(): void;
  onClose?(): void;
  /** 完整记录里若有图片/产物，交给宿主的查看器（与子代理完整记录同一通路）。 */
  onOpenArtifact?(artifact: Artifact): void;
}

/**
 * 运行详情：绑定**冻结的定义快照**与按轮次的执行记录。
 *
 * 为什么不复用编辑画布着色：运行期间用户可能保存了新版定义，把旧 run 的状态
 * 画在改过的图上会给出错误的因果（方案 §9 明确禁止）。这里只按 `run.executions`
 * 列出每轮每个节点，产物与转写按需读取、单次只渲染一条。
 *
 * 完整记录复用 `TranscriptTimeline`（与子代理完整记录同一套只读渲染），
 * 这里**没有**输入框，不产生第二个 composer。
 *
 * 完整记录是**有界窗口分页**的（后端 `readTranscript` 给 `messages/nextCursor/truncated`）：
 * 窗口内首屏一页、`nextCursor` 在就能「加载更多」，但窗口最多缓存若干页；窗口满了还有
 * `nextCursor` 时改给「查看后续记录」——**替换**窗口继续推进游标，绝不拿「页数上限」冒充
 * 完整记录。窗口不是从第一页开始时明说「前面已移出」，并提供「上一窗口」与「从头查看」。
 * 消息被响应截断时如实标注只省略了长内容（原文未改）。
 */
export function WorkflowRunDetails({
  run,
  definition,
  selectedExecutionId,
  contents,
  now = Date.now(),
  loading = false,
  error,
  stopping = false,
  onSelectExecution,
  onLoadArtifact,
  onLoadTranscript,
  onLoadMoreTranscript,
  onLoadNextWindow,
  onLoadPreviousWindow,
  onRestartTranscript,
  onStop,
  onClose,
  onOpenArtifact
}: WorkflowRunDetailsProps): ReactNode {
  const attempts = useMemo(() => groupByAttempt(run.executions), [run.executions]);
  const selected = run.executions.find((execution) => execution.executionId === selectedExecutionId) ?? run.executions.at(-1);
  const content = selected ? contents[selected.executionId] : undefined;
  const terminal = isTerminalRunStatus(run.status);
  const nodeTitles = new Map(definition.nodes.map((node) => [node.id, node.title]));

  return (
    <section className="workflow-run-details" data-pane="workflow-run-details">
      <header className="workflow-run-details-head">
        <div>
          <h3 title={run.workflowName}>{run.workflowName}</h3>
          <p>
            <span className={`workflow-run-status status-${run.status}`}>{WORKFLOW_RUN_STATUS_LABELS[run.status]}</span>
            {run.maxAttempts > 1 ? ` · ${attemptText(run.currentAttempt, run.maxAttempts)}` : ""}
            {` · ${formatShortTime(run.startedAt, now)}`}
            {run.endedAt ? ` · 耗时 ${formatElapsed(run.endedAt - run.startedAt)}` : ""}
            {workspaceDisplayName(run.workspace) ? ` · ${workspaceDisplayName(run.workspace)}` : ""}
          </p>
        </div>
        <div className="workflow-run-details-actions">
          {onStop && !terminal && (
            <button type="button" data-control="workflow-run-stop" disabled={stopping || run.status === "stopping"} title="只停止这次工作流，不影响 owner 会话自己的回合" onClick={onStop}>
              <CircleStop size={12} />{run.status === "stopping" || stopping ? "停止中…" : "停止工作流"}
            </button>
          )}
          {onClose && <button type="button" data-control="workflow-run-close" title="关闭详情" aria-label="关闭运行详情" onClick={onClose}><X size={13} /></button>}
        </div>
      </header>

      {error && <p className="workflow-run-error"><AlertTriangle size={12} />{error}</p>}
      {run.error && <p className="workflow-run-error"><AlertTriangle size={12} />{run.error}</p>}
      {loading && <p className="workflow-run-placeholder"><LoaderCircle size={13} className="spinning" />正在读取运行记录…</p>}

      <div className="workflow-run-details-body">
        <div className="workflow-run-attempts">
          <p className="workflow-run-note">定义快照：启动时冻结，后续编辑不影响本次运行（{definition.nodes.length} 节点）。</p>
          {attempts.map(([attempt, executions]) => (
            <section className="workflow-run-attempt-group" key={attempt}>
              <h4>{attemptText(attempt, run.maxAttempts)}</h4>
              {executions.map((execution) => (
                <button
                  key={execution.executionId}
                  type="button"
                  className={`workflow-run-execution${execution.executionId === selected?.executionId ? " active" : ""}`}
                  data-control="workflow-run-execution"
                  data-execution-id={execution.executionId}
                  data-execution-status={execution.status}
                  onClick={() => onSelectExecution(execution.executionId)}
                >
                  <span className="workflow-run-execution-title" title={nodeTitles.get(execution.nodeId) ?? execution.nodeId}>
                    {execution.nodeTitle || nodeTitles.get(execution.nodeId) || execution.nodeId}
                  </span>
                  <span className={`workflow-run-execution-status state-${execution.status}`}>{WORKFLOW_EXECUTION_STATUS_LABELS[execution.status]}</span>
                  {execution.decision && (
                    <span className={`workflow-gate-decision ${execution.decision.verdict}`} title={execution.decision.reason}>
                      {execution.decision.verdict === "pass" ? "gate: pass" : "gate: retry"}
                    </span>
                  )}
                  {execution.decision && (
                    <span className="workflow-gate-reason" title={execution.decision.reason}>{execution.decision.reason.slice(0, 40)}</span>
                  )}
                  {execution.error && <span className="workflow-run-execution-error" title={execution.error}>{execution.error.slice(0, 60)}</span>}
                </button>
              ))}
            </section>
          ))}
          {run.executions.length === 0 && !loading && <p className="workflow-run-placeholder">还没有节点执行记录。</p>}
        </div>

        <div className="workflow-run-content">
          {!selected ? (
            <p className="workflow-run-placeholder">选择左侧的一次执行查看产物与完整记录。</p>
          ) : (
            <>
              <div className="workflow-run-content-head">
                <strong>{selected.nodeTitle || nodeTitles.get(selected.nodeId) || selected.nodeId}</strong>
                <span className={`workflow-run-execution-status state-${selected.status}`}>{WORKFLOW_EXECUTION_STATUS_LABELS[selected.status]}</span>
                {selected.sessionFile && <em title={selected.sessionFile}>独立会话记录</em>}
                <span className="workflow-run-content-spacer" />
                <button type="button" data-control="workflow-run-content-artifact" onClick={() => onLoadArtifact(selected.executionId)}>
                  <FileCode2 size={12} />产物
                </button>
                <button type="button" data-control="workflow-run-content-transcript" onClick={() => onLoadTranscript(selected.executionId)}>
                  <MessageSquare size={12} />完整记录
                </button>
              </div>
              {selected.decision && (
                <p className={`workflow-gate-verdict ${selected.decision.verdict}`}>
                  {selected.decision.verdict === "pass" ? "验收通过" : "要求返工"}：{selected.decision.reason}
                </p>
              )}
              {content?.error && <p className="workflow-run-error"><AlertTriangle size={12} />{content.error}</p>}
              {content?.loading && <p className="workflow-run-placeholder"><LoaderCircle size={13} className="spinning" />正在读取…</p>}
              {content?.messages && content.messages.length > 0 && (
                <div className="workflow-run-transcript">
                  <TranscriptTimeline messages={content.messages} onOpenArtifact={onOpenArtifact ?? (() => undefined)} />
                </div>
              )}
              {content?.messages && content.messages.length === 0 && <p className="workflow-run-placeholder">这次执行没有可展示的消息。</p>}
              {content?.messages && (content.windowFull || content.hasEarlier) && (
                <p className="workflow-run-transcript-note" data-workflow-transcript-window={content.windowFull ? "full" : "partial"}>
                  <AlertTriangle size={11} />
                  {windowNoticeText(content)}
                </p>
              )}
              {content?.messages && (content.windowFull || content.hasEarlier) && (
                <div className="workflow-run-transcript-nav" data-workflow-transcript-nav="true">
                  {content.windowFull && content.nextCursor && onLoadNextWindow && (
                    <button
                      type="button"
                      className="workflow-run-transcript-more"
                      aria-label="查看后续记录"
                      disabled={content.loadingMore}
                      onClick={() => onLoadNextWindow(selected.executionId)}
                    >
                      <ChevronRight size={11} className={content.loadingMore ? "spinning" : undefined} />
                      {content.loadingMore ? "正在读取后续…" : "查看后续记录"}
                    </button>
                  )}
                  {content.hasEarlier && (content.windowBack?.length ?? 0) > 0 && onLoadPreviousWindow && (
                    <button
                      type="button"
                      className="workflow-run-transcript-more"
                      aria-label="查看上一窗口"
                      disabled={content.loadingMore}
                      onClick={() => onLoadPreviousWindow(selected.executionId)}
                    >
                      <ChevronLeft size={11} />上一窗口
                    </button>
                  )}
                  {content.hasEarlier && onRestartTranscript && (
                    <button
                      type="button"
                      className="workflow-run-transcript-more"
                      aria-label="从头查看完整记录"
                      disabled={content.loadingMore}
                      onClick={() => onRestartTranscript(selected.executionId)}
                    >
                      <RotateCcw size={11} />从头查看
                    </button>
                  )}
                </div>
              )}
              {content?.messages && content.nextCursor && onLoadMoreTranscript && !content.windowFull && (
                <button
                  type="button"
                  className="workflow-run-transcript-more"
                  aria-label="加载更多完整记录"
                  disabled={content.loadingMore}
                  onClick={() => onLoadMoreTranscript(selected.executionId)}
                >
                  <RefreshCw size={11} className={content.loadingMore ? "spinning" : undefined} />
                  {content.loadingMore ? "正在加载更多…" : `加载更多记录（已看${windowRangeText(content)}）`}
                </button>
              )}
              {content?.messages && content.transcriptTruncated && (
                <p className="workflow-run-transcript-note" data-workflow-transcript-clipped="true">
                  <AlertTriangle size={11} />部分消息过大已被截断（只省略末尾的长内容，原始会话文件未修改）：这里不是完整记录。
                </p>
              )}
              {content?.artifact !== undefined && (
                <>
                  <pre className="workflow-run-artifact">{content.artifact || "（空产物）"}</pre>
                  {content.truncated && (
                    <p className="workflow-run-note">
                      <RefreshCw size={11} />产物较大：这里只显示前 8 KiB，完整文件在运行目录的 artifacts/a{selected.attempt}/{selected.nodeId}.txt。
                    </p>
                  )}
                </>
              )}
              {!content && (
                <p className="workflow-run-placeholder">
                  产物与完整记录按需读取（不随运行推送）。点上面的「产物」或「完整记录」。
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** 当前窗口的页范围文案（页号是「读取次数」口径，1 起；单页时不写成区间）。 */
function windowRangeText(content: WorkflowNodeContent): string {
  const start = Math.max(1, content.windowStartPage ?? 1);
  const pages = Math.max(1, content.pages ?? 1);
  return pages > 1 ? `第 ${start}–${start + pages - 1} 页` : `第 ${start} 页`;
}

/**
 * 窗口提示：当前范围 / 前面被移出了多少 / 后面还有没有。
 * 有 `nextCursor` 就一定给前进入口，所以这里绝不把「窗口满了」说成「记录读完了」。
 */
function windowNoticeText(content: WorkflowNodeContent): string {
  const start = Math.max(1, content.windowStartPage ?? 1);
  const parts = [`当前窗口：${windowRangeText(content)}`];
  if (start > 1) parts.push(`前面第 1–${start - 1} 页已移出窗口`);
  if (content.nextCursor) {
    parts.push(content.windowFull
      ? "窗口已满但后面还有内容没有显示：这不是完整记录，点「查看后续记录」继续推进（会替换当前窗口，不会无限堆积）"
      : "后面还有内容没有显示：这不是完整记录");
  } else {
    parts.push("已到记录末尾");
  }
  parts.push("原始会话文件未被修改，也可直接打开上面的独立会话记录");
  return `${parts.join("；")}。`;
}

function groupByAttempt(executions: readonly WorkflowExecution[]): [number, WorkflowExecution[]][] {
  const groups = new Map<number, WorkflowExecution[]>();
  for (const execution of executions) {
    const list = groups.get(execution.attempt);
    if (list) list.push(execution);
    else groups.set(execution.attempt, [execution]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}
