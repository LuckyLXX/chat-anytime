import { describe, expect, it } from "vitest";
import { CUSTOM_PROVIDER_ID, createDefaultAgent, isPositiveInt, mergeProviderModels, migrateSettings, normalizeAccessMode, normalizeAgent, normalizeCheckpoint, normalizeCustomThemes, normalizeDivBubbleMode, normalizeInterfaceTuning, normalizeProvider, normalizeThemeAssets, normalizeVision, normalizeWallpaperOpacity } from "./settings.js";

describe("desktop settings migration", () => {
  it("migrates the legacy custom provider without changing its stable id", () => {
    const result = migrateSettings({ customProvider: { name: "中转站", baseUrl: "https://example.com/v1", models: [{ id: "vision-model", name: "Vision" }] }, customProviderApiKey: "secret", thinkingLevel: "high" });
    expect(result.settings.version).toBe(2);
    expect(result.settings.providers[0]).toMatchObject({ id: CUSTOM_PROVIDER_ID, baseUrl: "https://example.com/v1" });
    expect(result.legacyApiKey).toBe("secret");
    expect(result.settings.agents).toHaveLength(1);
  });

  it("keeps interface tuning and drops invalid density/radius values", () => {
    const result = migrateSettings({ appearance: { theme: "dark", tune: { density: "compact", radius: "round" } } });
    expect(result.settings.appearance.tune).toEqual({ density: "compact", radius: "round" });
    expect(normalizeInterfaceTuning({ density: "huge", radius: "blob" })).toBeUndefined();
    expect(normalizeInterfaceTuning({ density: "relaxed", radius: "blob" })).toEqual({ density: "relaxed" });
    expect(normalizeInterfaceTuning(undefined)).toBeUndefined();
    expect(migrateSettings({ appearance: { theme: "system" } }).settings.appearance.tune).toBeUndefined();
  });

  it("keeps custom agent prompts empty and always provides the default assistant", () => {
    const result = migrateSettings({ agents: [{ id: "coder", name: "代码助手", systemPrompt: "" }] });
    expect(result.settings.agents.find((agent) => agent.id === "coder")?.systemPrompt).toBe("");
    expect(result.settings.agents.find((agent) => agent.id === "coder")?.divMode).toBe("off");
    expect(result.settings.agents.some((agent) => agent.id === "default")).toBe(true);
    expect(createDefaultAgent().id).toBe("default");
  });

  it("persists the Agent-level Div mode switch", () => {
    const result = migrateSettings({ agents: [{ id: "designer", name: "设计助手", divMode: true }] });
    expect(result.settings.agents.find((agent) => agent.id === "designer")).toMatchObject({ divMode: "always" });
    expect(createDefaultAgent().divMode).toBe("auto");
  });

  it("migrates the legacy boolean divMode and keeps valid tri-state values idempotently", () => {
    expect(normalizeDivBubbleMode(true)).toBe("always");
    expect(normalizeDivBubbleMode(false)).toBe("off");
    expect(normalizeDivBubbleMode(undefined)).toBe("off");
    expect(normalizeDivBubbleMode("auto")).toBe("auto");
    expect(normalizeDivBubbleMode("always")).toBe("always");
    expect(normalizeDivBubbleMode("sideways" as unknown as string)).toBe("off");
    // 已迁移的设置再次落盘-读回应原样保留（幂等）。
    const result = migrateSettings({ agents: [{ id: "designer", divMode: "auto" as unknown as boolean }] });
    expect(result.settings.agents.find((agent) => agent.id === "designer")?.divMode).toBe("auto");
  });

  it("preserves only valid Agent-level Skill overrides", () => {
    const agent = normalizeAgent({
      id: "coder",
      skillOverrides: { " skill:review ": false, "skill:notes": true, invalid: true, "skill:bad": "yes" as unknown as boolean }
    });

    expect(agent.skillOverrides).toEqual({ "skill:review": false, "skill:notes": true });
    expect(normalizeAgent({ id: "plain" }).skillOverrides).toBeUndefined();
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

  it("treats powershell as opt-in: absent keys default off, explicit true survives", () => {
    // 存量配置缺 powershell 键 → 默认关闭，其余工具缺省开启语义不变。
    expect(normalizeAgent({ id: "legacy", tools: { bash: false } }).tools).toMatchObject({ bash: false, read: true, powershell: false });
    // 显式开启则保留。
    expect(normalizeAgent({ id: "ps", tools: { powershell: true } }).tools).toMatchObject({ powershell: true, bash: true });
    // 默认 Agent 与新建路径同样默认关闭。
    expect(createDefaultAgent().tools).toMatchObject({ powershell: false, bash: true });
  });

  it("keeps legacy provider models enabled by default", () => {
    const result = migrateSettings({ providers: [{ id: "proxy", name: "代理", baseUrl: "https://proxy.test/v1", models: [{ id: "model-a" }, { id: "model-b", enabled: false }] }] });
    expect(result.settings.providers[0]?.models).toEqual([
      { id: "model-a", name: "model-a", imageInput: undefined, enabled: true },
      { id: "model-b", name: "model-b", imageInput: undefined, enabled: false }
    ]);
  });

  it("preserves built-in provider visibility entries through migration", () => {
    const result = migrateSettings({ providers: [
      { id: "openai", name: "OpenAI", baseUrl: "", models: [{ id: "gpt-4o", name: "GPT-4o", enabled: true }, { id: "gpt-4o-mini", name: "GPT-4o mini", enabled: false }], custom: false },
      { id: "proxy", name: "代理", baseUrl: "https://proxy.test/v1", models: [{ id: "model-a", enabled: false }] }
    ] });
    expect(result.settings.providers).toEqual([
      { id: "openai", name: "OpenAI", baseUrl: "", models: [{ id: "gpt-4o", name: "GPT-4o", imageInput: undefined, enabled: true }, { id: "gpt-4o-mini", name: "GPT-4o mini", imageInput: undefined, enabled: false }], custom: false },
      { id: "proxy", name: "代理", baseUrl: "https://proxy.test/v1", models: [{ id: "model-a", name: "model-a", imageInput: undefined, enabled: false }] }
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

  it("keeps user-corrected token limits through an upstream refresh and normalization", () => {
    // 手动修正的限额不能被「拉取最新模型」冲掉。
    const merged = mergeProviderModels(
      [{ id: "glm-4.6", name: "GLM", contextWindow: 200000, maxTokens: 32000, imageInput: true, enabled: true }],
      [{ id: "glm-4.6", name: "GLM upstream", imageInput: false }]
    );
    expect(merged[0]).toMatchObject({ contextWindow: 200000, maxTokens: 32000 });
    // 非法/缺省值在规范化时被丢弃，不会流入运行时。
    const normalized = normalizeProvider({
      id: "p",
      name: "P",
      baseUrl: "",
      models: [
        { id: "a", name: "a", contextWindow: -5, maxTokens: Number.NaN },
        { id: "b", name: "b", contextWindow: 65536, maxTokens: 8192 }
      ]
    });
    expect(normalized.models[0]).not.toHaveProperty("contextWindow");
    expect(normalized.models[0]).not.toHaveProperty("maxTokens");
    expect(normalized.models[1]).toMatchObject({ contextWindow: 65536, maxTokens: 8192 });
  });

  it("migrates the live theme controls and custom CSS", () => {
    const result = migrateSettings({ appearance: { theme: "dark", themePreset: "rose", customCss: ".message { outline: 1px solid red; }", showThinking: false } });
    expect(result.settings.appearance).toEqual({
      theme: "dark",
      themePreset: "rose",
      customCss: ".message { outline: 1px solid red; }",
      customThemes: [],
      showThinking: false
    });
  });

  it("falls back to safe appearance defaults for unknown theme values", () => {
    const result = migrateSettings({ appearance: { theme: "neon", themePreset: "unknown", customCss: 42 } });
    expect(result.settings.appearance).toEqual({ theme: "system", themePreset: "default", customCss: "", customThemes: [], showThinking: true });
  });

  it("accepts the expanded reference theme presets", () => {
    expect(migrateSettings({ appearance: { themePreset: "ocean" } }).settings.appearance.themePreset).toBe("ocean");
  });

  it("migrates legacy themeOverrides wallpaper opacity and clamps values", () => {
    expect(normalizeWallpaperOpacity({ light: { accent: "#abcdef", wallpaperOpacity: 1.4 }, dark: { wallpaperOpacity: "-0.2" } })).toEqual({ light: 1, dark: 0 });
    expect(normalizeWallpaperOpacity({ light: { wallpaperOpacity: "not-a-number" } })).toBeUndefined();
    expect(migrateSettings({ appearance: { themeOverrides: { dark: { wallpaperOpacity: 0.42 } } } }).settings.appearance.wallpaperOpacity).toEqual({ dark: 0.42 });
    expect(migrateSettings({ appearance: { wallpaperOpacity: { light: 0.24, dark: 0.32 } } }).settings.appearance.wallpaperOpacity).toEqual({ light: 0.24, dark: 0.32 });
  });

  it("defaults unknown access modes to asking and preserves supported modes", () => {
    expect(migrateSettings({}).settings.accessMode).toBe("ask");
    expect(normalizeAccessMode("read-only")).toBe("read-only");
    expect(normalizeAccessMode("workspace")).toBe("workspace");
    expect(normalizeAccessMode("full")).toBe("full");
    expect(normalizeAccessMode("unsafe")).toBe("ask");
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

  it("keeps imported image and font data separate from the editable CSS", () => {
    const result = migrateSettings({ appearance: { customCss: ":root { --chat-bg-image: url(wallpaper.png); }", customCssAssets: { "wallpaper.png": "data:image/png;base64,abc", "brand.woff2": "data:font/woff2;base64,def" } } });
    expect(result.settings.appearance.customCss).toContain("url(wallpaper.png)");
    expect(result.settings.appearance.customCss).not.toContain("base64");
    expect(result.settings.appearance.customCssAssets).toEqual({ "wallpaper.png": "data:image/png;base64,abc", "brand.woff2": "data:font/woff2;base64,def" });
    expect(normalizeThemeAssets({ "../wallpaper.png": "data:image/png;base64,abc", bad: "https://example.com/image.png" })).toEqual({ "../wallpaper.png": "data:image/png;base64,abc" });
  });

  it("normalizes the vision fallback config and drops empty ones", () => {
    expect(migrateSettings({ vision: { enabled: true, provider: " proxy ", model: " glm-4v-flash ", prompt: "  " } }).settings.vision).toEqual({ enabled: true, provider: "proxy", model: "glm-4v-flash" });
    expect(migrateSettings({}).settings.vision).toBeUndefined();
    expect(normalizeVision({ enabled: false, provider: "", model: "" })).toBeUndefined();
    expect(normalizeVision({ enabled: false, provider: "proxy", model: "glm-4v-flash", prompt: "详细描述" })).toEqual({ enabled: false, provider: "proxy", model: "glm-4v-flash", prompt: "详细描述" });
    expect(normalizeVision("invalid")).toBeUndefined();
  });

  it("normalizes the checkpoint toggle with default-enabled semantics", () => {
    expect(normalizeCheckpoint({ enabled: false })).toEqual({ enabled: false });
    expect(normalizeCheckpoint({})).toEqual({ enabled: true });
    expect(normalizeCheckpoint("invalid")).toBeUndefined();
    // 缺省视为启用（enabled !== false），落盘读回不漂移。
    expect(migrateSettings({ checkpoint: { enabled: false } }).settings.checkpoint).toEqual({ enabled: false });
    expect(migrateSettings({ checkpoint: { enabled: true } }).settings.checkpoint).toEqual({ enabled: true });
    expect(migrateSettings({}).settings.checkpoint).toBeUndefined();
  });
});
