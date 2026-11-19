import type { DesktopApi, RuntimeMessage, WorkflowCommand, WorkflowDiagnostic, WorkflowResult, WorkflowRunSummary, WorkflowRunsSnapshot } from "../../../shared/protocol";
import type { WorkflowDefinition } from "../../../shared/workflow";

/**
 * 工作流渲染端的请求封装（步骤六）。
 *
 * 为什么不走 store：定义全文、节点产物、子会话转写体积大且只有中心页/运行条
 * 用到，塞进全局 store 会让每次快照合并都复制一遍。这里走「requestId +
 * `workflow.result` 回执」的点对点通道，详情由组件持有有界本地状态。
 *
 * 两条硬纪律（与 `preview-selection-send.ts` 同口径）：
 * ① **先订阅再发**：utility 的回执可能比 `send()` 的 Promise 更早到达，
 *    先发后订阅会丢那一帧，界面永久停在「读取中」。
 * ② 每个请求都有**有限超时**：命令还没接线或 utility 崩了时，按钮不能永久转圈。
 */

export type WorkflowApi = Pick<DesktopApi, "send" | "onRuntimeMessage">;

type OkResult = Extract<WorkflowResult, { ok: true }>;

/**
 * 某个命令成功回执里的 result 载荷。
 *
 * 注意：协议的 `workflow.get | workflow.save` 共用同一联合成员，所以不能用
 * `Extract<OkResult, { op: T }>`（联合成员会被整体排除成 never）。这里用分布式
 * 条件类型按「成员的 op 并集是否包含 T」来挑选。
 */
type PayloadFor<T extends WorkflowCommand["type"]> = OkResult extends infer R
  ? R extends { op: infer O; result: infer P }
    ? T extends O
      ? P
      : never
    : never
  : never;

export type WorkflowPayload<T extends WorkflowCommand["type"]> = PayloadFor<T>;

/** 命令失败/超时/传输异常的归一化形状（不含 requestId，调用方不需要它）。 */
export interface WorkflowFailure {
  ok: false;
  op: WorkflowCommand["type"];
  /** 与 utility 的错误码同名字段：超时 `timeout`，传输失败 `transport`。 */
  code: string;
  errors: WorkflowDiagnostic[];
}

export type WorkflowOutcome<T extends WorkflowCommand["type"]> = { ok: true; result: WorkflowPayload<T> } | WorkflowFailure;

const DEFAULT_TIMEOUT_MS = 20_000;
/** 受理/预检比读定义慢（要解析节点配置、抢工作区锁），单独放宽。 */
const TIMEOUT_BY_OP: Partial<Record<WorkflowCommand["type"], number>> = {
  "workflow.run": 60_000,
  "workflow.node.get": 30_000,
  "workflow.run.get": 30_000
};

export function nextWorkflowRequestId(prefix = "workflow"): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

/** 把命令里的回执映射成调用方关心的形状；顺带挡住「op 与请求不一致」的串号回执。 */
function toOutcome<T extends WorkflowCommand["type"]>(command: Extract<WorkflowCommand, { type: T }>, result: WorkflowResult): WorkflowOutcome<T> {
  if (!result.ok) return { ok: false, op: command.type, code: result.code, errors: result.errors };
  if (result.op !== command.type) {
    return { ok: false, op: command.type, code: "op-mismatch", errors: [{ code: "op-mismatch", message: `回执类型不匹配：请求 ${command.type}，回执 ${result.op}` }] };
  }
  return { ok: true, result: result.result as WorkflowPayload<T> };
}

function failure(op: WorkflowCommand["type"], code: string, message: string): WorkflowFailure {
  return { ok: false, op, code, errors: [{ code, message }] };
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

/**
 * 发出命令并等待匹配 requestId 的 `workflow.result`。
 * 订阅先于发送建立；超时后仍会释放订阅，不会泄漏监听器。
 */
export function requestWorkflow<C extends WorkflowCommand>(api: WorkflowApi, command: C, timeoutMs = TIMEOUT_BY_OP[command.type] ?? DEFAULT_TIMEOUT_MS): Promise<WorkflowOutcome<C["type"]>> {
  return new Promise<WorkflowOutcome<C["type"]>>((resolve) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const finish = (finishWith: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      finishWith();
    };
    const timer = setTimeout(() => finish(() => resolve(failure(command.type, "timeout", "工作流请求超时：后端没有回执，请稍后重试"))), timeoutMs);
    unsubscribe = api.onRuntimeMessage((message: RuntimeMessage) => {
      if (message.type !== "workflow.result" || message.result.requestId !== command.requestId) return;
      // toOutcome 内部已按回执 op 校验；泛型收窄靠这里的断言（C["type"] 在调用点才具体）。
      finish(() => resolve(toOutcome(command, message.result) as WorkflowOutcome<C["type"]>));
    });
    try {
      void api.send(command).catch((cause: unknown) => finish(() => resolve(failure(command.type, "transport", messageOf(cause, "工作流请求发送失败")))));
    } catch (cause) {
      finish(() => resolve(failure(command.type, "transport", messageOf(cause, "工作流请求发送失败"))));
    }
  });
}

