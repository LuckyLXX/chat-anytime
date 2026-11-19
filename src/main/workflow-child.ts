/**
 * 工作流节点执行适配器（实施方案步骤四）：为**一次**节点执行创建一个独立的
 * 真实子会话，跑完取回最终 assistant 文本后立刻释放。
 *
 * 一个节点执行 = 一个全新的 AgentSession：独立 UUID、SDK 返回的真实 sessionFile、
 * 独立目录 `chatanytime-sessions/<agentId>/delegations/workflows/<ownerSessionId>/
 * <runId>/a<attempt>/<nodeId>/`（`delegations` 已被侧栏目录扫描排除）。返工每轮、
 * 不同 run 的同名节点都拿新会话，绝不复用 sessionId / 文件。
 *
 * 硬约束：
 * - **冻结配置**：请求里的 `config` 是运行前解析好的唯一事实源。适配器不读全局
 *   设置、不重读角色/子智能体目录、不按当前模型改写；进入执行后副本化并冻结，
 *   调用方之后再改自己的对象也影响不到本次执行。
 * - **cacheWarming 一律 OFF**（`withCacheWarmingOff`）：无人值守节点不能替用户
 *   烧 token 保温前缀缓存（AGENTS.md §9）。
 * - **权限门**：`createChildPermissionExtension` 把每次工具调用交给调用方注入的
 *   handler（带 runId/nodeId/nodeTitle/attempt，供权限卡与 allow-session 归属）。
 *   权限上限、owner 访问模式的取严、10 分钟自动拒绝都由 handler 侧完成。
 * - **能力白名单**：只按 `config` 激活原生工具 + 显式声明的浏览器工具；不挂
 *   team / delegate / workflow / MCP / SSH 等 customTools，节点不能递归编排，
 *   也不继承 MCP、question、automation 等能力。
 * - **先订阅、再 prompt**：`prompt()` 返回不等于回合结束，只有 `agent_settled`
 *   结算正常回合。`agent_end` 只是底层 run 边界（自动重试、压缩恢复、followUp
 *   之后 Pi 还会继续），拿它推进会把「还在跑」当成「已完成」，所以这里完全不
 *   监听 `agent_end`。
 * - **每种失败都有收场**：prompt rejection、preflight handled、最终 assistant
 *   错误（即便前面有文本）、空输出、abort、超时，都不能挂住等一个不会来的
 *   `agent_settled`。
 * - **停止的清理语义**：abort/超时走 §7.3 的顺序（abort 当前 child → 解除监听 →
 *   清 timer → dispose），并且**只有清理报告确认后**才把结果当作停止完成；
 *   未确认时 `cleanup.confirmed = false`，运行器必须保留 stopping 与工作区锁，
 *   不能假报 stopped 后放行另一个写入 run。宽限内等不到的证据（卡住的 abort、
 *   迟到的创建）不会丢：outcome 附带 `cleanupSettled`（迟到证据落地的推送，
 *   不落盘）与 `retryCleanup()`（有界重试，幂等），运行器据此把 stopping 收成
 *   真终态——没有清理证据就永远不放锁。
 *
 * 与 `team-runtime.ts` 的差异（有意为之）：产物文本保留换行（用 `assistantText`，
 * 不用团队看板的折叠空白摘要）；不做 idle 复用、不冷恢复、不做成员名册——
 * 每次执行一次性生命周期。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEventListener,
  type ModelRuntime,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentProfile, PermissionDecision } from "../shared/protocol.js";
import {
  MAX_WORKFLOW_NODE_MESSAGE_BYTES,
  WORKFLOW_NODE_TIMEOUT_MS,
  utf8ByteLength,
  type WorkflowModelRef,
  type WorkflowResolvedNodeConfig
} from "../shared/workflow.js";
import { assistantText, createChildPermissionExtension } from "./subagent.js";
import { withCacheWarmingOff } from "./runtime-settings.js";

/** abort 后等待子会话真正收场（工具退出、agent_settled）的上限。 */
export const WORKFLOW_CHILD_ABORT_GRACE_MS = 5_000;

/** 路径分量白名单：与 `workflow-run-store.ts` 同口径，防止 id 拼出越界目录。 */
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/**
 * 冻结解析后的节点配置：落盘的 `WorkflowResolvedNodeConfig` 再加**冻结的系统提示**。
 * systemPrompt 只含静态身份/职责、来源提示和固定 gate 输出规则；用户输入、上游
 * 产物、轮号与返工反馈全部进用户消息，不把动态运行态写进系统提示词。
 */
export interface WorkflowChildNodeConfig extends WorkflowResolvedNodeConfig {
  systemPrompt: string;
}

/** 节点执行期间会上报的活状态（终态由结果决定，不走这里）。 */
export type WorkflowChildLiveStatus = "starting" | "running" | "waiting_permission";

