import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, headerValue, payloadText, type PbFrame } from "./im-proto";
import {
  feishuWsHandshake,
  ImWsClient,
  IM_WS_MAX_RECONNECT_ATTEMPTS,
  retryDelayMs,
  serviceIdFromUrl,
  type ImSocketLike,
  type ImWsHandshakeResult
} from "./im-feishu-ws";

/**
 * 飞书长连接客户端的回归网（假 socket / 假握手 / 手动时钟，零网络）。
 *
 * 每一条都对应一个「静默坏掉」的场景：
 * - 不回 ACK → 平台无限重投同一条消息；
 * - ping 的 service/type 写错 → 平台判定死连接；
 * - 分片乱序/UTF-8 跨片拼接 → 中文事件体 JSON.parse 失败（整条消息丢失）；
 * - 看门狗缺失 → socket 假活，事件再也不来（SDK 实测过的长连接静默断开）；
 * - close 重入 → 一次掉线拉起一串 socket。
 */

class FakeSocket implements ImSocketLike {
  readonly sent: Uint8Array[] = [];
  closed = false;
  terminated = false;
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: "open" | "close" | "error" | "message", listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
  }

  frames(): PbFrame[] {
    return this.sent.map((bytes) => decodeFrame(bytes)).filter((frame): frame is PbFrame => Boolean(frame));
  }

  /** 第 index 个已发送帧（-1 = 最后一帧）。 */
  frameAt(index: number): PbFrame | undefined {
    return decodeFrame(this.sent.at(index) ?? new Uint8Array()) ?? undefined;
  }
}

function createClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(1, ms), fn });
      return id;
    },
    cancel: (id: number): void => { timers.delete(id); },
    advance(ms: number): void {
      const target = current + ms;
      let guard = 0;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        current = due[1].at;
        due[1].fn();
        guard += 1;
        if (guard > 500) throw new Error("定时器风暴：测试推进逻辑有环");
      }
      current = target;
    },
    pending: (): number => timers.size,
    now: (): number => current
  };
}

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

