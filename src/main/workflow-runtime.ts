import { randomUUID } from "node:crypto";
import {
  MAX_WORKFLOW_INLINE_ARTIFACT_BYTES, MAX_WORKFLOW_INLINE_CONTEXT_BYTES, MAX_WORKFLOW_INPUT_BYTES,
  MAX_WORKFLOW_NODE_MESSAGE_BYTES, WORKFLOW_RUN_TIMEOUT_MS,
  collectTemplateReferences, parseGateDecision, renderWorkflowTemplate, utf8ByteLength, validateWorkflowForRun,
  type CompiledWorkflowPlan, type WorkflowDefinition, type WorkflowExecution, type WorkflowRun
} from "../shared/workflow.js";
import { WORKFLOW_CHILD_ABORT_GRACE_MS, type WorkflowChildCleanup, type WorkflowChildExecutor, type WorkflowChildNodeConfig } from "./workflow-child.js";
import type { WorkflowCoordinator, WorkflowLockLease, WorkflowLockReleaseResult } from "./workflow-coordinator.js";
import { WorkflowRunStore } from "./workflow-run-store.js";

export interface WorkflowRuntimeOptions {
  workspace: string;
  agentId: string;
  ownerSessionId: string;
  ownerSessionFile?: string;
  coordinator: WorkflowCoordinator;
  store: WorkflowRunStore;
  executeChild: WorkflowChildExecutor;
  cancelPermissions(runId: string): void;
  onChange?(run: WorkflowRun): void;
  now?: () => number;
  runTimeoutMs?: number;
  /** 清理未确认时 stopAndWait 额外等待迟到确认的窗口（墙钟 ms）；缺省一个 abort 宽限。 */
  lateCleanupWaitMs?: number;
}

export interface WorkflowStartInput {
  definition: WorkflowDefinition;
  definitionHash: string;
  input: string;
  /** 全部节点在受理之前完成来源/模型解析，systemPrompt 不进入 run.json。 */
  configs: WorkflowChildNodeConfig[];
}

interface Artifact { text: string; path: string }
interface ActiveRun {
  run: WorkflowRun;
  definition: WorkflowDefinition;
  plan: CompiledWorkflowPlan;
  input: string;
  configs: Map<string, WorkflowChildNodeConfig>;
  lease: WorkflowLockLease;
  controller: AbortController;
  promise?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopTarget?: "stopped" | "failed";
  stopReason?: string;
  cleanupConfirmed: boolean;
  /** 清理未确认时的迟到确认入口（由节点结果提供；不落盘）。 */
  retryCleanup?: () => Promise<WorkflowChildCleanup>;
  retryInFlight?: boolean;
  /** 终态已写入（幂等标记）：finish 之后只可能还差锁释放。 */
  finished?: boolean;
  /** 终态已写但锁未释放：stop / stopAndWait 可重试释放。 */
  releasePending?: boolean;
  /** 「等待工具退出」的展示文案：落中性 stopped 终态时剥离。 */
  waitingCleanup?: string;
}

type WorkflowTerminalStatus = "completed" | "rejected" | "stopped" | "failed";

/** 每 owner 一个运行器，所有节点严格串行；调度不占用 utility 命令队列。 */
export class WorkflowRuntime {
  private active?: ActiveRun;
  private latest?: WorkflowRun;
  private readonly now: () => number;

  constructor(private readonly options: WorkflowRuntimeOptions) { this.now = options.now ?? Date.now; }

