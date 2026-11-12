import { randomBytes } from "node:crypto";
import {
  createImApprovalCode,
  IM_DEFAULT_APPROVAL_TIMEOUT_MS,
  IM_MAX_ANSWER_CHARS,
  imSessionKey,
  parseImSessionKey,
  splitByBytes,
  splitMarkdown
} from "../shared/im.js";
import type {
  AccessMode,
  DesktopSettings,
  ImChannelConfig,
  ImChannelStatus,
  ImStatus,
  PermissionDecision,
  PermissionRequest,
  RuntimeCommand,
  RuntimeMessage
} from "../shared/protocol.js";
import { ImFeishuApi, type ImApiResult } from "./im-feishu-api.js";
import {
  buildImAnswerCard,
  buildImApprovalCard,
  buildImTextCard,
  normalizeFeishuEvent,
  parseImCardAction,
  parseImCommand,
  type ImInboundMessage
} from "./im-feishu-channel.js";
import { ImWsClient, type ImWsCardAck, type ImWsHandshakeConfig, type ImWsState, type ImWsStatusDetail } from "./im-feishu-ws.js";
import { toImMarkdown } from "./im-outbound.js";
import { imStorePath, ImStore } from "./im-store.js";

/**
 * IM 通道网关（2026-11-12，飞书长连接 P1）——主进程侧的全部业务逻辑。
 *
 * 职责链：通道连接（im-feishu-ws）→ 事件归一化（im-feishu-channel）→ **本文件**：
 * 去重 → 白名单 → 指令 → 会话绑定（`im.session.ensure`）→ 投递（`im.prompt`）
 * → 回合事件（`im.turn` / `im.delta`）→ 出站卡片 / 审批 → 状态推送。
 *
 * 为什么在主进程：凭据（safeStorage）、设置、生命周期、IPC 都在这里，通道 QPS
 * 很低。**不选独立网关进程**：两个进程同时写同一会话 JSONL 有损坏风险。
 *
 * 全部外部依赖可注入（api / ws / 时钟 / 定时器 / 审批码），单元测试零网络、零
 * Electron；本模块不直接读磁盘设置以外的任何全局状态。
 */

/** 进度更新节流：≥1.5s 一次、最多 20 次（官方只给了「单条消息 5 QPS」，这里是保守上限）。 */
export const IM_PROGRESS_MIN_INTERVAL_MS = 1_500;
export const IM_PROGRESS_MAX_PATCHES = 20;
/** 同一 open_id 的「未授权」提示最多 10 分钟一次（防刷屏）。 */
export const IM_UNAUTHORIZED_NOTICE_INTERVAL_MS = 10 * 60 * 1000;
/** 本会话最多排队几条（与运行时侧上限一致）。 */
export const IM_MAX_QUEUED_MESSAGES = 3;
/** 等 `im.session.ready` 的超时（运行时初始化 + 冷开大会话最坏情况）。 */
export const IM_ENSURE_TIMEOUT_MS = 120_000;
/** 单张卡片正文的字节预算：飞书上限 30KB，扣掉 JSON 包装（宽屏/标题/markdown 标签）的余量。 */
export const IM_CARD_TEXT_BYTES = 28 * 1024;

export interface ImApiLike {
  tenantToken(): Promise<ImApiResult<string>>;
  botInfo(): Promise<ImApiResult<{ name: string; openId?: string }>>;
  sendText(chatId: string, text: string): Promise<ImApiResult<{ messageId: string }>>;
  sendCard(chatId: string, card: unknown): Promise<ImApiResult<{ messageId: string }>>;
  patchCard(messageId: string, card: unknown, sentAt?: number): Promise<ImApiResult<{ messageId: string }>>;
}

export interface ImWsHandlers {
  onEvent: (body: unknown) => void;
  onCardAction: (body: unknown) => Promise<ImWsCardAck | undefined>;
  onStatus: (state: ImWsState, detail?: ImWsStatusDetail) => void;
  onLog: (level: "info" | "warn", message: string) => void;
  /** 每解出一帧回调一次（诊断用：区分「链路通」与「有事件」）。 */
  onInbound: () => void;
}

export interface ImWsLike {
  start(): Promise<void>;
  dispose(): void;
  connected?(): boolean;
}

export interface ImGatewayDeps {
  /** userData 目录（`pidesktop-im.json` 落在这里）。 */
  userDataDir: string;
  getSettings: () => DesktopSettings | undefined;
  /** 取通道密钥（credentials.json 解密后的明文；缺省表示未保存）。 */
  getSecret: (channelId: string) => string | undefined;
  /** main → utility（im.session.ensure / im.prompt / im.abort / permission.resolve）。 */
  sendCommand: (command: RuntimeCommand) => void;
  /** main → 渲染端推送（im.status / im.test-result）。 */
  push: (message: RuntimeMessage) => void;
  log?: (level: "info" | "warn", message: string) => void;
  now?: () => number;
  createApi?: (config: ImChannelConfig, secret: string) => ImApiLike;
  createWs?: (config: ImChannelConfig, secret: string, handlers: ImWsHandlers) => ImWsLike;
  makeApprovalCode?: () => string;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
}

interface ImApprovalState {
  code: string;
  requestId: string;
  conversationKey: string;
  decisionRequested: boolean;
  timer?: number;
  messageId?: string;
  sentAt?: number;
}

