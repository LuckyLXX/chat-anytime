/**
 * 工作流命令处理器（实施方案 §8「IPC、目录、回读与角色开关」/ 步骤五）。
 *
 * 定位：**显式输入的命令处理器**。这里只做「命令 → 结果」的编排：读定义、校验、
 * 受理运行、停运行、查历史、读产物，以及运行摘要快照的 epoch/revision 发帧。
 * 会话解析（谁是 owner、owner 是否真的 live、工作区 realpath 是否一致）、运行器
 * 归属（每 owner 一份、持有在 record 上）、角色/模型配置解析、权限 broker 与
 * 浏览器工具的实时总闸全部留在 `pi-runtime.ts`，通过 {@link WorkflowCommandDeps}
 * 注入——本模块不读全局会话表、不读 activeRuntime、不碰 settings。
 *
 * 四条硬纪律：
 * - **全命令请求关联**：每条命令都回一条 `workflow.result`（成功或失败），带
 *   requestId 与 op；失败带具体 code 与逐项诊断，不只发全局 error toast。
 * - **start 立即返回 / stop 走旁路**：`workflow.run` 只做预检、锁定与受理，
 *   节点执行在运行器的微任务里推进；`workflow.stop` 的回执在旁路通道里立刻返回
 *   `stopping`（由 pi-runtime 的消息入口接线，见 handleCommand 的注释）。
 * - **摘要只含轻量**：`workflow.runs` 只带状态/轮号/节点状态/待决权限 id/短错误，
 *   绝不带 prompt、产物、聊天内容；终态即时 flush，其余短时间合帧。
 * - **不发明语义**：工作流目录/定义/运行记录的合法性与路径边界由
 *   `workflow-store.ts` / `workflow-run-store.ts` 判定，这里只把它们的诊断透出去。
 */

import type { RuntimeMessage } from "../shared/protocol.js";
import type { WorkflowCommand, WorkflowResult, WorkflowRunsSnapshot, WorkflowRunSummary, WorkflowSummary } from "../shared/workflow-protocol.js";
import { summarizeWorkflowRun } from "../shared/workflow-protocol.js";
import {
  MAX_WORKFLOW_INPUT_BYTES, utf8ByteLength, validateWorkflowForRun,
  type WorkflowDefinition, type WorkflowDiagnostic, type WorkflowResolvedNodeConfig, type WorkflowRun,
  type WorkflowRunValidationContext
} from "../shared/workflow.js";
import type { WorkflowChildNodeConfig } from "./workflow-child.js";
import type { WorkflowProcessLiveness } from "./workflow-coordinator.js";
import type { WorkflowStartInput } from "./workflow-runtime.js";
import type { WorkflowRunStore, WorkflowTranscriptPage } from "./workflow-run-store.js";
import type { WorkflowCatalogCache } from "./workflow-catalog-cache.js";
import type { WorkflowStore } from "./workflow-store.js";
import { WorkflowStoreError } from "./workflow-store.js";

/** 终态：不再推进、不再推帧，只有这些能被历史裁剪。 */
export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowRun["status"]> = new Set(["completed", "rejected", "stopped", "failed", "interrupted"]);
/** 活跃态：占用工作区锁、受「不能跨实例停止」约束。 */
export const ACTIVE_WORKFLOW_STATUSES: ReadonlySet<WorkflowRun["status"]> = new Set(["starting", "running", "stopping"]);

/** `workflow.runs` 快照里的终态保留条数：更早的历史按需走 `workflow.runs.list`。 */
export const WORKFLOW_RUN_SNAPSHOT_TERMINAL_LIMIT = 50;
/** `workflow.node.get` 单次内联产物上限：更大的内容必须按文件引用交接（协议里有 truncated 标记）。 */
export const MAX_WORKFLOW_NODE_GET_ARTIFACT_BYTES = 256 * 1024;

// ── 依赖注入面（全部显式传入；会话语义留在 pi-runtime） ───────────────────