/** 一次节点执行的输入；除 `signal`/回调外全部是运行前冻结的只读数据。 */
export interface WorkflowChildExecutionRequest {
  runId: string;
  /** 本次执行的唯一 id（与 sessionId 不同：一个 execution 一定对应一个新会话）。 */
  executionId: string;
  nodeId: string;
  nodeTitle: string;
  /** 实际执行轮号（返工区间内每轮 +1）。 */
  attempt: number;
  config: WorkflowChildNodeConfig;
  /** 已渲染的完整用户消息（模板替换 + 上游产物 + 返工反馈）；换行原样传给会话。 */
  prompt: string;
  /** owner 会话 id：目录归属与 parentSession，不作为权限/生命周期事实源。 */
  ownerSessionId: string;
  /** 停止信号（运行器在 stop / 超时守卫里 abort）。 */
  signal?: AbortSignal;
  /** 活状态回调（仅展示用；回调抛错不影响执行）。 */
  onStatus?(status: WorkflowChildLiveStatus): void;
  /** 创建完成即持久化 SDK 的真实路径，避免进程崩溃后丢失节点记录定位。 */
  onCreated?(info: { sessionId: string; sessionFile: string }): void;
  /** 权限被拒绝时的通知（运行器可据此停止整个 run；失败判定仍由本适配器记录）。 */
  onDenied?(info: { toolName: string; reason: string }): void;
}

/** 注入给调用方的权限请求形状：节点归属显式给出，handler 负责取严与超时。 */
export interface WorkflowChildPermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  node: { runId: string; nodeId: string; nodeTitle: string; attempt: number };
}

/**
 * 权限 handler：构造带 workflow scope 的 principal、与 owner 访问模式取更严格
 * 结果、并按 `WORKFLOW_PERMISSION_TIMEOUT_MS`（10 分钟）自动拒绝。
 */
export type WorkflowChildPermissionHandler = (request: WorkflowChildPermissionRequest) => Promise<PermissionDecision>;

/** 清理报告：`confirmed` 是「停止完成」的唯一判据。 */
export interface WorkflowChildCleanup {
  /** 监听/监听器已解除、timer 已清、会话已回收、请求过的 abort 已收场且无错误。 */
  confirmed: boolean;
  /** 会话事件订阅与 signal 的 abort 监听都已解除。 */
  listenersReleased: boolean;
  /** 没有残留 timer（节点总预算与 abort 宽限都算）。 */
  timersCleared: boolean;
  /**
   * 子会话已 dispose。没有建成会话（创建失败）时同样为 true；创建结果在宽限内
   * 无法确认时为 false——那正是不能宣称「停止完成」的情形。
   */
  sessionDisposed: boolean;
  /** 请求过 abort 时必须等它完成；超宽限 / 抛错时为 false。 */
  abortAcknowledged: boolean;
  errors: string[];
}

export type WorkflowChildOutcomeStatus = "completed" | "failed" | "stopped";

export interface WorkflowChildOutcome {
  status: WorkflowChildOutcomeStatus;
  /** 执行开始/结束墙钟时间（ms），运行记录可直接落盘。 */
  startedAt: number;
  endedAt: number;
  /** 保留换行的最终 assistant 文本；仅 completed 有。 */
  text?: string;
  /** 最终 assistant 的 stopReason（可见时；诊断用）。 */
  stopReason?: string;
  /** 失败原因（status=failed 时必有）。 */
  error?: string;
  /** 中性停止原因（status=stopped 时给出，不是失败）。 */
  stoppedReason?: string;
  /** SDK 返回的真实会话 id / 文件路径（创建成功时一定有）。 */
  sessionId?: string;
  sessionFile?: string;
  cleanup: WorkflowChildCleanup;
  /**
   * 初次清理**未确认**时才有：全部迟到证据（卡住的 abort 收场、迟到的创建被
   * 回收）落地时 resolve 为最终清理报告（绝不 reject）。仅供运行器收尾，不落盘。
   */
  cleanupSettled?: Promise<WorkflowChildCleanup>;
  /**
   * 初次清理**未确认**时才有：有界重试残留清理（等迟到的 abort/创建一个宽限，
   * 再幂等重试 dispose/解除监听）。卡死的资源只会返回仍未确认，不会无限等待。
   */
  retryCleanup?(): Promise<WorkflowChildCleanup>;
}

/** 子会话窄接口：单测用 fake 注入，不必伪造整个 AgentSession。 */
export interface WorkflowChildSession {
  prompt(text: string, options?: {
    expandPromptTemplates?: boolean;
    preflightResult?: (disposition: "handled" | "queued" | "started") => void;
  }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: AgentSessionEventListener): () => void;
}

export interface WorkflowChildSessionCreated {
  handle: WorkflowChildSession;
  sessionId: string;
  sessionFile: string;
  /** 回收会话（幂等由调用方保证：适配器只在清理阶段调用一次）。 */
  dispose(): void;
}

/** 子会话工厂的注入上下文：本次执行的冻结请求 + 已包装好的权限入口。 */
export interface WorkflowChildSessionContext {
  request: WorkflowChildExecutionRequest;
  requestPermission(toolName: string, args: Record<string, unknown>, toolCallId: string): Promise<PermissionDecision>;
}

