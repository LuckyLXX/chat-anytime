/**
 * Codex 成员的 `TeamChildSession` 适配器（协议 → 团队事件）。
 *
 * 一个成员 ↔ 一条 app-server 进程 ↔ 一个 Codex thread。适配器只做四件事：
 * 1. **绑定**：首次 `thread/start`，之后 `thread/resume`（线程失效给出具体原因，绝不
 *    静默新建线程把上下文丢掉）；threadId 交给调用方持久化。
 * 2. **回合路由**：`turn/start`（新回合）/ `turn/steer`（运行中追加指令）/
 *    `turn/interrupt`（停止），按 `threadId` + `turnId` 过滤事件；上一轮的迟到终态
 *    不会覆盖新回合（每个回合只结算一次）。
 * 3. **投影**：把 Codex 的通知投影成团队运行时已经在用的 Pi 事件
 *    （agent_start / tool_execution_* / message_end / agent_settled），这样看板、
 *    结算、任务绑定、team_wait 全部沿用既有语义。`failed` 终态用窄的
 *    `pidesktop_run_failed` 事件表达——它不能被记成「已完成」。
 * 4. **转写**：用成员的 `SessionManager` 写 user/assistant 兼容消息（完整条目或整回合
 *    一次写入），`subagent.transcript` 无需为 Codex 另开一条读取路径。
 *
 * 权限边界（首版）：每轮下发的 `sandboxPolicy` 固定 cwd/写入根/网络，`approvalPolicy`
 * 固定为 `never`；服务端请求（审批、提问…）由客户端默认**拒绝**。C 阶段通过
 * `resolveTurnPolicy` 与自定义请求处理器接入真实审批——未接入时这里只会更严，不会更松。
 */

import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  CodexAppServerClient,
  readItemInfo,
  readThreadInfo,
  readTurnInfo,
  type CodexHandshake,
  type CodexItemInfo,
  type CodexThreadInfo,
  type CodexTurnInfo
} from "./codex-app-server.js";
import {
  assertCodexTurnPolicy,
  decideCodexWindowsSandboxReadiness,
  inspectCodexEffectiveConfig,
  isCodexWindowsPlatform,
  readCodexWindowsSandboxReadiness,
  type CodexEffectiveConfigInspection,
  type CodexWindowsSandboxReadiness
} from "./codex-policy.js";
import type { TeamChildEvent, TeamChildListener, TeamChildRunFailedEvent, TeamChildSession } from "./team-runtime.js";

/** 一条 app-server 连接 + 回收进程的出口。 */
export interface CodexConnection {
  client: CodexAppServerClient;
  /** 回收整棵进程树（停止/销毁/半启动失败都走它）。 */
  stop(reason?: string): void;
}

/**
 * 建连接。`onClosed` 由客户端在关闭/进程退出时调用（适配器据此把在途回合判失败），
 * 与 `CodexAppServerOptions.onClose` 是同一个出口。
 */
export type CodexConnectionFactory = (onClosed: (reason: string) => void) => Promise<CodexConnection> | CodexConnection;

/** 有效沙箱（协议字段的最小局部类型；`workspaceWrite` 的写入根固定为工作区）。 */
export type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess?: boolean }
  | { type: "workspaceWrite"; writableRoots?: string[]; networkAccess?: boolean; excludeTmpdirEnvVar?: boolean; excludeSlashTmp?: boolean };

/** 一轮的实际执行策略：C 阶段据此逐轮收紧/放开；首版固定为构造时的只读/工作区写入。 */
export interface CodexTurnPolicy {
  cwd: string;
  sandboxPolicy: CodexSandboxPolicy;
  approvalPolicy: "never" | "on-request";
}

export interface CodexTurnPolicyInput {
  /** initial = 成员首条任务；message = 空闲后新指令；steer = 运行中追加。 */
  turn: "initial" | "message" | "steer";
  text: string;
  /**
   * 本轮需要用户确认时，在**挂卡之前**调用一次。
   *
   * 首轮确认可能等上几分钟（权限卡 10 分钟兜底），而 spawn 的预检只有 30s；
   * 适配器据此先把首条 prompt 按「已受理（排队等授权）」放行，避免用户还没点卡
   * 就被判成创建失败、成员名被永久占掉。
   */
  onAwaitingApproval?(): void;
}

export type CodexTurnPolicyResolver = (input: CodexTurnPolicyInput) => CodexTurnPolicy | Promise<CodexTurnPolicy>;

/** 停止时等「真实终态」的预算；超时即回收进程树（绝不谎报已停止）。 */
export const CODEX_INTERRUPT_CONFIRM_MS = 10_000;
/** 回合请求（turn/start 等）的外层超时：模型回合可能很久，只用于「指令被受理」。 */
export const CODEX_TURN_REQUEST_TIMEOUT_MS = 60_000;