  start(input: WorkflowStartInput): WorkflowRun {
    if (this.hasActiveRun()) {
      const active = this.active!;
      throw new Error(
        active.releasePending ? "上一个工作流已结束但工作区锁尚未释放，请再次停止以重试释放"
          : active.run.status === "stopping" ? "工作流正在停止中，等待节点资源退出后才能重新运行"
            : "该会话已有工作流在运行");
    }
    if (typeof input.input !== "string" || utf8ByteLength(input.input) > MAX_WORKFLOW_INPUT_BYTES) throw new Error("工作流输入超过 16 KiB");
    const validation = validateWorkflowForRun(input.definition);
    if (!validation.ok || !validation.plan) throw new Error(validation.errors.map((error) => error.message).join("；") || "无法编译工作流");
    const configs = new Map(input.configs.map((config) => [config.nodeId, structuredClone(config)]));
    for (const node of input.definition.nodes) if (!configs.has(node.id)) throw new Error(`节点缺少已解析配置：${node.id}`);
    const runId = `wr-${randomUUID()}`;
    const acquired = this.options.coordinator.acquire({ workspace: this.options.workspace, runId });
    if (!acquired.ok) throw new Error(acquired.reason === "conflict" ? acquired.summary : acquired.message);
    const run: WorkflowRun = {
      runId, workflowId: input.definition.id, workflowName: input.definition.name,
      workspace: this.options.workspace, agentId: this.options.agentId, ownerSessionId: this.options.ownerSessionId,
      ...(this.options.ownerSessionFile ? { ownerSessionFile: this.options.ownerSessionFile } : {}),
      definitionHash: input.definitionHash, runnerInstanceId: this.options.coordinator.instanceId, runnerPid: this.options.coordinator.pid,
      status: "starting", startedAt: this.now(), currentAttempt: 1, maxAttempts: input.definition.rework?.maxAttempts ?? 1,
      executions: [], resolvedNodes: input.configs.map(({ systemPrompt: _systemPrompt, ...config }) => structuredClone(config))
    };
    try { this.options.store.create(run, input.definition); }
    catch (error) { acquired.lease.release(); throw error; }
    const active: ActiveRun = {
      run, definition: structuredClone(input.definition), plan: validation.plan, input: input.input, configs,
      lease: acquired.lease, controller: new AbortController(), cleanupConfirmed: true
    };
    this.active = active;
    this.latest = run;
    this.notify(active);
    active.timer = setTimeout(() => this.requestStop(active, "failed", "工作流运行超过 120 分钟"), this.options.runTimeoutMs ?? WORKFLOW_RUN_TIMEOUT_MS);
    active.timer.unref?.();
    // 微任务受理之后才执行；start 只做预检、锁定与落盘。
    active.promise = Promise.resolve().then(() => this.run(active));
    // 最后防线：run() 自带收场，这里只保证漏网异常不会变成未处理拒绝或永久锁死。
    active.promise.catch((error) => this.emergencyFinalize(active, error));
    return structuredClone(run);
  }

  stop(runId?: string): WorkflowRun | undefined {
    const active = this.active;
    if (!active || (runId && active.run.runId !== runId)) return this.snapshot();
    if (active.finished || active.stopTarget) {
      // 已在收场：重试未完成的收尾（迟到清理确认 / 锁释放），回执仍立即返回。
      this.retryFinalization(active);
      return this.snapshot();
    }
    this.requestStop(active, "stopped", "用户停止工作流");
    return this.snapshot();
  }

  async stopAndWait(): Promise<boolean> {
    const active = this.active;
    if (!active) return true;
    this.stop(active.run.runId);
    if (active.promise) await active.promise.catch(() => undefined);
    if (this.active !== active) return true;
    // 清理未确认时只再等一个**有限**窗口（迟到 abort 确认 / 临时锁释放重试），
    // 绝不无限等待卡死的 abort；窗口结束仍 stopping 就如实返回未确认。
    const budget = this.options.lateCleanupWaitMs ?? WORKFLOW_CHILD_ABORT_GRACE_MS;
    const deadline = Date.now() + budget;
    while (this.active === active && Date.now() < deadline) {
      this.retryFinalization(active);
      await sleep(50);
    }
    return !this.hasActiveRun();
  }

  hasActiveRun(): boolean { return this.active !== undefined; }
  snapshot(): WorkflowRun | undefined { return this.latest ? structuredClone(this.latest) : undefined; }
  async dispose(): Promise<void> {
    if (!(await this.stopAndWait())) throw new Error("工作流子会话尚未确认退出，保留运行与工作区锁");
  }

  private requestStop(active: ActiveRun, target: "stopped" | "failed", reason: string): void {
    if (this.active !== active || active.stopTarget || active.finished) return;
    active.stopTarget = target;
    active.stopReason = reason;
    active.run.status = "stopping";
    try { this.persist(active); } catch (error) { active.run.error = errorText(error); }
    try { this.options.cancelPermissions(active.run.runId); } catch { /* 取消回调失败不改写停止语义 */ }
    active.controller.abort();
  }