export type WorkflowChildSessionFactory = (context: WorkflowChildSessionContext) => Promise<WorkflowChildSessionCreated>;

/** 注入 `WorkflowRuntime` 的窄接口：一次调用 = 一次独立节点执行。 */
export type WorkflowChildExecutor = (request: WorkflowChildExecutionRequest) => Promise<WorkflowChildOutcome>;

export interface WorkflowChildAdapterOptions {
  workspace: string;
  agentDir: string;
  /** owner 角色（只用于目录归属与 agentId；配置一律取 request.config）。 */
  agent: AgentProfile;
  modelRuntime: ModelRuntime;
  /** 与主会话一致的用户 token-limit 覆盖钩子。 */
  transformModel?(model: Model<Api>): Model<Api>;
  /** 节点权限入口（必须带 workflow scope 与权限上限取严）。 */
  requestPermission: WorkflowChildPermissionHandler;
  /** 浏览器能力显式注入；未声明 / 未接线时按不可用处理。 */
  buildBrowserTools?(): ToolDefinition[];
  /** 节点执行总预算（含启动与权限等待）；缺省 30 分钟。 */
  nodeTimeoutMs?: number;
  /** abort 后等待收场的上限；缺省 5s。 */
  abortGraceMs?: number;
  /** 测试注入；缺省走真实 `createAgentSession` 配方。 */
  createChildSession?: WorkflowChildSessionFactory;
}

/** 会话目录（导出供运行器/测试核对磁盘布局；不创建目录）。 */
export function workflowChildSessionDirectory(
  options: Pick<WorkflowChildAdapterOptions, "agentDir" | "agent">,
  request: Pick<WorkflowChildExecutionRequest, "ownerSessionId" | "runId" | "attempt" | "nodeId">
): string {
  return join(
    options.agentDir,
    "chatanytime-sessions",
    component(options.agent.id, "agentId"),
    "delegations",
    "workflows",
    component(request.ownerSessionId, "ownerSessionId"),
    component(request.runId, "runId"),
    `a${attemptComponent(request.attempt)}`,
    component(request.nodeId, "nodeId")
  );
}

/**
 * 真实子会话创建配方（照 `team-runtime.ts` 的 defaultCreateChild）：
 * `withCacheWarmingOff(SettingsManager.create)` + `DefaultResourceLoader`（无第三方
 * 扩展/技能/主题/context 文件，只挂权限扩展）+ `createAgentSession` +
 * `bindExtensions` + `setActiveToolsByName`。
 */
export async function createWorkflowChildSession(
  options: WorkflowChildAdapterOptions,
  context: WorkflowChildSessionContext
): Promise<WorkflowChildSessionCreated> {
  const request = context.request;
  const config = request.config;
  const sessionDir = workflowChildSessionDirectory(options, request);
  const sessionManager = SessionManager.create(options.workspace, sessionDir, {
    id: randomUUID(),
    parentSession: request.ownerSessionId
  });
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("无法为工作流节点创建会话文件");
  const settingsManager = withCacheWarmingOff(SettingsManager.create(options.workspace, options.agentDir));
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.workspace,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createChildPermissionExtension(
      context.requestPermission,
      "用户已在 PiDesktop 中拒绝该工作流节点操作"
    )],
    systemPromptOverride: (base) => [base, config.systemPrompt].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();
  // 浏览器能力只在来源定义显式声明且主进程接线时才挂；注册≠激活，激活集在下面
  // 与原生工具一起显式设定（总闸仍由每次 execute 实时兜底）。
  const browserTools = config.browserTools === true && options.buildBrowserTools ? options.buildBrowserTools() : [];
  const model = resolveChildModel(options.modelRuntime, config.model, options.transformModel);
  const { session } = await createAgentSession({
    cwd: options.workspace,
    modelRuntime: options.modelRuntime,
    model,
    thinkingLevel: config.thinkingLevel,
    sessionManager,
    settingsManager,
    resourceLoader,
    customTools: [...browserTools]
  });
  try {
    await session.bindExtensions({ onError: () => { /* 权限扩展的错误由 handler/broker 记录 */ } });
    session.setActiveToolsByName([...config.tools, ...browserTools.map((tool) => tool.name)]);
  } catch (error) {
    try {
      session.dispose();
    } catch {
      // best-effort：创建失败路径优先保留原始错误
    }
    throw error;
  }
  return {
    handle: session as unknown as WorkflowChildSession,
    sessionId: session.sessionId,
    sessionFile,
    dispose: () => session.dispose()
  };
}

/** 组装窄接口执行器；`createChildSession` 可注入 fake 供单测。 */
export function createWorkflowChildExecutor(options: WorkflowChildAdapterOptions): WorkflowChildExecutor {
  const factory: WorkflowChildSessionFactory = options.createChildSession
    ?? ((context) => createWorkflowChildSession(options, context));
  return async (request) => await runWorkflowChild(options, factory, request);
}