export interface CodexTeamChildOptions {
  memberId: string;
  memberName: string;
  /** 工作区（= Codex 的 cwd；每轮 sandboxPolicy 的写入根）。 */
  workspace: string;
  /** 成员的 SessionManager（转写；与 Pi 成员同一套 JSONL 读法）。 */
  manager: SessionManager;
  /** 建连接（内含进程启动 + 握手）；每次冷恢复一条新进程。 */
  connect: CodexConnectionFactory;
  /** 首版冻结的沙箱：`read-only` / `workspace-write`（后者需 C 的策略已接入）。 */
  sandbox: "read-only" | "workspace-write";
  /** 冻结的批准策略；首版只会是 `never`。 */
  approvalPolicy?: "never" | "on-request";
  /** 可选的 Codex 模型（缺省用用户本机配置的模型）。 */
  model?: string;
  /** 已存在的线程（冷恢复入口）。 */
  threadId?: string;
  /** thread 绑定成功后回调（调用方原子落盘）。 */
  onThreadId?(threadId: string): void;
  /** 逐轮策略解析（授权/有效沙箱/取消）。缺省用构造时冻结的只读/工作区写入。 */
  resolveTurnPolicy?: CodexTurnPolicyResolver;
  // 服务端请求（审批/提问/提权）的处理**不在**这一层：它挂在 `CodexAppServerClient`
  // 的构造参数上（连接由 `connect` 建），见 runtime-codex 的 `decideCodexServerRequest`。
  // 历史上这里留过一个从未接线的同名 option——那是「看起来挡住了、实际没生效」的隐患。
  /** 诊断输出（默认丢弃，由调用方按需接日志）。 */
  log?(level: "info" | "warn", message: string): void;
  /** 停止时等真实终态的预算（缺省 `CODEX_INTERRUPT_CONFIRM_MS`；单测压短）。 */
  interruptConfirmMs?: number;
}

interface TurnState {
  /** Codex 回合 id；`turn/started` 或 `turn/start` 响应都可能先到。 */
  id?: string;
  startedAt: number;
  texts: string[];
  items: Map<string, { toolName: string; startedAt: number }>;
  settled: boolean;
  abortRequested: boolean;
  /** `agent_start` 只发一次（Pi 的事件序是 start → … → settled）。 */
  announced: boolean;
}

interface RunWaiter {
  promise: Promise<void>;
  resolve(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 路径比较口径：Windows 大小写不敏感、反斜杠统一（只用于核对，不改真实路径）。 */
function normalizePathForCompare(path: string): string {
  const unified = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

function clip(text: string, max: number): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/**
 * 构造一条「assistant 消息」给团队运行时消费（它只读 role + 文本块）。
 * 这里不做模型计费/统计：Codex 的用量来自 `thread/tokenUsage/updated`，与 Pi 的
 * usage 结构无关，强行塞进 Pi 的字段只会误导 UI。
 */
function assistantEvent(text: string): AgentSessionEvent {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "codex",
    provider: "codex",
    model: "codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
  return { type: "message_end", message: message as unknown as AgentMessage };
}

/** 一条 Codex ThreadItem 投影成团队时间线上的一步；不产生步骤的 item 返回 undefined。 */
export function toolStepForItem(item: CodexItemInfo): { toolName: string; args: Record<string, unknown> } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { toolName: "commandExecution", args: { ...(item.command ? { command: item.command } : {}) } };
    case "fileChange":
      return { toolName: "fileChange", args: { ...(item.path ? { path: item.path } : {}) } };
    case "mcpToolCall":
      return { toolName: "mcpToolCall", args: {} };
    case "dynamicToolCall":
      return { toolName: "dynamicToolCall", args: {} };
    case "webSearch":
      return { toolName: "webSearch", args: { ...(item.query ? { query: item.query } : {}) } };
    case "imageView":
      return { toolName: "imageView", args: { ...(item.path ? { path: item.path } : {}) } };
    default:
      return undefined;
  }
}

/** item 的状态是否算失败（团队看板用红色步骤 + 结算里的「失败」）。 */
function itemFailed(status: string | undefined): boolean {
  return status === "failed" || status === "declined";
}

/**
 * 一个 Codex 团队成员的子会话。
 *
 * 注意：这里**不注入团队工具/身份提示词**——Codex 成员是执行者，协作走 Lead 的
 * 派发/续发/结算；给它一套它无法调用的 `team_*` 只会浪费上下文并误导模型。
 */
export class CodexTeamChild implements TeamChildSession {
  private readonly listeners = new Set<TeamChildListener>();
  private readonly options: CodexTeamChildOptions;
  private connection?: CodexConnection;
  private client?: CodexAppServerClient;
  private handshake?: CodexHandshake;
  private thread?: CodexThreadInfo;
  /** thread 已经 start/resume 过（光有 id 不够：绑定文件里的 id 还没验证）。 */
  private threadConfirmed = false;
  /** 本连接已经通过运行时隔离校验（Windows readiness + 生效配置）；换进程即失效。 */
  private runtimeVerified = false;
  private turn?: TurnState;
  private turnWaiter?: RunWaiter;
  private queued: string[] = [];
  private closedByUs = false;
  private disposed = false;
  private lastError?: string;
  private toolCalls = 0;
  private totalTokens = 0;
  private contextWindow?: number;
  private lateTurnIds = new Set<string>();

