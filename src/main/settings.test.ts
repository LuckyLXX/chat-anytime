import { describe, expect, it } from "vitest";
import { CUSTOM_PROVIDER_ID, createDefaultAgent, mergeProviderModels, migrateSettings, normalizeCustomThemes, normalizeThemeAssets, normalizeThemeOverrides } from "./settings.js";

describe("desktop settings migration", () => {
  it("migrates the legacy custom provider without changing its stable id", () => {
    const result = migrateSettings({ customProvider: { name: "中转站", baseUrl: "https://example.com/v1", models: [{ id: "vision-model", name: "Vision" }] }, customProviderApiKey: "secret", thinkingLevel: "high" });
    expect(result.settings.version).toBe(2);
    expect(result.settings.providers[0]).toMatchObject({ id: CUSTOM_PROVIDER_ID, baseUrl: "https://example.com/v1" });
    expect(result.legacyApiKey).toBe("secret");
    expect(result.settings.agents).toHaveLength(1);
  });

  it("keeps custom agent prompts empty and always provides the default assistant", () => {
    const result = migrateSettings({ agents: [{ id: "coder", name: "代码助手", systemPrompt: "" }] });
    expect(result.settings.agents.find((agent) => agent.id === "coder")?.systemPrompt).toBe("");
    expect(result.settings.agents.some((agent) => agent.id === "default")).toBe(true);
    expect(createDefaultAgent().id).toBe("default");
  });

  it("preserves provider and agent defaults while normalizing invalid current ids", () => {
    const result = migrateSettings({
      providers: [{ id: "proxy", name: "代理", baseUrl: "https://proxy.test/v1", models: [{ id: "vision-model" }] }],
      agents: [{ id: "coder", name: "代码助手", defaultModel: { provider: "proxy", id: "vision-model" }, defaultThinkingLevel: "high", tools: { bash: false } }],
      currentAgentId: "missing"
    });
    expect(result.settings.providers[0]).toMatchObject({ id: "proxy", models: [{ id: "vision-model", name: "vision-model" }] });
    expect(result.settings.currentAgentId).toBe("default");
    expect(result.settings.agents.find((agent) => agent.id === "coder")).toMatchObject({ defaultThinkingLevel: "high", tools: { bash: false, read: true } });
  });

  it("keeps legacy provider models enabled by default", () => {
    const result = migrateSettings({ providers: [{ id: "proxy", name: "代理", baseUrl: "https://proxy.test/v1", models: [{ id: "model-a" }, { id: "model-b", enabled: false }] }] });
    expect(result.settings.providers[0]?.models).toEqual([
      { id: "model-a", name: "model-a", imageInput: undefined, enabled: true },
      { id: "model-b", name: "model-b", imageInput: undefined, enabled: false }
    ]);
  });

  it("preserves local model choices when merging an upstream refresh", () => {
    const merged = mergeProviderModels(
      [{ id: "vision", name: "Vision", imageInput: false, enabled: false }],
      [{ id: "vision", name: "Vision upstream", imageInput: true }, { id: "new", name: "New" }]
    );
    expect(merged).toEqual([
      { id: "vision", name: "Vision upstream", imageInput: false, enabled: false },
      { id: "new", name: "New", imageInput: undefined, enabled: false }
    ]);
  });

  it("migrates the live theme controls and custom CSS", () => {
    const result = migrateSettings({ appearance: { theme: "dark", themePreset: "rose", customCss: ".message { outline: 1px solid red; }", showThinking: false } });
    expect(result.settings.appearance).toEqual({
      theme: "dark",
      themePreset: "rose",
      customCss: ".message { outline: 1px solid red; }",
      customThemes: [],
      themeOverrides: { light: {}, dark: {} },
      showThinking: false
    });
  });

  it("falls back to safe appearance defaults for unknown theme values", () => {
    const result = migrateSettings({ appearance: { theme: "neon", themePreset: "unknown", customCss: 42 } });
    expect(result.settings.appearance).toEqual({ theme: "system", themePreset: "default", customCss: "", customThemes: [], themeOverrides: { light: {}, dark: {} }, showThinking: true });
  });

  it("accepts the expanded reference theme presets", () => {
    expect(migrateSettings({ appearance: { themePreset: "ocean" } }).settings.appearance.themePreset).toBe("ocean");
  });

  it("normalizes independent theme color overrides and drops invalid values", () => {
    expect(normalizeThemeOverrides({
      light: { accent: " #ABCDEF ", aiBubble: "rgb(0 0 0)" },
      dark: { accentHover: "#123456", unknown: "#ffffff" }
    })).toEqual({ light: { accent: "#abcdef" }, dark: { accentHover: "#123456" } });
  });

  it("normalizes saved custom CSS themes and ignores empty entries", () => {
    expect(normalizeCustomThemes([
      { id: "midnight", name: "  午夜  ", css: " :root { --accent: red; } ", assets: { "./wallpaper.png": "data:image/png;base64,abc" } },
      { id: "midnight", name: "重复", css: ".message { color: blue; }" },
      { id: "empty", name: "空", css: "   " },
      { name: "无 ID", css: ".message { color: green; }" },
      { id: "bad", css: 42 }
    ])).toEqual([
      { id: "midnight", name: "午夜", css: " :root { --accent: red; } ", assets: { "wallpaper.png": "data:image/png;base64,abc" } },
      { id: "midnight-2", name: "重复", css: ".message { color: blue; }" },
      { id: "custom-4", name: "无 ID", css: ".message { color: green; }" }
    ]);
  });

  it("keeps imported image data separate from the editable CSS", () => {
    const result = migrateSettings({ appearance: { customCss: ":root { --chat-bg-image: url(wallpaper.png); }", customCssAssets: { "wallpaper.png": "data:image/png;base64,abc" } } });
    expect(result.settings.appearance.customCss).toContain("url(wallpaper.png)");
    expect(result.settings.appearance.customCss).not.toContain("base64");
    expect(result.settings.appearance.customCssAssets).toEqual({ "wallpaper.png": "data:image/png;base64,abc" });
    expect(normalizeThemeAssets({ "../wallpaper.png": "data:image/png;base64,abc", bad: "https://example.com/image.png" })).toEqual({ "../wallpaper.png": "data:image/png;base64,abc" });
  });
});