/** 没有任何资源需要回收时的清理报告（校验早退、创建前已停止）。 */
export function idleWorkflowChildCleanup(): WorkflowChildCleanup {
  return { confirmed: true, listenersReleased: true, timersCleared: true, sessionDisposed: true, abortAcknowledged: true, errors: [] };
}

// ── 内部：一次执行的收场状态机 ────────────────────────────────────────────

type FinalizeTrigger =
  | { kind: "settled"; aborted: boolean }
  | { kind: "abort" }
  | { kind: "timeout" }
  | { kind: "prompt-error" }
  | { kind: "preflight" }
  | { kind: "creation-error" };

/** 判定结局所需的最小 assistant 形状（AgentMessage 的兼容子集）。 */
interface AssistantLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

/**
 * 子会话创建结果（只结算一次）：主流与清理路径共用同一份事实源，
 * 创建慢/卡死时主流不会把整个执行挂住（否则停止后永远拿不到结果）。
 */
type CreationResult =
  | { kind: "created"; created: WorkflowChildSessionCreated }
  | { kind: "failed"; error: string };

/** 一次执行的结算（时间戳由最外层统一补，任何返回路径都不会漏）。 */
type WorkflowChildSettlement = Omit<WorkflowChildOutcome, "startedAt" | "endedAt">;

async function runWorkflowChild(
  options: WorkflowChildAdapterOptions,
  factory: WorkflowChildSessionFactory,
  rawRequest: WorkflowChildExecutionRequest
): Promise<WorkflowChildOutcome> {
  const startedAt = Date.now();
  const settlement = await executeWorkflowChild(options, factory, rawRequest);
  return { ...settlement, startedAt, endedAt: Date.now() };
}

