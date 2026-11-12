import { IM_MAX_CARD_BYTES, IM_DEFAULT_DOMAIN } from "../shared/im.js";

/**
 * 飞书 OpenAPI 的最小客户端（2026-11-12，IM 通道 P1）。
 *
 * 只做四件事：取 tenant_access_token（缓存 + 提前 30 分钟刷新）、发文本、发卡片、
 * 更新卡片，外加读一次机器人信息（设置页「测试连接」用）。`fetch` / `now` /
 * `sleep` 全部可注入，单元测试零网络。
 *
 * 三条硬约束（官方文档）：
 * - 同一 chat 发送 5 QPS ⇒ 按 chat_id 串行 + 最小间隔 200ms；
 * - 卡片体 ≤ 30KB ⇒ 发送前用 JSON 字符串字节数预校验（超长由调用方切片）；
 * - 更新卡片仅限 14 天内、且卡片必须 `config.update_multi: true`（由卡片构造保证）。
 *
 * 错误统一成 `{ ok: false, code?, message }`：调用方（网关）只需要人话原因，
 * 不能因为一次 400 抛异常把整条消息链断掉。
 */

export interface ImApiOk<T> {
  ok: true;
  data: T;
}

/** request() 的内部返回：多带一份完整信封（顶层字段不都在 data 里，如 `/bot/v3/info` 的 bot）。 */
type ImApiEnvelopeOk<T> = ImApiOk<T> & { envelope: Record<string, unknown> };

export interface ImApiError {
  ok: false;
  code?: number;
  message: string;
}

export type ImApiResult<T> = ImApiOk<T> | ImApiError;

export const IM_TOKEN_REFRESH_MARGIN_MS = 30 * 60 * 1000;
/** 同一 chat 的发送最小间隔（5 QPS）。 */
export const IM_SEND_MIN_INTERVAL_MS = 200;
/** 卡片更新仅限 14 天内的消息。 */
export const IM_CARD_UPDATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface ImFeishuApiOptions {
  appId: string;
  appSecret: string;
  /** 开放平台域名（缺省 open.feishu.cn；可传完整 https:// 前缀）。 */
  domain?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 测试可调；缺省 5 QPS。 */
  sendMinIntervalMs?: number;
}

/** 统一成 https://host（无尾斜杠）。 */
export function imApiBaseUrl(domain?: string): string {
  const raw = (domain ?? IM_DEFAULT_DOMAIN).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return `https://${raw || IM_DEFAULT_DOMAIN}`;
}

function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

interface TokenState {
  token: string;
  /** token 到期的绝对时间（毫秒）。 */
  expiresAt: number;
}