  private async run(active: ActiveRun): Promise<void> {
    try {
      if (active.stopTarget) return;
      active.run.status = "running";
      this.persist(active);
      const prefix = new Map<string, Artifact>();
      await this.executeNodes(active, active.plan.prefixNodeIds, 1, prefix, "");
      if (active.stopTarget) return;
      if (!active.plan.rework) {
        this.finish(active, "completed");
        return;
      }
      let feedback = "";
      for (let attempt = 1; attempt <= active.run.maxAttempts; attempt++) {
        active.run.currentAttempt = attempt;
        // 每轮新映射，普通模板不可能读到上一轮产物；P 的产物仍保留。
        const current = new Map(prefix);
        this.persist(active);
        await this.executeNodes(active, active.plan.regionNodeIds, attempt, current, feedback);
        if (active.stopTarget) return;
        const gate = active.run.executions.filter((item) => item.nodeId === active.plan.rework!.gateNodeId && item.attempt === attempt).at(-1);
        if (!gate?.decision) throw new Error("验收节点缺少 decision");
        if (gate.decision.verdict === "pass") {
          await this.executeNodes(active, active.plan.suffixNodeIds, attempt, current, feedback);
          if (!active.stopTarget) this.finish(active, "completed");
          return;
        }
        if (attempt === active.run.maxAttempts) {
          this.skipUnexecuted(active);
          active.run.error = gate.decision.reason;
          this.finish(active, "rejected");
          return;
        }
        const files = active.plan.regionNodeIds.map((id) => current.get(id)?.path).filter((path): path is string => Boolean(path));
        feedback = `上一轮验收反馈：\n${gate.decision.reason}\n上一轮区间产物文件：\n${files.join("\n")}`;
      }
    } catch (error) {
      active.run.error = errorText(error);
      if (!active.stopTarget) { active.stopTarget = "failed"; active.stopReason = active.run.error; }
    } finally {
      try {
        this.settleStopped(active);
      } catch (error) {
        // settleStopped 自带分层兜底；这里只防未处理拒绝与永久锁死。
        this.emergencyFinalize(active, error);
      }
    }
  }

  /**
   * run() 主流程退出后的统一收场。完成/拒绝路径已在 try 内 finish（这里直接略过）；
   * 停止/失败路径：清理已确认 → 写终态并放锁；未确认 → 保持 stopping 与锁，
   * 等迟到确认（cleanupSettled 推送 / 再次 stop 的有界重试）。
   */
  private settleStopped(active: ActiveRun): void {
    if (active.timer) { clearTimeout(active.timer); active.timer = undefined; }
    if (this.active !== active || active.finished) return;
    if (!active.stopTarget) {
      // 理论不可达（所有正常出口都在 try 内 finish）：按失败收场，绝不悬挂。
      active.stopTarget = "failed";
      active.stopReason = "运行器在没有终态的情况下退出";
    }
    this.cancelPermissionsQuietly(active);
    this.skipUnexecuted(active);
    if (active.cleanupConfirmed) {
      active.run.error = this.terminalError(active);
      this.finish(active, active.stopTarget);
      return;
    }
    active.run.status = "stopping";
    active.waitingCleanup = `等待工具退出：${active.run.error ?? active.stopReason ?? "资源清理未确认"}`;
    if (active.stopTarget === "failed") active.run.error = active.waitingCleanup;
    try { this.persist(active); } catch { this.notify(active); }
  }

