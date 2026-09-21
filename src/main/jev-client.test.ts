import { describe, expect, it } from "vitest";
import { probeJev } from "./runtime-jev.js";
import { askJev, buildJevProbe, detectSensitivePage, extractErrorDetail, JEV_PROBE_EXPECTED, JEV_PROBE_QUESTION, type JevFetch } from "./jev-client.js";

/** 构造一个按调用序返回预设响应的假 fetch。 */
function fakeFetch(responses: { status: number; body?: unknown; text?: string }[]) {
  const calls: { url: string; body: unknown; apiKey: string }[] = [];
  let index = 0;
  const fetchJev: JevFetch = async (url, body, apiKey) => {
    calls.push({ url, body, apiKey });
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return {
      status: response.status,
      json: async () => response.body,
      text: async () => response.text ?? JSON.stringify(response.body ?? {})
    };
  };
  return { fetchJev, calls };
}

const query = {
  baseUrl: "https://api.typesafe.ai/v1",
  apiKey: "k",
  model: "jev-latest",
  state: { a: 1 },
  questions: { operation: { type: "choice", criteria: { CLICK: "点" } } }
};

const noDelay = async (): Promise<void> => undefined;

describe("jev client", () => {
  it("posts to {baseUrl}/systemone with a bearer token and returns answers", async () => {
    const { fetchJev, calls } = fakeFetch([{ status: 200, body: { model: "jev-1.13.0", answers: { operation: { choice: "CLICK" } }, usage: { input_tokens: 12 } } }]);
    const result = await askJev(query, fetchJev, undefined, noDelay);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.apiKey).toBe("k");
    expect(calls[0]!.body).toMatchObject({ model: "jev-latest", state: { a: 1 } });
    expect(result.answers).toEqual({ operation: { choice: "CLICK" } });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual({ input_tokens: 12 });
  });

  it("tolerates a trailing slash in the configured base url", async () => {
    const { fetchJev, calls } = fakeFetch([{ status: 200, body: { answers: {} } }]);
    await askJev({ ...query, baseUrl: "https://gateway.local/typesafe/v1/" }, fetchJev, undefined, noDelay);
    expect(calls[0]!.url).toBe("https://gateway.local/typesafe/v1/systemone");
  });

  it("retries 429/503/529 with backoff and succeeds", async () => {
    const { fetchJev, calls } = fakeFetch([
      { status: 429 },
      { status: 503 },
      { status: 200, body: { answers: { ok: true } } }
    ]);
    const delays: number[] = [];
    const result = await askJev(query, fetchJev, undefined, async (ms) => { delays.push(ms); });
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([500, 1000]);
    expect(result.answers).toEqual({ ok: true });
  });

  it("gives up after three retryable failures", async () => {
    const { fetchJev, calls } = fakeFetch([{ status: 503 }]);
    await expect(askJev(query, fetchJev, undefined, noDelay)).rejects.toThrow(/已重试 3 次/);
    expect(calls).toHaveLength(3);
  });

  it("maps a rejected key to an actionable error without retrying", async () => {
    const { fetchJev, calls } = fakeFetch([{ status: 401 }]);
    await expect(askJev(query, fetchJev, undefined, noDelay)).rejects.toThrow(/检查密钥/);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a network failure and names the endpoint", async () => {
    let attempts = 0;
    const fetchJev: JevFetch = async () => { attempts += 1; throw new Error("ENOTFOUND"); };
    await expect(askJev(query, fetchJev, undefined, noDelay)).rejects.toThrow(/无法连接 TypeSafe（https:\/\/api\.typesafe\.ai\/v1\/systemone）/);
    expect(attempts).toBe(1);
  });

  it("surfaces an http error body", async () => {
    const { fetchJev } = fakeFetch([{ status: 422, text: '{"message":"model required"}' }]);
    // 报文里只保留人类可读的那一句（不再把整包 JSON 丢给用户/模型）。
    await expect(askJev(query, fetchJev, undefined, noDelay)).rejects.toThrow(/HTTP 422：model required/);
  });

  it("rejects a response without answers", async () => {
    const { fetchJev } = fakeFetch([{ status: 200, body: { model: "x" } }]);
    await expect(askJev(query, fetchJev, undefined, noDelay)).rejects.toThrow(/没有 answers/);
  });

  it("rejects a non-JSON body", async () => {
    const { fetchJev } = fakeFetch([{ status: 200, text: "<html>proxy error</html>" }]);
    // json() 抛错 → 映射为「不是合法 JSON」并终止（不执行任何动作）。
    const broken: JevFetch = async () => ({ status: 200, json: async () => { throw new Error("bad json"); }, text: async () => "" });
    await expect(askJev(query, broken, undefined, noDelay)).rejects.toThrow(/不是合法 JSON/);
    expect(fetchJev).toBeDefined();
  });
});

