import { describe, expect, it } from "vitest";
import type { BrowserElementPick } from "../../../shared/protocol.js";
import { composePickMessage, composePickText, formatPickedElementDescription } from "./browser-pick.js";

function pick(element: BrowserElementPick["element"], url = "https://example.com/page"): BrowserElementPick {
  return { tabId: "default", url, element };
}

describe("browser element pick text", () => {
  it("describes a button with its label", () => {
    const result = formatPickedElementDescription(pick({ tag: "button", type: "submit", text: "登录" }));
    expect(result).toBe('<button type="submit"> "登录"');
  });

  it("describes an anchor with role and name", () => {
    const result = formatPickedElementDescription(pick({ tag: "a", role: "link", name: "首页", text: "首页" }));
    expect(result).toBe('<a role="link" name="首页"> "首页"');
  });

  it("composes a full composer message with url, description and content", () => {
    const text = composePickText(pick(
      { tag: "button", type: "submit", text: "登录", href: "https://example.com/login" },
      "https://example.com/page"
    ));
    expect(text).toContain("【来自内置浏览器】");
    expect(text).toContain("页面：https://example.com/page");
    expect(text).toContain('<button type="submit"> "登录"');
    expect(text).toContain("链接：https://example.com/login");
    expect(text).toContain("内容：\n登录");
  });

  it("includes the element CSS selector path when captured", () => {
    const text = composePickText(pick({ tag: "button", path: "#main > form > button:nth-of-type(2)", text: "登录" }));
    expect(text).toContain("路径：#main > form > button:nth-of-type(2)");
  });

  it("omits optional lines when the element carries no link or text", () => {
    const text = composePickText(pick({ tag: "img", src: "https://example.com/a.png" }));
    expect(text).toContain("图片：https://example.com/a.png");
    expect(text).not.toContain("链接：");
    expect(text).not.toContain("内容：");
  });

  it("appends the user note below the element block", () => {
    const text = composePickMessage(pick({ tag: "button", text: "登录" }), "帮我点这个按钮");
    expect(text.startsWith("【来自内置浏览器】\n")).toBe(true);
    expect(text.endsWith("\n\n帮我点这个按钮")).toBe(true);
  });

  it("falls back to the element block alone for a blank note", () => {
    const element = pick({ tag: "button", text: "登录" });
    expect(composePickMessage(element, "")).toBe(composePickText(element));
    expect(composePickMessage(element, "   ")).toBe(composePickText(element));
  });
});