function harness(options: { handshake?: Partial<ImWsHandshakeResult>; onCardAction?: (body: unknown) => Promise<{ toast?: { type: "success"; content: string } } | undefined> } = {}) {
  const sockets: FakeSocket[] = [];
  const clock = createClock();
  const events: unknown[] = [];
  const statuses: string[] = [];
  let inbound = 0;
  const logs: string[] = [];
  let handshakes = 0;
  let random = 0;
  const client = new ImWsClient({
    config: { appId: "cli_1", appSecret: "secret" },
    handshake: async () => {
      handshakes += 1;
      return {
        url: "wss://ws.example/callback?device_id=d1&service_id=42",
        clientConfig: { pingInterval: 60, reconnectNonce: 0 },
        ...options.handshake
      };
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (body) => events.push(body),
    ...(options.onCardAction ? { onCardAction: options.onCardAction } : {}),
    onStatus: (state) => statuses.push(state),
    onLog: (_level, message) => logs.push(message),
    onInbound: () => { inbound += 1; },
    now: () => clock.now(),
    random: () => random,
    schedule: clock.schedule,
    cancel: clock.cancel
  });
  return {
    client,
    sockets,
    clock,
    events,
    statuses,
    logs,
    inbound: () => inbound,
    handshakes: () => handshakes,
    setRandom: (value: number) => { random = value; }
  };
}

function eventFrame(input: { headers: { key: string; value: string }[]; payload: string | Uint8Array }): PbFrame {
  return {
    seqId: 1,
    logId: 2,
    service: 42,
    method: 1,
    headers: [{ key: "type", value: "event" }, ...input.headers],
    payload: typeof input.payload === "string" ? new TextEncoder().encode(input.payload) : input.payload
  };
}

describe("feishuWsHandshake", () => {
  it("POSTs AppID/AppSecret with locale zh and reads URL + ClientConfig", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as unknown, headers: init.headers as Record<string, string> });
      return {
        status: 200,
        json: async () => ({ code: 0, data: { URL: "wss://ws.example/x?service_id=7", ClientConfig: { PingInterval: 30, ReconnectInterval: 15, ReconnectNonce: 5, ReconnectCount: -1 } }, msg: "ok" })
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await feishuWsHandshake({ appId: "cli_1", appSecret: "s", domain: "https://open.larksuite.com/" }, fetchImpl);
    expect(calls[0]?.url).toBe("https://open.larksuite.com/callback/ws/endpoint");
    expect(calls[0]?.body).toEqual({ AppID: "cli_1", AppSecret: "s" });
    expect(calls[0]?.headers.locale).toBe("zh");
    expect(result).toEqual({ url: "wss://ws.example/x?service_id=7", clientConfig: { pingInterval: 30, reconnectCount: -1, reconnectInterval: 15, reconnectNonce: 5 } });
  });

  it("throws a readable error on a non-zero code", async () => {
    const fetchImpl = (async () => ({ status: 200, json: async () => ({ code: 10003, msg: "invalid param" }) }) as unknown as Response) as unknown as typeof fetch;
    await expect(feishuWsHandshake({ appId: "a", appSecret: "b" }, fetchImpl)).rejects.toThrow("invalid param（code 10003）");
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially with a jitter bounded by the base delay", () => {
    expect([1, 2, 3, 4, 7].map((attempt) => retryDelayMs(attempt, 30_000, () => 0))).toEqual([1_000, 2_000, 4_000, 8_000, 60_000]);
    expect(retryDelayMs(1, 30_000, () => 1)).toBe(2_000);
    expect(retryDelayMs(8, 30_000, () => 0.5)).toBe(75_000);
  });

  it("reads the service id out of the handshake URL", () => {
    expect(serviceIdFromUrl("wss://ws.example/callback?device_id=d&service_id=42")).toBe(42);
    expect(serviceIdFromUrl("not a url")).toBe(0);
    expect(serviceIdFromUrl("wss://ws.example/callback")).toBe(0);
  });
});