describe("sensitive page detection", () => {
  it("stops on login / captcha / payment wording", () => {
    expect(detectSensitivePage({ pageText: "请输入验证码" })).toContain("验证码");
    expect(detectSensitivePage({ pageText: "请登录后继续" })).toContain("登录");
    expect(detectSensitivePage({ title: "收银台" })).toContain("支付");
    expect(detectSensitivePage({ pageText: "Sign in to continue" })).toContain("登录或验证码");
    expect(detectSensitivePage({ items: [{ label: "Pay now" }] })).toContain("支付");
  });

  it("stays quiet on ordinary pages", () => {
    expect(detectSensitivePage({ title: "Google Flights", pageText: "Zurich to London" })).toBeUndefined();
    expect(detectSensitivePage({})).toBeUndefined();
  });
});

describe("jev connectivity probe (设置页「测试连接」)", () => {
  it("builds a real choice question with a known correct answer", () => {
    const probe = buildJevProbe("jev-latest");
    expect(probe.model).toBe("jev-latest");
    const question = probe.questions[JEV_PROBE_QUESTION] as { type: string; criteria: Record<string, string> };
    // 必须是**真实形状**的 choice 问法：探测的价值就在于同时验证请求与响应两端的契约。
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria).sort()).toEqual([JEV_PROBE_EXPECTED, "disconnect"].sort());
  });

  it("reports success with the model that actually answered", async () => {
    const { fetchJev, calls } = fakeFetch([{
      status: 200,
      body: { model: "jev-1.13.0", answers: { [JEV_PROBE_QUESTION]: { type: "choice", choice: "connect", confidence: 1, probabilities: { connect: 1, disconnect: 0 } } } }
    }]);
    const result = await probeJev({ baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", apiKey: "secret" }, fetchJev);
    expect(result.ok).toBe(true);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.message).toContain("连接成功");
    // 打的是真实端点路径 + 真实密钥
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.apiKey).toBe("secret");
  });

  it("fails with an actionable message when the response shape is wrong", async () => {
    // 上游回了 noul（不是 choice）——这正是「本地测试全绿、真机每步都报无效响应」的那类漂移。
    const { fetchJev } = fakeFetch([{ status: 200, body: { answers: { [JEV_PROBE_QUESTION]: { type: "noul", noul: 0.9 } } } }]);
    const result = await probeJev({ baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", apiKey: "k" }, fetchJev);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不符合预期形状");
  });

  it("surfaces the API key rejection instead of a generic failure", async () => {
    const { fetchJev } = fakeFetch([{ status: 401, body: {} }]);
    const result = await probeJev({ baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", apiKey: "bad" }, fetchJev);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("API Key");
  });

  it("asks for the missing field instead of firing a pointless request", async () => {
    const { fetchJev, calls } = fakeFetch([{ status: 200, body: {} }]);
    expect((await probeJev({ baseUrl: "", model: "jev-latest", apiKey: "k" }, fetchJev)).message).toContain("接口地址");
    expect((await probeJev({ baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", apiKey: "" }, fetchJev)).message).toContain("API Key");
    expect(calls).toHaveLength(0);
  });

  it("fails on the wrong answer instead of pretending the switch works", async () => {
    const { fetchJev } = fakeFetch([{
      status: 200,
      body: { answers: { [JEV_PROBE_QUESTION]: { type: "choice", choice: "disconnect", confidence: 1, probabilities: { connect: 0, disconnect: 1 } } } }
    }]);
    const result = await probeJev({ baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", apiKey: "k" }, fetchJev);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("disconnect");
  });
});

describe("错误体解析（形状来自 2026-09-21 真实端点实测）", () => {
  it("取官方端点 detail.message（401/403 的真实形状）", () => {
    expect(extractErrorDetail(JSON.stringify({ detail: { error_type: "authentication_error", message: "Must supply an API key!" } })))
      .toBe("Must supply an API key!");
    expect(extractErrorDetail(JSON.stringify({ detail: { message: "Cannot authenticate with the server." } })))
      .toBe("Cannot authenticate with the server.");
  });

  it("回落到 message / error.message，最后才是原文截断", () => {
    expect(extractErrorDetail(JSON.stringify({ message: "bad request" }))).toBe("bad request");
    expect(extractErrorDetail(JSON.stringify({ error: { message: "gateway exploded" } }))).toBe("gateway exploded");
    // 网关的 HTML 错误页不是 JSON——不能因为解析失败就丢掉信息。
    expect(extractErrorDetail("<html>502 Bad Gateway</html>")).toBe("<html>502 Bad Gateway</html>");
    expect(extractErrorDetail("")).toBe("");
  });

  it("403（官方端点「未带密钥」的真实状态码）也给可行动的密钥提示", async () => {
    const { fetchJev } = fakeFetch([{ status: 403, text: JSON.stringify({ detail: { message: "Must supply an API key! Check your request and try again." } }) }]);
    const result = await probeJev({ baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", apiKey: "k" }, fetchJev);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Must supply an API key!");
    expect(result.message).toContain("API Key");
  });
});
