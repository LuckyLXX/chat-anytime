// 默认导入（CJS 互操作）：ws 的 module.exports 就是 WebSocket 类，具名导入在
// Node ESM 的 cjs-module-lexer 下不保证被识别。
import NodeWebSocket from "ws";
import { decodeFrame, encodeFrame, headerValue, payloadText, setHeader, setPayloadText, type PbFrame } from "./im-proto.js";

/**
 * 飞书长连接（WebSocket）客户端（2026-11-12，IM 通道 P1）。
 *
 * 协议按官方 `larksuite/node-sdk` 的 `ws-client/*.ts` 一比一复刻：
 *
 * 1. 握手 `POST https://<domain>/callback/ws/endpoint`，body `{AppID, AppSecret}`，
 *    响应给出 WSS 地址（query 带 device_id / service_id）与 ClientConfig。
 * 2. 帧是 protobuf `pbbp2.Frame`（见 im-proto.ts）。method=0 是控制帧（ping/pong），
 *    method=1 是数据帧（headers.type = event / card）。
 * 3. 每 PingInterval 秒发一帧 ping（service = URL 里的 service_id）；收到 pong 时
 *    用 payload 里的 ClientConfig 更新心跳间隔。
 * 4. 事件帧按 `message_id` 聚合（`seq` 从 0，`sum` 为片数），拼完 JSON.parse。
 * 5. **ACK 是把收到的同一帧原样回发**，追加 header `biz_rt`（处理耗时 ms），
 *    payload 换成 `{"code":200}`；卡片回调的 `data` 放 base64(JSON.stringify({toast, card}))。
 *    不回 ACK 平台会重投（所以正常路径必须 ACK）。
 * 6. 断线按指数退避（1s→2s→4s…上限 60s）+ 抖动重连；连续失败 5 次进 error 停止。
 * 7. 看门狗：`3 × PingInterval` 内没有任何入站帧就主动 terminate 重连——SDK 实测
 *    过长连接会「假活」（socket 还在、事件不再来），心跳自己发出去不代表链路通。
 *
 * 可测性：socket 工厂、握手函数、时钟、随机数、定时器全部可注入；本模块**不读
 * settings**，由 im-gateway 装配。
 */

export interface ImSocketLike {
  on(event: "open" | "close" | "error" | "message", listener: (...args: unknown[]) => void): void;
  send(data: Uint8Array): void;
  close(): void;
  /** ws 专有：立即断开（不发关闭帧）。缺省回落到 close()。 */
  terminate?(): void;
}

export interface ImWsHandshakeConfig {
  appId: string;
  appSecret: string;
  domain?: string;
}

export interface ImWsClientConfig {
  pingInterval?: number;
  reconnectCount?: number;
  reconnectInterval?: number;
  reconnectNonce?: number;
}

export interface ImWsHandshakeResult {
  url: string;
  clientConfig?: ImWsClientConfig;
}

export type ImWsState = "connecting" | "connected" | "error" | "stopped";

export interface ImWsStatusDetail {
  message?: string;
}

/** 卡片回执：`{toast?, card?}` 会被 base64 后放进 ACK 的 data。 */
export interface ImWsCardAck {
  toast?: { type: "success" | "error" | "info" | "warning"; content: string };
  card?: unknown;
}

export interface ImWsClientDeps {
  fetchImpl?: typeof fetch;
  createSocket?: (url: string) => ImSocketLike;
  handshake?: (config: ImWsHandshakeConfig) => Promise<ImWsHandshakeResult>;
  now?: () => number;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
}

export interface ImWsClientOptions extends ImWsClientDeps {
  config: ImWsHandshakeConfig;
  /** 事件体（JSON.parse 之后的 `{schema, header, event}`）。 */
  onEvent: (body: unknown) => void;
  /** 卡片回调；返回 undefined 表示只回一个空 ACK。 */
  onCardAction?: (body: unknown) => Promise<ImWsCardAck | undefined>;
  onStatus?: (state: ImWsState, detail?: ImWsStatusDetail) => void;
  onLog?: (level: "info" | "warn", message: string) => void;
}