interface ImStatusCard {
  messageId: string;
  sentAt: number;
  patches: number;
  lastPatchAt: number;
}

interface ImConversation {
  key: string;
  channelId: string;
  openId: string;
  chatId: string;
  sessionId?: string;
  sessionPath?: string;
  model?: string;
  busy: boolean;
  queued: number;
  /** 等待 `im.session.ready` 期间到达的消息（按顺序补发）。 */
  pending: string[];
  ensureRequestId?: string;
  ensureTimer?: number;
  statusCard?: ImStatusCard;
  /** 最近一次 delta 的全量文本（回合结束时用它兜底）。 */
  lastDelta?: string;
  approvalCode?: string;
}

interface ChannelRuntime {
  config: ImChannelConfig;
  secret: string;
  api: ImApiLike;
  ws: ImWsLike;
  status: ImChannelStatus;
}

/**
 * 通道诊断（「发了消息没反应」时唯一的判断依据，随 im.status 一起推给面板）：
 * 帧到了没有 → 事件到了没有 → 被什么过滤了 → 出站报了什么错。四层分开记，
 * 才能真正分清「平台没投递」与「我们没处理」。
 */
interface ChannelDiag {
  lastFrameAt?: number;
  lastEventAt?: number;
  lastEventSummary?: string;
  lastIgnored?: string;
  lastError?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ImGateway {
  private readonly channels = new Map<string, ChannelRuntime>();
  private readonly conversations = new Map<string, ImConversation>();
  private readonly approvals = new Map<string, ImApprovalState>();
  private readonly sessionIndex = new Map<string, string>();
  private readonly unauthorizedNotices = new Map<string, number>();
  private readonly diagnostics = new Map<string, ChannelDiag>();
  private diagEmitTimer: number | undefined;
  private readonly store: ImStore;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancel: (handle: number) => void;
  private disposed = false;

  constructor(private readonly deps: ImGatewayDeps) {
    this.store = new ImStore(
      imStorePath(deps.userDataDir),
      (message) => this.log("warn", message),
      () => this.now()
    );
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      (handle as unknown as { unref?: () => void }).unref?.();
      return handle as unknown as number;
    });
    this.cancel = deps.cancel ?? ((handle) => clearTimeout(handle as unknown as number));
  }

  // —— 生命周期 ——

  /** 按当前设置启动/重建全部通道连接（幂等：先回收旧连接）。 */
  start(): void {
    this.disposed = false;
    // 只回收连接与 socket：会话绑定/待发消息/待审批要跨「保存设置触发的重建」存活，
    // 否则用户在手机上正等着答案时去改一下白名单，这一轮的回复就没人送了。
    this.resetChannels();
    const settings = this.deps.getSettings();
    const im = settings?.im;
    if (!im || !im.enabled) {
      // 总闸关闭：不建连接，但把每个已配置通道标成 disabled，面板据此显示「未启用」。
      for (const channel of im?.channels ?? []) {
        this.channels.set(channel.id, {
          config: channel,
          secret: "",
          api: this.apiFor(channel, ""),
          ws: this.noopWs(),
          status: { channelId: channel.id, state: "disabled", message: "IM 通道总开关未开启", updatedAt: this.now() }
        });
      }
      this.emitStatus();
      return;
    }
    for (const channel of im.channels) {
      const secret = this.deps.getSecret(channel.id)?.trim() ?? "";
      const base = { channelId: channel.id, updatedAt: this.now() } as const;
      if (!channel.enabled) {
        this.channels.set(channel.id, { config: channel, secret, api: this.apiFor(channel, secret), ws: this.noopWs(), status: { ...base, state: "disabled", message: "该通道未启用" } });
        continue;
      }
      if (!channel.appId.trim()) {
        this.channels.set(channel.id, { config: channel, secret, api: this.apiFor(channel, secret), ws: this.noopWs(), status: { ...base, state: "disabled", message: "未填写 App ID" } });
        continue;
      }
      if (!secret) {
        this.channels.set(channel.id, { config: channel, secret: "", api: this.apiFor(channel, ""), ws: this.noopWs(), status: { ...base, state: "disabled", message: "未保存 App Secret" } });
        continue;
      }
      if (channel.allowFrom.length === 0) {
        this.log("warn", `通道「${channel.id}」白名单为空：任何私聊消息都不会被服务（请在设置页填写 open_id）`);
      }
      const api = this.apiFor(channel, secret);
      const ws = this.createWs(channel, secret);
      this.channels.set(channel.id, { config: channel, secret, api, ws, status: { ...base, state: "connecting" } });
      void ws.start().catch((error) => {
        this.setChannelStatus(channel.id, "error", `连接失败：${errorText(error)}`);
      });
    }
    this.emitStatus();
  }

  /** 设置保存后重启全部连接（先关旧 socket 再起新的）。 */
  restart(): void {
    this.start();
  }

  dispose(): void {
    this.disposed = true;
    for (const approval of this.approvals.values()) {
      if (approval.timer !== undefined) this.cancel(approval.timer);
    }
    this.approvals.clear();
    for (const conversation of this.conversations.values()) {
      if (conversation.ensureTimer !== undefined) this.cancel(conversation.ensureTimer);
    }
    this.disposeChannels();
  }

  /** 当前状态快照（bootstrap 与 im.status 推送同源）。 */
  status(): ImStatus {
    const settings = this.deps.getSettings();
    return {
      enabled: settings?.im?.enabled === true,
      channels: [...this.channels.values()].map((channel) => ({ ...channel.status, ...this.diagnostics.get(channel.config.id) }))
    };
  }

  // —— 通道诊断 ——

  private diag(channelId: string): ChannelDiag {
    const existing = this.diagnostics.get(channelId);
    if (existing) return existing;
    const created: ChannelDiag = {};
    this.diagnostics.set(channelId, created);
    return created;
  }

  /** 诊断变化合并 1s 再推（心跳 pong 每 90s 一帧，但别让每帧都走一次 IPC）。 */
  private scheduleDiagEmit(): void {
    if (this.diagEmitTimer !== undefined) return;
    this.diagEmitTimer = this.schedule(() => {
      this.diagEmitTimer = undefined;
      this.emitStatus();
    }, 1_000);
  }

  private noteFrame(channelId: string): void {
    this.diag(channelId).lastFrameAt = this.now();
    this.scheduleDiagEmit();
  }

  private noteEvent(channelId: string, summary: string): void {
    const diag = this.diag(channelId);
    diag.lastEventAt = this.now();
    diag.lastEventSummary = summary;
    this.scheduleDiagEmit();
  }

  private noteIgnored(channelId: string, reason: string): void {
    const diag = this.diag(channelId);
    diag.lastIgnored = reason;
    diag.lastEventAt = this.now();
    this.scheduleDiagEmit();
  }

  private noteError(channelId: string, message: string): void {
    this.diag(channelId).lastError = message;
    this.scheduleDiagEmit();
  }

  /**
   * 测试连接：取 token + bot info（草稿值优先，缺省回落已保存配置）。
   * 返回给渲染端的结果走 `im.test-result` 推送（与 skill-store 同款 fire-and-forget）。
   */
  async testChannel(input: { requestId: string; channelId: string; appId?: string; appSecret?: string; domain?: string }): Promise<void> {
    const channel = this.deps.getSettings()?.im?.channels.find((candidate) => candidate.id === input.channelId);
    const appId = (input.appId ?? channel?.appId ?? "").trim();
    const domain = (input.domain ?? channel?.domain)?.trim() || undefined;
    const secret = (input.appSecret?.trim() || this.deps.getSecret(input.channelId) || "").trim();
    const base = { requestId: input.requestId } as const;
    if (!appId) {
      this.deps.push({ type: "im.test-result", ...base, ok: false, message: "请先填写 App ID" });
      return;
    }
    if (!secret) {
      this.deps.push({ type: "im.test-result", ...base, ok: false, message: "请先填写并保存 App Secret" });
      return;
    }
    const startedAt = this.now();
    try {
      const api = this.deps.createApi?.({ id: input.channelId, kind: "feishu", enabled: true, appId, allowFrom: [], accessMode: "workspace", ...(domain ? { domain } : {}) }, secret)
        ?? new ImFeishuApi({ appId, appSecret: secret, ...(domain ? { domain } : {}) });
      const token = await api.tenantToken();
      if (!token.ok) {
        this.deps.push({ type: "im.test-result", ...base, ok: false, message: token.message });
        return;
      }
      const bot = await api.botInfo();
      if (!bot.ok) {
        this.deps.push({ type: "im.test-result", ...base, ok: false, message: bot.message });
        return;
      }
      this.deps.push({ type: "im.test-result", ...base, ok: true, botName: bot.data.name, message: `已连接机器人「${bot.data.name}」`, latencyMs: this.now() - startedAt });
    } catch (error) {
      this.deps.push({ type: "im.test-result", ...base, ok: false, message: errorText(error) });
    }
  }

  // —— 运行时消息 ——

  /**
   * 消费 utility 的内部 IM 事件。返回 true 表示「这是内部协议，不要转发渲染端」。
   * 权限请求也喂进来（可能需要在飞书出审批卡），但仍要转发渲染端——
   * 桌面与手机双通道，先到先得（broker 幂等）。
   */
  handleRuntimeMessage(message: RuntimeMessage): boolean {
    switch (message.type) {
      case "im.session.ready":
        this.handleSessionReady(message);
        return true;
      case "im.turn":
        void this.handleTurn(message);
        return true;
      case "im.delta":
        this.handleDelta(message);
        return true;
      case "permission":
        this.handlePermission(message.request);
        return false;
      case "permission.dismiss":
        this.handlePermissionDismiss(message.id);
        return false;
      default:
        return false;
    }
  }

  private handleSessionReady(message: Extract<RuntimeMessage, { type: "im.session.ready" }>): void {
    const conversation = this.conversationByRequestId(message.requestId);
    if (!conversation) return;
    if (conversation.ensureTimer !== undefined) {
      this.cancel(conversation.ensureTimer);
      conversation.ensureTimer = undefined;
    }
    conversation.ensureRequestId = undefined;
    if (message.error || !message.sessionId) {
      const reason = message.error ?? "运行时没有返回会话 id";
      this.log("warn", `IM 会话准备失败（${message.sessionKey}）：${reason}`);
      conversation.pending = [];
      // 已经发出去的「处理中」回执不能一直转圈：清掉引用，答案会以新卡片/text 送达。
      conversation.statusCard = undefined;
      void this.replyText(conversation, `无法打开会话：${reason}`);
      return;
    }
    conversation.sessionId = message.sessionId;
    if (message.sessionPath) conversation.sessionPath = message.sessionPath;
    if (message.model) conversation.model = message.model;
    this.sessionIndex.set(message.sessionId, conversation.key);
    if (conversation.sessionPath) {
      this.store.bind(conversation.key, {
        sessionPath: conversation.sessionPath,
        chatId: conversation.chatId,
        openId: conversation.openId
      });
    }
    const pending = conversation.pending.splice(0, conversation.pending.length);
    for (const text of pending) this.dispatchPrompt(conversation, text);
  }

  private async handleTurn(message: Extract<RuntimeMessage, { type: "im.turn" }>): Promise<void> {
    const conversation = this.conversationBySessionId(message.sessionId);
    if (!conversation) return;
    const channel = this.channels.get(conversation.channelId);
    if (!channel) return;
    if (message.phase === "queued") {
      conversation.queued += 1;
      await this.replyText(conversation, `已排队（第 ${conversation.queued} 条），当前回合结束后处理。发送 /stop 可中止当前任务。`);
      return;
    }
    if (message.phase === "start") {
      conversation.busy = true;
      conversation.queued = 0;
      conversation.lastDelta = undefined;
      return;
    }
    if (message.phase !== "end") return;
    conversation.busy = false;
    conversation.queued = 0;
    // 出站前压平 Div 气泡：飞书卡片是受限 markdown，不渲染 HTML（见 im-outbound.ts）。
    const text = toImMarkdown((message.text ?? "").trim() || (conversation.lastDelta ?? "").trim());
    if (message.status === "aborted") {
      await this.finishConversation(conversation, channel, "已停止当前回复。", "neutral");
      return;
    }
    if (message.status === "error" || message.error) {
      const reason = (message.error ?? "").trim() || "未知错误";
      await this.finishConversation(conversation, channel, `执行失败：${reason}`, "error");
      return;
    }
    if (!text) {
      await this.finishConversation(conversation, channel, "（模型没有返回文本内容，请在桌面端查看会话详情）", "neutral");
      return;
    }
    await this.finishConversation(conversation, channel, text, "answer");
  }

  private handleDelta(message: Extract<RuntimeMessage, { type: "im.delta" }>): void {
    const conversation = this.conversationBySessionId(message.sessionId);
    if (!conversation) return;
    const channel = this.channels.get(conversation.channelId);
    const card = conversation.statusCard;
    if (!channel || !card) return;
    conversation.lastDelta = toImMarkdown(message.text);
    if (card.patches >= IM_PROGRESS_MAX_PATCHES) return;
    if (this.now() - card.lastPatchAt < IM_PROGRESS_MIN_INTERVAL_MS) return;
    // 先记账再发请求：并发 delta 不会把节流打穿。
    card.patches += 1;
    card.lastPatchAt = this.now();
    const chunk = answerChunks(conversation.lastDelta)[0] ?? conversation.lastDelta;
    void channel.api.patchCard(card.messageId, buildImAnswerCard(chunk, { title: "PiDesktop · 处理中", template: "blue" }), card.sentAt)
      .then((result) => {
        if (!result.ok) this.log("info", `进度卡片更新失败（${result.message}），最终答案会改发新卡片`);
      })
      .catch(() => undefined);
  }

  // —— 权限审批 ——

  /** 权限请求 → 飞书审批卡。只处理属于 IM 会话的请求（其他会话不打扰手机）。 */
  private handlePermission(request: PermissionRequest): void {
    const sessionId = request.principal.kind === "subagent"
      ? (request.principal.parentSessionId ?? request.principal.sessionId)
      : request.principal.sessionId;
    const conversation = this.conversationBySessionId(sessionId);
    if (!conversation) return;
    const channel = this.channels.get(conversation.channelId);
    if (!channel) return;
    const code = (this.deps.makeApprovalCode ?? defaultApprovalCode)();
    const timeoutMs = this.approvalTimeoutFor(channel.config);
    const approval: ImApprovalState = { code, requestId: request.id, conversationKey: conversation.key, decisionRequested: false };
    this.approvals.set(code, approval);
    conversation.approvalCode = code;
    approval.timer = this.schedule(() => {
      const current = this.approvals.get(code);
      if (!current || current.decisionRequested) return;
      this.approvals.delete(code);
      if (conversation.approvalCode === code) conversation.approvalCode = undefined;
      // broker 自己也会超时 deny（同一时长）；这里只负责把结论告诉手机用户。
      void this.replyText(conversation, `审批超时，已自动拒绝（${code}）。下次请及时处理，或在桌面端操作。`);
      if (current.messageId) void this.patchApprovalCard(channel, current, "⌛ 审批超时，已自动拒绝");
    }, timeoutMs);
    const card = buildImApprovalCard({
      code,
      toolName: request.toolName,
      summary: request.summary,
      risk: request.risk,
      timeoutMs
    });
    void channel.api.sendCard(conversation.chatId, card)
      .then((result) => {
        if (result.ok) {
          approval.messageId = result.data.messageId;
          approval.sentAt = this.now();
          return;
        }
        this.log("warn", `审批卡片发送失败（${result.message}），改发文本审批`);
        return channel.api.sendText(conversation.chatId, `需要确认：${request.toolName} — ${request.summary}\n发送 ${`/allow ${code}`} 允许一次，或 /deny ${code} 拒绝。`);
      })
      .catch((error) => {
        this.log("warn", `审批卡片发送异常：${errorText(error)}`);
      });
  }

  /** 桌面端先处理了：清掉飞书侧的待审（卡片保留原文，不再响应点击）。 */
  private handlePermissionDismiss(requestId: string): void {
    for (const [code, approval] of this.approvals) {
      if (approval.requestId !== requestId) continue;
      this.approvals.delete(code);
      if (approval.timer !== undefined) this.cancel(approval.timer);
      const conversation = this.conversations.get(approval.conversationKey);
      if (conversation?.approvalCode === code) conversation.approvalCode = undefined;
      const channel = this.channels.get(conversation?.channelId ?? "");
      if (channel && approval.messageId) {
        const decision = "已在桌面端处理";
        void this.patchApprovalCard(channel, approval, `✅ ${decision}`);
      }
      return;
    }
  }

  private resolveApproval(code: string, decision: PermissionDecision): boolean {
    const approval = this.approvals.get(code);
    if (!approval) return false;
    this.approvals.delete(code);
    approval.decisionRequested = true;
    if (approval.timer !== undefined) this.cancel(approval.timer);
    const conversation = this.conversations.get(approval.conversationKey);
    if (conversation?.approvalCode === code) conversation.approvalCode = undefined;
    this.sendCommand({ type: "permission.resolve", id: approval.requestId, decision }, conversation);
    const channel = conversation ? this.channels.get(conversation.channelId) : undefined;
    if (channel && approval.messageId) {
      const label = decision === "deny" ? "❌ 已拒绝" : decision === "allow-session" ? "✅ 本会话已信任" : "✅ 已允许一次";
      void this.patchApprovalCard(channel, approval, label);
    }
    return true;
  }

  private async patchApprovalCard(channel: ChannelRuntime, approval: ImApprovalState, text: string): Promise<void> {
    if (!approval.messageId) return;
    try {
      await channel.api.patchCard(
        approval.messageId,
        buildImAnswerCard(text, { title: "PiDesktop · 审批结果", template: "green" }),
        approval.sentAt
      );
    } catch {
      /* 卡片更新失败不影响审批结论本身 */
    }
  }

  // —— 入站 ——

  private async handleInbound(channelId: string, message: ImInboundMessage): Promise<void> {
    const channel = this.channels.get(channelId);
    // 通道被停用/删除后，旧 socket 的残留事件不能继续执行指令。
    if (!channel || this.disposed || !channel.config.enabled) return;
    const channelKey = `feishu:${channelId}`;
    if (this.store.hasSeen(channelKey, message.messageId)) return;
    this.store.markSeen(channelKey, message.messageId);

    if (channel.config.allowFrom.length === 0) {
      await this.notifyUnauthorized(channel, message, "未配置授权名单，机器人不会执行任何指令。请把下面这行 open_id 填进设置 → 消息通道的白名单：");
      this.log("warn", `收到消息但白名单为空（open_id=${message.openId}）`);
      return;
    }
    if (!channel.config.allowFrom.includes(message.openId)) {
      await this.notifyUnauthorized(channel, message, "你不在授权名单里，机器人不会执行任何指令。请把下面这行 open_id 交给管理员加入白名单：");
      this.log("warn", `拒绝未授权 open_id=${message.openId}（通道 ${channelId}）`);
      return;
    }

    const conversation = this.conversationFor(channel.config, message);
    this.store.touch(conversation.key);
    const command = parseImCommand(message.text);
    switch (command.kind) {
      case "allow":
      case "deny": {
        const decision: PermissionDecision = command.kind === "allow" ? "allow-once" : "deny";
        if (!this.resolveApproval(command.code, decision)) {
          await this.replyText(conversation, `没有待处理的审批码 ${command.code}（可能已处理或已超时）。`);
        }
        return;
      }
      case "stop": {
        if (!conversation.sessionId) {
          await this.replyText(conversation, "当前还没有进行中的会话。");
          return;
        }
        this.sendCommand({ type: "im.abort", sessionId: conversation.sessionId }, conversation);
        await this.replyText(conversation, "已请求停止当前生成。");
        return;
      }
      case "new": {
        this.resetConversation(conversation);
        await this.replyText(conversation, "已开启新话题。下一条消息会建一个新的 PiDesktop 会话。");
        return;
      }
      case "status": {
        await this.replyText(conversation, this.describeStatus(conversation));
        return;
      }
      case "help": {
        await this.replyText(conversation, [
          "可用指令：",
          "/new 开启新话题（解绑当前会话）",
          "/stop 停止当前生成",
          "/status 查看会话状态",
          "/allow <code> · /deny <code> 批复工具调用",
          "其余消息都会作为任务发给当前会话。"
        ].join("\n"));
        return;
      }
      case "text":
        break;
    }

    if (!command.text.trim()) {
      await this.replyText(conversation, "（空消息已忽略）");
      return;
    }
    // 忙时排队：网关先做一次粗粒度封顶，运行时侧还有一道 3 条的硬上限。
    if (conversation.busy && conversation.queued >= IM_MAX_QUEUED_MESSAGES) {
      await this.replyText(conversation, `上一条还在处理（已排队 ${conversation.queued} 条），请稍后再发，或发送 /stop 中止。`);
      return;
    }
    if (channel.config.ack !== false && !conversation.statusCard) {
      const sent = await channel.api.sendCard(conversation.chatId, buildImAnswerCard("已收到，正在处理…", { title: "PiDesktop · 处理中", template: "blue" }));
      if (sent.ok) {
        conversation.statusCard = { messageId: sent.data.messageId, sentAt: this.now(), patches: 0, lastPatchAt: this.now() };
      } else {
        this.log("warn", `回执卡片发送失败（${sent.message}），继续处理`);
      }
    }
    // 投递必须等 `im.session.ready`：先入待发队列，再确保会话存在（已在飞就复用
    // 那一次，ready 到了统一按顺序补发）。
    conversation.pending.push(command.text);
    if (conversation.ensureRequestId) return;
    await this.ensureSession(conversation, channel.config);
  }

  /** 确保会话存在（每轮都问一次：运行时可能已经把空闲会话回收了）。 */
  private async ensureSession(conversation: ImConversation, config: ImChannelConfig): Promise<void> {
    const requestId = `im-ensure-${++this.ensureSequence}`;
    conversation.ensureRequestId = requestId;
    this.ensureRequests.set(requestId, conversation.key);
    conversation.ensureTimer = this.schedule(() => {
      const pending = this.conversations.get(conversation.key);
      if (!pending || pending.ensureRequestId !== requestId) return;
      pending.ensureRequestId = undefined;
      pending.ensureTimer = undefined;
      this.ensureRequests.delete(requestId);
      pending.sessionId = undefined;
      void this.replyText(pending, "运行时没有响应（会话可能正在初始化），请稍后重发。");
    }, IM_ENSURE_TIMEOUT_MS);
    this.sendCommand({
      type: "im.session.ensure",
      requestId,
      sessionKey: conversation.key,
      title: `飞书 · ${conversation.openId.slice(0, 8)}`,
      ...(conversation.sessionPath ? { sessionPath: conversation.sessionPath } : {}),
      ...(config.workspace ? { workspace: config.workspace } : {}),
      ...(config.agentId ? { agentId: config.agentId } : {}),
      accessMode: config.accessMode,
      ...(config.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: config.approvalTimeoutMs } : {})
    }, conversation);
    // 真正投递在 im.session.ready 里做（确保 sessionId 新鲜）。
  }

  private dispatchPrompt(conversation: ImConversation, text: string): void {
    if (!conversation.sessionId) return;
    this.sendCommand({ type: "im.prompt", sessionId: conversation.sessionId, text }, conversation);
  }

  // —— 卡片回调 ——

  private async handleCardAction(channelId: string, body: unknown): Promise<ImWsCardAck | undefined> {
    const action = parseImCardAction(body);
    if (!action) return undefined;
    const channel = this.channels.get(channelId);
    const allowFrom = channel?.config.allowFrom ?? [];
    if (action.openId && allowFrom.length > 0 && !allowFrom.includes(action.openId)) {
      return { toast: { type: "error", content: "你不在授权名单里" } };
    }
    const approval = this.approvals.get(action.code);
    if (!approval) {
      return { toast: { type: "info", content: "这个审批已处理或已超时" } };
    }
    const ok = this.resolveApproval(action.code, action.decision);
    return ok
      ? { toast: { type: action.decision === "deny" ? "info" : "success", content: action.decision === "deny" ? "已拒绝" : "已放行" } }
      : { toast: { type: "info", content: "这个审批已处理" } };
  }

  // —— 出站 ——

  private async finishConversation(conversation: ImConversation, channel: ChannelRuntime, text: string, kind: "answer" | "error" | "neutral"): Promise<void> {
    const card = conversation.statusCard;
    conversation.statusCard = undefined;
    conversation.lastDelta = undefined;
    if (kind === "error") {
      // 失败优先发文本（卡片更新失败也不能让用户看不到原因）：先把状态卡改成
      // 同内容（避免一直显示「处理中」），再补一条纯文本，保证一定送达。
      if (card) await this.tryPatch(channel, card, text, "PiDesktop · 执行失败", "red");
      await this.replyText(conversation, text);
      return;
    }
    const chunks = answerChunks(text);
    const first = chunks[0] ?? text;
    const title = "PiDesktop";
    let delivered = false;
    if (card) {
      const result = await this.tryPatch(channel, card, first, title, kind === "neutral" ? "grey" : "blue");
      delivered = result;
    }
    if (!delivered) {
      const sent = await this.sendCardSafe(channel, conversation, buildImAnswerCard(first, { title, ...(kind === "neutral" ? { template: "grey" } : {}) }));
      if (!sent) {
        // 卡片彻底发不出去：退到纯文本（截断到单条消息可读长度）。
        await this.replyText(conversation, first.slice(0, 8_000));
      }
    }
    for (let index = 1; index < chunks.length; index += 1) {
      const sent = await this.sendCardSafe(channel, conversation, buildImAnswerCard(chunks[index]!, { title: `${title}（${index + 1}/${chunks.length}）` }));
      if (!sent) {
        await this.replyText(conversation, chunks[index]!.slice(0, 8_000));
      }
    }
  }

  private async tryPatch(channel: ChannelRuntime, card: ImStatusCard, text: string, title: string, template: string): Promise<boolean> {
    try {
      const result = await channel.api.patchCard(card.messageId, buildImAnswerCard(text, { title, template }), card.sentAt);
      if (result.ok) return true;
      this.log("info", `卡片更新失败（${result.message}），改发新卡片`);
      return false;
    } catch (error) {
      this.log("warn", `卡片更新异常：${errorText(error)}`);
      return false;
    }
  }

  private async sendCardSafe(channel: ChannelRuntime, conversation: ImConversation, card: unknown): Promise<boolean> {
    try {
      const result = await channel.api.sendCard(conversation.chatId, card);
      if (result.ok) return true;
      this.log("warn", `发送卡片失败：${result.message}`);
      this.noteError(conversation.channelId, result.message);
      return false;
    } catch (error) {
      this.log("warn", `发送卡片异常：${errorText(error)}`);
      return false;
    }
  }

  private async replyText(conversation: ImConversation, text: string): Promise<void> {
    const channel = this.channels.get(conversation.channelId);
    if (!channel) return;
    try {
      const result = await channel.api.sendText(conversation.chatId, text);
      if (!result.ok) {
        this.log("warn", `发送文本失败：${result.message}`);
        this.noteError(conversation.channelId, result.message);
      }
    } catch (error) {
      this.log("warn", `发送文本异常：${errorText(error)}`);
    }
  }

  private async notifyUnauthorized(channel: ChannelRuntime, message: ImInboundMessage, prefix: string): Promise<void> {
    const last = this.unauthorizedNotices.get(message.openId) ?? 0;
    if (this.now() - last < IM_UNAUTHORIZED_NOTICE_INTERVAL_MS) return;
    this.unauthorizedNotices.set(message.openId, this.now());
    try {
      const result = await channel.api.sendText(message.chatId, `${prefix}\nopen_id: ${message.openId}`);
      if (!result.ok) {
        this.log("warn", `发送授权提示失败：${result.message}`);
        this.noteError(channel.config.id, result.message);
      }
    } catch (error) {
      this.log("warn", `发送授权提示异常：${errorText(error)}`);
    }
  }

  // —— 内部工具 ——

  private readonly ensureRequests = new Map<string, string>();
  private ensureSequence = 0;

  private conversationFor(config: ImChannelConfig, message: ImInboundMessage): ImConversation {
    const key = imSessionKey({ channelId: config.id, peerId: message.openId });
    const existing = this.conversations.get(key);
    if (existing) {
      existing.chatId = message.chatId;
      return existing;
    }
    const binding = this.store.binding(key);
    const conversation: ImConversation = {
      key,
      channelId: config.id,
      openId: message.openId,
      chatId: message.chatId,
      ...(binding ? { sessionPath: binding.sessionPath } : {}),
      busy: false,
      queued: 0,
      pending: []
    };
    this.conversations.set(key, conversation);
    return conversation;
  }

  private resetConversation(conversation: ImConversation): void {
    this.store.unbind(conversation.key);
    if (conversation.sessionId) this.sessionIndex.delete(conversation.sessionId);
    conversation.sessionId = undefined;
    conversation.sessionPath = undefined;
    conversation.model = undefined;
    conversation.busy = false;
    conversation.queued = 0;
    conversation.pending = [];
    conversation.statusCard = undefined;
    conversation.lastDelta = undefined;
    if (conversation.ensureTimer !== undefined) {
      this.cancel(conversation.ensureTimer);
      conversation.ensureTimer = undefined;
    }
    if (conversation.ensureRequestId) {
      this.ensureRequests.delete(conversation.ensureRequestId);
      conversation.ensureRequestId = undefined;
    }
  }

  private describeStatus(conversation: ImConversation): string {
    const lines = [
      `会话键：${conversation.key}`,
      conversation.sessionPath ? `会话文件：${conversation.sessionPath}` : "会话文件：尚未创建（下一条消息会新建）",
      conversation.model ? `模型：${conversation.model}` : "模型：与桌面端当前选择一致",
      `状态：${conversation.busy ? "正在执行" : "空闲"}${conversation.queued > 0 ? `（排队 ${conversation.queued} 条）` : ""}`
    ];
    if (conversation.approvalCode) lines.push(`待审批码：${conversation.approvalCode}`);
    return lines.join("\n");
  }

  private conversationBySessionId(sessionId: string): ImConversation | undefined {
    const key = this.sessionIndex.get(sessionId);
    if (key) return this.conversations.get(key);
    for (const conversation of this.conversations.values()) {
      if (conversation.sessionId === sessionId) return conversation;
    }
    return undefined;
  }

  private conversationByRequestId(requestId: string): ImConversation | undefined {
    const key = this.ensureRequests.get(requestId);
    if (!key) return undefined;
    this.ensureRequests.delete(requestId);
    return this.conversations.get(key);
  }

  private approvalTimeoutFor(config: ImChannelConfig): number {
    const value = config.approvalTimeoutMs;
    return typeof value === "number" && Number.isFinite(value) && value >= 30_000 ? value : IM_DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  private sendCommand(command: RuntimeCommand, conversation?: ImConversation): void {
    try {
      this.deps.sendCommand(command);
    } catch (error) {
      const reason = errorText(error);
      this.log("warn", `IM 命令下发失败：${reason}`);
      if (conversation) {
        // 运行时不可用（重启中/退出）：明确告诉手机端，不让消息静默丢失。
        void this.replyText(conversation, `PiDesktop 运行时当前不可用（${reason}），消息未送达。`);
      }
    }
  }

  private setChannelStatus(channelId: string, state: ImChannelStatus["state"], message?: string, botName?: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.status = {
      channelId,
      state,
      updatedAt: this.now(),
      ...(message ? { message } : {}),
      ...(botName ? { botName } : {})
    };
    this.emitStatus();
  }

  private emitStatus(): void {
    this.deps.push({ type: "im.status", status: this.status() });
  }

  private apiFor(config: ImChannelConfig, secret: string): ImApiLike {
    return this.deps.createApi?.(config, secret) ?? new ImFeishuApi({
      appId: config.appId,
      appSecret: secret,
      ...(config.domain ? { domain: config.domain } : {})
    });
  }

  private createWs(config: ImChannelConfig, secret: string): ImWsLike {
    const handlers: ImWsHandlers = {
      onEvent: (body) => {
        const normalized = normalizeFeishuEvent(body);
        if (normalized.kind === "ignore") {
          this.log("info", `忽略飞书事件：${normalized.reason}`);
          this.noteIgnored(config.id, normalized.reason);
          return;
        }
        this.noteEvent(config.id, `${normalized.message.chatType} · ${normalized.message.openId.slice(0, 10)} · ${normalized.message.text.slice(0, 40)}`);
        void this.handleInbound(config.id, normalized.message);
      },
      onCardAction: (body) => this.handleCardAction(config.id, body),
      onStatus: (state, detail) => this.applyWsStatus(config.id, state, detail),
      onLog: (level, message) => this.log(level, `[${config.id}] ${message}`),
      onInbound: () => this.noteFrame(config.id)
    };
    if (this.deps.createWs) return this.deps.createWs(config, secret, handlers);
    const handshakeConfig: ImWsHandshakeConfig = { appId: config.appId, appSecret: secret, ...(config.domain ? { domain: config.domain } : {}) };
    return new ImWsClient({
      config: handshakeConfig,
      onEvent: handlers.onEvent,
      onCardAction: handlers.onCardAction,
      onStatus: handlers.onStatus,
      onLog: handlers.onLog,
      onInbound: handlers.onInbound
    });
  }

  private applyWsStatus(channelId: string, state: ImWsState, detail?: ImWsStatusDetail): void {
    if (this.disposed) return;
    if (state === "connected") {
      this.setChannelStatus(channelId, "connected");
      const channel = this.channels.get(channelId);
      // 连上后读一次机器人名（面板徽标用）；失败不影响连接本身。
      if (channel && !channel.status.botName) {
        void channel.api.botInfo().then((bot) => {
          if (bot.ok) this.setChannelStatus(channelId, "connected", undefined, bot.data.name);
        }).catch(() => undefined);
      }
      return;
    }
    if (state === "connecting") {
      this.setChannelStatus(channelId, "connecting");
      return;
    }
    if (state === "error") {
      this.setChannelStatus(channelId, "error", detail?.message ?? "连接失败");
      return;
    }
    // stopped：主动 dispose 时不广播（重启中），只记一笔。
    this.log("info", `通道 ${channelId} 已停止`);
  }

  /** 只回收通道连接（start/restart 用；会话状态保留）。 */
  private resetChannels(): void {
    for (const channel of this.channels.values()) {
      try {
        channel.ws.dispose();
      } catch {
        /* 已断开的连接再 dispose 一次不致命 */
      }
    }
    this.channels.clear();
  }

  /** 全量回收（dispose 用）：连接 + 会话 + 待审批。 */
  private disposeChannels(): void {
    this.resetChannels();
    for (const conversation of this.conversations.values()) {
      if (conversation.ensureTimer !== undefined) this.cancel(conversation.ensureTimer);
    }
    this.conversations.clear();
    this.sessionIndex.clear();
    this.ensureRequests.clear();
    for (const approval of this.approvals.values()) {
      if (approval.timer !== undefined) this.cancel(approval.timer);
    }
    this.approvals.clear();
  }

  private noopWs(): ImWsLike {
    return { start: async () => undefined, dispose: () => undefined, connected: () => false };
  }

  private log(level: "info" | "warn", message: string): void {
    this.deps.log?.(level, message);
  }
}

/**
 * 答案切片：先按 markdown 边界（≤20K 字符），再按卡片字节预算（CJK/emoji 下
 * 20K 字符可能是 60KB，飞书要的是字节上限）。
 */
function answerChunks(text: string): string[] {
  return splitMarkdown(text, IM_MAX_ANSWER_CHARS).flatMap((chunk) => splitByBytes(chunk, IM_CARD_TEXT_BYTES));
}

function defaultApprovalCode(): string {
  return createImApprovalCode(() => randomBytes(1)[0] ?? 0);
}

/** 供 pi-runtime 侧解析会话键（导出以免两处各写一份正则）。 */
export function parseImBindingKey(key: string): { channelId: string; peerId: string } | undefined {
  return parseImSessionKey(key);
}