  constructor(options: CodexTeamChildOptions) {
    this.options = options;
    this.thread = options.threadId ? { id: options.threadId } : undefined;
  }

  get isStreaming(): boolean {
    return this.turn !== undefined && !this.turn.settled;
  }

  /** 当前绑定的 Codex thread（线程建立前是恢复值；都没有时 undefined）。 */
  get threadId(): string | undefined {
    return this.thread?.id;
  }

  get handshakeInfo(): CodexHandshake | undefined {
    return this.handshake;
  }

  subscribe(listener: TeamChildListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSessionStats(): { toolCalls: number; tokens: { total: number }; cost: number } {
    return { toolCalls: this.toolCalls, tokens: { total: this.totalTokens }, cost: 0 };
  }

  getContextUsage(): { percent: number | null } | undefined {
    if (!this.contextWindow || this.contextWindow <= 0) return { percent: null };
    return { percent: Math.min(100, Math.round((this.totalTokens / this.contextWindow) * 100)) };
  }

  /** 首条任务：建线程（或恢复）→ 起回合。失败直接抛出（spawn 会记 failed）。 */
  async prompt(
    text: string,
    options?: { expandPromptTemplates?: boolean; preflightResult?: (disposition: "handled" | "queued" | "started") => void }
  ): Promise<void> {
    this.assertUsable();
    await this.dispatch(String(text ?? ""), "initial", {
      onStarted: () => options?.preflightResult?.("started"),
      // 首轮确认一开始就按「已受理、等授权」放行 spawn 的预检（见 CodexTurnPolicyInput）。
      onAwaitingApproval: () => options?.preflightResult?.("queued")
    });
  }

  /**
   * team_send 的投递：运行中追加指令（steer），空闲则起新回合。
   * 「立刻失败」必须 reject（目标线程失效、进程已退），TeamRuntime 据此如实报错；
   * 正常投递返回的 promise 在回合结束时收口（TeamRuntime 只等一个宏任务窗口）。
   */
  sendCustomMessage(
    message: { customType: string; content: { type: "text"; text: string }[]; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ): Promise<void> {
    this.assertUsable();
    const text = (message.content ?? []).map((block) => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n");
    if (!text.trim()) return Promise.reject(new Error("发给 Codex 成员的消息不能为空"));
    const triggerTurn = options?.triggerTurn !== false;
    if (!triggerTurn && !this.isStreaming) {
      // 只入队、不主动起回合（与 Pi 的 triggerTurn:false 同义）。
      this.queued.push(text);
      return Promise.resolve();
    }
    return this.dispatch(text, "message", undefined);
  }

  /**
   * 停止：先 `turn/interrupt`，等真实终态（`turn/completed`）；预算内没有确认就回收
   * 整棵进程树，并按「已中止」只结算一次（过期指令与挂起请求一并丢弃）。
   */
  async abort(): Promise<void> {
    this.queued = [];
    const turn = this.turn;
    const client = this.client;
    if (!turn || turn.settled) return;
    turn.abortRequested = true;
    const threadId = this.thread?.id;
    if (client && !client.isClosed && threadId) {
      // 刚开始的回合可能还没有 turn id（turn/start 尚未返回）：给一个很短的窗口等它，
      // 拿到 id 才能发 interrupt（否则只能走「回收进程」这条路）。
      let turnId = turn.id;
      if (!turnId) {
        await this.waitForTurnId(turn, 2_000);
        turnId = turn.id;
      }
      if (turnId) {
        try {
          await client.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 10_000 });
        } catch (error) {
          this.options.log?.("warn", `Codex turn/interrupt 失败：${errorText(error)}`);
        }
      }
    }
    const confirmed = await this.waitForTurn(this.options.interruptConfirmMs ?? CODEX_INTERRUPT_CONFIRM_MS);
    if (confirmed) return;
    // 没有确认：回收进程树（每个成员至多一条进程，回收后这条成员会话等于被释放）。
    this.stopProcess("停止未在预期时间内确认，已回收 Codex 进程树");
    this.finishTurn("interrupted", "停止未在预期时间内确认，已回收 Codex 进程树");
  }

  /** 等 `turn/start` 的 id 到位（最多 budgetMs）；收口/超时返回。 */
  private async waitForTurnId(turn: TurnState, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!turn.id && !turn.settled && this.turn === turn && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        timer.unref?.();
      });
    }
  }

  /** 连接关闭（进程退出/被回收）：在途回合按「失败」或「已中止」收口一次。 */
  private handleConnectionClosed(reason: string): void {
    if (this.disposed || this.closedByUs) return;
    this.client = undefined;
    this.connection = undefined;
    // 新进程里没有这条线程的内存态：下一次 prompt 必须重新 resume（thread id 仍保留）。
    this.threadConfirmed = false;
    this.runtimeVerified = false;
    this.handshake = undefined;
    const turn = this.turn;
    if (!turn || turn.settled) {
      this.lastError = reason;
      return;
    }
    this.lastError = reason;
    if (turn.abortRequested) this.finishTurn("interrupted", reason);
    else this.finishTurn("failed", `Codex 进程已退出：${reason}`);
  }

  /** 清掉排队指令（Pi 的 abort 不清 steering/followUp；Codex 侧同样要显式清）。 */
  clearQueue(): void {
    this.queued = [];
  }

  /** 释放：回收进程、断开监听（不删会话文件/线程）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queued = [];
    this.stopProcess("成员子会话已释放");
    this.listeners.clear();
    if (this.turn && !this.turn.settled) this.finishTurn("interrupted", "成员子会话已释放", { emit: false });
  }

  // ── 内部：连接 / 线程 ─────────────────────────────────────────────────

  private assertUsable(): void {
    if (this.disposed) throw new Error(`Codex 成员「${this.options.memberName}」的子会话已释放`);
  }

  private async ensureClient(): Promise<CodexAppServerClient> {
    if (this.client && !this.client.isClosed && this.runtimeVerified) return this.client;
    this.stopProcess("重建 Codex 连接");
    let connection: CodexConnection;
    try {
      connection = await this.options.connect((reason) => this.handleConnectionClosed(reason));
    } catch (error) {
      throw new Error(`无法启动 Codex 成员「${this.options.memberName}」的进程：${errorText(error)}`);
    }
    // connect 是异步的：等进程期间会话可能已被释放。此时立刻回收刚建的连接，绝不继续派发。
    if (this.disposed) {
      try {
        connection.stop("成员子会话已释放");
      } catch {
        // best-effort
      }
      throw new Error(`Codex 成员「${this.options.memberName}」的子会话已释放`);
    }
    this.connection = connection;
    const client = connection.client;
    this.client = client;
    client.onNotification((method, params) => this.handleNotification(method, params));
    try {
      this.handshake = await client.handshake();
    } catch (error) {
      this.stopProcess("Codex 握手失败");
      if (this.disposed) throw new Error(`Codex 成员「${this.options.memberName}」的子会话已释放`);
      throw new Error(`Codex 握手失败（成员「${this.options.memberName}」）：${errorText(error)}`);
    }
    try {
      await this.verifyRuntimeIsolation(client);
      this.assertUsable();
      return client;
    } catch (error) {
      if (this.client === client) this.stopProcess("Codex 运行时隔离校验未通过");
      throw error;
    }
  }

  /**
   * 建线程**之前**的运行时隔离校验（每个连接一次）：
   *
   * 1. Windows：真实的 `windowsSandbox/readiness` 握手（无参数）必须是 `ready`。
   *    Windows 上的只读也依赖 Codex 自己的沙箱，因此**两种访问级别**都在这里拦下；
   * 2. 所有平台：`config/read`（带本次 cwd）的**生效**配置里，hooks/apps/plugins 必须
   *    已关闭、MCP 服务器必须全部禁用、notify 必须是空数组——只靠启动参数与静态
   *    config.toml 扫描证明不了用户/项目层的实际生效值，这里 fail closed。
   */
  private async verifyRuntimeIsolation(client: CodexAppServerClient): Promise<void> {
    if (this.runtimeVerified) return;
    const name = this.options.memberName;
    if (this.handshake && isCodexWindowsPlatform(this.handshake)) {
      let readiness: CodexWindowsSandboxReadiness | undefined;
      let error: string | undefined;
      try {
        readiness = readCodexWindowsSandboxReadiness(await client.readWindowsSandboxReadiness());
      } catch (readinessError) {
        error = errorText(readinessError);
      }
      const decision = decideCodexWindowsSandboxReadiness({
        ...(readiness ? { readiness } : {}),
        ...(error ? { error } : {})
      });
      if (!decision.ok) throw new Error(`Codex 运行时隔离校验失败（成员「${name}」）：${decision.reason}`);
    }
    let inspection: CodexEffectiveConfigInspection;
    try {
      inspection = inspectCodexEffectiveConfig(await client.readEffectiveConfig(this.options.workspace));
    } catch (configError) {
      throw new Error(
        `Codex 运行时隔离校验失败（成员「${name}」）：无法读取生效配置（config/read：${errorText(configError)}），` +
        "不能确认钩子/插件/Apps/MCP/notify 已关闭，已拦下本回合"
      );
    }
    if (!inspection.ok) throw new Error(`Codex 运行时隔离校验失败（成员「${name}」）：${inspection.reason}`);
    this.runtimeVerified = true;
  }

  /**
   * 线程返回值的**核对**（attestation）：真实 schema 的 thread/start|resume 响应带
   * `cwd` / `approvalPolicy` / `sandbox`。字段存在却不符（换了 cwd、审批策略不是 never、
   * 沙箱不是只读）就立刻失败——线程本身的姿态永远只读，写入只经每轮显式 sandboxPolicy。
   */
  private attestThread(info: CodexThreadInfo, action: string): void {
    const expectedCwd = normalizePathForCompare(this.options.workspace);
    if (info.cwd) {
      const actualCwd = normalizePathForCompare(info.cwd);
      if (actualCwd !== expectedCwd) {
        throw new Error(`${action} 返回的 cwd 不是当前工作区（期望 ${this.options.workspace}，实际 ${info.cwd}）`);
      }
    }
    if (info.approvalPolicy && info.approvalPolicy !== "never") {
      throw new Error(`${action} 返回的 approvalPolicy 不是 never（实际 ${info.approvalPolicy}）：不允许 Codex 自行升级权限`);
    }
    if (info.sandboxType && info.sandboxType !== "readOnly") {
      throw new Error(`${action} 返回的 sandbox 不是 readOnly（实际 ${info.sandboxType}）：线程必须以只读建立`);
    }
  }

  private async ensureThread(client: CodexAppServerClient): Promise<CodexThreadInfo> {
    if (this.thread?.id && this.threadConfirmed) return this.thread;
    // 线程**永远**以只读 + approvalPolicy never 建立：写入权限只由每轮 `turn/start` 的
    // 显式 `sandboxPolicy` 授权（工作区写入时再核对 writableRoots 与排除项）。
    const base = {
      cwd: this.options.workspace,
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
      ...(this.options.model ? { model: this.options.model } : {})
    };
    try {
      if (this.thread?.id) {
        const resumed = readThreadInfo(await client.request("thread/resume", { threadId: this.thread.id, ...base }, { timeoutMs: CODEX_TURN_REQUEST_TIMEOUT_MS }));
        if (!resumed) throw new Error("thread/resume 返回缺少 thread id");
        this.attestThread(resumed, "thread/resume");
        this.thread = resumed;
        this.threadConfirmed = true;
        return resumed;
      }
      const started = readThreadInfo(await client.request("thread/start", base, { timeoutMs: CODEX_TURN_REQUEST_TIMEOUT_MS }));
      if (!started) throw new Error("thread/start 返回缺少 thread id");
      this.attestThread(started, "thread/start");
      this.thread = started;
      this.threadConfirmed = true;
      this.options.onThreadId?.(started.id);
      return started;
    } catch (error) {
      const reason = errorText(error);
      const message = this.thread?.id
        ? `Codex 线程恢复失败（成员「${this.options.memberName}」，thread ${this.thread.id}）：${reason}。原转写已保留；可以在设置里检查 Codex CLI 与登录状态，或新建成员重试。`
        : `Codex 线程创建失败（成员「${this.options.memberName}」）：${reason}`;
      this.lastError = message;
      throw new Error(message);
    }
  }

  // ── 内部：回合 ───────────────────────────────────────────────────────

  private async resolvePolicy(input: CodexTurnPolicyInput): Promise<CodexTurnPolicy> {
    if (this.options.resolveTurnPolicy) return await this.options.resolveTurnPolicy(input);
    return {
      cwd: this.options.workspace,
      approvalPolicy: this.options.approvalPolicy ?? "never",
      sandboxPolicy: this.options.sandbox === "workspace-write"
        ? {
          type: "workspaceWrite",
          writableRoots: [this.options.workspace],
          networkAccess: false,
          // 显式排除隐式临时目录写入：可写范围就是这个工作区。
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true
        }
        : { type: "readOnly", networkAccess: false }
    };
  }

  private async dispatch(
    text: string,
    kind: "initial" | "message",
    hooks: { onStarted?(): void; onAwaitingApproval?(): void } = {}
  ): Promise<void> {
    const client = await this.ensureClient();
    this.assertUsable();
    const thread = await this.ensureThread(client);
    this.assertUsable();
    if (this.turn && !this.turn.settled) {
      // 运行中追加：必须带 expectedTurnId，否则 Codex 会拒绝（旧实现的静默丢失点）。
      const expectedTurnId = this.turn.id;
      if (!expectedTurnId) {
        // turn/start 还没返回（id 未知）：先入队，等 id 到位后按 steer 补发。
        this.queued.push(text);
        return this.awaitCurrentTurn();
      }
      await client.request("turn/steer", {
        threadId: thread.id,
        expectedTurnId,
        input: [{ type: "text", text }]
      }, { timeoutMs: CODEX_TURN_REQUEST_TIMEOUT_MS });
      this.assertUsable();
      this.appendUserTranscript(text);
      hooks.onStarted?.();
      return this.awaitCurrentTurn();
    }
    const policy = await this.resolvePolicy({
      turn: kind,
      text,
      ...(hooks.onAwaitingApproval ? { onAwaitingApproval: hooks.onAwaitingApproval } : {})
    });
    // 策略解析可能包含用户审批（几分钟）：结束后会话可能已被释放/替换，绝不继续派发。
    this.assertUsable();
    // 侧效边界的最后一道闸：裁决结果必须是自洽的，且**不许超过**成员编制冻结的上限。
    const access = policy.sandboxPolicy.type === "workspaceWrite" ? "workspace-write" : "read-only";
    if (access === "workspace-write" && this.options.sandbox !== "workspace-write") {
      throw new Error(`Codex 成员的访问上限是「${this.options.sandbox}」：本轮不能以工作区写入执行`);
    }
    assertCodexTurnPolicy(policy, { access, workspace: this.options.workspace });
    const state: TurnState = { startedAt: Date.now(), texts: [], items: new Map(), settled: false, abortRequested: false, announced: false };
    this.turn = state;
    this.appendUserTranscript(text);
    let response: unknown;
    try {
      response = await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text }],
        cwd: policy.cwd,
        sandboxPolicy: policy.sandboxPolicy,
        approvalPolicy: policy.approvalPolicy
      }, { timeoutMs: CODEX_TURN_REQUEST_TIMEOUT_MS });
    } catch (error) {
      if (this.turn === state) {
        this.turn = undefined;
        this.failRun(errorText(error));
      }
      throw new Error(`Codex 回合启动失败：${errorText(error)}`);
    }
    if (this.disposed) {
      // 极端竞态：turn/start 已被受理但会话刚被释放（进程已回收），按中止收口一次。
      if (this.turn === state) this.finishTurn("interrupted", "成员子会话已释放");
      throw new Error(`Codex 成员「${this.options.memberName}」的子会话已释放`);
    }
    const turnInfo = readTurnInfo(response);
    if (turnInfo && !state.id) state.id = turnInfo.id;
    // `turn/started` 通知可能比响应先到、也可能后到（甚至只来一个）：回合一旦被受理，
    // 必须保证团队运行时收到一次 agent_start，否则它不会为这个回合开账（结算会丢）。
    this.announceTurn(state);
    hooks.onStarted?.();
    // 回合前排队/未拿到 turn id 的追加指令：现在有 id 了，按顺序补发。
    this.flushQueue(state);
    return this.awaitCurrentTurn();
  }

  /** 发一次 agent_start（同一回合只发一次；已收口/已过期回合不发）。 */
  private announceTurn(turn: TurnState): void {
    if (turn.announced || turn.settled || this.turn !== turn) return;
    turn.announced = true;
    this.emit({ type: "agent_start" });
  }

  /**
   * 把排队中的追加指令按顺序补发（拿到 turn id 之后）。
   *
   * 两个入队来源：turn/start 尚未返回时到达的 steer、以及 `triggerTurn:false` 的
   * 后续消息。旧实现只入队不出队——这些消息会永久停在内存里（用户看不见也发不出）。
   */
  private flushQueue(turn: TurnState): void {
    if (this.queued.length === 0) return;
    const client = this.client;
    const threadId = this.thread?.id;
    if (!client || client.isClosed || !threadId || !turn.id || turn.settled) return;
    const pending = this.queued.splice(0);
    void (async () => {
      for (const text of pending) {
        if (this.disposed || this.turn !== turn || turn.settled) return;
        try {
          await client.request("turn/steer", {
            threadId,
            expectedTurnId: turn.id,
            input: [{ type: "text", text }]
          }, { timeoutMs: CODEX_TURN_REQUEST_TIMEOUT_MS });
          this.appendUserTranscript(text);
        } catch (error) {
          // 回合可能刚好收口：迟到追加投不进去不影响结算，只留诊断。
          this.options.log?.("warn", `Codex 排队指令投递失败：${errorText(error)}`);
        }
      }
    })();
  }

  private awaitCurrentTurn(): Promise<void> {
    if (!this.turn || this.turn.settled) return Promise.resolve();
    if (this.turnWaiter) return this.turnWaiter.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((res) => { resolve = res; });
    this.turnWaiter = { promise, resolve };
    return promise;
  }

  /** 等当前回合收口；超时返回 false（调用方决定是否回收进程）。 */
  private async waitForTurn(timeoutMs: number): Promise<boolean> {
    const waiter = this.turnWaiter;
    if (!waiter) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      void waiter.promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** 回合收口：写结算一次，解析等待者，清状态（重复调用无副作用）。 */
  private finishTurn(outcome: "completed" | "interrupted" | "failed", error?: string, options: { emit?: boolean } = {}): void {
    const turn = this.turn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    this.turn = undefined;
    if (turn.id) this.lateTurnIds.add(turn.id);
    const text = turn.texts.join("\n\n").trim();
    if (text) {
      // message_end 已在 item/completed（或 completeTurn 从 turn.items 的兜底提取）里发过：
      // 这里只落转写，不再重复发一条会让看板出现两个「最新回报」的事件。
      this.appendAssistantTranscript(text, outcome === "failed" ? "error" : outcome === "interrupted" ? "aborted" : "stop", error);
    } else if (outcome === "failed" && error) {
      this.appendAssistantTranscript("", "error", error);
    }
    if (options.emit !== false) {
      if (outcome === "failed") {
        const event: TeamChildRunFailedEvent = { type: "pidesktop_run_failed", error: error ?? "Codex 回合失败" };
        this.emit(event);
      } else {
        this.emit({ type: "agent_settled", aborted: outcome === "interrupted" });
      }
    }
    const waiter = this.turnWaiter;
    this.turnWaiter = undefined;
    waiter?.resolve();
  }

  private failRun(error: string): void {
    const waiter = this.turnWaiter;
    this.turnWaiter = undefined;
    this.lastError = error;
    waiter?.resolve();
  }

  private stopProcess(reason: string): void {
    const connection = this.connection;
    const client = this.client;
    this.connection = undefined;
    this.client = undefined;
    // 进程一换，线程确认态与握手就失效：thread id 仍保留，下一次必须重新 resume。
    // 漏掉这一步，重建连接后的第一个回合会直接 `turn/start` 在一个没加载线程的新进程上。
    this.threadConfirmed = false;
    this.runtimeVerified = false;
    this.handshake = undefined;
    try {
      // 先关客户端：挂起请求以 closed 收场（onClose 会回调 handleConnectionClosed，
      // 这里用 closedByUs 标记避免把「主动停止」记成进程崩溃）。
      this.closedByUs = true;
      client?.close(reason);
    } catch {
      // best-effort
    } finally {
      this.closedByUs = false;
    }
    try {
      connection?.stop(reason);
    } catch {
      // best-effort：主进程退出路径会兜底回收。
    }
  }

  // ── 内部：事件处理 ───────────────────────────────────────────────────

  private emit(event: TeamChildEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        (listener as (event: unknown) => void)(event);
      } catch (error) {
        this.options.log?.("warn", `团队事件监听器抛错：${errorText(error)}`);
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.disposed) return;
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
    if (threadId && this.thread?.id && threadId !== this.thread.id) return;
    switch (method) {
      case "turn/started": {
        const info = readTurnInfo(params);
        if (!info) return;
        this.beginTurn(info);
        return;
      }
      case "turn/completed": {
        const info = readTurnInfo(params);
        if (!info) return;
        this.completeTurn(info, params);
        return;
      }
      case "item/started": {
        this.startItem(params);
        return;
      }
      case "item/completed": {
        this.completeItem(params);
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = record.tokenUsage && typeof record.tokenUsage === "object" ? record.tokenUsage as Record<string, unknown> : undefined;
        const last = usage?.last && typeof usage.last === "object" ? usage.last as Record<string, unknown> : undefined;
        const total = usage?.total && typeof usage.total === "object" ? usage.total as Record<string, unknown> : undefined;
        const totalTokens = typeof last?.totalTokens === "number" ? last.totalTokens : typeof total?.totalTokens === "number" ? total.totalTokens : undefined;
        if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) this.totalTokens = totalTokens;
        const window = typeof usage?.modelContextWindow === "number" ? usage.modelContextWindow : undefined;
        if (window && Number.isFinite(window)) this.contextWindow = window;
        return;
      }
      case "error": {
        const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
        const message = typeof error?.message === "string" ? error.message : "Codex 回合报错";
        this.lastError = message;
        this.options.log?.("warn", `Codex 成员「${this.options.memberName}」：${message}`);
        return;
      }
      case "warning": {
        const message = typeof record.message === "string" ? record.message : undefined;
        if (message) this.options.log?.("warn", `Codex 警告：${clip(message, 300)}`);
        return;
      }
      default:
        return;
    }
  }

  private beginTurn(info: CodexTurnInfo): void {
    const turn = this.turn;
    if (!turn) {
      // 没有在途回合的 turn/started = 上一轮/别的线程的迟到帧。
      this.lateTurnIds.add(info.id);
      return;
    }
    if (turn.id && turn.id !== info.id) {
      this.lateTurnIds.add(info.id);
      return;
    }
    if (this.lateTurnIds.has(info.id)) return;
    turn.id = info.id;
    this.announceTurn(turn);
    this.flushQueue(turn);
  }

  private completeTurn(info: CodexTurnInfo, params?: unknown): void {
    const turn = this.turn;
    if (!turn) {
      this.lateTurnIds.add(info.id);
      return;
    }
    if (turn.id && turn.id !== info.id) {
      // 上一轮的终态不能覆盖新回合。
      this.lateTurnIds.add(info.id);
      return;
    }
    if (this.lateTurnIds.has(info.id)) return;
    turn.id = info.id;
    // 有些版本只在 turn/completed 的 items 里带最终文本（没有 item/completed 通知）：
    // 没有收到过 agentMessage 时从这里补一次 message_end，别让结算缺「短结论」。
    if (turn.texts.length === 0 && params && typeof params === "object") {
      const record = params as Record<string, unknown>;
      const turnPayload = record.turn && typeof record.turn === "object" ? record.turn as Record<string, unknown> : undefined;
      const items = Array.isArray(turnPayload?.items) ? turnPayload.items : [];
      const texts = items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .filter((item) => item.type === "agentMessage" && typeof item.text === "string")
        .map((item) => item.text as string)
        .filter((text) => text.trim());
      if (texts.length > 0) {
        turn.texts.push(...texts);
        this.emit(assistantEvent(texts.join("\n\n")));
      }
    }
    const outcome = info.status === "completed" ? "completed" : info.status === "interrupted" ? "interrupted" : info.status === "failed" ? "failed" : undefined;
    if (!outcome) return; // inProgress：等真正的终态
    this.finishTurn(outcome, info.error);
  }

  private startItem(params: unknown): void {
    const turn = this.turn;
    if (!turn) return;
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    if (typeof record.turnId === "string" && turn.id && record.turnId !== turn.id) return;
    const item = readItemInfo(params);
    if (!item) return;
    const step = toolStepForItem(item);
    if (!step) return;
    this.toolCalls += 1;
    turn.items.set(item.id, { toolName: step.toolName, startedAt: Date.now() });
    this.emit({ type: "tool_execution_start", toolCallId: item.id, toolName: step.toolName, args: step.args });
  }

  private completeItem(params: unknown): void {
    const turn = this.turn;
    if (!turn) return;
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    if (typeof record.turnId === "string" && turn.id && record.turnId !== turn.id) return;
    const item = readItemInfo(params);
    if (!item) return;
    if (item.type === "agentMessage") {
      const text = item.text ?? "";
      if (text.trim()) {
        turn.texts.push(text);
        this.emit(assistantEvent(text));
      }
      return;
    }
    const step = toolStepForItem(item);
    if (!step) return;
    const open = turn.items.get(item.id);
    const startedAt = open?.startedAt ?? Date.now();
    turn.items.delete(item.id);
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (!open) {
      // 只看到 end（没看到 start）：补一条 start，让看板的步骤序号能对上。
      this.toolCalls += 1;
      this.emit({ type: "tool_execution_start", toolCallId: item.id, toolName: step.toolName, args: step.args });
    }
    this.emit({
      type: "tool_execution_end",
      toolCallId: item.id,
      toolName: step.toolName,
      result: item.type === "fileChange" && item.status === "completed" ? { changedPaths: item.changedPaths ?? [] } : undefined,
      isError: itemFailed(item.status),
      durationMs
    });
  }

  // ── 内部：转写 ───────────────────────────────────────────────────────

  private appendUserTranscript(text: string): void {
    try {
      this.options.manager.appendMessage({ role: "user", content: text, timestamp: Date.now() } as never);
    } catch (error) {
      this.options.log?.("warn", `写入成员转写失败（user）：${errorText(error)}`);
    }
  }

  private appendAssistantTranscript(text: string, stopReason: "stop" | "aborted" | "error", error?: string): void {
    try {
      this.options.manager.appendMessage({
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        api: "codex",
        provider: "codex",
        model: this.thread?.model ?? "codex",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason,
        ...(error ? { errorMessage: error } : {}),
        timestamp: Date.now()
      } as never);
    } catch (writeError) {
      this.options.log?.("warn", `写入成员转写失败（assistant）：${errorText(writeError)}`);
    }
  }
}
