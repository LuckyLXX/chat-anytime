import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ImChannelConfig, ImCustomHost } from "../shared/protocol.js";
import { IM_CUSTOM_DEFAULT_HOST } from "../shared/im.js";
import type { ImApiResult } from "./im-feishu-api.js";
import type { ImEventNormalization, ImInboundMessage } from "./im-feishu-channel.js";

/**
 * 自定义通道（2026-11-12，IM 通道 P2）：给内网工作软件用的通用接入点。
 *
 * 形状：本机起一个极小的 HTTP 服务，任何脚本按 `docs/im-channel-protocol.md` 的
 * 三条路由说话即可——
 *   POST /v1/messages   把一条消息投进来（等价于「有人给我发了消息」）
 *   GET  /v1/replies    按游标取回答案（轮询；同时也会回调 replyUrl）
 *   GET  /v1/health     探活
 *
 * 为什么是 HTTP 而不是再写一个平台协议：用户的脚本在哪个平台、用什么语言都不确定，
 * HTTP + JSON 是唯一不需要我们发依赖的接法；而且「谁连谁」可以反过来——脚本推消息
 * 进来，我们推答案回去（回调）或让它来拉（轮询），内网 NAT 也能通。
 *
 * 复用面：网关侧（白名单/去重/会话绑定/排队/审批/`/stop` 指令）一行不改，这里只提供
 * `ImApiLike`（出站）与 `ImWsLike`（入站）两个形状的适配器；卡片一律「不支持」，
 * 让网关自动降级成纯文本（这条兜底链路本来就有）。
 *
 * 安全默认：只监听 127.0.0.1、必须配 Token（没配就不启动）、白名单为空不服务任何消息。
 * Token 与飞书 App Secret 走同一条 safeStorage 通道，永不进 settings.json。
 */

/** 单条入站请求体的字节上限：消息本身很小，超了多半是打错接口或误发文件。 */
export const IM_CUSTOM_MAX_BODY_BYTES = 256 * 1024;
/** 单条消息文本的字符上限（与卡片切片口径一致，超出直接截断并记日志）。 */
export const IM_CUSTOM_MAX_TEXT_CHARS = 20_000;
/** 出站队列长度：轮询方落后太多时只保留最近这些条（回调不受影响）。 */
export const IM_CUSTOM_REPLY_LIMIT = 200;
/** 轮询单页条数。 */
export const IM_CUSTOM_REPLY_PAGE = 50;
/** 回调超时：对方服务器慢不该把网关卡住（我们不等它成功，只是尽力投递）。 */
export const IM_CUSTOM_CALLBACK_TIMEOUT_MS = 8_000;
/** 记住多少个 peer 的 replyUrl（每 peer 只留最近一条）。 */
export const IM_CUSTOM_REPLY_URL_LIMIT = 200;

export const IM_CUSTOM_MESSAGES_PATH = "/v1/messages";
export const IM_CUSTOM_REPLIES_PATH = "/v1/replies";
export const IM_CUSTOM_HEALTH_PATH = "/v1/health";