  private async executeNodes(active: ActiveRun, ids: string[], attempt: number, artifacts: Map<string, Artifact>, feedback: string): Promise<void> {
    for (const id of ids) {
      if (active.stopTarget) return;
      const node = active.definition.nodes.find((item) => item.id === id)!;
      const config = active.configs.get(id)!;
      const execution: WorkflowExecution = { executionId: randomUUID(), nodeId: id, nodeTitle: node.title, attempt, status: "starting", startedAt: this.now() };
      active.run.executions.push(execution);
      active.run.currentExecutionId = execution.executionId;
      this.persist(active);
      try {
        const prompt = buildWorkflowNodeMessage(active.definition, id, active.input, attempt, feedback, artifacts, config.tools.includes("read"));
        const outcome = await this.options.executeChild({
          runId: active.run.runId, executionId: execution.executionId, nodeId: id, nodeTitle: node.title, attempt, config, prompt,
          ownerSessionId: this.options.ownerSessionId, signal: active.controller.signal,
          onCreated: (info) => {
            execution.sessionId = info.sessionId;
            execution.sessionFile = info.sessionFile;
            try { this.persist(active); }
            catch (error) { this.requestStop(active, "failed", `保存节点会话信息失败：${errorText(error)}`); }
          },
          onStatus: (status) => {
            if (active.stopTarget) return;
            execution.status = status;
            try { this.persist(active); }
            catch (error) { this.requestStop(active, "failed", `保存节点状态失败：${errorText(error)}`); }
          }
        });
        execution.sessionId = outcome.sessionId;
        execution.sessionFile = outcome.sessionFile;
        execution.endedAt = outcome.endedAt;
        active.cleanupConfirmed = outcome.cleanup.confirmed;
        if (!outcome.cleanup.confirmed) {
          // 清理未确认：节点按技术失败落终态（含 endedAt），run 保持 stopping 与锁，
          // 绝不假报 stopped 后放行另一个写入 run。
          execution.status = "failed";
          execution.error = outcome.cleanup.errors.join("；") || "节点资源清理未确认";
          this.requestStop(active, "failed", execution.error);
          // 迟到确认入口（不落盘）：推送通道与有界重试都汇到 applyLateCleanup。
          if (outcome.retryCleanup) active.retryCleanup = outcome.retryCleanup;
          if (outcome.cleanupSettled) {
            void outcome.cleanupSettled.then(
              (cleanup) => this.applyLateCleanup(active, cleanup),
              (error: unknown) => this.applyLateCleanup(active, unconfirmedCleanup(`迟到清理通知失败：${errorText(error)}`))
            );
          }
          return;
        }
        if (active.stopTarget) { execution.status = "stopped"; this.persist(active); return; }
        if (outcome.status !== "completed") {
          execution.status = outcome.status;
          execution.error = outcome.error ?? outcome.stoppedReason;
          if (outcome.status === "stopped") this.requestStop(active, "stopped", outcome.stoppedReason ?? "节点已中止");
          else throw new Error(outcome.error ?? "节点执行失败");
          return;
        }
        const text = outcome.text ?? "";
        if (!text.trim()) throw new Error("节点最终产物为空");
        // 产物先于节点成功终态落盘，下一节点只能读取这次保存完成的内容。
        execution.artifactPath = this.options.store.writeArtifact(active.run.runId, execution.executionId, text);
        if (node.kind === "gate") {
          const decision = parseGateDecision(text);
          if (!decision.ok) throw new Error(decision.error);
          execution.decision = decision.decision;
        }
        execution.status = "completed";
        this.persist(active);
        artifacts.set(id, { text, path: execution.artifactPath });
      } catch (error) {
        execution.status = "failed";
        execution.error = errorText(error);
        execution.endedAt = this.now();
        this.persist(active);
        throw error;
      }
    }
  }

  private skipUnexecuted(active: ActiveRun): void {
    for (const node of active.definition.nodes) {
      if (active.run.executions.some((execution) => execution.nodeId === node.id)) continue;
      active.run.executions.push({ executionId: randomUUID(), nodeId: node.id, nodeTitle: node.title, attempt: active.run.currentAttempt, status: "skipped", endedAt: this.now() });
    }
  }

  /**
   * 写终态并释放工作区锁（只在清理已确认后调用）。任何一步失败都不抛出：
   * - 落盘失败 → 显式改写 failed 附诊断再写一次；
   * - 释放失败 → 保留运行与锁（releasePending），后续 stop / stopAndWait 重试。
   * 幂等：重复 finish 只重试锁释放。
   */
  private finish(active: ActiveRun, status: WorkflowTerminalStatus): void {
    if (active.finished) { this.tryRelease(active); return; }
    active.finished = true;
    active.run.status = status;
    active.run.endedAt = this.now();
    active.run.currentExecutionId = undefined;
    this.persistTerminal(active, status);
    this.cancelPermissionsQuietly(active);
    this.tryRelease(active);
  }

