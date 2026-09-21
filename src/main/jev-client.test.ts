import { describe, expect, it } from "vitest";
import { askJev, detectSensitivePage, type JevFetch } from "./jev-client.js";

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
    await expect(askJev(query, fetchJev, undefined, noDelay)).rejects.toThrow(/重新填写密钥/);
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
    await expect(askJev(query, fetchJev, undefined, noDelay)).rejects.toThrow(/HTTP 422：\{"message":"model required"\}/);
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