/** 通道对外地址（脚本要拼的 base，含 /v1）。 */
export function customChannelEndpoint(host: ImCustomHost, port: number): string {
  return `http://${host}:${port}/v1`;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * 入站请求体 → 归一化消息（与飞书事件同一个出口形状，网关侧零分支）。
 *
 * 只收文本：图片/文件走「脚本先存盘、再把路径写进 text」的路子（P2 边界，见文档）。
 */
export function normalizeCustomMessage(body: unknown): ImEventNormalization {
  const root = recordOf(body);
  if (!root) return { kind: "ignore", reason: "请求体不是 JSON 对象" };
  const peerId = trimmed(root.peerId);
  if (!peerId) return { kind: "ignore", reason: "缺少 peerId（发送人标识）" };
  if (peerId.length > 120) return { kind: "ignore", reason: "peerId 超过 120 字" };
  const rawText = root.text;
  if (typeof rawText !== "string") return { kind: "ignore", reason: "text 必须是字符串" };
  const text = rawText.length > IM_CUSTOM_MAX_TEXT_CHARS ? rawText.slice(0, IM_CUSTOM_MAX_TEXT_CHARS) : rawText;
  const messageId = trimmed(root.messageId)?.slice(0, 200) || `custom-${randomUUID()}`;
  const replyUrl = trimmed(root.replyUrl);
  if (replyUrl && !/^https?:\/\/\S{1,2000}$/iu.test(replyUrl)) {
    return { kind: "ignore", reason: "replyUrl 必须是 http(s) 绝对地址" };
  }
  return {
    kind: "message",
    message: {
      messageId,
      chatId: peerId,
      chatType: "p2p",
      openId: peerId,
      senderType: "user",
      messageType: "text",
      text
    }
  };
}

/** 出站队列里的一条（轮询按 seq 游标取）。 */
export interface CustomOutbound {
  seq: number;
  peerId: string;
  text: string;
  at: number;
}

/** 定长环形出站队列：轮询方落后就丢最旧的，绝不无限涨内存。 */
export class CustomOutbox {
  private items: CustomOutbound[] = [];
  private sequence = 0;

  push(input: { peerId: string; text: string; at: number }): CustomOutbound {
    this.sequence += 1;
    const entry: CustomOutbound = { seq: this.sequence, peerId: input.peerId, text: input.text, at: input.at };
    this.items.push(entry);
    if (this.items.length > IM_CUSTOM_REPLY_LIMIT) this.items.splice(0, this.items.length - IM_CUSTOM_REPLY_LIMIT);
    return entry;
  }

  since(cursor: number, peerId?: string, limit = IM_CUSTOM_REPLY_PAGE): CustomOutbound[] {
    return this.items
      .filter((item) => item.seq > cursor && (!peerId || item.peerId === peerId))
      .slice(0, Math.max(1, Math.min(IM_CUSTOM_REPLY_PAGE, limit)));
  }

  /** 当前游标（下一次轮询把它当 since 传回来）。 */
  get cursor(): number {
    return this.sequence;
  }

  get size(): number {
    return this.items.length;
  }
}

/** 只比 token：等长比较避免按字节提前返回（本地端口，聊胜于无）。 */
function tokenMatches(expected: string, candidate: string): boolean {
  if (!expected || !candidate) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 从 Authorization / X-PiDesktop-Token / ?token= 三者之一取 token。 */
export function readCustomToken(headers: IncomingMessage["headers"], url: URL): string {
  const header = headers["authorization"] ?? headers["x-pidesktop-token"];
  const raw = Array.isArray(header) ? header[0] : header;
  const bearer = typeof raw === "string" ? raw.replace(/^Bearer\s+/iu, "").trim() : "";
  if (bearer) return bearer;
  return url.searchParams.get("token")?.trim() ?? "";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve({ ok: false });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => resolve({ ok: false }));
  });
}

export interface CustomChannelApi {
  tenantToken(): Promise<ImApiResult<string>>;
  botInfo(): Promise<ImApiResult<{ name: string; openId?: string }>>;
  sendText(chatId: string, text: string): Promise<ImApiResult<{ messageId: string }>>;
  sendCard(chatId: string, card: unknown): Promise<ImApiResult<{ messageId: string }>>;
  patchCard(messageId: string, card: unknown, sentAt?: number): Promise<ImApiResult<{ messageId: string }>>;
}

export interface CustomChannelWs {
  start(): Promise<void>;
  dispose(): void;
  connected(): boolean;
  /** 实际监听地址（端口随机时以它为准）；未起来时 undefined。 */
  endpoint(): string | undefined;
}

