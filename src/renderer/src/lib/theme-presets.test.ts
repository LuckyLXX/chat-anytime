import { describe, expect, it } from "vitest";
import { THEME_PRESETS, themePresetCss } from "./theme-presets";

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
});
