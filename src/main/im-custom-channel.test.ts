import { describe, expect, it } from "vitest";
import type { ImChannelConfig } from "../shared/protocol.js";
import {
  createCustomChannelTransport,
  customChannelEndpoint,
  CustomOutbox,
  IM_CUSTOM_MAX_TEXT_CHARS,
  IM_CUSTOM_REPLY_LIMIT,
  normalizeCustomMessage,
  readCustomToken,
  type CustomChannelTransport
} from "./im-custom-channel.js";
import type { ImInboundMessage } from "./im-feishu-channel.js";

/**
 * 自定义通道（2026-11-12，接内网工作软件）的回归网。
 *
 * 这一层坏起来全是「静默」：Token 没校验 = 本机任何进程都能让 AI 跑命令、回调 404 沉默、
 * 出站队列无限涨、长消息把网关撑死。所以全部走真实 HTTP（127.0.0.1 随机端口、零外部依赖），
 * 不 mock 掉边界。
 */

const channelConfig = (over: Partial<ImChannelConfig> = {}): ImChannelConfig => ({
  id: "dingtalk",
  kind: "custom",
  enabled: true,
  appId: "",
  host: "127.0.0.1",
  port: 0,
  allowFrom: [],
  accessMode: "workspace",
  ...over
});

interface Harness {
  transport: CustomChannelTransport;
  messages: ImInboundMessage[];
  ignored: string[];
  statuses: string[];
  logs: string[];
  base: () => string;
  dispose: () => void;
}

