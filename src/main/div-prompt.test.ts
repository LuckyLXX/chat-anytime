import { describe, expect, it } from "vitest";
import { buildDivModePrompt, DIV_AUTO_MODE_PROMPT, DIV_DYNAMIC_MODE_PROMPT, DIV_MODE_PROMPT } from "./div-prompt.js";

describe("Div mode prompt", () => {
  it("keeps the static bubble output contract", () => {
    expect(DIV_MODE_PROMPT).toContain("<assistant_html><div>...</div></assistant_html>");
    expect(DIV_MODE_PROMPT).toContain("完整 HTML");
    expect(DIV_MODE_PROMPT).toContain("不得使用 ```html");
    expect(DIV_MODE_PROMPT).toContain("data-send");
  });

  it("documents PiDesktop's controlled chat-bubble boundary for dynamic content", () => {
    expect(DIV_DYNAMIC_MODE_PROMPT).toContain("聊天窗口内实时渲染气泡");
    expect(DIV_DYNAMIC_MODE_PROMPT).toContain("完整 HTML 页面仍使用隔离的 HTML Artifact 预览");
    expect(DIV_DYNAMIC_MODE_PROMPT).toContain("addEventListener");
    expect(buildDivModePrompt("always")).toContain(DIV_MODE_PROMPT);
    expect(buildDivModePrompt("always")).toContain(DIV_DYNAMIC_MODE_PROMPT);
  });

  it("auto mode delegates the bubble decision to scenario fit instead of mandating it", () => {
    expect(DIV_AUTO_MODE_PROMPT).toContain("<assistant_html><div>...</div></assistant_html>");
    expect(DIV_AUTO_MODE_PROMPT).toContain("自行判断");
    expect(DIV_AUTO_MODE_PROMPT).toContain("原型图");
    expect(DIV_AUTO_MODE_PROMPT).toContain("编写或修改代码的过程中");
    expect(DIV_AUTO_MODE_PROMPT).not.toContain("必须且只输出");
    const prompt = buildDivModePrompt("auto");
    expect(prompt).toContain(DIV_AUTO_MODE_PROMPT);
    expect(prompt).toContain(DIV_DYNAMIC_MODE_PROMPT);
    expect(prompt).not.toContain(DIV_MODE_PROMPT);
  });

  it("off mode injects nothing", () => {
    expect(buildDivModePrompt("off")).toBeUndefined();
  });
});
