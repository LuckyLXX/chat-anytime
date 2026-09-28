import { describe, expect, it } from "vitest";
import { shouldRevealBrowserTab } from "./browser-reveal";

describe("shouldRevealBrowserTab（when-hidden 档的条件判定）", () => {
  it("面板未开时永远 reveal（用户报告的核心场景：AI 操作浏览器但面板关着）", () => {
    expect(shouldRevealBrowserTab(false, undefined, "pi-browser-1")).toBe(true);
    expect(shouldRevealBrowserTab(false, ["pi-browser-1"], "pi-browser-1")).toBe(true);
  });

  it("面板开着且标签已在面板里：不 reveal（不打扰正在看其他内容的用户）", () => {
    expect(shouldRevealBrowserTab(true, ["pi-browser-1"], "pi-browser-1")).toBe(false);
    expect(shouldRevealBrowserTab(true, ["default", "pi-browser-1"], "pi-browser-1")).toBe(false);
  });

  it("面板开着但标签不在面板里（渲染端重载脱节）：reveal 找回标签", () => {
    expect(shouldRevealBrowserTab(true, undefined, "pi-browser-1")).toBe(true);
    expect(shouldRevealBrowserTab(true, [], "pi-browser-1")).toBe(true);
    expect(shouldRevealBrowserTab(true, ["default"], "pi-browser-1")).toBe(true);
  });
});