async function executeWorkflowChild(
  options: WorkflowChildAdapterOptions,
  factory: WorkflowChildSessionFactory,
  rawRequest: WorkflowChildExecutionRequest
): Promise<WorkflowChildSettlement> {
  const request = normalizeRequest(rawRequest);
  const prompt = request.prompt;
  if (!prompt.trim()) {
    return { status: "failed", error: "节点用户消息为空，未启动子会话", cleanup: idleWorkflowChildCleanup() };
  }
  const bytes = utf8ByteLength(prompt);
  if (bytes > MAX_WORKFLOW_NODE_MESSAGE_BYTES) {
    return {
      status: "failed",
      error: `节点用户消息超过 ${MAX_WORKFLOW_NODE_MESSAGE_BYTES} 字节（${bytes}），未启动子会话`,
      cleanup: idleWorkflowChildCleanup()
    };
  }
  const signal = request.signal;
  if (signal?.aborted) {
    return { status: "stopped", stoppedReason: "创建会话前已收到停止", cleanup: idleWorkflowChildCleanup() };
  }

  const timeoutMs = positiveDuration(options.nodeTimeoutMs, WORKFLOW_NODE_TIMEOUT_MS);
  const abortGraceMs = positiveDuration(options.abortGraceMs, WORKFLOW_CHILD_ABORT_GRACE_MS);

  let settled = false;
  let timedOut = false;
  let denied: string | undefined;
  let promptError: string | undefined;
  let lastAssistant: AssistantLike | undefined;
  let created: WorkflowChildSessionCreated | undefined;
  let unsubscribe: (() => void) | undefined;
  let abortListener: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  let resolveOutcome!: (outcome: WorkflowChildSettlement) => void;
  const outcome = new Promise<WorkflowChildSettlement>((resolve) => {
    resolveOutcome = resolve;
  });

  const armTimer = (delayMs: number, fire: () => void): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fire();
    }, delayMs);
    timer.unref?.();
    timers.add(timer);
    return timer;
  };
  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(timer);
  };
  // 创建结果只结算一次；主流与清理路径共用（创建卡住时主流也必须能退出）。
  // 未开始创建时给一个永不 resolve 的占位：清理路径会按「等不到」如实报未确认。
  let creationSettled: Promise<CreationResult> = new Promise<CreationResult>(() => undefined);
  const waitCreationBounded = async (): Promise<CreationResult | undefined> => {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      deadlineTimer = armTimer(abortGraceMs, () => resolve(undefined));
    });
    try {
      return await Promise.race<CreationResult | undefined>([creationSettled, deadline]);
    } finally {
      if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
    }
  };

  const reportStatus = (status: WorkflowChildLiveStatus): void => {
    if (settled) return;
    try {
      request.onStatus?.(status);
    } catch {
      // 状态回调属于展示层：它的异常不能打断节点执行。
    }
  };

  const noteDenied = (toolName: string): void => {
    if (denied !== undefined) return;
    denied = `工具调用「${toolName}」被拒绝`;
    try {
      request.onDenied?.({ toolName, reason: denied });
    } catch {
      // 通知失败不影响失败判定。
    }
  };

  const permissionFor = (toolName: string, args: Record<string, unknown>, toolCallId: string): Promise<PermissionDecision> => {
    reportStatus("waiting_permission");
    let pending: Promise<PermissionDecision>;
    try {
      pending = options.requestPermission({
        toolName,
        args,
        toolCallId,
        node: { runId: request.runId, nodeId: request.nodeId, nodeTitle: request.nodeTitle, attempt: request.attempt }
      });
    } catch (error) {
      reportStatus("running");
      return Promise.reject(error);
    }
    return pending.then((decision) => {
      reportStatus("running");
      if (decision === "deny") noteDenied(toolName);
      return decision;
    }, (error: unknown) => {
      reportStatus("running");
      throw error;
    });
  };

  const decide = (trigger: FinalizeTrigger): Omit<WorkflowChildSettlement, "cleanup"> => {
    const stopReason = lastAssistant?.stopReason;
    const withStopReason = stopReason === undefined ? {} : { stopReason };
    if (trigger.kind === "abort") {
      return { status: "stopped", stoppedReason: "工作流节点被停止", ...withStopReason };
    }
    if (trigger.kind === "timeout" || timedOut) {
      return { status: "failed", error: `节点执行超时（${Math.round(timeoutMs / 60_000)} 分钟）`, ...withStopReason };
    }
    if (trigger.kind === "creation-error") {
      return { status: "failed", error: `无法创建节点子会话：${promptError ?? "未知错误"}` };
    }
    if (trigger.kind === "preflight") {
      return { status: "failed", error: "节点 prompt 被扩展拦截（preflight handled），未真正开始" };
    }
    if (trigger.kind === "prompt-error") {
      return { status: "failed", error: `节点 prompt 启动失败：${promptError ?? "未知错误"}` };
    }
    // 正常收口（agent_settled）：权限拒绝优先——模型换个工具绕过也不能算成功。
    if (denied !== undefined) return { status: "failed", error: `权限被拒绝：${denied}；节点记为技术失败`, ...withStopReason };
    if (trigger.kind === "settled" && trigger.aborted) {
      return { status: "stopped", stoppedReason: "工作流节点被中止", ...withStopReason };
    }
    if (!lastAssistant) return { status: "failed", error: "节点没有返回 assistant 消息" };
    if (stopReason === "error") {
      const message = lastAssistant.errorMessage?.trim();
      return { status: "failed", error: message ? message : "模型返回错误", ...withStopReason };
    }
    if (stopReason === "aborted") {
      return { status: "stopped", stoppedReason: "工作流节点被中止", ...withStopReason };
    }
    // 保留换行：产物（Markdown/代码）必须逐字交接，只有「是否为空」看 trim。
    const text = assistantText(lastAssistant);
    if (!text.trim()) {
      return { status: "failed", error: "节点没有返回任何文本（空输出）", ...withStopReason };
    }
    return { status: "completed", text, ...withStopReason };
  };

  // ── 清理状态机：初次收场 + 迟到确认/重试 ─────────────────────────────
  // 事实位只在清理路径里更新；宽限内等不到的证据（卡住的 abort、迟到的创建）记为
  // outstanding*，由迟到监听（cleanupSettled 推送）与 retryCleanup（有界重试）交给
  // 运行器继续确认。所有迟到回调幂等：dispose 只成功一次，重复触发只刷新事实。
  let listenersReleased = true;
  let timersCleared = false;
  let sessionDisposed = true;
  let abortAcknowledged = true;
  let cleanupErrors: string[] = [];
  let teardownDone = false;
  /** 已请求但尚未确认收场的 abort（迟到确认的证据源）。 */
  let outstandingAbort: Promise<void> | undefined;
  /** 尚未收场的会话创建（迟到回收的证据源）。 */
  let outstandingCreation: Promise<CreationResult> | undefined;
  /** created 已成功回收：迟到回调与重试都不会二次 dispose。 */
  let createdDisposed = false;
  let cleanupSettledChannel: Promise<WorkflowChildCleanup> | undefined;
  let resolveCleanupSettled: ((cleanup: WorkflowChildCleanup) => void) | undefined;
  let outstandingWait: Promise<void> | undefined;
  let resolveOutstandingWait: (() => void) | undefined;

  const cleanupReport = (): WorkflowChildCleanup => ({
    confirmed: listenersReleased && timersCleared && sessionDisposed && abortAcknowledged && cleanupErrors.length === 0,
    listenersReleased,
    timersCleared,
    sessionDisposed,
    abortAcknowledged,
    errors: [...cleanupErrors]
  });
  // 同一 marker 的诊断只保留最新一条：重试成功后旧错误必须被抹掉，否则永远 confirmed=false。
  const setCleanupError = (marker: string, message: string): void => {
    cleanupErrors = [...cleanupErrors.filter((item) => !item.includes(marker)), message];
  };
  const clearCleanupError = (marker: string): void => {
    cleanupErrors = cleanupErrors.filter((item) => !item.includes(marker));
  };
  const ensureCleanupSettledChannel = (): Promise<WorkflowChildCleanup> => {
    if (!cleanupSettledChannel) {
      cleanupSettledChannel = new Promise<WorkflowChildCleanup>((resolve) => {
        resolveCleanupSettled = resolve;
      });
    }
    return cleanupSettledChannel;
  };
  const whenOutstandingSettled = (): Promise<void> => {
    if (outstandingAbort === undefined && outstandingCreation === undefined) return Promise.resolve();
    // 共享一个等待 Promise：超时后不会累积残留 waiter。
    if (!outstandingWait) {
      outstandingWait = new Promise<void>((resolve) => {
        resolveOutstandingWait = resolve;
      });
    }
    return outstandingWait;
  };
  const notifyCleanupSettled = (): void => {
    if (outstandingAbort !== undefined || outstandingCreation !== undefined) return;
    const report = cleanupReport();
    const resolveWait = resolveOutstandingWait;
    outstandingWait = undefined;
    resolveOutstandingWait = undefined;
    resolveWait?.();
    resolveCleanupSettled?.(report);
  };
  /** 幂等回收：只有成功才记位；失败可由 retryCleanup 再试。 */
  const disposeCreated = (): boolean => {
    if (!created || createdDisposed) return true;
    try {
      created.dispose();
    } catch (error) {
      sessionDisposed = false;
      setCleanupError("会话回收失败", `会话回收失败：${errorText(error)}`);
      return false;
    }
    createdDisposed = true;
    sessionDisposed = true;
    clearCleanupError("会话回收失败");
    return true;
  };
  const releaseListeners = (): void => {
    if (unsubscribe) {
      try {
        unsubscribe();
        unsubscribe = undefined;
        listenersReleased = true;
        clearCleanupError("解除会话订阅失败");
      } catch (error) {
        listenersReleased = false;
        setCleanupError("解除会话订阅失败", `解除会话订阅失败：${errorText(error)}`);
      }
    }
    if (abortListener && signal) {
      try {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      } catch (error) {
        listenersReleased = false;
        setCleanupError("解除 abort 监听失败", `解除 abort 监听失败：${errorText(error)}`);
      }
    }
  };
  const clearAllTimers = (): void => {
    for (const timer of [...timers]) clearTimer(timer);
    timersCleared = timers.size === 0;
  };
  /** 迟到的创建：成功则幂等回收，失败则没有会话可回收——两种都是「已收场」。 */
  const watchLateCreation = (): void => {
    ensureCleanupSettledChannel();
    outstandingCreation = creationSettled;
    void creationSettled.then((late: CreationResult): void => {
      if (late.kind === "failed") {
        outstandingCreation = undefined;
        sessionDisposed = true;
        clearCleanupError("未能确认节点会话是否创建");
        notifyCleanupSettled();
        return;
      }
      created = late.created;
      const disposed = disposeCreated();
      outstandingCreation = undefined;
      if (disposed) clearCleanupError("未能确认节点会话是否创建");
      notifyCleanupSettled();
    }, (error: unknown): void => {
      // 理论不可达（工厂结果已包装为 CreationResult），防御性收场。
      outstandingCreation = undefined;
      setCleanupError("迟到创建收场异常", `迟到创建收场异常：${errorText(error)}`);
      notifyCleanupSettled();
    });
  };
  /** 迟到的 abort 确认：它真正落地后，abortAcknowledged 才能翻成 true。 */
  const watchLateAbort = (abortPromise: Promise<void>): void => {
    ensureCleanupSettledChannel();
    outstandingAbort = abortPromise;
    void Promise.resolve(abortPromise).then((): void => {
      outstandingAbort = undefined;
      abortAcknowledged = true;
      clearCleanupError("子会话未能确认停止");
      notifyCleanupSettled();
    }, (error: unknown): void => {
      outstandingAbort = undefined;
      setCleanupError("子会话停止确认失败", `子会话停止确认失败：${errorText(error)}`);
      notifyCleanupSettled();
    });
  };

  const teardown = async (trigger: FinalizeTrigger): Promise<void> => {
    try {
      // 创建还在飞行时先等它收场（有限预算）；等不回来就挂迟到回收，绝不留下无主会话。
      if (!created) {
        const waited = await waitCreationBounded();
        if (waited === undefined) {
          sessionDisposed = false;
          setCleanupError("未能确认节点会话是否创建", `未能确认节点会话是否创建：会话创建未在 ${abortGraceMs}ms 内收场`);
          watchLateCreation();
        } else if (waited.kind === "created") {
          created = waited.created;
        }
        // waited.kind === "failed"：创建失败，没有会话可回收（仍然是已确认状态）。
      }
      // §7.3 顺序：先 abort 当前 child 并等它真正收场（工具退出），再解监听、清
      // timer、dispose。settled 触发自带收场证据；creation-error 没有会话；其余
      // 触发（abort/timeout/prompt 拒绝/preflight）都必须拿 abort 证据——dispose
      // 本身不能证明工具已停，prompt 被拒也可能是回合已经开跑后才失败。
      if (created && trigger.kind !== "settled" && trigger.kind !== "creation-error") {
        let abortPromise: Promise<void> | undefined;
        try {
          abortPromise = created.handle.abort();
        } catch (error) {
          abortAcknowledged = false;
          setCleanupError("子会话未能确认停止", `子会话未能确认停止：${errorText(error)}`);
        }
        if (abortPromise) {
          try {
            await settleWithin(abortPromise, abortGraceMs, { arm: armTimer, clear: clearTimer }, `子会话未在 ${abortGraceMs}ms 内确认停止`);
          } catch (error) {
            abortAcknowledged = false;
            setCleanupError("子会话未能确认停止", `子会话未能确认停止：${errorText(error)}`);
            // 宽限内没等到：挂迟到确认，等它真正落地才能翻成已确认。
            watchLateAbort(abortPromise);
          }
        }
      }
      releaseListeners();
      clearAllTimers();
      if (created) disposeCreated();
    } catch (error) {
      setCleanupError("清理失败", `清理失败：${errorText(error)}`);
    } finally {
      teardownDone = true;
    }
  };

  const retryCleanup = async (): Promise<WorkflowChildCleanup> => {
    if (!teardownDone) return cleanupReport();
    // 尚在飞行的迟到项只再等一个宽限预算：卡死的 abort 不无限等（stopAndWait 有界）。
    if (outstandingAbort !== undefined || outstandingCreation !== undefined) {
      try {
        await settleWithin(whenOutstandingSettled(), abortGraceMs, { arm: armTimer, clear: clearTimer }, `迟到清理未在 ${abortGraceMs}ms 内收场`);
      } catch {
        // 仍飞行：按当前事实如实报告未确认。
      }
    }
    // 可重试的残留：解除订阅 / 移除监听 / 回收会话（全部幂等守卫，不会二次 dispose）。
    releaseListeners();
    if (created) disposeCreated();
    clearAllTimers();
    notifyCleanupSettled();
    return cleanupReport();
  };

  // 终态只落一次：停止与完成竞争时后来的触发直接丢弃。
  const finalize = (trigger: FinalizeTrigger): void => {
    if (settled) return;
    settled = true;
    const decided = decide(trigger);
    void teardown(trigger)
      .catch((error: unknown): void => {
        // teardown 自带兜底；这里只防未处理拒绝。
        setCleanupError("清理失败", `清理失败：${errorText(error)}`);
      })
      .then(() => {
        const cleanup = cleanupReport();
        // 清理未确认时给运行器两个收尾入口（不落盘）：迟到证据推送 + 有界重试。
        const late: Pick<WorkflowChildOutcome, "cleanupSettled" | "retryCleanup"> = cleanup.confirmed
          ? {}
          : { cleanupSettled: ensureCleanupSettledChannel(), retryCleanup };
        resolveOutcome({
          ...decided,
          ...(created ? { sessionId: created.sessionId, sessionFile: created.sessionFile } : {}),
          cleanup,
          ...late
        });
      });
  };

  reportStatus("starting");
  // 预算从执行开始算（含创建与权限等待），不是从第一个 token 算。
  armTimer(timeoutMs, () => {
    if (settled) return;
    timedOut = true;
    finalize({ kind: "timeout" });
  });
  if (signal) {
    abortListener = () => {
      if (settled) return;
      finalize({ kind: "abort" });
    };
    // 注册与下面的创建之间没有 await，所以上面对 `signal.aborted` 的检查就是最新值。
    signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    creationSettled = Promise.resolve(factory({ request, requestPermission: permissionFor })).then(
      (value): CreationResult => ({ kind: "created", created: value }),
      (error: unknown): CreationResult => ({ kind: "failed", error: errorText(error) })
    );
  } catch (error) {
    creationSettled = Promise.resolve<CreationResult>({ kind: "failed", error: errorText(error) });
  }
  // 主流只等「创建完成」或「已经被停止/超时」，不被卡死的创建挂住。
  const first = await Promise.race<CreationResult | undefined>([creationSettled, outcome.then(() => undefined)]);
  if (first === undefined) return await outcome;
  if (first.kind === "failed") {
    promptError = first.error;
    finalize({ kind: "creation-error" });
    return await outcome;
  }
  created = first.created;
  if (settled) return await outcome;
  try { request.onCreated?.({ sessionId: created.sessionId, sessionFile: created.sessionFile }); }
  catch (error) {
    promptError = errorText(error);
    finalize({ kind: "prompt-error" });
    return await outcome;
  }

  // 关键时序：先订阅，再 prompt。任何在 prompt 之前到达的事件都不能丢。
  let subscription: (() => void) | undefined;
  try {
    subscription = created.handle.subscribe((event) => {
      if (event.type === "message_end") {
        const message = event.message as AssistantLike;
        if (message?.role === "assistant") lastAssistant = message;
        return;
      }
      // 只有会话级终点能结算；agent_end 会因自动重试/压缩恢复/收尾继续到来。
      if (event.type === "agent_settled") finalize({ kind: "settled", aborted: event.aborted === true });
    });
    unsubscribe = subscription;
  } catch (error) {
    promptError = errorText(error);
    finalize({ kind: "prompt-error" });
    return await outcome;
  }
  if (settled) {
    // Pi 的 subscribe 不会同步派发事件；万一实现变了在这一行之前就结算过，
    // 清理路径看不到 unsubscribe，这里补一次解除，避免监听泄漏。
    unsubscribe = undefined;
    try {
      subscription();
    } catch {
      // best-effort
    }
    return await outcome;
  }

  reportStatus("running");
  let promptResult: Promise<void>;
  try {
    promptResult = created.handle.prompt(prompt, {
      expandPromptTemplates: false,
      preflightResult: (disposition) => {
        if (settled) return;
        if (disposition === "handled") {
          finalize({ kind: "preflight" });
          return;
        }
        reportStatus("running");
      }
    });
  } catch (error) {
    promptError = errorText(error);
    finalize({ kind: "prompt-error" });
    return await outcome;
  }
  void Promise.resolve(promptResult).catch((error: unknown) => {
    if (settled) return;
    promptError = errorText(error);
    finalize({ kind: "prompt-error" });
  });
  // `prompt()` 自己在 finally 里发 agent_settled，所以正常路径这里什么都不做；
  // 万一它先 resolve 而 settle 还没到，节点总预算 timer 兜底，不会永久挂住。
  return await outcome;
}