export interface CustomChannelTransportOptions {
  config: ImChannelConfig;
  /** 接入 Token（来自 credentials.json）。空 = 拒绝启动（fail-closed）。 */
  token: string;
  onMessage: (message: ImInboundMessage) => void;
  onIgnored?: (reason: string) => void;
  onStatus: (state: "connected" | "connecting" | "error" | "stopped", message?: string) => void;
  onLog?: (level: "info" | "warn", message: string) => void;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface CustomChannelTransport {
  api: CustomChannelApi;
  ws: CustomChannelWs;
}

/**
 * 建一条自定义通道的连接适配器（不建 socket，`ws.start()` 才监听）。
 *
 * 出站两条腿同时开：
 * - 消息里带 `replyUrl` ⇒ 收到答案就 POST 回去（对方服务不用轮询）；
 * - 同时进 `CustomOutbox` ⇒ 对方也可以 `GET /v1/replies?since=` 来拉。
 * 两条腿互不依赖：回调失败不会影响轮询能拿到。
 */
export function createCustomChannelTransport(options: CustomChannelTransportOptions): CustomChannelTransport {
  const { config, token } = options;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const host: ImCustomHost = config.host ?? IM_CUSTOM_DEFAULT_HOST;
  const desiredPort = config.port ?? 0;
  const outbox = new CustomOutbox();
  /** 每个 peer 最近一次的回复地址与消息 id（答案按 peer 路由，一条会话同一时刻只有一个回合）。 */
  const replyUrls = new Map<string, { url: string; messageId: string }>();
  let server: Server | undefined;
  let listening = false;
  let endpoint: string | undefined;

  const log = (level: "info" | "warn", message: string): void => options.onLog?.(level, message);

  const rememberReplyUrl = (peerId: string, entry: { url: string; messageId: string }): void => {
    replyUrls.delete(peerId);
    replyUrls.set(peerId, entry);
    while (replyUrls.size > IM_CUSTOM_REPLY_URL_LIMIT) {
      const oldest = replyUrls.keys().next().value;
      if (oldest === undefined) break;
      replyUrls.delete(oldest);
    }
  };

  const deliverCallback = async (url: string, peerId: string, text: string, messageId: string): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IM_CUSTOM_CALLBACK_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "x-pidesktop-channel": config.id },
        body: JSON.stringify({ channelId: config.id, peerId, text, messageId, at: now() }),
        signal: controller.signal
      });
      if (!response.ok) log("warn", `回调 ${url} 返回 ${response.status}（答案仍在 /v1/replies 里）`);
    } catch (error) {
      log("warn", `回调 ${url} 失败：${error instanceof Error ? error.message : String(error)}（答案仍在 /v1/replies 里）`);
    } finally {
      clearTimeout(timer);
    }
  };

  const api: CustomChannelApi = {
    tenantToken: async () => ({ ok: true, data: "custom" }),
    botInfo: async () => ({ ok: true, data: { name: config.label || `自定义通道 ${config.id}` } }),
    sendText: async (chatId, text) => {
      const entry = outbox.push({ peerId: chatId, text, at: now() });
      const reply = replyUrls.get(chatId);
      if (reply) void deliverCallback(reply.url, chatId, text, reply.messageId);
      return { ok: true, data: { messageId: `custom-out-${entry.seq}` } };
    },
    // 卡片一律「不支持」：网关会自动退到纯文本（回执卡 → 无回执、审批卡 → 文本审批码）。
    sendCard: async () => ({ ok: false, message: "自定义通道不支持卡片，请改用纯文本" }),
    patchCard: async () => ({ ok: false, message: "自定义通道不支持卡片，请改用纯文本" })
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!tokenMatches(token, readCustomToken(req.headers, url))) {
      res.setHeader("www-authenticate", "Bearer");
      sendJson(res, 401, { ok: false, error: "token 不正确（放在 Authorization: Bearer 或 ?token= 里）" });
      return;
    }
    if (req.method === "GET" && url.pathname === IM_CUSTOM_HEALTH_PATH) {
      sendJson(res, 200, {
        ok: true,
        channelId: config.id,
        endpoint: endpoint ?? "",
        listening,
        outbox: outbox.size,
        cursor: outbox.cursor
      });
      return;
    }
    if (req.method === "GET" && url.pathname === IM_CUSTOM_REPLIES_PATH) {
      const since = Number(url.searchParams.get("since") ?? "0");
      const cursor = Number.isFinite(since) && since >= 0 ? Math.round(since) : 0;
      const peerId = url.searchParams.get("peerId")?.trim() || undefined;
      const limit = Number(url.searchParams.get("limit") ?? "");
      sendJson(res, 200, {
        ok: true,
        items: outbox.since(cursor, peerId, Number.isFinite(limit) ? limit : undefined),
        next: outbox.cursor
      });
      return;
    }
    if (req.method === "POST" && url.pathname === IM_CUSTOM_MESSAGES_PATH) {
      const body = await readBody(req, IM_CUSTOM_MAX_BODY_BYTES);
      if (!body.ok) {
        sendJson(res, 413, { ok: false, error: `请求体超过 ${IM_CUSTOM_MAX_BODY_BYTES} 字节` });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
        return;
      }
      const normalized = normalizeCustomMessage(parsed);
      if (normalized.kind === "ignore") {
        log("info", `忽略自定义通道消息：${normalized.reason}`);
        options.onIgnored?.(normalized.reason);
        sendJson(res, 400, { ok: false, error: normalized.reason });
        return;
      }
      const root = recordOf(parsed);
      const replyUrl = trimmed(root?.replyUrl);
      if (replyUrl) rememberReplyUrl(normalized.message.openId, { url: replyUrl, messageId: normalized.message.messageId });
      options.onMessage(normalized.message);
      sendJson(res, 202, { ok: true, messageId: normalized.message.messageId, peerId: normalized.message.openId });
      return;
    }
    sendJson(res, 404, { ok: false, error: `未知路由 ${req.method ?? "?"} ${url.pathname}（可用：POST /v1/messages · GET /v1/replies · GET /v1/health）` });
  };

  const ws: CustomChannelWs = {
    start: async () => {
      if (!token) {
        options.onStatus("error", "未设置接入 Token：自定义通道不会启动（设置页里填一个，或点「生成」）");
        throw new Error("未设置接入 Token");
      }
      if (server) return;
      options.onStatus("connecting");
      await new Promise<void>((resolve, reject) => {
        const created = createServer((req, res) => {
          void handleRequest(req, res).catch((error) => {
            log("warn", `请求处理失败：${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: "服务内部错误" });
          });
        });
        created.on("error", (error: NodeJS.ErrnoException) => {
          server = undefined;
          listening = false;
          // EADDRINUSE 是可自解释的常见误配：内网脚本常把「通道监听端口」与「回调端口」
          // 写成同一个（协议文档示例的回调服务就是 8799），原样抛 code 会让人以为是 bug。
          const detail = error.code === "EADDRINUSE"
            ? `端口 ${desiredPort} 已被其他程序占用（通道监听端口要和脚本自己的回调端口分开），换一个端口保存即可`
            : error.message;
          options.onStatus("error", `监听 ${host}:${desiredPort || "随机"} 失败：${detail}`);
          // 网关在 start() 的 catch 里会用 error.message 覆盖状态（「连接失败：…」），
          // 所以把友好文案一并放进 reject 的错误里，否则面板上只剩裸 code。
          reject(error.code === "EADDRINUSE" ? Object.assign(new Error(detail), { code: error.code }) : error);
        });
        created.listen({ host, port: desiredPort }, () => {
          server = created;
          listening = true;
          const address = created.address() as AddressInfo | string | null;
          const port = typeof address === "object" && address ? address.port : desiredPort;
          endpoint = customChannelEndpoint(host, port);
          options.onStatus("connected");
          log("info", `自定义通道 ${config.id} 已监听 ${endpoint}`);
          resolve();
        });
      });
    },
    dispose: () => {
      const current = server;
      server = undefined;
      listening = false;
      endpoint = undefined;
      if (!current) return;
      try {
        current.close();
        current.closeAllConnections?.();
      } catch {
        /* 已关闭 */
      }
      options.onStatus("stopped");
    },
    connected: () => listening,
    endpoint: () => endpoint
  };

  return { api, ws };
}
