import { describe, expect, it } from "vitest";
import { buildDivModePrompt, buildUiThemeContextBlock, DIV_AUTO_MODE_PROMPT, DIV_COLOR_PROMPT, DIV_DYNAMIC_MODE_PROMPT, DIV_MEDIA_PROMPT, DIV_MODE_PROMPT, UI_THEME_PALETTE_ORDER } from "./div-prompt.js";
import type { UiThemeContext } from "../shared/protocol.js";

const PALETTE = {
  surface: "#172033",
  surfaceRaised: "#1e293b",
  text: "#eef2ff",
  textMuted: "#a6b1c5",
  border: "#334155",
  accent: "#4f46e5",
  accentSoft: "#25254b"
};

const DARK_WALLPAPER: UiThemeContext = { mode: "dark", wallpaper: true, palette: PALETTE };

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

  it("teaches workspace-relative image references for both modes", () => {
    expect(DIV_MEDIA_PROMPT).toContain('<img src="相对路径"');
    expect(DIV_MEDIA_PROMPT).toContain("outputs/fox.png");
    expect(DIV_MEDIA_PROMPT).toContain("不要拼绝对路径或 file:// 前缀");
    expect(buildDivModePrompt("always")).toContain(DIV_MEDIA_PROMPT);
    expect(buildDivModePrompt("auto")).toContain(DIV_MEDIA_PROMPT);
  });

  it("off mode injects nothing", () => {
    expect(buildDivModePrompt("off")).toBeUndefined();
    expect(buildUiThemeContextBlock("off", DARK_WALLPAPER)).toBeUndefined();
  });

  it("teaches readable bubble colors in both modes and off still injects nothing", () => {
    expect(DIV_COLOR_PROMPT).toContain("对比度 ≥ 4.5:1");
    expect(DIV_COLOR_PROMPT).toContain("var(--surface)");
    expect(DIV_COLOR_PROMPT).toContain("var(--accent-soft)");
    expect(DIV_COLOR_PROMPT).toContain("壁纸");
    expect(buildDivModePrompt("always")).toContain(DIV_COLOR_PROMPT);
    expect(buildDivModePrompt("auto")).toContain(DIV_COLOR_PROMPT);
    expect(buildDivModePrompt("off")).toBeUndefined();
  });

  it("renders the live theme context as one compact line", () => {
    const dark = buildUiThemeContextBlock("auto", DARK_WALLPAPER)!;
    expect(dark).toBe(
      "【当前界面主题】深色模式｜聊天区背景：壁纸图片｜主题色值：surface #172033｜surface-raised #1e293b｜text #eef2ff｜text-muted #a6b1c5｜border #334155｜accent #4f46e5｜accent-soft #25254b"
    );
    // 浅色 + 纯色面板
    expect(buildUiThemeContextBlock("auto", { mode: "light", wallpaper: false, palette: PALETTE }))
      .toContain("【当前界面主题】浅色模式｜聊天区背景：纯色面板｜");
    // 读不到的键直接不出现，不编造
    expect(buildUiThemeContextBlock("auto", { mode: "light", wallpaper: false, palette: { text: "#111111" } }))
      .toBe("【当前界面主题】浅色模式｜聊天区背景：纯色面板｜主题色值：text #111111");
    // 完全没有色值时只报明暗与背景
    expect(buildUiThemeContextBlock("auto", { mode: "dark", wallpaper: false, palette: {} }))
      .toBe("【当前界面主题】深色模式｜聊天区背景：纯色面板");
    expect(buildUiThemeContextBlock("auto", undefined)).toBeUndefined();
  });

  it("keeps both prompt blocks inside their token budget", () => {
    // 系统提示词的每一句都要付费：两块的长度钉住，后续改动不会静默膨胀。
    expect(DIV_COLOR_PROMPT.length).toBeLessThanOrEqual(320);
    expect(buildUiThemeContextBlock("always", DARK_WALLPAPER)!.length).toBeLessThanOrEqual(200);
    // 键顺序与渲染端上报表是同一份口径（写入顺序即提示词顺序）
    expect(UI_THEME_PALETTE_ORDER.map(([key]) => key)).toEqual(Object.keys(PALETTE));
  });
});