async function startHarness(options: { token?: string } = {}): Promise<Harness> {
  const messages: ImInboundMessage[] = [];
  const ignored: string[] = [];
  const statuses: string[] = [];
  const logs: string[] = [];
  const transport = createCustomChannelTransport({
    config: channelConfig(),
    token: options.token ?? "token-123",
    onMessage: (message) => messages.push(message),
    onIgnored: (reason) => ignored.push(reason),
    onStatus: (state) => statuses.push(state),
    onLog: (level, message) => logs.push(`${level}:${message}`),
    fetchImpl: (async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch
  });
  await transport.ws.start();
  return {
    transport,
    messages,
    ignored,
    statuses,
    logs,
    base: () => {
      const value = transport.ws.endpoint?.();
      if (!value) throw new Error("通道没有监听地址");
      return value;
    },
    dispose: () => transport.ws.dispose()
  };
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

function postMessage(base: string, token: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return call(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
}

describe("normalizeCustomMessage", () => {
  it("把脚本的 JSON 变成本地会话能吃的消息（只收文本）", () => {
    const normalized = normalizeCustomMessage({ peerId: "zhangsan", text: "帮我看下发布记录", messageId: "m-1" });
    expect(normalized).toEqual({
      kind: "message",
      message: {
        messageId: "m-1",
        chatId: "zhangsan",
        chatType: "p2p",
        openId: "zhangsan",
        senderType: "user",
        messageType: "text",
        text: "帮我看下发布记录"
      }
    });
  });

  it("缺 peerId / text 非字符串 / replyUrl 非法都拒收（带人话原因）", () => {
    expect(normalizeCustomMessage({ text: "x" })).toEqual({ kind: "ignore", reason: "缺少 peerId（发送人标识）" });
    expect(normalizeCustomMessage({ peerId: "a", text: 42 })).toEqual({ kind: "ignore", reason: "text 必须是字符串" });
    expect(normalizeCustomMessage({ peerId: "a", text: "x", replyUrl: "ftp://x" })).toEqual({ kind: "ignore", reason: "replyUrl 必须是 http(s) 绝对地址" });
    expect(normalizeCustomMessage("nope")).toEqual({ kind: "ignore", reason: "请求体不是 JSON 对象" });
  });

  it("超长文本截断、缺 messageId 自动生成（去重的兜底不能变成同一 id）", () => {
    const long = normalizeCustomMessage({ peerId: "a", text: "字".repeat(IM_CUSTOM_MAX_TEXT_CHARS + 10) });
    expect(long.kind === "message" && long.message.text.length).toBe(IM_CUSTOM_MAX_TEXT_CHARS);
    const first = normalizeCustomMessage({ peerId: "a", text: "hi" });
    const second = normalizeCustomMessage({ peerId: "a", text: "hi" });
    expect(first.kind === "message" && first.message.messageId).toMatch(/^custom-/u);
    expect(first.kind === "message" && second.kind === "message" && first.message.messageId !== second.message.messageId).toBe(true);
  });
});

describe("CustomOutbox", () => {
  it("按游标取、按 peer 过滤，超出上限只留最近 N 条", () => {
    const outbox = new CustomOutbox();
    for (let index = 0; index < IM_CUSTOM_REPLY_LIMIT + 5; index += 1) {
      outbox.push({ peerId: index % 2 === 0 ? "a" : "b", text: `t${index}`, at: index });
    }
    expect(outbox.size).toBe(IM_CUSTOM_REPLY_LIMIT);
    expect(outbox.cursor).toBe(IM_CUSTOM_REPLY_LIMIT + 5);
    const page = outbox.since(outbox.cursor - 2);
    expect(page.map((item) => item.text)).toEqual([`t${IM_CUSTOM_REPLY_LIMIT + 3}`, `t${IM_CUSTOM_REPLY_LIMIT + 4}`]);
    expect(outbox.since(0, "b").every((item) => item.peerId === "b")).toBe(true);
  });
});

describe("自定义通道服务", () => {
  it("没配 Token 就不启动（fail-closed，不监听任何端口）", async () => {
    const statuses: string[] = [];
    const transport = createCustomChannelTransport({
      config: channelConfig(),
      token: "",
      onMessage: () => undefined,
      onStatus: (state) => statuses.push(state)
    });
    await expect(transport.ws.start()).rejects.toThrow("未设置接入 Token");
    expect(statuses).toContain("error");
    expect(transport.ws.connected()).toBe(false);
    expect(transport.ws.endpoint()).toBeUndefined();
  });

  it("Token 不对一律 401，对了才把消息交给网关", async () => {
    const harness = await startHarness();
    try {
      expect(harness.statuses).toContain("connected");
      expect(harness.base()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
      const denied = await postMessage(harness.base(), "wrong", { peerId: "zhangsan", text: "x" });
      expect(denied.status).toBe(401);
      expect(harness.messages).toHaveLength(0);

      const accepted = await postMessage(harness.base(), "token-123", { peerId: "zhangsan", text: "帮我看下发布记录", messageId: "m-9" });
      expect(accepted.status).toBe(202);
      expect(accepted.body).toMatchObject({ ok: true, messageId: "m-9", peerId: "zhangsan" });
      expect(harness.messages).toHaveLength(1);
      expect(harness.messages[0]).toMatchObject({ openId: "zhangsan", chatId: "zhangsan", text: "帮我看下发布记录" });

      // 坏请求体：400 且带上具体原因（脚本排查靠它）
      const bad = await postMessage(harness.base(), "token-123", { text: "x" });
      expect(bad.status).toBe(400);
      expect(String(bad.body.error)).toContain("peerId");
      expect(harness.ignored).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  it("答案两条腿都通：能轮询取回，也能按 replyUrl 回调出去", async () => {
    const harness = await startHarness();
    try {
      const base = harness.base();
      await postMessage(base, "token-123", { peerId: "zhangsan", text: "跑测试", replyUrl: "http://127.0.0.1:9/reply" });
      const sent = await harness.transport.api.sendText("zhangsan", "全部通过 ✅");
      expect(sent.ok).toBe(true);
      await new Promise((resolve) => { setTimeout(resolve, 30); });

      const replies = await call(`${base}/replies?since=0&token=token-123`);
      expect(replies.status).toBe(200);
      const items = replies.body.items as { text: string; peerId: string }[];
      expect(items.map((item) => item.text)).toContain("全部通过 ✅");
      expect(replies.body.next).toBe(1);

      const health = await call(`${base}/health?token=token-123`);
      expect(health.body).toMatchObject({ ok: true, channelId: "dingtalk", cursor: 1 });
    } finally {
      harness.dispose();
    }
  });

  it("卡片一律不支持（网关据此降级为纯文本）", async () => {
    const harness = await startHarness();
    try {
      expect(await harness.transport.api.sendCard("zhangsan", {})).toMatchObject({ ok: false });
      expect(await harness.transport.api.patchCard("m", {})).toMatchObject({ ok: false });
    } finally {
      harness.dispose();
    }
  });

  it("dispose 之后端口关掉、endpoint 消失（重启/改配置不留野端口）", async () => {
    const harness = await startHarness();
    const base = harness.base();
    harness.dispose();
    expect(harness.statuses).toContain("stopped");
    await expect(call(`${base}/health?token=token-123`)).rejects.toBeTruthy();
  });
});

describe("地址与鉴权口径", () => {
  it("endpoint 是脚本直接能拼的那段 base", () => {
    expect(customChannelEndpoint("127.0.0.1", 8787)).toBe("http://127.0.0.1:8787/v1");
    expect(customChannelEndpoint("0.0.0.0", 8787)).toBe("http://0.0.0.0:8787/v1");
  });

  it("token 可以从 Authorization、X-PiDesktop-Token 或 ?token= 取", () => {
    const url = new URL("http://x/v1/replies?token=fromQuery");
    expect(readCustomToken({ authorization: "Bearer abc" }, url)).toBe("abc");
    expect(readCustomToken({ "x-pidesktop-token": "xyz" }, url)).toBe("xyz");
    expect(readCustomToken({}, url)).toBe("fromQuery");
    expect(readCustomToken({}, new URL("http://x/v1/replies"))).toBe("");
  });
});
