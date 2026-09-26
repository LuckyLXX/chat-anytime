import { describe, expect, it } from "vitest";
import { MAX_PENDING_REQUESTS, PANEL_CORS_URL_FILTER, buildPanelCorsPatch, requestedHeaders } from "./panel-cors.js";

const origin = "http://127.0.0.1:12378";

function patch(input: Partial<Parameters<typeof buildPanelCorsPatch>[0]> = {}): ReturnType<typeof buildPanelCorsPatch> {
  return buildPanelCorsPatch({
    method: "POST",
    statusLine: "HTTP/1.1 200 OK",
    responseHeaders: {},
    request: { origin },
    ...input
  });
}

function header(result: ReturnType<typeof buildPanelCorsPatch>, name: string): string | string[] | undefined {
  const headers = result?.responseHeaders ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

describe("requestedHeaders", () => {
  it("大小写原样匹配（Electron 给的是发送时的原始头）", () => {
    expect(
      requestedHeaders({
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "access-control-request-headers": "authorization,content-type",
        "User-Agent": "x"
      })
    ).toEqual({ origin, requestedMethod: "POST", requestedHeaders: "authorization,content-type" });
  });

  it("没有 Origin 时只返回空对象（同源/main 进程请求不该被记）", () => {
    expect(requestedHeaders({ "User-Agent": "x" })).toEqual({});
  });
});

describe("buildPanelCorsPatch：普通响应", () => {
  it("服务端完全没给 CORS 头 → 补上反映来源的那一套", () => {
    const result = patch({ responseHeaders: { "content-type": ["application/json"] } });
    expect(header(result, "Access-Control-Allow-Origin")).toEqual([origin]);
    expect(header(result, "Access-Control-Allow-Credentials")).toEqual(["true"]);
    expect(header(result, "Access-Control-Expose-Headers")).toEqual(["*"]);
    // 原有业务头必须原样保留（我们只加 CORS，不重写响应）
    expect(header(result, "content-type")).toEqual(["application/json"]);
  });

  it("服务端自己就给了正确的 Allow-Origin（等于来源或 *）→ 不插手", () => {
    expect(patch({ responseHeaders: { "Access-Control-Allow-Origin": [origin] } })).toBeUndefined();
    expect(patch({ responseHeaders: { "access-control-allow-origin": "*" } })).toBeUndefined();
  });

  it("服务端给错了（指向别的站点）→ 覆盖掉，并清掉其余 access-control-* 残留", () => {
    const result = patch({
      responseHeaders: {
        "Access-Control-Allow-Origin": ["https://evil.example"],
        "Access-Control-Allow-Methods": ["GET"],
        "content-length": ["2"]
      }
    });
    expect(header(result, "Access-Control-Allow-Origin")).toEqual([origin]);
    // 错的 Allow-Methods 留着只会让浏览器判失败（非预检响应里也不该出现两份）
    expect(header(result, "Access-Control-Allow-Methods")).toBeUndefined();
    expect(header(result, "content-length")).toEqual(["2"]);
  });

  it("没有 Origin（同源请求 / main 进程发起）→ 一律不动", () => {
    expect(patch({ request: {} })).toBeUndefined();
    expect(patch({ request: { origin: "  " } })).toBeUndefined();
  });

  it("反映来源时补 Vary: Origin，且与已有 Vary 合并而不是覆盖", () => {
    expect(header(patch(), "Vary")).toBe("Origin");
    expect(header(patch({ responseHeaders: { Vary: ["Accept-Encoding"] } }), "Vary")).toBe("Accept-Encoding, Origin");
    // 已经有了就不重复追加（原样保留服务端自己的 Vary）
    expect(header(patch({ responseHeaders: { Vary: ["Origin"] } }), "Vary")).toEqual(["Origin"]);
    expect(header(patch({ responseHeaders: { Vary: ["origin"] } }), "Vary")).toEqual(["origin"]);
  });

  it("普通响应不改状态行（业务状态码是面板要判的东西）", () => {
    expect(patch({ statusLine: "HTTP/1.1 401 Unauthorized" })?.statusLine).toBeUndefined();
  });
});

describe("buildPanelCorsPatch：预检（OPTIONS）", () => {
  const preflight = { origin, requestedMethod: "POST", requestedHeaders: "authorization,content-type" };

  it("服务端拒绝预检（405）→ 改写状态行并回显它要求的方法/头", () => {
    const result = patch({ method: "OPTIONS", statusLine: "HTTP/1.1 405 Method Not Allowed", request: preflight });
    expect(result?.statusLine).toBe("HTTP/1.1 200 OK");
    expect(header(result, "Access-Control-Allow-Methods")).toEqual(["POST"]);
    expect(header(result, "Access-Control-Allow-Headers")).toEqual(["authorization,content-type"]);
    expect(header(result, "Access-Control-Max-Age")).toEqual(["600"]);
    expect(header(result, "Access-Control-Allow-Origin")).toEqual([origin]);
  });

  it("保留原协议版本（HTTP/2 的响应上写 HTTP/1.1 状态行不合适）", () => {
    const result = patch({ method: "OPTIONS", statusLine: "HTTP/2 405 Method Not Allowed", request: preflight });
    expect(result?.statusLine).toBe("HTTP/2 200 OK");
  });

  it("服务端预检本来就 2xx → 只补 CORS 头，不动状态行", () => {
    const result = patch({ method: "OPTIONS", statusLine: "HTTP/1.1 204 No Content", request: preflight });
    expect(result?.statusLine).toBeUndefined();
    expect(header(result, "Access-Control-Allow-Methods")).toEqual(["POST"]);
  });

  it("带 Origin 但没有 Access-Control-Request-Method 的 OPTIONS 不算预检（不改状态行）", () => {
    const result = patch({ method: "OPTIONS", statusLine: "HTTP/1.1 405 Method Not Allowed", request: { origin } });
    expect(result?.statusLine).toBeUndefined();
    expect(header(result, "Access-Control-Allow-Headers")).toBeUndefined();
  });

  it("预检要求的头缺失时回显 *（比空着强，浏览器会据实际情况判）", () => {
    const result = patch({ method: "OPTIONS", statusLine: "HTTP/1.1 200 OK", request: { origin, requestedMethod: "GET" } });
    expect(header(result, "Access-Control-Allow-Headers")).toEqual(["*"]);
  });
});

describe("安装面的常量", () => {
  it("只挂 http/https（其余 scheme 没有跨域概念，也不该被碰）", () => {
    expect(PANEL_CORS_URL_FILTER).toEqual(["http://*/*", "https://*/*"]);
    expect(MAX_PENDING_REQUESTS).toBeGreaterThanOrEqual(64);
  });
});