  /** 终态落盘：失败必须显式可见——改写 failed 附诊断再试一次，仍失败保留内存终态并通知。 */
  private persistTerminal(active: ActiveRun, status: WorkflowTerminalStatus): void {
    try {
      this.persist(active);
      return;
    } catch (error) {
      const diagnostic = `写入运行终态失败：${errorText(error)}`;
      active.run.error = active.run.error ? `${active.run.error}；${diagnostic}` : diagnostic;
      if (status !== "failed") active.run.status = "failed";
      try {
        this.persist(active);
      } catch (second) {
        active.run.error = `${active.run.error}；重试写入终态仍失败：${errorText(second)}`;
        this.notify(active);
      }
    }
  }

  /**
   * 释放工作区锁。失败时保留运行与锁（归属仍在本 run，后续可重试），
   * 并把诊断写进运行记录——绝不静默丢弃锁。
   */
  private tryRelease(active: ActiveRun): void {
    let released: WorkflowLockReleaseResult;
    try {
      released = active.lease.release();
    } catch (error) {
      released = { ok: false, reason: "error", message: errorText(error) };
    }
    if (released.ok) {
      if (active.releasePending && active.run.error) {
        // 之前释放失败的诊断补上「已重试释放」，避免误读为锁仍被占用。
        active.run.error = `${active.run.error}（重试后已释放）`;
        try { this.persist(active); } catch { /* 内存态已更新；落盘失败已有诊断 */ }
      }
      if (this.active === active) this.active = undefined;
      this.notify(active);
      return;
    }
    active.releasePending = true;
    const message = `释放工作区锁失败：${released.message}`;
    active.run.error = active.run.error ? `${active.run.error}；${message}` : message;
    try { this.persist(active); } catch { this.notify(active); }
  }

  /** 迟到清理证据落地：确认则写终态并放锁；仍未确认只更新等待诊断（保持 stopping 与锁）。 */
  private applyLateCleanup(active: ActiveRun, cleanup: WorkflowChildCleanup): void {
    if (this.active !== active || active.finished || active.cleanupConfirmed) return;
    if (!cleanup.confirmed) {
      const detail = cleanup.errors.join("；") || "资源清理未确认";
      active.waitingCleanup = `等待工具退出：${detail}`;
      if (active.stopTarget === "failed") active.run.error = active.waitingCleanup;
      active.run.status = "stopping";
      try { this.persist(active); } catch { this.notify(active); }
      return;
    }
    active.cleanupConfirmed = true;
    active.retryCleanup = undefined;
    this.cancelPermissionsQuietly(active);
    this.skipUnexecuted(active);
    active.run.error = this.terminalError(active);
    this.finish(active, active.stopTarget ?? "failed");
  }

  /** 再次 stop / stopAndWait 触发的迟到清理重试：有界、结果异步落地，不阻塞 stop 立即返回。 */
  private kickLateCleanup(active: ActiveRun): void {
    const retry = active.retryCleanup;
    if (!retry || active.retryInFlight || active.finished || active.cleanupConfirmed || this.active !== active) return;
    active.retryInFlight = true;
    Promise.resolve()
      .then(() => retry())
      .then(
        (cleanup) => { active.retryInFlight = false; this.applyLateCleanup(active, cleanup); },
        (error: unknown) => {
          active.retryInFlight = false;
          this.applyLateCleanup(active, unconfirmedCleanup(`重试节点清理失败：${errorText(error)}`));
        }
      );
  }

  /** 收场重试入口：终态已写只差锁释放时重试释放；清理未确认时触发一次有界迟到清理。 */
  private retryFinalization(active: ActiveRun): void {
    if (this.active !== active) return;
    if (active.finished) {
      if (active.releasePending) this.tryRelease(active);
      return;
    }
    if (!active.cleanupConfirmed) this.kickLateCleanup(active);
  }