/** 限时等待：超时就 reject，并保证宽限 timer 一定被清掉（清理报告要如实）。 */
async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timers: { arm: (delayMs: number, fire: () => void) => ReturnType<typeof setTimeout>; clear: (timer: ReturnType<typeof setTimeout>) => void },
  message: string
): Promise<T> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<never>((_resolve, reject) => {
        graceTimer = timers.arm(timeoutMs, () => reject(new Error(message)));
      })
    ]);
  } finally {
    if (graceTimer !== undefined) timers.clear(graceTimer);
  }
}

function normalizeRequest(request: WorkflowChildExecutionRequest): WorkflowChildExecutionRequest {
  if (!request || typeof request !== "object") throw new Error("工作流节点执行请求必须是对象");
  const prompt = typeof request.prompt === "string" ? request.prompt : "";
  if (typeof request.prompt !== "string") throw new Error("工作流节点执行请求缺少 prompt 文本");
  const nodeTitle = typeof request.nodeTitle === "string" ? request.nodeTitle : "";
  return {
    ...request,
    runId: component(request.runId, "runId"),
    executionId: component(request.executionId, "executionId"),
    nodeId: component(request.nodeId, "nodeId"),
    ownerSessionId: component(request.ownerSessionId, "ownerSessionId"),
    attempt: attemptComponent(request.attempt),
    nodeTitle,
    prompt,
    config: freezeNodeConfig(request.config)
  };
}

