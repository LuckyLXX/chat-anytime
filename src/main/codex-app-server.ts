/**
 * Codex App Server 的 **JSONL / JSON-RPC 客户端**（utility 侧语义层）。
 *
 * 传输由主进程的受监管子进程提供（见 `codex-process.ts`）；这里只关心帧：
 * - 严格按 `\n` 分帧，跨 chunk 的半个 JSON 帧、跨 chunk 的 UTF-8 多字节字符都要能接上；
 * - 每个请求分配唯一 id、带超时，响应按 id 归位；**未知 id 的迟到响应直接丢弃**
 *   （上一轮/上一进程的残留帧不能改动新状态）；
 * - 通知（notification）与响应可以任意交错：握手响应到达之前就到的通知先缓冲，
 *   握手完成后按到达顺序补发，不丢、不乱序；
 * - 未知通知方法只计数、不报错（协议会随版本演进）；未知的服务端请求（审批、提问、
 *   MCP elicitation）默认回 JSON-RPC 错误 —— **绝不 fail open**（C 阶段接入真实审批前，
 *   任何「请求方等待客户端点头」的东西都必须被明确拒绝，而不是悬挂）；
 * - 单帧上限、缓冲上限、stderr 尾部上限都有边界，超限只影响那一帧。
 *
 * 协议字段只保留实际用到的最小局部类型（Thread / Turn / ThreadItem 子集）。字段名与
 * 形状按本机 `codex app-server generate-json-schema --out <dir>` 生成的 schema 核对
 * （`ClientRequest.json` 的 `thread/start`、`thread/resume`、`turn/start`、`turn/steer`、
 * `turn/interrupt`、`account/read`；`ServerNotification.json` 的 `turn/started`、
 * `turn/completed`、`item/started`、`item/completed`；`ClientNotification.json` 的
 * `initialized`）。计划里对照的 0.146.0 与实测机器上的 0.171.0 在这些字段上一致；
 * 版本差异通过初始化握手的 `userAgent` 与错误码体现，不做魔法兼容。
 */

/** 单帧 JSONL 文本上限（超过的帧被丢弃并计数，不阻断后续帧）。 */
export const CODEX_MAX_FRAME_CHARS = 8 * 1024 * 1024;
/** 未分帧缓冲上限：超过就进入「丢弃到下一个换行」状态，防止无换行的垃圾流吃内存。 */
export const CODEX_MAX_BUFFER_CHARS = CODEX_MAX_FRAME_CHARS + 64 * 1024;
/** 默认请求超时（回合类请求单独给更长预算）。 */
export const CODEX_REQUEST_TIMEOUT_MS = 30_000;
/** 握手（initialize + initialized + account/read）的总预算。 */
export const CODEX_HANDSHAKE_TIMEOUT_MS = 20_000;

export interface CodexClientInfo {
  name: string;
  title?: string;
  version: string;
}

export type CodexAuthStatus =
  /** ChatGPT 登录（plan 只是套餐标识，**不带邮箱等身份信息**）。 */
  | { state: "signed-in"; plan?: string }
  /** API key 账号。 */
  | { state: "api-key" }
  /** 需要 OpenAI 登录但当前没登录。 */
  | { state: "signed-out" }
  /** 当前配置不需要 OpenAI 登录（例如自定义 provider）。 */
  | { state: "not-required" }
  | { state: "unknown" };

export interface CodexHandshake {
  /** initialize 返回的 userAgent（`<client>/<version> (<platform>)…`）。 */
  userAgent: string;
  platformFamily: string;
  platformOs: string;
  codexHome: string;
  auth: CodexAuthStatus;
  /** account/read 失败时的可读原因（连接本身仍算成功）。 */
  accountError?: string;
}

export interface CodexServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

/** 服务端请求的处理结果：`error` = 明确拒绝（默认），`result` = 只给 C 阶段接的真实审批用。 */
export type CodexServerRequestDecision =
  | { kind: "error"; code?: number; message: string }
  | { kind: "result"; result: unknown };

export type CodexRpcErrorKind = "timeout" | "closed" | "incompatible" | "rpc" | "frame";