describe("connection lifecycle", () => {
  it("connects, emits a ping with the handshake service id and type=ping", async () => {
    const { client, sockets, statuses } = harness();
    await client.start();
    expect(statuses).toEqual(["connecting"]);
    sockets[0]!.emit("open");
    expect(statuses).toEqual(["connecting", "connected"]);
    const ping = sockets[0]!.frames()[0]!;
    expect(ping).toMatchObject({ method: 0, service: 42, seqId: 0n, logId: 0n });
    expect(headerValue(ping, "type")).toBe("ping");
    client.dispose();
  });

  it("is idempotent (start twice creates one socket)", async () => {
    const { client, sockets } = harness();
    await client.start();
    await client.start();
    expect(sockets).toHaveLength(1);
    client.dispose();
  });

  it("updates the ping interval from a pong payload", async () => {
    const { client, sockets, clock } = harness();
    await client.start();
    sockets[0]!.emit("open");
    expect(sockets[0]!.frames()).toHaveLength(1);
    // pong 里带新的 PingInterval=10s：随后的心跳要按 10s 而不是 60s。
    sockets[0]!.emit("message", encodeFrame({ seqId: 0, logId: 0, service: 42, method: 0, headers: [{ key: "type", value: "pong" }], payload: new TextEncoder().encode(JSON.stringify({ ClientConfig: { PingInterval: 10 } })) }));
    // 收到新间隔立刻按新节奏发一次，然后每 10s 一次（而不是原来的 60s）。
    expect(sockets[0]!.frames().filter((frame) => headerValue(frame, "type") === "ping")).toHaveLength(2);
    clock.advance(10_000);
    await flush();
    expect(sockets[0]!.frames().filter((frame) => headerValue(frame, "type") === "ping")).toHaveLength(3);
    client.dispose();
  });

  it("reconnects once per close (repeated close does not re-enter)", async () => {
    const { client, sockets, clock } = harness();
    await client.start();
    sockets[0]!.emit("open");
    sockets[0]!.close();
    sockets[0]!.close(); // 第二次 close 必须被忽略
    clock.advance(1_000);
    await flush();
    expect(sockets).toHaveLength(2);
    client.dispose();
  });

  it("stops after the attempt cap instead of reconnecting forever", async () => {
    const { client, sockets, clock, statuses } = harness();
    await client.start();
    // 第 N 次掉线触发第 N 次重排；超过上限（5）那一次才进 error。
    for (let attempt = 0; attempt < IM_WS_MAX_RECONNECT_ATTEMPTS + 1; attempt += 1) {
      sockets.at(-1)!.emit("open");
      sockets.at(-1)!.close();
      clock.advance(120_000);
      await flush();
    }
    expect(statuses).toContain("error");
    const before = sockets.length;
    clock.advance(600_000);
    await flush();
    expect(sockets.length).toBe(before);
    client.dispose();
  });

  it("treats 3×ping-interval of silence as a dead link and reconnects", async () => {
    const { client, sockets, clock } = harness();
    await client.start();
    sockets[0]!.emit("open");
    clock.advance(60_000);
    clock.advance(60_000);
    clock.advance(60_000);
    await flush();
    expect(sockets[0]!.terminated).toBe(true);
    clock.advance(1_000);
    await flush();
    expect(sockets.length).toBe(2);
    client.dispose();
  });

  it("reports every decoded frame via onInbound (diagnostics: link alive vs events)", async () => {
    const { client, sockets, inbound } = harness();
    await client.start();
    sockets[0]!.emit("open");
    const before = inbound();
    sockets[0]!.emit("message", encodeFrame({ seqId: 0, logId: 0, service: 42, method: 0, headers: [{ key: "type", value: "pong" }], payload: new TextEncoder().encode("{}") }));
    sockets[0]!.emit("message", encodeFrame(eventFrame({ headers: [{ key: "message_id", value: "om_1" }], payload: "{}" })));
    expect(inbound()).toBe(before + 2);
    client.dispose();
  });

  it("keeps the link alive while frames arrive", async () => {
    const { client, sockets, clock } = harness();
    await client.start();
    sockets[0]!.emit("open");
    for (let index = 0; index < 5; index += 1) {
      sockets[0]!.emit("message", encodeFrame(eventFrame({ headers: [{ key: "message_id", value: `om_${index}` }], payload: JSON.stringify({ n: index }) })));
      clock.advance(100_000);
      await flush();
    }
    expect(sockets).toHaveLength(1);
    client.dispose();
  });
});