export class ImFeishuApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sendMinIntervalMs: number;
  private tokenState: TokenState | undefined;
  private tokenInFlight: Promise<ImApiResult<string>> | undefined;
  /** 每个 chat（或 message）一条串行链 + 上次发送时间。 */
  private readonly sendChains = new Map<string, Promise<void>>();
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly options: ImFeishuApiOptions) {
    this.baseUrl = imApiBaseUrl(options.domain);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.sendMinIntervalMs = options.sendMinIntervalMs ?? IM_SEND_MIN_INTERVAL_MS;
  }

  /** 当前缓存的 token（测试用；生产代码只走 tenantToken()）。 */
  cachedToken(): string | undefined {
    return this.tokenState?.token;
  }

  /** 取 token：剩余不足 30 分钟才换新；并发调用单飞。 */
  async tenantToken(): Promise<ImApiResult<string>> {
    const cached = this.tokenState;
    if (cached && this.now() < cached.expiresAt - IM_TOKEN_REFRESH_MARGIN_MS) {
      return { ok: true, data: cached.token };
    }
    if (this.tokenInFlight) return this.tokenInFlight;
    const task = this.fetchToken().finally(() => {
      this.tokenInFlight = undefined;
    });
    this.tokenInFlight = task;
    return task;
  }

  private async fetchToken(): Promise<ImApiResult<string>> {
    const result = await this.request<{ tenant_access_token?: unknown; expire?: unknown }>(
      "POST",
      "/open-apis/auth/v3/tenant_access_token/internal",
      { app_id: this.options.appId, app_secret: this.options.appSecret },
      { auth: false }
    );
    if (!result.ok) return result;
    // token 接口把两个字段放在**响应顶层**（不在 data 里）；两处都读，平台挪位置也不静默失败。
    const source = (result.envelope.tenant_access_token !== undefined ? result.envelope : result.data) as { tenant_access_token?: unknown; expire?: unknown };
    const token = typeof source.tenant_access_token === "string" ? source.tenant_access_token : "";
    if (!token) return { ok: false, message: "飞书没有返回 tenant_access_token（请检查 App ID / App Secret）" };
    const expireSeconds = typeof source.expire === "number" && Number.isFinite(source.expire) ? source.expire : 7200;
    this.tokenState = { token, expiresAt: this.now() + Math.max(60, expireSeconds) * 1000 };
    return { ok: true, data: token };
  }

  /**
   * 机器人信息（测试连接用；需要 token）。
   * 注意 `/bot/v3/info` 的机器人在**响应顶层** `bot`（不在 `data` 里）——两处都读，
   * 平台哪天把它挪进 `data` 也不会静默变成「未命名机器人」。
   */
  async botInfo(): Promise<ImApiResult<{ name: string; openId?: string }>> {
    const result = await this.request<{ bot?: { app_name?: unknown; open_id?: unknown } }>("GET", "/open-apis/bot/v3/info", undefined, { auth: true });
    if (!result.ok) return result;
    const bot = (result.envelope.bot ?? result.data.bot) as { app_name?: unknown; open_id?: unknown } | undefined;
    const name = bot && typeof bot.app_name === "string" && bot.app_name.trim() ? bot.app_name.trim() : "";
    const openId = bot && typeof bot.open_id === "string" ? bot.open_id : undefined;
    return { ok: true, data: { name: name || "（未命名机器人）", ...(openId ? { openId } : {}) } };
  }

  async sendText(chatId: string, text: string): Promise<ImApiResult<{ messageId: string }>> {
    return this.send(chatId, "text", JSON.stringify({ text }));
  }

  /** 发卡片：卡片 JSON 超过 30KB 直接拒绝（调用方应先切片，绝不发一条必然 400 的消息）。 */
  async sendCard(chatId: string, card: unknown): Promise<ImApiResult<{ messageId: string }>> {
    const content = JSON.stringify(card);
    if (textBytes(content) > IM_MAX_CARD_BYTES) {
      return { ok: false, message: `卡片体超过 ${Math.round(IM_MAX_CARD_BYTES / 1024)}KB（${textBytes(content)} 字节），需要先切片` };
    }
    return this.send(chatId, "interactive", content);
  }

  private async send(chatId: string, msgType: "text" | "interactive", content: string): Promise<ImApiResult<{ messageId: string }>> {
    await this.throttle(`chat:${chatId}`);
    const result = await this.request<{ message_id?: unknown }>(
      "POST",
      "/open-apis/im/v1/messages?receive_id_type=chat_id",
      { receive_id: chatId, msg_type: msgType, content },
      { auth: true }
    );
    if (!result.ok) return result;
    const messageId = typeof result.data.message_id === "string" ? result.data.message_id : "";
    if (!messageId) return { ok: false, message: "飞书没有返回 message_id（发送结果不可追踪）" };
    return { ok: true, data: { messageId } };
  }

  /**
   * 更新已有卡片。`sentAt`（本端记录的发送时间）用于 14 天窗口前置校验——
   * 拿不到时只跳过校验，仍由平台裁决。
   */
  async patchCard(messageId: string, card: unknown, sentAt?: number): Promise<ImApiResult<{ messageId: string }>> {
    if (sentAt !== undefined && this.now() - sentAt > IM_CARD_UPDATE_WINDOW_MS) {
      return { ok: false, message: "消息超过 14 天，飞书不再允许更新卡片" };
    }
    const content = JSON.stringify(card);
    if (textBytes(content) > IM_MAX_CARD_BYTES) {
      return { ok: false, message: `卡片体超过 ${Math.round(IM_MAX_CARD_BYTES / 1024)}KB（${textBytes(content)} 字节），需要先切片` };
    }
    await this.throttle(`message:${messageId}`);
    const result = await this.request<{ message_id?: unknown }>(
      "PATCH",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { content },
      { auth: true }
    );
    if (!result.ok) return result;
    return { ok: true, data: { messageId: typeof result.data.message_id === "string" ? result.data.message_id : messageId } };
  }

  /** 串行 + 最小间隔（5 QPS）：同 key 的调用按到达顺序排队，相邻两次至少隔 200ms。 */
  private async throttle(key: string): Promise<void> {
    const previous = this.sendChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.sendChains.set(key, previous.then(() => current));
    await previous;
    try {
      const last = this.lastSentAt.get(key);
      if (last !== undefined) {
        const wait = this.sendMinIntervalMs - (this.now() - last);
        if (wait > 0) await this.sleep(wait);
      }
      this.lastSentAt.set(key, this.now());
    } finally {
      release();
    }
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    options: { auth: boolean }
  ): Promise<ImApiEnvelopeOk<T> | ImApiError> {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    if (options.auth) {
      const token = await this.tenantToken();
      if (!token.ok) return token;
      headers.Authorization = `Bearer ${token.data}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      return { ok: false, message: `网络错误：${error instanceof Error ? error.message : String(error)}` };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, message: `飞书返回了非 JSON 响应（HTTP ${response.status}）` };
    }
    if (!payload || typeof payload !== "object") {
      return { ok: false, message: `飞书返回了意外响应（HTTP ${response.status}）` };
    }
    const record = payload as Record<string, unknown>;
    const code = typeof record.code === "number" ? record.code : Number.NaN;
    if (!Number.isFinite(code)) {
      return { ok: false, message: `飞书响应缺少 code（HTTP ${response.status}）` };
    }
    if (code !== 0) {
      const message = typeof record.msg === "string" && record.msg ? record.msg : `飞书返回错误码 ${code}`;
      return { ok: false, code, message };
    }
    const data = record.data && typeof record.data === "object" ? record.data as T : ({} as T);
    return { ok: true, data, envelope: record };
  }
}
