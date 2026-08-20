import { describe, expect, it } from "vitest";
import { THEME_PRESETS, bubbleOpacityCss, collectThemeLayers, scopeCustomThemeCss, scopeCustomThemeCssForPreview, themePresetCss, themePreviewCss, themeWallpaperOpacity, wallpaperOpacityCss } from "./theme-presets";

describe("theme presets", () => {
  it("contains the reference palette families", () => {
    expect(THEME_PRESETS.map((preset) => preset.id)).toEqual([
      "default", "ocean", "emerald", "indigo", "forest", "rose", "amber", "violet", "carbon", "blue-dream"
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

  it("includes explicit foreground and status tokens for dark surfaces", () => {
    const css = themePreviewCss("default");
    expect(css).toContain("--text-on-user-bubble: #ffffff;");
    expect(css).toContain("--inline-code-text: var(--accent-hover);");
    expect(css).toContain("--danger-soft: #4a1d2b;");
    expect(css).toContain("--diff-remove-text: #fda4af;");
  });

  it("chooses readable button foregrounds for bright preset accents", () => {
    expect(themePresetCss("emerald")).toContain("--text-on-accent: #052e16;");
    expect(themePresetCss("amber")).toContain("--text-on-accent: #422006;");
  });

  it("reads generic and mode-specific wallpaper opacity values", () => {
    const css = `:root { --chat-bg-opacity: 24%; }
:root[data-theme-effective="light"] { --chat-bg-opacity: 0.18; }
:root[data-theme-effective="dark"] { --chat-bg-opacity: 0.16 !important; }`;

    expect(themeWallpaperOpacity(css, "light")).toBe(0.18);
    expect(themeWallpaperOpacity(css, "dark")).toBe(0.16);
    expect(themeWallpaperOpacity(":root { --chat-bg-opacity: 24%; }", "light")).toBe(0.24);
  });

  it("clamps wallpaper opacity overrides before emitting CSS", () => {
    const css = wallpaperOpacityCss({ light: 1.5, dark: -0.2 }, ".preview");

    expect(css).toContain('.preview[data-theme-wallpaper="true"][data-theme-effective="light"] {\n  --chat-bg-opacity: 1 !important;\n}');
    expect(css).toContain('.preview[data-theme-wallpaper="true"][data-theme-effective="dark"] {\n  --chat-bg-opacity: 0 !important;\n}');
  });

  it("lets explicit opacity overrides win over important theme declarations", () => {
    expect(wallpaperOpacityCss({ dark: 0.42 }, ".preview"))
      .toBe('.preview[data-theme-wallpaper="true"][data-theme-effective="dark"] {\n  --chat-bg-opacity: 0.42 !important;\n}');
  });

  it("emits nothing without a stored slider preference", () => {
    expect(wallpaperOpacityCss(undefined, ".preview")).toBe("");
    expect(wallpaperOpacityCss({ light: Number.NaN }, ".preview")).toBe("");
  });

  it("emits bubble-alpha per mode with rounded integer percentages", () => {
    const css = bubbleOpacityCss({ light: 0.8, dark: 0.65 }, ".preview");

    expect(css).toContain('.preview[data-theme-wallpaper="true"][data-theme-effective="light"] {\n  --bubble-alpha: 80% !important;\n}');
    expect(css).toContain('.preview[data-theme-wallpaper="true"][data-theme-effective="dark"] {\n  --bubble-alpha: 65% !important;\n}');
  });

  it("clamps and drops invalid bubble-opacity values", () => {
    expect(bubbleOpacityCss({ light: 1.9, dark: -0.3 }, ".preview"))
      .toBe('.preview[data-theme-wallpaper="true"][data-theme-effective="light"] {\n  --bubble-alpha: 100% !important;\n}\n.preview[data-theme-wallpaper="true"][data-theme-effective="dark"] {\n  --bubble-alpha: 0% !important;\n}');
    expect(bubbleOpacityCss(undefined, ".preview")).toBe("");
    expect(bubbleOpacityCss({ dark: Number.NaN }, ".preview")).toBe("");
  });

  it("redirects ChatAnyTime mode selectors into a preview scope", () => {
    expect(scopeCustomThemeCssForPreview("html.theme-light { --accent: red; } :root { --surface: blue; }"))
      .toBe('.theme-preview-scope[data-theme-custom][data-theme-effective="light"] { --accent: red; } .theme-preview-scope[data-theme-custom][data-theme-effective] { --surface: blue; }');
  });

  it("maps common ChatAnyTime variables into the desktop token names", () => {
    expect(scopeCustomThemeCss(':root { --bg-primary: #111; --accent-primary: #f0a; color: var(--text-primary); }'))
      .toBe(':root[data-theme-custom][data-theme-effective] { --surface: #111; --accent: #f0a; color: var(--text); }');
  });

  it("keeps ChatAnyTime semantic bubble variables and maps success colors", () => {
    const css = scopeCustomThemeCss(":root { --accent-success: #12b981; --ai-bubble: #101827; --tool-bubble-bg: #18243a; }");
    expect(css).toContain("--success: #12b981");
    expect(css).toContain("--ai-bubble: #101827");
    expect(css).toContain("--tool-bubble-bg: #18243a");
  });

  it("keeps ChatAnyTime wallpaper variables and scopes bubble styles", () => {
    const css = scopeCustomThemeCss("html.has-wallpaper .message-bubble { --chat-bg-image: url(wallpaper-dark.png); }");
    expect(css).toContain(':root[data-theme-custom][data-theme-wallpaper="true"]');
    expect(css).toContain(':root[data-theme-custom] .message-bubble');
    expect(css).toContain("--chat-bg-image: url(wallpaper-dark.png)");
  });

  it("collects decoration layer declarations with natural name ordering", () => {
    const css = `:root {
  --pi-layer-backdrop: url(palace.webp) center / cover no-repeat;
  --pi-layer-mascot-10: url(m10.webp) bottom right / 220px no-repeat;
  --pi-layer-mascot-2: url(m2.webp) bottom right / 200px no-repeat;
  --pi-overlay-frame: url(frame.webp) top / 600px repeat-x;
}
:root[data-theme-effective="dark"] { --pi-layer-backdrop: url(palace-dark.webp) center / cover no-repeat; }
.x { background: var(--pi-layer-backdrop); }`;

    expect(collectThemeLayers(css)).toEqual([
      { kind: "layer", name: "backdrop" },
      { kind: "layer", name: "mascot-2" },
      { kind: "layer", name: "mascot-10" },
      { kind: "overlay", name: "frame" }
    ]);
  });

  it("collects no layers from ordinary theme CSS", () => {
    expect(collectThemeLayers(":root { --accent: red; } .x { background: var(--pi-layer-none-here); }")).toEqual([]);
    expect(collectThemeLayers("")).toEqual([]);
  });
});