/** owner 绑定：页面运行与会话工具都必须落在真实 live owner 上。 */
export interface WorkflowOwnerBinding {
  ownerSessionId: string;
  /** owner 记录自己的工作区（已与页面/工具传入的路径做过 realpath 比对）。 */
  workspace: string;
  sessionFile?: string;
  agentId: string;
  /** 该 owner 当前是否已有活跃运行（受理前给出可读诊断）。 */
  hasActiveRun: boolean;
}

/** 运行器窄接口（pi-runtime 包装 record 上的 WorkflowRuntime）。 */
export interface WorkflowRuntimeHandle {
  /** 运行受理前的准备（冻结模型 token 覆盖等）；抛错则不启动。 */
  beginRun?(): void;
  start(input: WorkflowStartInput): WorkflowRun;
  stop(runId?: string): WorkflowRun | undefined;
  snapshot(): WorkflowRun | undefined;
  hasActiveRun(): boolean;
}

export interface WorkflowCommandDeps {
  store: WorkflowStore;
  catalog: WorkflowCatalogCache;
  runs: WorkflowRunStore;
  /** 本实例标识（协调器 instanceId）：用于把其他实例的运行标成 external。 */
  instanceId: string;
  post(message: RuntimeMessage): void;
  /** owner 解析：必须校验 live 记录与工作区 realpath 一致；不一致返回具体诊断。 */
  resolveOwner(ownerSessionId: string, workspace: string): { ok: true; owner: WorkflowOwnerBinding } | { ok: false; diagnostic: WorkflowDiagnostic };
  /** 取得/创建该 owner 的运行器（pi-runtime 持于每次 owner record）。 */
  runtimeFor(owner: WorkflowOwnerBinding): WorkflowRuntimeHandle;
  /** 运行前冻结全部节点配置（来源/模型/工具/提示词）；失败抛出逐节点诊断。 */
  resolveConfigs(owner: WorkflowOwnerBinding, definition: WorkflowDefinition): WorkflowChildNodeConfig[];
  /** UI 展示用的实际模型（`workflow.get/save` 附带）；解析不出就省略，不阻断读写。 */
  resolveDisplayConfigs?(workspace: string, definition: WorkflowDefinition): WorkflowResolvedNodeConfig[] | undefined;
  /** 目录/运行校验上下文（子智能体目录、可用模型、来源工具、owner 访问模式）。 */
  validationContext(workspace: string): WorkflowRunValidationContext;
  /** 某 run 当前待决的权限请求 id（摘要里只放 id，不带参数）。 */
  pendingPermissionIds(runId: string): readonly string[];
  /** 本实例的活跃运行（含 stopping；终态由历史缓存提供）。 */
  activeRuns(): readonly WorkflowRun[];
  /** 按 runId 找本实例运行器（stop / 读实时快照用）。 */
  findRuntime(runId: string): WorkflowRuntimeHandle | undefined;
  /** 定义保存/删除后重发资源目录（目录缓存已 invalidate）。 */
  publishCatalog(workspace: string): void;
  /** 运行摘要帧：immediate = 终态/受理/补帧立即发，否则合帧。 */
  publishRuns(options?: { immediate?: boolean }): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnostic(code: string, message: string, extra: Partial<WorkflowDiagnostic> = {}): WorkflowDiagnostic {
  return { code, message, ...extra };
}

/** 命令级失败：带稳定的错误码与逐项诊断（渲染端按 code 分类、按 errors 显示）。 */
export class WorkflowCommandFailure extends Error {
  constructor(readonly code: string, message: string, readonly errors: WorkflowDiagnostic[] = []) {
    super(message);
    this.name = "WorkflowCommandFailure";
  }
}

/** 任意异常 → `workflow.result` 的失败形状（命令边界统一兜底用）。 */
export function workflowFailureResult(command: WorkflowCommand, error: unknown): WorkflowResult {
  if (error instanceof WorkflowCommandFailure) {
    return {
      requestId: command.requestId, op: command.type, ok: false, code: error.code,
      errors: error.errors.length > 0 ? error.errors : [diagnostic(error.code, error.message)]
    };
  }
  if (error instanceof WorkflowStoreError) {
    return {
      requestId: command.requestId, op: command.type, ok: false, code: error.code,
      errors: error.errors && error.errors.length > 0 ? error.errors : [diagnostic(error.code, error.message)]
    };
  }
  const message = errorText(error);
  return { requestId: command.requestId, op: command.type, ok: false, code: "workflow-error", errors: [diagnostic("workflow-error", message)] };
}

/** 把冻结配置投影成可回给 UI 的非敏感形状（去掉 systemPrompt，绝不外泄提示词）。 */
export function projectResolvedNodeConfigs(configs: readonly WorkflowChildNodeConfig[]): WorkflowResolvedNodeConfig[] {
  return configs.map(({ systemPrompt: _systemPrompt, ...config }) => structuredClone(config));
}

/** `workflow_list` 这类按 id 或精确名称引用的解析：先 id 后名称，不做模糊匹配。 */
export function matchWorkflowReference(entries: readonly WorkflowSummary[], reference: string): WorkflowSummary | undefined {
  const wanted = typeof reference === "string" ? reference.trim() : "";
  if (!wanted) return undefined;
  return entries.find((entry) => entry.id === wanted) ?? entries.find((entry) => entry.name === wanted);
}

// ── 工具接线面（步骤七 workflow_list / workflow_run / workflow_status 的形状） ──
//
// 步骤七的 `runtime-workflow.ts` 只需要这一份契约，**不必 import pi-runtime**
// （pi-runtime 是 utility 入口模块，导入即要求 parentPort，单测里会直接炸）。
// 实现由 pi-runtime 按会话闭包注入：每个会话的工具都绑定自己的 record，所以
// 这些函数不接收 record 参数，也不读 activeRuntime。

/** gate 判定结果的只读视图（与 `WorkflowExecution.decision` 同口径）。 */
export interface WorkflowGateDecisionView {
  nodeId: string;
  nodeTitle: string;
  attempt: number;
  verdict: "pass" | "retry";
  reason: string;
}

/** 节点产物的文件引用（模型工具只拿引用与短预览，正文走 workflow.node.get）。 */
export interface WorkflowArtifactReference {
  executionId: string;
  nodeId: string;
  nodeTitle: string;
  attempt: number;
  /** 同目录内的真实产物文件路径（后端已核验归属与 realpath）。 */
  artifactPath: string;
}

/** `workflow_status` 的数据面：摘要 + gate 判定 + 产物引用（不含无界全文）。 */
export interface WorkflowRunStatusView {
  summary: WorkflowRunSummary;
  decisions: WorkflowGateDecisionView[];
  artifacts: WorkflowArtifactReference[];
  /** 由其他实例执行：只读展示，不能从这里停止。 */
  external: boolean;
}

/** `workflow_run` 的受理回执（立即返回，不等待节点执行）。 */
export interface WorkflowRunAccepted {
  runId: string;
  status: WorkflowRun["status"];
  workflowName: string;
}

/** 三个工作流工具的接线面（步骤七注入；页面运行不经过它，不受角色开关限制）。 */
export interface WorkflowToolSurface {
  list(): { workflows: WorkflowSummary[]; diagnostics: string[] };
  /**
   * 受理一次运行。`options.signal` 只用于**受理前**的取消检查：已中止则直接失败、
   * 不留下半套准备；受理成功后运行交给后台运行器，不再跟随这个 signal（否则用户
   * 点一次停止就会连带杀掉整个后台运行，见 §8.3）。
   */
  start(workflowRef: string, input: string, options?: { signal?: AbortSignal }): Promise<WorkflowRunAccepted>;
  status(runId?: string): WorkflowRunStatusView;
}

// ── 运行摘要历史（轻量：只留终态摘要 + 其他实例的活跃运行） ───────────────

export interface WorkflowRunHistoryOptions {
  /** 本实例标识：其他实例的运行只展示（external），不能停。 */
  selfInstanceId: string;
  /** 终态保留条数；缺省 {@link WORKFLOW_RUN_SNAPSHOT_TERMINAL_LIMIT}。 */
  terminalLimit?: number;
  /** 进程存活判定（外部实例活跃运行）；缺省按「不确定也算活着」保守处理。 */
  liveness?: (pid: number) => WorkflowProcessLiveness;
}

/**
 * 运行快照的轻量历史缓存。
 *
 * 为什么不在每次发帧时重读运行目录：一个 run 的每个节点状态变化都会推帧，而
 * 目录里可能躺着 200 条历史（每条 run.json 都要解析）。这里只在启动对账时读一次
 * 磁盘，之后由本实例的运行回调增量维护。
 */
export class WorkflowRunHistory {
  private readonly terminalRuns = new Map<string, WorkflowRun>();
  private readonly externalRuns = new Map<string, WorkflowRun>();
  private readonly terminalLimit: number;
  private readonly liveness: (pid: number) => WorkflowProcessLiveness;