export class CodexRpcError extends Error {
  constructor(
    readonly kind: CodexRpcErrorKind,
    message: string,
    readonly method?: string,
    readonly code?: number
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export interface CodexAppServerOptions {
  /** 写一帧到子进程 stdin（必须自己补 `\n`，这里统一在 `notify`/`request` 里做）。 */
  write(frame: string): void;
  clientInfo?: CodexClientInfo;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxFrameChars?: number;
  /** 关闭时的宿主回调：回收进程树（停止/超时/销毁都会经过这里）。 */
  onClose?(reason: string): void;
  /** 诊断：协议层异常（坏帧、未知响应）。生产侧只记日志，不抛给回合。 */
  onProtocolError?(message: string): void;
  /** stderr 尾部（诊断用）。 */
  onStderr?(message: string): void;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcInbound {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 从 initialize 的返回里取协议版本信息；缺字段即视为不兼容（不猜默认值）。 */
export function readHandshake(value: unknown): { userAgent: string; platformFamily: string; platformOs: string; codexHome: string } | undefined {
  if (!isRecord(value)) return undefined;
  const userAgent = typeof value.userAgent === "string" ? value.userAgent : undefined;
  const codexHome = typeof value.codexHome === "string" ? value.codexHome : undefined;
  const platformOs = typeof value.platformOs === "string" ? value.platformOs : undefined;
  const platformFamily = typeof value.platformFamily === "string" ? value.platformFamily : undefined;
  if (!userAgent || !codexHome || !platformOs || !platformFamily) return undefined;
  return { userAgent, platformFamily, platformOs, codexHome };
}

/** account/read 的最小投影：只出状态，不带邮箱/用户名等身份信息。 */
export function readAuthStatus(value: unknown): CodexAuthStatus {
  if (!isRecord(value)) return { state: "unknown" };
  const account = value.account;
  if (isRecord(account) && typeof account.type === "string") {
    if (account.type === "chatgpt") {
      const plan = typeof account.planType === "string" ? account.planType : undefined;
      return plan ? { state: "signed-in", plan } : { state: "signed-in" };
    }
    if (account.type === "apiKey") return { state: "api-key" };
    return { state: "signed-in" };
  }
  if (value.requiresOpenaiAuth === true) return { state: "signed-out" };
  if (value.requiresOpenaiAuth === false) return { state: "not-required" };
  return { state: "unknown" };
}

/** thread/start|resume 的返回投影（只取团队要用的字段）。 */
export interface CodexThreadInfo {
  id: string;
  cliVersion?: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  /** thread/start|resume 返回的生效审批策略（schema 里是必填；旧版缺失时 undefined）。 */
  approvalPolicy?: string;
  /** 返回的生效沙箱类型（`readOnly` / `workspaceWrite` / …）。 */
  sandboxType?: string;
}

export function readThreadInfo(value: unknown): CodexThreadInfo | undefined {
  if (!isRecord(value)) return undefined;
  const thread = isRecord(value.thread) ? value.thread : undefined;
  const id = typeof thread?.id === "string" ? thread.id : undefined;
  if (!id) return undefined;
  const sandbox = isRecord(value.sandbox) ? value.sandbox : isRecord(thread?.sandbox) ? thread.sandbox : undefined;
  return {
    id,
    ...(typeof thread?.cliVersion === "string" ? { cliVersion: thread.cliVersion } : {}),
    ...(typeof thread?.cwd === "string" ? { cwd: thread.cwd } : typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : typeof thread?.model === "string" ? { model: thread.model } : {}),
    ...(typeof value.modelProvider === "string" ? { modelProvider: value.modelProvider } : {}),
    ...(typeof value.approvalPolicy === "string" ? { approvalPolicy: value.approvalPolicy } : {}),
    ...(typeof sandbox?.type === "string" ? { sandboxType: sandbox.type } : {})
  };
}

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface CodexTurnInfo {
  id: string;
  status: CodexTurnStatus;
  error?: string;
}

const TURN_STATUSES: readonly CodexTurnStatus[] = ["completed", "interrupted", "failed", "inProgress"];

export function readTurnInfo(value: unknown): CodexTurnInfo | undefined {
  if (!isRecord(value)) return undefined;
  const turn = isRecord(value.turn) ? value.turn : undefined;
  const id = typeof turn?.id === "string" ? turn.id : undefined;
  const status = typeof turn?.status === "string" && (TURN_STATUSES as readonly string[]).includes(turn.status)
    ? turn.status as CodexTurnStatus
    : undefined;
  if (!id || !status) return undefined;
  const error = isRecord(turn?.error) && typeof turn.error.message === "string" ? turn.error.message : undefined;
  return { id, status, ...(error ? { error } : {}) };
}

/** ThreadItem 的最小投影：类型 + 时间线要展示的少量字段。 */
export interface CodexItemInfo {
  id: string;
  type: string;
  text?: string;
  command?: string;
  status?: string;
  path?: string;
  changedPaths?: string[];
  query?: string;
}

export function readItemInfo(value: unknown): CodexItemInfo | undefined {
  if (!isRecord(value)) return undefined;
  const item = isRecord(value.item) ? value.item : undefined;
  const id = typeof item?.id === "string" ? item.id : undefined;
  const type = typeof item?.type === "string" ? item.type : undefined;
  if (!id || !type) return undefined;
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const changedPaths = changes.flatMap((change) => isRecord(change) && typeof change.path === "string" ? [change.path] : []).slice(0, 32);
  const path = changedPaths[0] ?? (typeof item?.path === "string" ? item.path : undefined);
  return {
    id,
    type,
    ...(typeof item?.text === "string" ? { text: item.text } : {}),
    ...(typeof item?.command === "string" ? { command: item.command } : {}),
    ...(typeof item?.status === "string" ? { status: item.status } : {}),
    ...(path ? { path } : {}),
    ...(changedPaths.length ? { changedPaths } : {}),
    ...(typeof item?.query === "string" ? { query: item.query } : {})
  };
}

/**
 * 一条 app-server 连接（一个成员进程一条）。
 *
 * 生命周期：`handshake()` → 若干个 `request()`/`notify()` → `pushStdout/pushStderr/exit`
 * 由宿主喂入 → `close()`（拒绝所有挂起请求 + 让宿主回收进程树）。
 */
export class CodexAppServerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly requestHandler: (request: CodexServerRequest) => CodexServerRequestDecision;
  private readonly protocolError: (message: string) => void;
  private readonly stderrListener: (message: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxFrameChars: number;
  /** 未分帧缓冲上限：超过就进入「丢弃到下一个换行」状态，防止无换行的垃圾流吃内存。 */
  private readonly maxBufferChars: number;
  private buffer = "";
  private discardingOversizedFrame = false;
  private seq = 0;
  private closed = false;
  private closeReason?: string;
  private handshakeStarted = false;
  private handshakeDone = false;
  private bufferedNotifications: Array<{ method: string; params: unknown }> = [];
  private unknownNotifications = 0;
  private stderrTail = "";

  constructor(private readonly options: CodexAppServerOptions, requestHandler?: (request: CodexServerRequest) => CodexServerRequestDecision) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? CODEX_HANDSHAKE_TIMEOUT_MS;
    this.maxFrameChars = options.maxFrameChars ?? CODEX_MAX_FRAME_CHARS;
    // 缓冲上限跟随单帧上限（测试注入小帧上限时也能触发丢弃路径），缺省仍是同一个常量。
    this.maxBufferChars = this.maxFrameChars + 64 * 1024;
    this.protocolError = options.onProtocolError ?? (() => undefined);
    this.stderrListener = options.onStderr ?? (() => undefined);
    this.requestHandler = requestHandler ?? defaultServerRequestDecision;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  /** 未知通知方法的计数（诊断：协议漂移的第一个信号）。 */
  get unknownNotificationCount(): number {
    return this.unknownNotifications;
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /**
   * 握手：initialize → initialized → account/read。
   *
   * `account/read` 用 `refreshToken:false`：测试连接只读状态，**不刷新令牌、
   * 不触发任何模型调用**（计划明确限定）。account 读取失败不算连接失败（协议已通）。
   */
  async handshake(): Promise<CodexHandshake> {
    if (this.handshakeStarted) throw new CodexRpcError("incompatible", "Codex 连接已握手，不能重复 initialize");
    this.handshakeStarted = true;
    const info = this.options.clientInfo ?? { name: "pidesktop", version: "1" };
    let result: unknown;
    try {
      result = await this.request(
        "initialize",
        { clientInfo: { name: info.name, title: info.title ?? info.name, version: info.version } },
        { timeoutMs: this.handshakeTimeoutMs }
      );
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32601) {
        throw new CodexRpcError(
          "incompatible",
          "该 Codex 版本不支持 app-server 协议（没有 initialize 方法）：请升级 Codex CLI 后重试",
          "initialize",
          error.code
        );
      }
      throw error;
    }
    const handshake = readHandshake(result);
    if (!handshake) {
      throw new CodexRpcError("incompatible", "Codex app-server 的 initialize 返回缺少协议字段（userAgent/codexHome/platformOs），无法确认兼容性", "initialize");
    }
    this.notify("initialized");
    this.handshakeDone = true;
    for (const notification of this.bufferedNotifications.splice(0)) this.dispatchNotification(notification.method, notification.params);
    let auth: CodexAuthStatus = { state: "unknown" };
    let accountError: string | undefined;
    try {
      auth = readAuthStatus(await this.request("account/read", { refreshToken: false }, { timeoutMs: this.handshakeTimeoutMs }));
    } catch (error) {
      accountError = errorText(error);
    }
    return { ...handshake, auth, ...(accountError ? { accountError } : {}) };
  }

  /**
   * `windowsSandbox/readiness`（无参数：schema 里 `params` 为 null / 可省略）。
   *
   * 返回原始结果，由策略层（`codex-policy.readCodexWindowsSandboxReadiness`）裁决档位；
   * 方法不存在 / RPC 错误由调用方按「证明不了就不放行」处理。
   */
  readWindowsSandboxReadiness(): Promise<unknown> {
    return this.request("windowsSandbox/readiness", undefined, { timeoutMs: this.requestTimeoutMs });
  }

  /** `config/read`：读**生效**配置（含 cwd 的项目层），隔离检查据此 fail closed。 */
  readEffectiveConfig(cwd: string): Promise<unknown> {
    return this.request("config/read", { cwd, includeLayers: false }, { timeoutMs: this.requestTimeoutMs });
  }

  /** 发一个请求并等响应；超时/关闭/JSON-RPC error 都以 CodexRpcError 抛出。 */
  request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) {
      return Promise.reject(new CodexRpcError("closed", this.closeReason ?? "Codex 连接已关闭", method));
    }
    this.seq += 1;
    const id = `r${this.seq}`;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError("timeout", `Codex 请求超时（${method}，${Math.round(timeoutMs / 1000)} 秒无响应）`, method));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject
      });
      try {
        this.options.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CodexRpcError("closed", `写入 Codex 进程失败：${errorText(error)}`, method));
      }
    });
  }

  /** 发通知（不需要响应）。连接已关闭时安全丢弃。 */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.options.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
    } catch (error) {
      this.protocolError(`写入 Codex 进程失败：${errorText(error)}`);
    }
  }

  /** stdout 原始文本（可跨 chunk，含半帧）。 */
  pushStdout(text: string): void {
    if (this.closed || !text) return;
    // 丢弃阶段不累积内存：整块扫描换行，没有就直接丢，有就从换行后继续解析。
    // （旧实现每块都 append 到 buffer，一条永不换行的巨大输出会一直涨到换行或 OOM。）
    if (this.discardingOversizedFrame) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      this.discardingOversizedFrame = false;
      text = text.slice(newline + 1);
      if (!text) return;
    }
    this.buffer += text;
    // 先解析完整帧，再判断「剩余半帧」是否超过缓冲上限：超过就整段丢弃，等下一个换行。
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        if (line.length > this.maxFrameChars) {
          this.protocolError(`Codex 输出单帧超过 ${this.maxFrameChars} 字符上限，已丢弃该帧`);
        } else {
          this.dispatchLine(line);
        }
      }
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = "";
      this.discardingOversizedFrame = true;
      this.protocolError(`Codex 输出单帧超过 ${this.maxFrameChars} 字符上限，已丢弃该帧`);
    }
  }

  /** stderr：只留尾部（进诊断/错误文案），不参与协议。 */
  pushStderr(text: string): void {
    if (this.closed || !text) return;
    this.stderrTail = (this.stderrTail + text).slice(-4_000);
    this.stderrListener(text);
  }

  /** 子进程退出（或 spawn 失败）：所有挂起请求以 closed 收场，之后一切输入被忽略。 */
  handleExit(info: { code: number | null; signal?: string; error?: string }): void {
    if (this.closed) return;
    const reason = info.error
      ? `Codex 进程异常退出：${info.error}`
      : `Codex 进程已退出（退出码 ${info.code ?? "未知"}）`;
    this.close(reason);
  }

  /** 主动关闭（停止/超时/销毁）：拒绝挂起请求并通知宿主回收进程树。 */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(new CodexRpcError("closed", reason, request.method));
    }
    this.bufferedNotifications = [];
    this.options.onClose?.(reason);
  }

  // ── 内部：分帧 / 分发 ────────────────────────────────────────────────

  private dispatchLine(line: string): void {
    let message: JsonRpcInbound;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("不是 JSON 对象");
      message = parsed as JsonRpcInbound;
    } catch (error) {
      this.protocolError(`Codex 输出不是合法 JSON 帧：${errorText(error)}`);
      return;
    }
    // 响应：有 id、没有 method。
    if (message.id !== undefined && message.id !== null && message.method === undefined) {
      this.settleResponse(message);
      return;
    }
    // 服务端请求：同时有 id 与 method（审批、提问、MCP elicitation…）。
    if (message.id !== undefined && message.id !== null && typeof message.method === "string") {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    // 通知。
    if (typeof message.method === "string") {
      // 只在**握手进行中**缓冲：initialize 的响应还没到，通知就先到了（实测 0.171.0 会先发
      // configWarning / remoteControl 状态）。握手完成后按到达顺序补发，不丢不乱序；
      // 没有握手这一步的客户端（诊断/测试）则立刻分发。
      if (this.handshakeStarted && !this.handshakeDone) {
        this.bufferedNotifications.push({ method: message.method, params: message.params });
        return;
      }
      this.dispatchNotification(message.method, message.params);
      return;
    }
    this.protocolError("Codex 输出帧既不是响应也不是通知");
  }

  private settleResponse(message: JsonRpcInbound): void {
    const key = String(message.id);
    const pending = this.pending.get(key);
    if (!pending) {
      // 迟到/重复/未知 id：明确丢弃（上一轮或已关闭请求的残留，不能影响当前状态）。
      this.protocolError(`Codex 返回了未知请求 id 的响应：${key}`);
      return;
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : undefined;
      const detail = typeof message.error.message === "string" ? message.error.message : "未知错误";
      pending.reject(new CodexRpcError("rpc", `Codex 请求失败（${pending.method}）：${detail}`, pending.method, code));
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(id: string | number, method: string, params: unknown): void {
    let decision: CodexServerRequestDecision;
    try {
      decision = this.requestHandler({ id, method, params });
    } catch (error) {
      decision = { kind: "error", message: `PiDesktop 拒绝该请求：${errorText(error)}` };
    }
    // 任何服务端请求都必须有回应：不回应会让 Codex 回合永久挂起。
    const frame = decision.kind === "result"
      ? { id, result: decision.result }
      : { id, error: { code: decision.code ?? -32000, message: decision.message } };
    try {
      this.options.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.protocolError(`回写 Codex 服务端请求失败：${errorText(error)}`);
    }
    this.protocolError(`已处理 Codex 服务端请求 ${method}（${decision.kind === "result" ? "已应答" : "已拒绝"}）`);
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (this.notificationListeners.size === 0) {
      this.unknownNotifications += 1;
      return;
    }
    for (const listener of [...this.notificationListeners]) {
      try {
        listener(method, params);
      } catch (error) {
        this.protocolError(`处理 Codex 通知失败（${method}）：${errorText(error)}`);
      }
    }
  }
}

/**
 * 默认的服务端请求处理：**一律拒绝**。
 *
 * 首版（A/B）没有接入 C 的审批/沙箱策略，任何「客户端点头才继续」的请求都不能
 * 被默默放行——放行等于绕过 PiDesktop 的权限域。C 阶段通过构造参数替换成真正的
 * 审批（复用 PermissionBroker 与成员身份），未覆盖的方法仍落到这里被拒绝。
 */
export function defaultServerRequestDecision(request: CodexServerRequest): CodexServerRequestDecision {
  return {
    kind: "error",
    code: -32000,
    message: `PiDesktop 尚未接入 Codex 审批：已拒绝 ${request.method}（不会以默认权限放行）`
  };
}