  /**
   * 最后防线：运行器主体异常退出时按 stopping 保留运行与锁——没有清理证据
   * 绝不落终态、绝不放锁；诊断如实写入运行记录。
   */
  private emergencyFinalize(active: ActiveRun, error: unknown): void {
    if (this.active !== active) return;
    if (active.timer) { clearTimeout(active.timer); active.timer = undefined; }
    if (!active.stopTarget) { active.stopTarget = "failed"; active.stopReason = `运行器异常：${errorText(error)}`; }
    active.run.status = "stopping";
    active.waitingCleanup = `等待工具退出：运行器异常退出：${errorText(error)}`;
    if (active.stopTarget === "failed") active.run.error = active.waitingCleanup;
    this.cancelPermissionsQuietly(active);
    try { this.persist(active); } catch { this.notify(active); }
  }

  private cancelPermissionsQuietly(active: ActiveRun): void {
    try { this.options.cancelPermissions(active.run.runId); } catch { /* 收尾回调不能改写结局 */ }
  }

  /** 终态错误文案：failed 附停止原因；中性 stopped 剥离「等待工具退出」占位。 */
  private terminalError(active: ActiveRun): string | undefined {
    if (active.stopTarget === "failed") return active.stopReason ?? active.run.error;
    return active.run.error === active.waitingCleanup ? undefined : active.run.error;
  }

  private persist(active: ActiveRun): void { this.options.store.save(active.run); this.notify(active); }
  private notify(active: ActiveRun): void {
    this.latest = active.run;
    try { this.options.onChange?.(structuredClone(active.run)); } catch { /* 展示回调不能改变执行结局 */ }
  }
}

/** 总内联预算按 UTF-8 计量；超大产物引用文件，并要求节点可读取文件。 */
export function buildWorkflowNodeMessage(
  definition: WorkflowDefinition, nodeId: string, input: string, attempt: number, feedback: string,
  artifacts: ReadonlyMap<string, Artifact>, canRead: boolean
): string {
  const node = definition.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("节点不存在");
  let remaining = MAX_WORKFLOW_INLINE_CONTEXT_BYTES;
  const include = (text: string, path?: string): string => {
    const bytes = utf8ByteLength(text);
    if (bytes <= MAX_WORKFLOW_INLINE_ARTIFACT_BYTES && bytes <= remaining) { remaining -= bytes; return text; }
    if (!path) throw new Error("返工反馈超过内联预算");
    if (!canRead) throw new Error("上游产物需要读取外置文件，但该节点禁用了 read");
    return `（产物未内联，${bytes} 字节；请读取文件：${path}）`;
  };
  const retryFeedback = feedback ? include(feedback) : "";
  const refs = collectTemplateReferences(node.prompt).filter((ref) => ref.kind === "node").map((ref) => ref.nodeId!);
  const values: Record<string, string> = {};
  for (const id of new Set(refs)) {
    const artifact = artifacts.get(id);
    if (!artifact) throw new Error(`当前轮缺少祖先产物：${id}`);
    values[id] = include(artifact.text, artifact.path);
  }
  const prompt = renderWorkflowTemplate(node.prompt, { input, attempt, retryFeedback, nodes: values });
  const predecessors = definition.edges.filter((edge) => edge.to === nodeId && !refs.includes(edge.from));
  const appended = predecessors.map((edge) => {
    const artifact = artifacts.get(edge.from);
    if (!artifact) throw new Error(`当前轮缺少前驱产物：${edge.from}`);
    return `前驱 ${edge.from} 产物：\n${include(artifact.text, artifact.path)}`;
  });
  const hasFeedbackReference = collectTemplateReferences(node.prompt).some((ref) => ref.kind === "retry_feedback");
  const message = [prompt, `用户任务：\n${input}`, `执行轮号：${attempt}`, ...(retryFeedback && !hasFeedbackReference ? [retryFeedback] : []), ...appended].join("\n\n");
  if (utf8ByteLength(message) > MAX_WORKFLOW_NODE_MESSAGE_BYTES) throw new Error("模板替换后的节点消息超过 64 KiB");
  return message;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function unconfirmedCleanup(error: string): WorkflowChildCleanup {
  return { confirmed: false, listenersReleased: false, timersCleared: false, sessionDisposed: false, abortAcknowledged: false, errors: [error] };
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