  constructor(private readonly options: WorkflowRunHistoryOptions) {
    this.terminalLimit = Math.max(1, options.terminalLimit ?? WORKFLOW_RUN_SNAPSHOT_TERMINAL_LIMIT);
    // 判不出来存活时保守保留（显示为「其他实例运行中」），绝不把活运行抹掉。
    this.liveness = options.liveness ?? (() => "unknown");
  }

  /** 启动对账后的播种：终态进历史，其他实例仍存活的活跃运行单列。 */
  seed(runs: Iterable<WorkflowRun>): void {
    for (const run of runs) {
      if (TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
        this.remember(run);
        continue;
      }
      if (run.runnerInstanceId === this.options.selfInstanceId) continue;
      if (this.liveness(run.runnerPid) === "dead") continue;
      this.externalRuns.set(run.runId, structuredClone(run));
    }
    this.trim();
  }

  /** 本实例的运行变化：只有终态进历史（活跃运行由 deps.activeRuns 提供）。 */
  record(run: WorkflowRun): void {
    if (!TERMINAL_WORKFLOW_STATUSES.has(run.status)) return;
    this.remember(run);
    this.trim();
    this.externalRuns.delete(run.runId);
  }

  /** 运行记录被清理时同步摘掉索引，避免快照里出现「打不开的历史」。 */
  remove(runId: string): void {
    this.terminalRuns.delete(runId);
    this.externalRuns.delete(runId);
  }