/** 冻结配置：副本化数组、冻结对象，之后调用方再改自己的对象也影响不到本次执行。 */
function freezeNodeConfig(config: WorkflowChildNodeConfig): WorkflowChildNodeConfig {
  if (!config || typeof config !== "object") throw new Error("工作流节点缺少冻结配置");
  if (!config.model || typeof config.model.provider !== "string" || typeof config.model.id !== "string"
    || !config.model.provider.trim() || !config.model.id.trim()) {
    throw new Error("工作流节点配置缺少模型");
  }
  if (!Array.isArray(config.tools)) throw new Error("工作流节点配置的 tools 必须是数组");
  if (typeof config.thinkingLevel !== "string" || !config.thinkingLevel) throw new Error("工作流节点配置缺少思考等级");
  if (typeof config.systemPrompt !== "string") throw new Error("工作流节点配置缺少冻结的系统提示");
  return Object.freeze({
    nodeId: config.nodeId,
    source: config.source,
    ...(config.subagent === undefined ? {} : { subagent: config.subagent }),
    model: Object.freeze({ provider: config.model.provider, id: config.model.id }),
    thinkingLevel: config.thinkingLevel,
    tools: [...config.tools],
    ...(config.accessModeCap === undefined ? {} : { accessModeCap: config.accessModeCap }),
    browserTools: config.browserTools === true,
    ...(config.injectAgentsMd === undefined ? {} : { injectAgentsMd: config.injectAgentsMd }),
    systemPrompt: config.systemPrompt
  });
}

function resolveChildModel(
  modelRuntime: ModelRuntime,
  target: WorkflowModelRef,
  transform: ((model: Model<Api>) => Model<Api>) | undefined
): Model<Api> {
  const model = modelRuntime.getModel(target.provider, target.id);
  if (!model) throw new Error(`节点模型不可用：${target.provider}/${target.id}`);
  return transform ? transform(model) : model;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function component(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error(`${label} 不是合法的路径标识：${typeof value === "string" ? value : typeof value}`);
  }
  return value;
}

function attemptComponent(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`attempt 必须是正整数：${typeof value === "number" ? value : typeof value}`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
