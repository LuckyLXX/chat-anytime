import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 气泡合规重申的接线契约（2026-11-02）。
 *
 * 断线是静默的：扩展没注册、注册在主题块之前、或者静态规范仍被挤在中段，表现都只是
 * 「模型又用 Markdown 回了」。这里把三件事钉在源码上（与 ui-theme-wiring 同型）：
 *   ① 内联扩展按本会话的 divMode 注入；② 它排在 createUiThemeExtension **之后**
 *      （否则末尾是主题块，重申又退回中段）；③ 静态规范排在 systemPromptOverride
 *      的最后一段（零额外 token 的位置修正，与 ② 叠起来 = 尾重两遍）。
 *
 * 行尾：本地工作区 LF、CI 检出 CRLF，读入即归一化。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

const runtime = read("pi-runtime.ts");

describe("Compliance reminder wiring", () => {
  it("内联扩展按本会话的 divMode 注入（IM 会话压成 off：飞书卡片不渲染 HTML）", () => {
    expect(runtime).toContain("createDivModeExtension({");
    expect(runtime).toContain("divMode: divModeForSession");
    expect(runtime).toContain("const divModeForSession = (): DivBubbleMode => (recordBox?.im || options.im ? \"off\" : recordAgent.divMode);");
  });

  it("排在主题块之后（最终尾部是重申那一行）", () => {
    const theme = runtime.indexOf("createUiThemeExtension({");
    const reminder = runtime.indexOf("createDivModeExtension({");
    expect(theme).toBeGreaterThan(-1);
    expect(reminder).toBeGreaterThan(theme);
  });

  it("静态 Div 规范排在系统提示词覆盖的最后一段", () => {
    const override = runtime.slice(runtime.indexOf("systemPromptOverride: (base) =>"), runtime.indexOf("await resourceLoader.reload();"));
    const div = override.indexOf("buildDivModePrompt(divModeForSession())");
    expect(div).toBeGreaterThan(-1);
    // 所有其它块都在它之前：记忆块（原来的最后一段）也必须在它之前
    for (const block of ["buildSkillsSystemPromptBlock(", "TOOL_ORCHESTRATION_PROMPT_BLOCK", "OUTPUT_FORMAT_PROMPT_BLOCK", "buildSubagentPromptBlock(", "memoryPromptBlock"]) {
      const at = override.indexOf(block);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(div);
    }
  });
});