  /** 活跃 + 终态摘要：活跃在前（本实例的带待决权限），终态按开始时间倒序。 */
  summaries(active: readonly WorkflowRun[], pendingPermissionIds: (runId: string) => readonly string[]): WorkflowRunSummary[] {
    const ordered: WorkflowRunSummary[] = [];
    for (const run of [...active].sort((left, right) => right.startedAt - left.startedAt || left.runId.localeCompare(right.runId))) {
      ordered.push(summarizeWorkflowRun(run, [...pendingPermissionIds(run.runId)], false));
    }
    for (const run of this.externalRuns.values()) {
      ordered.push(summarizeWorkflowRun(run, [], true));
    }
    const terminal = [...this.terminalRuns.values()]
      .sort((left, right) => right.startedAt - left.startedAt || left.runId.localeCompare(right.runId))
      .slice(0, this.terminalLimit);
    for (const run of terminal) {
      ordered.push(summarizeWorkflowRun(run, [], run.runnerInstanceId !== this.options.selfInstanceId));
    }
    return ordered;
  }

  private remember(run: WorkflowRun): void {
    this.terminalRuns.set(run.runId, structuredClone(run));
  }

  private trim(): void {
    if (this.terminalRuns.size <= this.terminalLimit) return;
    const ordered = [...this.terminalRuns.values()]
      .sort((left, right) => right.startedAt - left.startedAt || left.runId.localeCompare(right.runId));
    for (const run of ordered.slice(this.terminalLimit)) this.terminalRuns.delete(run.runId);
  }
}

// ── workflow.runs 发帧（独立 epoch/revision，合帧 + 终态 flush） ──────────

export interface WorkflowRunsPublisherOptions {
  post(message: RuntimeMessage): void;
  history: WorkflowRunHistory;
  /** 本实例活跃运行（运行器状态变化的唯一事实源）。 */
  activeRuns(): readonly WorkflowRun[];
  /** 某 run 当前待决权限 id（权限卡数量/定位）。 */
  pendingPermissionIds(runId: string): readonly string[];
  /** 合帧间隔（缺省 150ms）；终态、受理、`workflow.sync` 补帧一律立即 flush。 */
  coalesceMs?: number;
  /** 本进程 epoch（缺省随机 UUID）：渲染端按它与 revision 丢弃过期帧。 */
  epoch?: string;
  schedule?(callback: () => void, delayMs: number): unknown;
  cancel?(handle: unknown): void;
}

export interface WorkflowRunsPublisher {
  readonly epoch: string;
  /** 合帧推送（节点/权限/运行状态变化）。 */
  publish(): void;
  /** 立即推送（终态 flush、受理回执、`workflow.sync` 补帧）。 */
  publishNow(): void;
  /** 只读快照（复用最近一次 revision；不推进序号）。 */
  snapshot(): WorkflowRunsSnapshot;
  /** 进程收尾：清掉挂起的合帧定时器。 */
  dispose(): void;
}

export function createWorkflowRunsPublisher(options: WorkflowRunsPublisherOptions): WorkflowRunsPublisher {
  const epoch = options.epoch ?? globalThis.crypto.randomUUID();
  const coalesceMs = Math.max(0, options.coalesceMs ?? 150);
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let revision = 0;
  let timer: unknown | undefined;

  const collect = (nextRevision: number): WorkflowRunsSnapshot => {
    const active = [...options.activeRuns()].filter((run) => ACTIVE_WORKFLOW_STATUSES.has(run.status));
    const runs = options.history.summaries(active, (runId) => options.pendingPermissionIds(runId));
    return { epoch, revision: nextRevision, runs };
  };
  const flush = (): void => {
    revision += 1;
    options.post({ type: "workflow.runs", snapshot: collect(revision) });
  };
  return {
    epoch,
    publish(): void {
      if (timer !== undefined) return;
      timer = schedule(() => {
        timer = undefined;
        try {
          flush();
        } catch {
          // 通道关闭/序列化失败不能改变后端状态：下一帧（或补帧）会补上。
        }
      }, coalesceMs);
    },
    publishNow(): void {
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      try {
        flush();
      } catch {
        // 同上：发帧失败不回滚运行状态。
      }
    },
    snapshot(): WorkflowRunsSnapshot {
      return collect(revision);
    },
    dispose(): void {
      if (timer === undefined) return;
      cancel(timer);
      timer = undefined;
    }
  };
}

// ── 命令处理器 ────────────────────────────────────────────────────────────

export type WorkflowCommandProcessor = (command: WorkflowCommand) => Promise<void>;

/** 每条命令都回一条 `workflow.result`；处理器自身永不抛（只把真实错误放进回执）。 */
export function createWorkflowCommandProcessor(deps: WorkflowCommandDeps): WorkflowCommandProcessor {
  function safeContext(workspace: string): WorkflowRunValidationContext {
    try {
      return deps.validationContext(workspace) ?? {};
    } catch {
      // 目录/模型读失败只影响「可运行」标记的准确度，不能让读取本身失败。
      return {};
    }
  }

  function safeDisplayConfigs(workspace: string, definition: WorkflowDefinition): WorkflowResolvedNodeConfig[] | undefined {
    if (!deps.resolveDisplayConfigs) return undefined;
    try {
      return deps.resolveDisplayConfigs(workspace, definition);
    } catch {
      return undefined;
    }
  }

  function issuesOf(definition: WorkflowDefinition, workspace: string): WorkflowDiagnostic[] {
    const validation = validateWorkflowForRun(definition, safeContext(workspace));
    return [...validation.errors, ...validation.warnings];
  }

  function listCatalog(workspace: string): { workspace: string; workflows: WorkflowSummary[]; diagnostics: string[] } {
    const catalog = deps.catalog.list(workspace, safeContext(workspace));
    return {
      workspace: catalog.workspace,
      workflows: catalog.workflows.map((entry) => ({ ...entry })),
      diagnostics: [...catalog.diagnostics]
    };
  }

  /** 运行记录读取失败：区分「记录不存在」与「记录/文件读取失败」，别把两者混成一个码。 */
  function runStoreFailure(runId: string, error: unknown): never {
    const message = errorText(error);
    // 目录不存在时底层只给 ENOENT（realpath），不能只靠中文文案判断。
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || message.includes("不存在") || message.includes("ENOENT");
    throw new WorkflowCommandFailure(
      missing ? "not-found" : "io",
      missing ? `找不到工作流运行：${runId}（${message}）` : `读取工作流运行失败：${runId}：${message}`
    );
  }

  function resolveOwnerOrFail(ownerSessionId: string, workspace: string): WorkflowOwnerBinding {
    const resolved = deps.resolveOwner(ownerSessionId, workspace);
    if (!resolved.ok) throw new WorkflowCommandFailure(resolved.diagnostic.code || "owner-unavailable", resolved.diagnostic.message, [resolved.diagnostic]);
    return resolved.owner;
  }

  /** 内联产物裁剪：按 UTF-8 字节封顶，绝不在多字节字符中间截断。 */
  function clipText(text: string, maxBytes: number): { text: string; truncated: boolean } {
    if (utf8ByteLength(text) <= maxBytes) return { text, truncated: false };
    let clipped = text.slice(0, maxBytes);
    while (clipped && utf8ByteLength(clipped) > maxBytes) clipped = clipped.slice(0, -1);
    return { text: clipped, truncated: true };
  }

  function parseCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value < 0) throw new WorkflowCommandFailure("invalid-input", `分页游标非法：${cursor}`);
    return value;
  }

  function execute(command: WorkflowCommand): WorkflowResult {
    switch (command.type) {
      case "workflow.get": {
        const stored = deps.store.get(command.workspace, command.workflowId);
        const resolvedNodes = safeDisplayConfigs(command.workspace, stored.definition);
        return {
          requestId: command.requestId, ok: true, op: "workflow.get",
          result: {
            definition: stored.definition,
            baseHash: stored.baseHash,
            issues: issuesOf(stored.definition, command.workspace),
            ...(resolvedNodes ? { resolvedNodes } : {})
          }
        };
      }
      case "workflow.save": {
        if (!command.draft || typeof command.draft !== "object" || Array.isArray(command.draft)) {
          throw new WorkflowCommandFailure("invalid-draft", "工作流草稿必须是对象");
        }
        // 草稿允许不完整（结构归一化在存储层）；运行校验只回问题，不阻断保存。
        const saved = deps.catalog.save(command.workspace, command.draft, {
          ...(command.workflowId ? { workflowId: command.workflowId } : {}),
          ...(command.baseHash ? { baseHash: command.baseHash } : {})
        });
        deps.publishCatalog(command.workspace);
        const resolvedNodes = safeDisplayConfigs(command.workspace, saved.definition);
        return {
          requestId: command.requestId, ok: true, op: "workflow.save",
          result: {
            definition: saved.definition,
            baseHash: saved.baseHash,
            issues: issuesOf(saved.definition, command.workspace),
            ...(resolvedNodes ? { resolvedNodes } : {})
          }
        };
      }
      case "workflow.delete": {
        deps.catalog.delete(command.workspace, command.workflowId, command.baseHash);
        deps.publishCatalog(command.workspace);
        // 已存在的运行快照不受定义删除影响（plan §5.1）：这里绝不动运行记录。
        return { requestId: command.requestId, ok: true, op: "workflow.delete", result: { workflowId: command.workflowId } };
      }
      case "workflow.run": {
        if (typeof command.input !== "string") throw new WorkflowCommandFailure("invalid-input", "工作流输入必须是字符串");
        const inputBytes = utf8ByteLength(command.input);
        if (inputBytes > MAX_WORKFLOW_INPUT_BYTES) {
          throw new WorkflowCommandFailure("invalid-input", `工作流输入超过 ${MAX_WORKFLOW_INPUT_BYTES} 字节（实际 ${inputBytes}）`);
        }
        const owner = resolveOwnerOrFail(command.ownerSessionId, command.workspace);
        const stored = deps.store.get(owner.workspace, command.workflowId);
        const validation = validateWorkflowForRun(stored.definition, safeContext(owner.workspace));
        if (!validation.ok) {
          throw new WorkflowCommandFailure("invalid-workflow", "工作流未通过运行校验", validation.errors);
        }
        // 先判「这个 owner 已经在跑」再解析配置：忙时直接给出可读诊断，不做无用的
        // 模型/子智能体解析（解析失败会把「已有运行」盖成配置问题）。
        const runtime = deps.runtimeFor(owner);
        if (runtime.hasActiveRun()) {
          const running = runtime.snapshot();
          throw new WorkflowCommandFailure("busy", `该会话已有工作流在运行${running ? `：${running.workflowName}（${running.runId}）` : ""}；请先停止或等待结束`);
        }
        let configs: WorkflowChildNodeConfig[];
        try {
          configs = deps.resolveConfigs(owner, stored.definition);
        } catch (error) {
          throw new WorkflowCommandFailure("config-invalid", errorText(error), [diagnostic("config-invalid", errorText(error))]);
        }
        if (configs.length !== stored.definition.nodes.length) {
          throw new WorkflowCommandFailure(
            "config-invalid",
            `节点配置数量与定义不一致（配置 ${configs.length} / 定义 ${stored.definition.nodes.length}）`
          );
        }
        // 冻结模型 token 覆盖等「一次 run 内不许变」的东西：受理前重置一次。
        runtime.beginRun?.();
        // start 只做预检、锁定与受理：节点执行在运行器的微任务里推进，这里立即回。
        const run = runtime.start({ definition: stored.definition, definitionHash: stored.baseHash, input: command.input, configs });
        deps.publishRuns({ immediate: true });
        return { requestId: command.requestId, ok: true, op: "workflow.run", result: { runId: run.runId, status: run.status } };
      }
      case "workflow.stop": {
        const runtime = deps.findRuntime(command.runId);
        if (runtime) {
          const stopped = runtime.stop(command.runId);
          if (stopped) {
            deps.publishRuns({ immediate: true });
            return { requestId: command.requestId, ok: true, op: "workflow.stop", result: { runId: command.runId, status: stopped.status } };
          }
        }
        // 本实例没有这个运行器：读记录区分「其他实例在跑」与「已经结束」。
        let stored: WorkflowRun;
        try {
          stored = deps.runs.get(command.runId);
        } catch (error) {
          throw new WorkflowCommandFailure("not-found", `找不到工作流运行：${command.runId}（${errorText(error)}）`);
        }
        if (ACTIVE_WORKFLOW_STATUSES.has(stored.status)) {
          if (stored.runnerInstanceId === deps.instanceId) {
            // 本实例的运行器已不在了（例如会话被删除）：记录停在活跃态但没有可停对象。
            // 不假装成功——重启后由启动对账按 PID 转 interrupted。
            throw new WorkflowCommandFailure(
              "stale-run",
              `本实例已没有运行 ${stored.runId} 的运行器（记录仍为 ${stored.status}）；重启应用后启动对账会把它转为 interrupted`
            );
          }
          throw new WorkflowCommandFailure(
            "external-run",
            `该运行由其他实例执行（实例 ${stored.runnerInstanceId}，PID ${stored.runnerPid}），首版不能跨实例停止`
          );
        }
        return { requestId: command.requestId, ok: true, op: "workflow.stop", result: { runId: command.runId, status: stored.status } };
      }
      case "workflow.runs.list": {
        const page = deps.runs.list({
          workspace: command.workspace,
          ...(command.agentId ? { agentId: command.agentId } : {}),
          ...(command.ownerSessionId ? { ownerSessionId: command.ownerSessionId } : {}),
          ...(command.cursor ? { cursor: command.cursor } : {}),
          ...(command.limit ? { limit: command.limit } : {})
        });
        const runs = page.runs.map((run) => summarizeWorkflowRun(
          run,
          [...deps.pendingPermissionIds(run.runId)],
          run.runnerInstanceId !== deps.instanceId
        ));
        return {
          requestId: command.requestId, ok: true, op: "workflow.runs.list",
          result: { runs, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), diagnostics: page.diagnostics }
        };
      }
      case "workflow.run.get": {
        // 活跃运行优先用内存快照（比磁盘新一帧），终态/外部运行读记录。
        const live = deps.findRuntime(command.runId)?.snapshot();
        let run: WorkflowRun;
        let definition: WorkflowDefinition;
        try {
          run = live && live.runId === command.runId ? live : deps.runs.get(command.runId);
          definition = deps.runs.getDefinition(command.runId);
        } catch (error) {
          runStoreFailure(command.runId, error);
        }
        return { requestId: command.requestId, ok: true, op: "workflow.run.get", result: { run, definition } };
      }
      case "workflow.node.get": {
        if (command.content === "artifact") {
          let text: string;
          try {
            text = deps.runs.readArtifact(command.runId, command.executionId);
          } catch (error) {
            runStoreFailure(command.runId, error);
          }
          const clipped = clipText(text, MAX_WORKFLOW_NODE_GET_ARTIFACT_BYTES);
          return {
            requestId: command.requestId, ok: true, op: "workflow.node.get",
            result: { executionId: command.executionId, artifact: clipped.text, ...(clipped.truncated ? { truncated: true } : {}) }
          };
        }
        const cursor = parseCursor(command.cursor);
        let page: WorkflowTranscriptPage;
        try {
          page = deps.runs.readTranscript(command.runId, command.executionId, cursor, command.limit ?? 100);
        } catch (error) {
          runStoreFailure(command.runId, error);
        }
        return {
          requestId: command.requestId, ok: true, op: "workflow.node.get",
          result: {
            executionId: command.executionId,
            messages: page.messages,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            ...(page.truncated ? { truncated: true } : {})
          }
        };
      }
      case "workflow.sync": {
        const target = typeof command.workspace === "string" ? command.workspace.trim() : "";
        const catalog = target
          ? listCatalog(target)
          : { workflows: [] as WorkflowSummary[], diagnostics: ["未指定工作区：工作流目录为空"] };
        // 补帧：订阅建立后立即推一帧运行摘要，渲染端不必触发所有会话 state.sync。
        deps.publishRuns({ immediate: true });
        return {
          requestId: command.requestId, ok: true, op: "workflow.sync",
          result: {
            ...("workspace" in catalog && catalog.workspace ? { workspace: catalog.workspace } : {}),
            workflows: catalog.workflows,
            diagnostics: catalog.diagnostics
          }
        };
      }
    }
  }

  return async (command) => {
    let result: WorkflowResult;
    try {
      result = execute(command);
    } catch (error) {
      result = workflowFailureResult(command, error);
    }
    try {
      deps.post({ type: "workflow.result", result });
    } catch {
      // utility 通道关闭：回执发不出去，但后端状态已经落定（运行记录才是事实源）。
    }
  };
}
