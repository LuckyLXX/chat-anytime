import { describe, expect, it } from "vitest";
import { ImFeishuApi, IM_CARD_UPDATE_WINDOW_MS, IM_TOKEN_REFRESH_MARGIN_MS, imApiBaseUrl } from "./im-feishu-api";
import { IM_MAX_CARD_BYTES } from "../shared/im";

/**
 * 飞书 OpenAPI 客户端的回归网（零网络：fetch / now / sleep 全注入）。
 *
 * 钉住四类静默失效：token 不缓存（每条消息都换 token）或缓存过期后不换（401 循环）、
 * 同一 chat 超过 5 QPS 被限流、卡片体超 30KB 的必然 400、14 天外更新卡片的白跑一趟。
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: Array<Record<string, unknown>>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined
    });
    const payload = responses.shift() ?? { code: 0, data: {} };
    return {
      status: 200,
      json: async () => payload
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeApi(responses: Array<Record<string, unknown>>, options: { expire?: number; sendMinIntervalMs?: number } = {}) {
  const { fetchImpl, calls } = fakeFetch(responses);
  let now = 1_000_000;
  const sleeps: number[] = [];
  const api = new ImFeishuApi({
    appId: "cli_1",
    appSecret: "secret",
    fetchImpl,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    ...(options.sendMinIntervalMs !== undefined ? { sendMinIntervalMs: options.sendMinIntervalMs } : {})
  });
  return {
    api,
    calls,
    sleeps,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    setNow: (value: number) => { now = value; }
  };
}

function tokenResponse(token = "t-1", expire = 7200) {
  return { code: 0, tenant_access_token: token, expire };
}

function sendResponse(messageId = "om_1") {
  return { code: 0, data: { message_id: messageId } };
}

describe("imApiBaseUrl", () => {
  it("normalizes domain input (default feishu, Lark host, full URL, trailing slash)", () => {
    expect(imApiBaseUrl()).toBe("https://open.feishu.cn");
    expect(imApiBaseUrl("open.larksuite.com")).toBe("https://open.larksuite.com");
    expect(imApiBaseUrl("https://open.feishu.cn/")).toBe("https://open.feishu.cn");
    expect(imApiBaseUrl("  ")).toBe("https://open.feishu.cn");
  });
});

describe("tenant token", () => {
  it("caches the token and only refreshes inside the 30-minute margin", async () => {
    const harness = makeApi([tokenResponse("t-1"), tokenResponse("t-2")]);
    expect((await harness.api.tenantToken()).ok).toBe(true);
    expect((await harness.api.tenantToken()).ok).toBe(true);
    expect(harness.calls.filter((call) => call.url.endsWith("/auth/v3/tenant_access_token/internal"))).toHaveLength(1);

    // 2h 有效、余量 30 分钟：推进到余量之内才会换新。
    harness.advance(7200 * 1000 - IM_TOKEN_REFRESH_MARGIN_MS - 1);
    await harness.api.tenantToken();
    expect(harness.calls.filter((call) => call.url.endsWith("/auth/v3/tenant_access_token/internal"))).toHaveLength(1);
    harness.advance(2);
    const refreshed = await harness.api.tenantToken();
    expect(refreshed).toEqual({ ok: true, data: "t-2" });
  });

  it("sends app_id/app_secret in the body and no Authorization header", async () => {
    const harness = makeApi([tokenResponse()]);
    await harness.api.tenantToken();
    expect(harness.calls[0]).toMatchObject({ method: "POST", body: { app_id: "cli_1", app_secret: "secret" } });
    expect(harness.calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("normalizes a non-zero code into a readable error", async () => {
    const harness = makeApi([{ code: 10014, msg: "app secret invalid" }]);
    const result = await harness.api.tenantToken();
    expect(result).toEqual({ ok: false, code: 10014, message: "app secret invalid" });
  });
});

describe("sendText / sendCard / patchCard", () => {
  it("posts text to the chat_id endpoint with a JSON-string content", async () => {
    const harness = makeApi([tokenResponse(), sendResponse("om_9")]);
    const result = await harness.api.sendText("oc_chat", "你好");
    expect(result).toEqual({ ok: true, data: { messageId: "om_9" } });
    const call = harness.calls[1]!;
    expect(call.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer t-1");
    expect(call.body).toEqual({ receive_id: "oc_chat", msg_type: "text", content: JSON.stringify({ text: "你好" }) });
  });

  it("sends cards with msg_type=interactive and the card JSON as content", async () => {
    const harness = makeApi([tokenResponse(), sendResponse("om_card")]);
    const card = { config: { wide_screen_mode: true, update_multi: true }, elements: [{ tag: "markdown", content: "hi" }] };
    const result = await harness.api.sendCard("oc_chat", card);
    expect(result.ok).toBe(true);
    expect(harness.calls[1]?.body).toEqual({ receive_id: "oc_chat", msg_type: "interactive", content: JSON.stringify(card) });
  });

  it("patches a message by id with the encoded path", async () => {
    const harness = makeApi([tokenResponse(), { code: 0, data: { message_id: "om_1" } }]);
    const result = await harness.api.patchCard("om_1", { elements: [] });
    expect(result.ok).toBe(true);
    expect(harness.calls[1]).toMatchObject({ method: "PATCH", url: "https://open.feishu.cn/open-apis/im/v1/messages/om_1", body: { content: JSON.stringify({ elements: [] }) } });
  });

  it("refuses a card over 30KB before spending a request", async () => {
    const harness = makeApi([tokenResponse()]);
    const big = { content: "x".repeat(IM_MAX_CARD_BYTES) };
    const sent = await harness.api.sendCard("oc_chat", big);
    expect(sent.ok).toBe(false);
    expect(sent.ok === false && sent.message).toContain("30KB");
    expect(harness.calls).toHaveLength(0);
  });

  it("refuses to patch a message older than 14 days (pre-check, no request)", async () => {
    const harness = makeApi([tokenResponse()]);
    const result = await harness.api.patchCard("om_old", { elements: [] }, harness.now() - IM_CARD_UPDATE_WINDOW_MS - 1);
    expect(result.ok).toBe(false);
    expect(harness.calls).toHaveLength(0);
  });

  it("surfaces non-zero codes and missing message ids as errors", async () => {
    const harness = makeApi([tokenResponse(), { code: 230001, msg: "bot not in chat" }, { code: 0, data: {} }]);
    const failed = await harness.api.sendText("oc_chat", "hi");
    expect(failed).toEqual({ ok: false, code: 230001, message: "bot not in chat" });
    const noId = await harness.api.sendText("oc_chat", "hi");
    expect(noId.ok).toBe(false);
  });

  it("reports network failures instead of throwing", async () => {
    const api = new ImFeishuApi({
      appId: "cli_1",
      appSecret: "secret",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      now: () => 0
    });
    const result = await api.tenantToken();
    expect(result).toEqual({ ok: false, message: "网络错误：ECONNREFUSED" });
  });
});

describe("5 QPS limiter", () => {
  it("spaces two sends to the same chat by the minimum interval", async () => {
    const harness = makeApi([tokenResponse(), sendResponse("om_1"), sendResponse("om_2")], { sendMinIntervalMs: 200 });
    await harness.api.sendText("oc_chat", "a");
    await harness.api.sendText("oc_chat", "b");
    expect(harness.sleeps).toEqual([200]);
  });

  it("does not delay sends to different chats", async () => {
    const harness = makeApi([tokenResponse(), sendResponse("om_1"), sendResponse("om_2")], { sendMinIntervalMs: 200 });
    await harness.api.sendText("oc_a", "a");
    await harness.api.sendText("oc_b", "b");
    expect(harness.sleeps).toEqual([]);
  });
});

describe("botInfo", () => {
  it("reads the bot from the top level of the /bot/v3/info envelope", async () => {
    const harness = makeApi([tokenResponse(), { code: 0, msg: "success", bot: { app_name: "值班机器人", open_id: "ou_bot" } }]);
    const result = await harness.api.botInfo();
    expect(result).toEqual({ ok: true, data: { name: "值班机器人", openId: "ou_bot" } });
    expect(harness.calls[1]?.url).toBe("https://open.feishu.cn/open-apis/bot/v3/info");
  });
});