/** 官方缺省值（握手没给 ClientConfig 时使用）。 */
export const IM_WS_DEFAULT_PING_INTERVAL_SEC = 120;
export const IM_WS_DEFAULT_RECONNECT_INTERVAL_SEC = 120;
export const IM_WS_DEFAULT_RECONNECT_NONCE_SEC = 30;
/** 连续失败上限：超过就进 error 停止（避免无限重连刷日志）。 */
export const IM_WS_MAX_RECONNECT_ATTEMPTS = 5;
export const IM_WS_RECONNECT_BASE_MS = 1_000;
export const IM_WS_RECONNECT_MAX_MS = 60_000;
/**
 * 连接稳定多久才算「成功」：open 后至少活这么久才把失败计数清零。
 * 平台踢线/网络抖动常常是「连上马上断」，只看 open 就清零会让 1s 退避永远重试下去
 * （对平台是刷接口，对日志是刷屏）。
 */
export const IM_WS_STABLE_RESET_MS = 10_000;

/**
 * 第 n 次失败后的等待时间：1s → 2s → 4s…上限 60s，再叠加抖动
 * `random() × min(nonceMs, delay)`（nonce 来自握手，缺省 30s）。抖动上限**不超过
 * 基础退避本身**：客户端集群被平台同时踢线时不至于又同时回来。
 */
