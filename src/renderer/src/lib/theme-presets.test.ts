import { describe, expect, it } from "vitest";
import { THEME_PRESETS, scopeCustomThemeCss, scopeCustomThemeCssForPreview, themePresetCss, themePreviewCss } from "./theme-presets";

describe("theme presets", () => {
  it("contains the reference palette families", () => {
    expect(THEME_PRESETS.map((preset) => preset.id)).toEqual([
      "default", "ocean", "emerald", "indigo", "forest", "rose", "amber", "violet", "carbon"
    ]);
  });

  it("emits light and dark selectors so mode changes stay live", () => {
    const css = themePresetCss("ocean");
    expect(css).toContain(':root[data-theme-preset="ocean"] {');
    expect(css).toContain(':root[data-theme-preset="ocean"][data-theme="dark"]');
    expect(css).toContain(':root[data-theme-preset="ocean"][data-theme="system"]');
    expect(css).toContain("--accent: #0284c7");
    expect(css).toContain("--accent: #0ea5e9");
  });

  it("lets custom root rules override preset selectors", () => {
    expect(scopeCustomThemeCss(':root[data-theme-effective="dark"] { --accent: red; }'))
      .toBe(':root[data-theme-custom][data-theme-effective="dark"] { --accent: red; }');
  });

  it("emits independent light and dark variables for nested previews", () => {
    const css = themePreviewCss("ocean");
    expect(css).toContain('.theme-preview-scope[data-theme-effective="light"]');
    expect(css).toContain('.theme-preview-scope[data-theme-effective="dark"]');
    expect(css).toContain('.theme-preview-scope[data-theme-preset="ocean"][data-theme="dark"]');
    expect(css).toContain("--accent: #0ea5e9");
    expect(css).toContain("--accent: #0284c7");
    expect(css).not.toContain(':root[data-theme-preset="ocean"]');
  });

  it("redirects ChatAnyTime mode selectors into a preview scope", () => {
    expect(scopeCustomThemeCssForPreview("html.theme-light { --accent: red; } :root { --surface: blue; }"))
      .toBe('.theme-preview-scope[data-theme-effective="light"] { --accent: red; } .theme-preview-scope[data-theme-effective="dark"] { --surface: blue; }');
  });

  it("maps common ChatAnyTime variables into the desktop token names", () => {
    expect(scopeCustomThemeCss(':root { --bg-primary: #111; --accent-primary: #f0a; color: var(--text-primary); }'))
      .toBe(':root[data-theme-custom] { --surface: #111; --accent: #f0a; color: var(--text); }');
  });
});
