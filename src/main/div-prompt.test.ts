import { describe, expect, it } from "vitest";
import { buildDivModePrompt, DIV_DYNAMIC_MODE_PROMPT, DIV_MODE_PROMPT } from "./div-prompt.js";

describe("Div mode prompt", () => {
  it("keeps the static bubble output contract", () => {
    expect(DIV_MODE_PROMPT).toContain("<assistant_html><div>...</div></assistant_html>");
    expect(DIV_MODE_PROMPT).toContain("完整 HTML");
    expect(DIV_MODE_PROMPT).toContain("不得使用 ```html");
    expect(DIV_MODE_PROMPT).toContain("data-send");
  });

  it("documents PiDesktop's sandbox boundary for dynamic content", () => {
    expect(DIV_DYNAMIC_MODE_PROMPT).toContain("隔离的 HTML Artifact 预览");
    expect(DIV_DYNAMIC_MODE_PROMPT).toContain("addEventListener");
    expect(buildDivModePrompt()).toContain(DIV_MODE_PROMPT);
    expect(buildDivModePrompt()).toContain(DIV_DYNAMIC_MODE_PROMPT);
  });
});