describe("event frames", () => {
  it("dispatches the parsed event body and ACKs the same frame with biz_rt + code 200", async () => {
    const { client, sockets } = harness();
    await client.start();
    sockets[0]!.emit("open");
    const frame = eventFrame({ headers: [{ key: "message_id", value: "om_1" }], payload: JSON.stringify({ schema: "2.0", event: { message: { message_id: "om_1" } } }) });
    sockets[0]!.emit("message", encodeFrame(frame));
    const received = sockets[0]!.frameAt(-1);
    expect(received?.seqId).toBe(1n);
    expect(received?.method).toBe(1);
    expect(headerValue(received!, "biz_rt")).toBe("0");
    expect(JSON.parse(payloadText(received!))).toEqual({ code: 200 });
    client.dispose();
  });

  it("merges out-of-order fragments by seq and decodes UTF-8 only after the byte merge", async () => {
    const { client, sockets, events } = harness();
    await client.start();
    sockets[0]!.emit("open");
    const body = JSON.stringify({ text: "你好，世界", nested: { n: 1 } });
    const bytes = new TextEncoder().encode(body);
    // 在 UTF-8 字节中间切（7/14 落在「你好」的多字节序列里）：逐片解码会得到乱码，
    // 必须先按字节拼接再解码。
    const cuts = [0, 7, 14, bytes.length];
    const parts = [0, 1, 2].map((index) => bytes.subarray(cuts[index], cuts[index + 1]));
    const frames = parts.map((part, index) => eventFrame({
      headers: [{ key: "message_id", value: "om_multi" }, { key: "sum", value: "3" }, { key: "seq", value: String(index) }],
      payload: part
    }));
    sockets[0]!.emit("message", encodeFrame(frames[2]!));
    sockets[0]!.emit("message", encodeFrame(frames[0]!));
    expect(events).toHaveLength(0);
    sockets[0]!.emit("message", encodeFrame(frames[1]!));
    expect(events).toEqual([JSON.parse(body)]);
    client.dispose();
  });

  it("rejects invalid sum/seq without dispatching (and without ACKing)", async () => {
    const { client, sockets, events } = harness();
    await client.start();
    sockets[0]!.emit("open");
    const before = sockets[0]!.sent.length;
    for (const headers of [
      [{ key: "message_id", value: "om_a" }, { key: "sum", value: "2" }, { key: "seq", value: "5" }],
      [{ key: "message_id", value: "om_b" }, { key: "sum", value: "0" }, { key: "seq", value: "0" }],
      [{ key: "message_id", value: "om_c" }, { key: "sum", value: "abc" }, { key: "seq", value: "0" }],
      [{ key: "message_id", value: "om_d" }, { key: "sum", value: "2" }, { key: "seq", value: "-1" }]
    ]) {
      sockets[0]!.emit("message", encodeFrame(eventFrame({ headers, payload: "{}" })));
    }
    expect(events).toHaveLength(0);
    expect(sockets[0]!.sent.length).toBe(before);
    client.dispose();
  });

  it("ACKs card callbacks with base64 data so the toast can be applied in place", async () => {
    const { client, sockets } = harness({ onCardAction: async () => ({ toast: { type: "success", content: "已放行" } }) });
    await client.start();
    sockets[0]!.emit("open");
    const frame: PbFrame = {
      seqId: 5,
      logId: 6,
      service: 42,
      method: 1,
      headers: [{ key: "type", value: "card" }],
      payload: new TextEncoder().encode(JSON.stringify({ event: { action: { value: { k: "perm:ABCD2345:allow-once" } } } }))
    };
    sockets[0]!.emit("message", encodeFrame(frame));
    await flush();
    const ack = sockets[0]!.frameAt(-1)!;
    const payload = JSON.parse(payloadText(ack)) as { code: number; data?: string };
    expect(payload.code).toBe(200);
    expect(JSON.parse(Buffer.from(payload.data!, "base64").toString("utf8"))).toEqual({ toast: { type: "success", content: "已放行" } });
    client.dispose();
  });

  it("ACKs a card callback even when the handler throws (no redelivery storm)", async () => {
    const { client, sockets } = harness({ onCardAction: async () => { throw new Error("boom"); } });
    await client.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", encodeFrame({ seqId: 1, logId: 1, service: 42, method: 1, headers: [{ key: "type", value: "card" }], payload: new TextEncoder().encode("{}") }));
    await flush();
    expect(JSON.parse(payloadText(sockets[0]!.frameAt(-1)!))).toEqual({ code: 200 });
    client.dispose();
  });

  it("ignores undecodable frames and bad JSON payloads without dying", async () => {
    const { client, sockets, events } = harness();
    await client.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", new Uint8Array([0x0f, 0x01]));
    sockets[0]!.emit("message", encodeFrame(eventFrame({ headers: [{ key: "message_id", value: "om_x" }], payload: "not json" })));
    expect(events).toHaveLength(0);
    // 连接仍然可用。
    sockets[0]!.emit("message", encodeFrame(eventFrame({ headers: [{ key: "message_id", value: "om_ok" }], payload: "{}" })));
    expect(events).toHaveLength(1);
    client.dispose();
  });
});
