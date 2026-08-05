import { describe, expect, it } from "vitest";
import { CUSTOM_PROVIDER_ID, createDefaultAgent, mergeProviderModels, migrateSettings } from "./settings.js";

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
      showThinking: false
    });
  });

  it("falls back to safe appearance defaults for unknown theme values", () => {
    const result = migrateSettings({ appearance: { theme: "neon", themePreset: "unknown", customCss: 42 } });
    expect(result.settings.appearance).toEqual({ theme: "system", themePreset: "default", customCss: "", showThinking: true });
  });

  it("accepts the expanded reference theme presets", () => {
    expect(migrateSettings({ appearance: { themePreset: "ocean" } }).settings.appearance.themePreset).toBe("ocean");
  });
});