export function retryDelayMs(attempt: number, nonceMs: number, random: () => number): number {
  const base = Math.min(IM_WS_RECONNECT_MAX_MS, IM_WS_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.min(Math.max(0, nonceMs), base) * Math.min(1, Math.max(0, random()));
  return Math.round(base + jitter);
}

/** 从握手 URL 的 query 里取 service_id（帧里的 `service` 字段）。 */
export function serviceIdFromUrl(url: string): number {
  try {
    const value = new URL(url).searchParams.get("service_id");
    const parsed = value ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const parts = data.filter((item): item is Uint8Array => item instanceof Uint8Array);
    if (parts.length === 0) return undefined;
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return merged;
  }
  if (typeof data === "string") return new TextEncoder().encode(data);
  return undefined;
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 默认握手（可被 options.handshake 覆盖）。 */
export async function feishuWsHandshake(config: ImWsHandshakeConfig, fetchImpl: typeof fetch = fetch): Promise<ImWsHandshakeResult> {
  const host = (config.domain ?? "open.feishu.cn").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "") || "open.feishu.cn";
  const response = await fetchImpl(`https://${host}/callback/ws/endpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", locale: "zh" },
    body: JSON.stringify({ AppID: config.appId, AppSecret: config.appSecret })
  });
  const payload = await response.json() as Record<string, unknown>;
  const code = typeof payload.code === "number" ? payload.code : Number.NaN;
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const url = typeof data.URL === "string" ? data.URL : "";
  if (!Number.isFinite(code) || code !== 0 || !url) {
    const message = typeof payload.msg === "string" && payload.msg ? payload.msg : `握手失败（HTTP ${response.status}）`;
    throw new Error(`${message}${Number.isFinite(code) ? `（code ${code}）` : ""}`);
  }
  const rawConfig = data.ClientConfig && typeof data.ClientConfig === "object" ? data.ClientConfig as Record<string, unknown> : {};
  return {
    url,
    clientConfig: {
      pingInterval: typeof rawConfig.PingInterval === "number" ? rawConfig.PingInterval : undefined,
      reconnectCount: typeof rawConfig.ReconnectCount === "number" ? rawConfig.ReconnectCount : undefined,
      reconnectInterval: typeof rawConfig.ReconnectInterval === "number" ? rawConfig.ReconnectInterval : undefined,
      reconnectNonce: typeof rawConfig.ReconnectNonce === "number" ? rawConfig.ReconnectNonce : undefined
    }
  };
}

interface FragmentBuffer {
  sum: number;
  parts: Map<number, Uint8Array>;
  at: number;
}

export class ImWsClient {
  private socket: ImSocketLike | undefined;
  private disposed = false;
  private connectInFlight = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | undefined;
  private pingTimer: number | undefined;
  private watchdogTimer: number | undefined;
  private stableTimer: number | undefined;
  private pingIntervalMs = IM_WS_DEFAULT_PING_INTERVAL_SEC * 1000;
  private reconnectNonceMs = IM_WS_DEFAULT_RECONNECT_NONCE_SEC * 1000;
  private serviceId = 0;
  private lastInboundAt = 0;
  private readonly fragments = new Map<string, FragmentBuffer>();
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancel: (handle: number) => void;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: ImWsClientOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      // 常驻应用的定时器不该拖住宿主退出（与 pi-runtime 的 flush 定时器同口径）。
      (handle as unknown as { unref?: () => void }).unref?.();
      return handle as unknown as number;
    });
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
  }

  /** 握手 → 建连；重复调用是幂等的（已在连接中/已连接时直接返回）。 */
  async start(): Promise<void> {
    if (this.disposed || this.connectInFlight || this.socket) return;
    await this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.teardownSocket(true);
    this.setStatus("stopped");
  }

  /** 当前是否已连上（网关状态兜底用）。 */
  connected(): boolean {
    return Boolean(this.socket);
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.connectInFlight) return;
    this.connectInFlight = true;
    this.setStatus("connecting");
    let handshake: ImWsHandshakeResult;
    try {
      handshake = await (this.options.handshake ?? ((config) => feishuWsHandshake(config, this.options.fetchImpl)))
        ({ ...this.options.config });
    } catch (error) {
      this.connectInFlight = false;
      this.log("warn", `飞书长连接握手失败：${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
      return;
    }
    if (this.disposed) {
      this.connectInFlight = false;
      return;
    }
    // 握手给出的 ClientConfig 只在**本连接**生效：先落地再建 socket。
    this.applyClientConfig(handshake.clientConfig);
    this.serviceId = serviceIdFromUrl(handshake.url);
    const socket = (this.options.createSocket ?? ((url) => createWsSocket(url)))(handshake.url);
    this.socket = socket;
    socket.on("open", () => {
      if (this.disposed || this.socket !== socket) return;
      this.connectInFlight = false;
      this.lastInboundAt = this.now();
      this.setStatus("connected");
      this.startPingLoop();
      this.startWatchdog();
      // 稳定一段时间才清零失败计数（见 IM_WS_STABLE_RESET_MS 的注释）。
      this.clearStableTimer();
      this.stableTimer = this.schedule(() => {
        this.stableTimer = undefined;
        this.reconnectAttempt = 0;
      }, IM_WS_STABLE_RESET_MS);
    });
    socket.on("message", (data) => {
      if (this.disposed || this.socket !== socket) return;
      this.handleIncoming(data);
    });
    socket.on("error", (error) => {
      if (this.disposed || this.socket !== socket) return;
      this.log("warn", `飞书长连接出错：${error instanceof Error ? error.message : String(error)}`);
      this.teardownSocket(true);
      this.scheduleReconnect();
    });
    socket.on("close", () => {
      if (this.disposed || this.socket !== socket) return;
      this.teardownSocket(false);
      this.scheduleReconnect();
    });
    this.connectInFlight = false;
  }

  private applyClientConfig(config: ImWsClientConfig | undefined): void {
    if (!config) return;
    this.pingIntervalMs = positiveSeconds(config.pingInterval, IM_WS_DEFAULT_PING_INTERVAL_SEC) * 1000;
    this.reconnectNonceMs = Math.max(0, positiveSeconds(config.reconnectNonce, IM_WS_DEFAULT_RECONNECT_NONCE_SEC)) * 1000;
  }

  private startPingLoop(): void {
    this.clearPingTimer();
    const tick = (): void => {
      if (this.disposed || !this.socket) return;
      this.sendControl("ping");
      this.pingTimer = this.schedule(tick, this.pingIntervalMs);
    };
    // 与官方实现一致：建连后先发一次，再按间隔继续。
    tick();
  }

  private startWatchdog(): void {
    this.clearWatchdogTimer();
    const tick = (): void => {
      if (this.disposed || !this.socket) return;
      const silence = this.now() - this.lastInboundAt;
      if (silence >= this.pingIntervalMs * 3) {
        this.log("warn", `飞书长连接 ${Math.round(silence / 1000)} 秒没有收到任何帧，判定链路假活，主动重连`);
        this.teardownSocket(true);
        this.scheduleReconnect();
        return;
      }
      this.watchdogTimer = this.schedule(tick, Math.max(1_000, Math.floor(this.pingIntervalMs / 3)));
    };
    this.watchdogTimer = this.schedule(tick, Math.max(1_000, Math.floor(this.pingIntervalMs / 3)));
  }

  private sendControl(type: "ping" | "pong"): void {
    const socket = this.socket;
    if (!socket) return;
    const frame: PbFrame = {
      seqId: 0,
      logId: 0,
      service: this.serviceId,
      method: 0,
      headers: [{ key: "type", value: type }],
      payload: new Uint8Array(0)
    };
    try {
      socket.send(encodeFrame(frame));
    } catch (error) {
      this.log("warn", `发送 ${type} 帧失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleIncoming(data: unknown): void {
    const bytes = toBytes(data);
    if (!bytes || bytes.length === 0) {
      this.log("warn", "收到空帧，已忽略");
      return;
    }
    const frame = decodeFrame(bytes);
    if (!frame) {
      this.log("warn", "收到无法解析的帧（protobuf 解码失败），已忽略");
      return;
    }
    const receivedAt = this.now();
    this.lastInboundAt = receivedAt;
    const type = headerValue(frame, "type") ?? "";
    if (frame.method === 0) {
      this.handleControlFrame(frame, type);
      return;
    }
    if (frame.method !== 1) {
      this.log("warn", `收到未知 method=${frame.method} 的帧，已忽略`);
      return;
    }
    if (type === "card") {
      // 卡片回执要带 data（toast/换卡），ACK 推迟到回调处理完（见 handleCardFrame）。
      void this.handleCardFrame(frame, receivedAt);
      return;
    }
    if (type !== "event") {
      this.ack(frame, receivedAt);
      this.log("warn", `收到未知数据帧类型「${type || "(空)"}」，已 ACK 并忽略`);
      return;
    }
    // 事件帧的 ACK 在**校验分片头之后**（非法帧不回执，让平台按自己的策略重投）。
    this.handleEventFrame(frame, receivedAt);
  }

  private handleControlFrame(frame: PbFrame, type: string): void {
    if (type === "ping") {
      this.sendControl("pong");
      return;
    }
    if (type !== "pong") return;
    const text = payloadText(frame);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const raw = (parsed.ClientConfig ?? parsed.clientConfig ?? parsed) as Record<string, unknown>;
      const config: ImWsClientConfig = {
        pingInterval: typeof raw.PingInterval === "number" ? raw.PingInterval : undefined,
        reconnectNonce: typeof raw.ReconnectNonce === "number" ? raw.ReconnectNonce : undefined,
        reconnectInterval: typeof raw.ReconnectInterval === "number" ? raw.ReconnectInterval : undefined,
        reconnectCount: typeof raw.ReconnectCount === "number" ? raw.ReconnectCount : undefined
      };
      this.applyClientConfig(config);
      // 间隔变了就按新节奏重排心跳（官方 SDK 同口径）。
      if (this.socket) this.startPingLoop();
    } catch {
      this.log("warn", "pong 帧的 payload 不是合法 JSON，沿用现有心跳间隔");
    }
  }

  private handleEventFrame(frame: PbFrame, receivedAt: number): void {
    const messageId = headerValue(frame, "message_id");
    const sumRaw = headerValue(frame, "sum");
    const seqRaw = headerValue(frame, "seq");
    const sum = sumRaw === undefined ? 1 : Number(sumRaw);
    const seq = seqRaw === undefined ? 0 : Number(seqRaw);
    if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) {
      // 非法分片头：不派发、不 ACK（与官方 SDK 一致——让平台按自己的策略重投）。
      this.log("warn", `事件帧分片信息非法（sum=${String(sumRaw)} seq=${String(seqRaw)}），已拒绝`);
      return;
    }
    if (sum === 1) {
      this.ack(frame, receivedAt);
      this.dispatchEvent(frame.payload);
      return;
    }
    if (!messageId) {
      this.log("warn", "多分片事件缺少 message_id，无法聚合，已忽略");
      return;
    }
    this.ack(frame, receivedAt);
    if (this.fragments.size > 100) {
      // 缺片的分片永远等不齐：按到达时间清掉最老的一批，绝不让它无限占内存。
      const oldest = [...this.fragments.entries()].sort((left, right) => left[1].at - right[1].at).slice(0, this.fragments.size - 100);
      for (const [key] of oldest) this.fragments.delete(key);
    }
    const buffer = this.fragments.get(messageId) ?? { sum, parts: new Map<number, Uint8Array>(), at: this.now() };
    buffer.sum = sum;
    buffer.at = this.now();
    buffer.parts.set(seq, frame.payload.slice());
    this.fragments.set(messageId, buffer);
    if (buffer.parts.size < sum) return;
    this.fragments.delete(messageId);
    const parts: Uint8Array[] = [];
    for (let index = 0; index < sum; index += 1) {
      const part = buffer.parts.get(index);
      if (!part) {
        this.log("warn", `事件分片缺失（message_id=${messageId} seq=${index}），已丢弃`);
        return;
      }
      parts.push(part);
    }
    const total = parts.reduce((length, part) => length + part.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    this.dispatchEvent(merged);
  }

  private dispatchEvent(payload: Uint8Array): void {
    if (payload.length === 0) return;
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      this.log("warn", "事件体不是合法 JSON，已忽略");
      return;
    }
    try {
      this.options.onEvent(body);
    } catch (error) {
      this.log("warn", `事件处理抛错（已吞掉，长连接继续）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleCardFrame(frame: PbFrame, receivedAt: number): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(payloadText(frame));
    } catch {
      this.log("warn", "卡片回调体不是合法 JSON，已忽略");
      this.ack(frame, receivedAt);
      return;
    }
    if (!this.options.onCardAction) {
      this.ack(frame, receivedAt);
      return;
    }
    let data: string | undefined;
    try {
      const result = await this.options.onCardAction(body);
      if (result) data = Buffer.from(JSON.stringify(result), "utf8").toString("base64");
    } catch (error) {
      this.log("warn", `卡片回调处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 无论回调成功与否都要 ACK：不回执平台会重投同一次点击（用户会看到重复审批）。
    this.ack(frame, receivedAt, data);
  }

  private ack(frame: PbFrame, receivedAt: number, data?: string): void {
    const socket = this.socket;
    if (!socket) return;
    const elapsed = Math.max(0, Math.round(this.now() - receivedAt));
    const payload = JSON.stringify({ code: 200, ...(data ? { data } : {}) });
    const ackFrame = setHeader(setPayloadText(frame, payload), "biz_rt", String(elapsed));
    try {
      socket.send(encodeFrame(ackFrame));
    } catch (error) {
      this.log("warn", `发送 ACK 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return;
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > IM_WS_MAX_RECONNECT_ATTEMPTS) {
      this.setStatus("error", { message: `连续 ${IM_WS_MAX_RECONNECT_ATTEMPTS} 次重连失败，已停止尝试（保存设置或重启应用后会重连）` });
      return;
    }
    const delay = retryDelayMs(this.reconnectAttempt, this.reconnectNonceMs, this.random);
    this.log("info", `飞书长连接将在 ${delay}ms 后重连（第 ${this.reconnectAttempt} 次）`);
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private teardownSocket(terminate: boolean): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connectInFlight = false;
    this.clearPingTimer();
    this.clearWatchdogTimer();
    this.clearStableTimer();
    this.fragments.clear();
    if (!socket) return;
    try {
      if (terminate && socket.terminate) socket.terminate();
      else socket.close();
    } catch {
      /* 已断开的 socket 再关一次会抛，忽略 */
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    this.cancel(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearPingTimer(): void {
    if (this.pingTimer === undefined) return;
    this.cancel(this.pingTimer);
    this.pingTimer = undefined;
  }

  private clearWatchdogTimer(): void {
    if (this.watchdogTimer === undefined) return;
    this.cancel(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  private clearStableTimer(): void {
    if (this.stableTimer === undefined) return;
    this.cancel(this.stableTimer);
    this.stableTimer = undefined;
  }

  private setStatus(state: ImWsState, detail?: ImWsStatusDetail): void {
    this.options.onStatus?.(state, detail);
  }

  private log(level: "info" | "warn", message: string): void {
    this.options.onLog?.(level, message);
  }
}

/** 默认 socket 工厂：真实 ws 实现（测试注入 fake，不碰网络）。 */
function createWsSocket(url: string): ImSocketLike {
  const socket = new NodeWebSocket(url);
  socket.binaryType = "arraybuffer";
  return {
    on(event, listener) {
      if (event === "message") socket.on("message", (data) => listener(data));
      else socket.on(event, listener as (...args: unknown[]) => void);
    },
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    terminate() {
      socket.terminate();
    }
  };
}
