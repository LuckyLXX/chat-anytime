import { describe, expect, it } from "vitest";
import { parseElementPickMessage } from "./browser-preview-pick.js";

describe("parseElementPickMessage", () => {
  it("parses a well-formed {url, element} pick message", () => {
    const result = parseElementPickMessage(
      { url: "https://example.com/page", element: { tag: "button", type: "submit", text: "登录" } },
      "https://fallback.example"
    );
    expect(result).toEqual({ url: "https://example.com/page", element: { tag: "button", type: "submit", text: "登录" } });
  });

  it("carries the in-card note and the element selector path", () => {
    const result = parseElementPickMessage(
      { url: "https://example.com", element: { tag: "button", path: "#main > form > button" }, note: "帮我点击这个按钮" },
      "https://fallback.example"
    );
    expect(result?.note).toBe("帮我点击这个按钮");
    expect(result?.element.path).toBe("#main > form > button");
  });

  it("drops blank notes and caps long ones", () => {
    expect(parseElementPickMessage({ element: { tag: "div" }, note: "   " }, "https://f.example")?.note).toBeUndefined();
    expect(parseElementPickMessage({ element: { tag: "div" }, note: "x".repeat(3000) }, "https://f.example")?.note).toHaveLength(2000);
    expect(parseElementPickMessage({ element: { tag: "div" }, note: 42 }, "https://f.example")?.note).toBeUndefined();
  });

  it("falls back to the tab URL when the message carries none", () => {
    const result = parseElementPickMessage({ element: { tag: "div" } }, "https://fallback.example");
    expect(result?.url).toBe("https://fallback.example");
  });

  it("rejects a payload whose element is missing (regression: whole payload must not be treated as the element)", () => {
    // 曾经的 bug：把 {url, element} 整包当 element 校验，tag 实际在 payload.element.tag，
    // 导致所有手选结果在主进程被静默丢弃。
    expect(parseElementPickMessage({ url: "https://example.com" }, "https://fallback.example")).toBeUndefined();
  });

  it("rejects an element without a string tag", () => {
    expect(parseElementPickMessage({ url: "https://example.com", element: { tag: 42 } }, "https://fallback.example")).toBeUndefined();
    expect(parseElementPickMessage({ url: "https://example.com", element: {} }, "https://fallback.example")).toBeUndefined();
  });

  it("rejects non-object payloads", () => {
    expect(parseElementPickMessage(undefined, "https://fallback.example")).toBeUndefined();
    expect(parseElementPickMessage("button", "https://fallback.example")).toBeUndefined();
    expect(parseElementPickMessage(null, "https://fallback.example")).toBeUndefined();
  });
});