/** 失败回执的可读文案：优先 utility 的诊断（含节点/边定位），其次错误码。 */
export function workflowFailureMessage(failureResult: WorkflowFailure, fallback = "工作流操作失败"): string {
  const details = failureResult.errors.map((error) => error.message.trim() || error.code).filter(Boolean);
  if (details.length === 0) return `${fallback}（${failureResult.code}）`;
  return details.slice(0, 3).join("；");
}

/** 订阅工作流运行摘要快照（活跃运行与最近终态）；返回退订函数。 */
export function subscribeWorkflowRuns(api: WorkflowApi, listener: (snapshot: WorkflowRunsSnapshot) => void): () => void {
  return api.onRuntimeMessage((message: RuntimeMessage) => {
    if (message.type === "workflow.runs") listener(message.snapshot);
  });
}

// —— 具体命令的薄封装：让组件里不出现 requestId 拼装与判空样板 ——

export function loadWorkflowCatalog(api: WorkflowApi, workspace: string): Promise<WorkflowOutcome<"workflow.sync">> {
  return requestWorkflow(api, { type: "workflow.sync", requestId: nextWorkflowRequestId("sync"), workspace });
}

export function loadWorkflow(api: WorkflowApi, workspace: string, workflowId: string): Promise<WorkflowOutcome<"workflow.get">> {
  return requestWorkflow(api, { type: "workflow.get", requestId: nextWorkflowRequestId("get"), workspace, workflowId });
}

export function saveWorkflow(api: WorkflowApi, workspace: string, draft: WorkflowDefinition, options: { workflowId?: string; baseHash?: string } = {}): Promise<WorkflowOutcome<"workflow.save">> {
  return requestWorkflow(api, {
    type: "workflow.save",
    requestId: nextWorkflowRequestId("save"),
    workspace,
    ...(options.workflowId ? { workflowId: options.workflowId } : {}),
    ...(options.baseHash ? { baseHash: options.baseHash } : {}),
    draft
  });
}

export function deleteWorkflow(api: WorkflowApi, workspace: string, workflowId: string, baseHash: string): Promise<WorkflowOutcome<"workflow.delete">> {
  return requestWorkflow(api, { type: "workflow.delete", requestId: nextWorkflowRequestId("delete"), workspace, workflowId, baseHash });
}

export function startWorkflowRun(api: WorkflowApi, input: { workspace: string; ownerSessionId: string; workflowId: string; input: string }): Promise<WorkflowOutcome<"workflow.run">> {
  return requestWorkflow(api, { type: "workflow.run", requestId: nextWorkflowRequestId("run"), ...input });
}

/** 精确停止：只停这一次 run，绝不用 owner 的 `session.abort` 代替。 */
export function stopWorkflowRun(api: WorkflowApi, runId: string): Promise<WorkflowOutcome<"workflow.stop">> {
  return requestWorkflow(api, { type: "workflow.stop", requestId: nextWorkflowRequestId("stop"), runId });
}

export function loadWorkflowRuns(api: WorkflowApi, query: { workspace: string; agentId?: string; ownerSessionId?: string; cursor?: string; limit?: number }): Promise<WorkflowOutcome<"workflow.runs.list">> {
  return requestWorkflow(api, {
    type: "workflow.runs.list",
    requestId: nextWorkflowRequestId("runs"),
    workspace: query.workspace,
    ...(query.agentId ? { agentId: query.agentId } : {}),
    ...(query.ownerSessionId ? { ownerSessionId: query.ownerSessionId } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.limit ? { limit: query.limit } : {})
  });
}

export function loadWorkflowRun(api: WorkflowApi, runId: string): Promise<WorkflowOutcome<"workflow.run.get">> {
  return requestWorkflow(api, { type: "workflow.run.get", requestId: nextWorkflowRequestId("run-get"), runId });
}

export function loadWorkflowNode(api: WorkflowApi, runId: string, executionId: string, content: "artifact" | "transcript", options: { cursor?: string; limit?: number } = {}): Promise<WorkflowOutcome<"workflow.node.get">> {
  return requestWorkflow(api, {
    type: "workflow.node.get",
    requestId: nextWorkflowRequestId("node-get"),
    runId,
    executionId,
    content,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit ? { limit: options.limit } : {})
  });
}

/** 运行摘要的归属判据：运行条按 owner 会话过滤（分屏各看各的）。 */
export function belongsToOwner(run: WorkflowRunSummary, ownerSessionId: string | undefined): boolean {
  return !ownerSessionId || run.ownerSessionId === ownerSessionId;
}
