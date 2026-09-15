import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUSTOM_PROVIDER_ID, createDefaultAgent, ensureDefaultWorkspaceDir, forgetAgentWorkspace, isPositiveInt, mergeProviderModels, migrateSettings, normalizeAccessMode, normalizeAgent, normalizeAgentWorkspaces, normalizeCheckpoint, normalizeComputer, normalizeCustomThemes, normalizeDivBubbleMode, normalizeInterfaceTuning, normalizeProvider, normalizeThemeAssets, normalizeVision, normalizeWallpaperOpacity, recordAgentWorkspace, resolveDefaultWorkspace, resolveInitialWorkspace } from "./settings.js";

describe("workspace per-agent memory and default workspace (方案 B)", () => {
  it("normalizes agentWorkspaces: keeps non-empty string entries, drops garbage, defaults undefined", () => {
    expect(normalizeAgentWorkspaces({
      default: "D:\\Projects\\a",
      empty: "   ",
      heiyuhe: "D:\\Projects\\b",
      number: 42,
      nul: null
    })).toEqual({ default: "D:\\Projects\\a", heiyuhe: "D:\\Projects\\b" });
    expect(normalizeAgentWorkspaces({ a: "" })).toBeUndefined();
    expect(normalizeAgentWorkspaces(undefined)).toBeUndefined();
    expect(normalizeAgentWorkspaces("junk")).toBeUndefined();
    expect(normalizeAgentWorkspaces([])).toBeUndefined();
  });

  it("migrates agentWorkspaces/defaultWorkspace and drops invalid values", () => {
    const result = migrateSettings({
      agentWorkspaces: { default: " D:\\Projects\\a ", bad: 42, empty: "" },
      defaultWorkspace: "  D:\\Projects\\default  "
    });
    expect(result.settings.agentWorkspaces).toEqual({ default: "D:\\Projects\\a" });
    expect(result.settings.defaultWorkspace).toBe("D:\\Projects\\default");
    // 缺省/空白：两字段均保持 undefined，不产生空对象/空串。
    expect(migrateSettings({}).settings.agentWorkspaces).toBeUndefined();
    expect(migrateSettings({}).settings.defaultWorkspace).toBeUndefined();
    expect(migrateSettings({ defaultWorkspace: "   " }).settings.defaultWorkspace).toBeUndefined();
  });

  it("resolves the default workspace: custom wins, otherwise the built-in directory", () => {
    expect(resolveDefaultWorkspace("C:\\agent", "D:\\Projects\\default")).toBe("D:\\Projects\\default");
    expect(resolveDefaultWorkspace("C:\\agent")).toBe(join("C:\\agent", "workspace-default"));
  });

  it("ensures the default workspace directory idempotently (mkdir recursive)", () => {
    const root = mkdtempSync(join(tmpdir(), "pidesktop-test-"));
    try {
      const custom = join(root, "custom");
      expect(ensureDefaultWorkspaceDir("C:\\agent", custom)).toBe(custom);
      expect(existsSync(custom)).toBe(true);
      // 幂等：重复调用不抛错、不覆盖已有内容。
      expect(() => ensureDefaultWorkspaceDir("C:\\agent", custom)).not.toThrow();
      const builtin = ensureDefaultWorkspaceDir(root);
      expect(builtin).toBe(join(root, "workspace-default"));
      expect(existsSync(builtin)).toBe(true);
      expect(() => ensureDefaultWorkspaceDir(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the initial workspace by the fallback chain: map hit → legacy → default", () => {
    const map = { default: "D:\\Projects\\a", heiyuhe: "D:\\Projects\\b" };
    expect(resolveInitialWorkspace(map, "default", "D:\\Projects\\legacy", "D:\\Projects\\default")).toBe("D:\\Projects\\a");
    expect(resolveInitialWorkspace(undefined, "coder", "D:\\Projects\\legacy", "D:\\Projects\\default")).toBe("D:\\Projects\\legacy");
    expect(resolveInitialWorkspace(undefined, "coder", undefined, "D:\\Projects\\default")).toBe("D:\\Projects\\default");
    // 默认目录创建失败（undefined）→ landing 极端兜底。
    expect(resolveInitialWorkspace(undefined, "coder", undefined, undefined)).toBeUndefined();
  });

  it("records a per-agent workspace: overwrite same agent, keep others, resolve to absolute", () => {
    const map = { default: "D:\\Projects\\a", heiyuhe: "D:\\Projects\\b" };
    const next = recordAgentWorkspace(map, "default", "D:\\Projects\\c");
    expect(next).toEqual({ default: "D:\\Projects\\c", heiyuhe: "D:\\Projects\\b" });
    // 原 map 不被就地修改（纯函数）。
    expect(map.default).toBe("D:\\Projects\\a");
    // 相对路径 resolve 规范化。
    expect(recordAgentWorkspace(undefined, "coder", "./x").coder).toBe(join(process.cwd(), "x"));
  });

  it("forgets a per-agent workspace: case-insensitive match only, others untouched", () => {
    const map = { default: "D:\\Projects\\a", heiyuhe: "D:\\Projects\\b" };
    // 大小写不敏感（Windows 风格路径）匹配才删。
    expect(forgetAgentWorkspace(map, "default", "d:\\projects\\A")).toEqual({ heiyuhe: "D:\\Projects\\b" });
    // 不匹配（其他路径/其他助手）不动。
    const unchanged = forgetAgentWorkspace(map, "heiyuhe", "D:\\Projects\\nope");
    expect(unchanged).toEqual(map);
    expect(forgetAgentWorkspace(map, "coder", "D:\\Projects\\a")).toEqual(map);
    // 空 map / 键缺失安全；删空回 undefined。
    expect(forgetAgentWorkspace(undefined, "default", "D:\\Projects\\a")).toBeUndefined();
    expect(forgetAgentWorkspace({ default: "D:\\Projects\\a" }, "default", "D:\\Projects\\a")).toBeUndefined();
    // 剩其他助手键时保留。
    expect(forgetAgentWorkspace({ default: "D:\\Projects\\a", heiyuhe: "D:\\Projects\\b" }, "default", "D:\\Projects\\a")).toEqual({ heiyuhe: "D:\\Projects\\b" });
  });
});

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

  it("keeps manually added models through an upstream refresh", () => {
    const merged = mergeProviderModels(
      [
        { id: "kept", name: "手动模型", manual: true, enabled: true },
        { id: "gone", name: "旧拉取结果", enabled: true },
        { id: "shared", name: "Shared", manual: true, contextWindow: 200000, enabled: false }
      ],
      [{ id: "shared", name: "Shared upstream" }, { id: "fresh", name: "Fresh" }]
    );
    expect(merged).toHaveLength(3);
    // 上游命中的手动条目：名称跟上游，标记与本地限额修正保留。
    expect(merged[0]).toMatchObject({ id: "shared", name: "Shared upstream", manual: true, contextWindow: 200000 });
    // 上游没有的手动条目整条保留（拉取是合并手动条目，不是整体替换）。
    expect(merged[2]).toMatchObject({ id: "kept", name: "手动模型", manual: true });
    // 非手动的本地多余条目（上游已下架）仍被丢弃。
    expect(merged.some((model) => model.id === "gone")).toBe(false);
  });

  it("normalizes the manual marker so only true survives", () => {
    const normalized = normalizeProvider({
      id: "p", name: "P", baseUrl: "",
      models: [{ id: "a", name: "a", manual: true }, { id: "b", name: "b", manual: "yes" as never }]
    });
    expect(normalized.models[0]?.manual).toBe(true);
    expect(normalized.models[1]).not.toHaveProperty("manual");
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

  it("keeps api-mode overrides through normalization and upstream refresh", () => {
    // 审查 P0-2：协议扩展字段必须随持久化链路存活，否则重启/拉取后覆盖静默回退。
    const normalized = normalizeProvider({
      id: "p",
      name: "P",
      baseUrl: "https://api.example.com/v1",
      api: "openai-responses",
      models: [{ id: "m1", name: "M1", api: "openai-completions" }]
    });
    expect(normalized.api).toBe("openai-responses");
    expect(normalized.models[0]?.api).toBe("openai-completions");
    // 非法值丢弃（白名单两档）。
    expect(normalizeProvider({ id: "p", name: "P", baseUrl: "", api: "anthropic-messages" as never, models: [{ id: "m", name: "M", api: "bogus" as never }] }).api).toBeUndefined();
    expect(normalizeProvider({ id: "p", name: "P", baseUrl: "", models: [{ id: "m", name: "M", api: "bogus" as never }] }).models[0]).not.toHaveProperty("api");
    // 拉取合并保留既有 api 覆盖。
    const merged = mergeProviderModels(
      [{ id: "m1", name: "M1", api: "openai-responses", enabled: true }],
      [{ id: "m1", name: "M1 upstream" }]
    );
    expect(merged[0]).toMatchObject({ api: "openai-responses" });
    // 迁移（重启读盘路径）同样保留。
    const migrated = migrateSettings({ providers: [{ id: "p", name: "P", baseUrl: "https://api.example.com/v1", api: "openai-responses", models: [{ id: "m1", name: "M1", api: "openai-completions" }] }] });
    expect(migrated.settings.providers[0]?.api).toBe("openai-responses");
    expect(migrated.settings.providers[0]?.models[0]?.api).toBe("openai-completions");
  });

  it("migrates the live theme controls and custom CSS", () => {
    const result = migrateSettings({ appearance: { theme: "dark", themePreset: "rose", customCss: ".message { outline: 1px solid red; }", showThinking: false } });
    expect(result.settings.appearance).toEqual({
      theme: "dark",
      themePreset: "rose",
      customCss: ".message { outline: 1px solid red; }",
      customThemes: [],
      motion: true,
      showThinking: false
    });
  });

  it("falls back to safe appearance defaults for unknown theme values", () => {
    const result = migrateSettings({ appearance: { theme: "neon", themePreset: "unknown", customCss: 42 } });
    expect(result.settings.appearance).toEqual({ theme: "system", themePreset: "default", customCss: "", customThemes: [], motion: true, showThinking: true });
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

  it("keeps the computer master switch across a settings round-trip", () => {
    expect(normalizeComputer({ enabled: false })).toEqual({ enabled: false });
    expect(normalizeComputer({})).toEqual({ enabled: true });
    expect(normalizeComputer("invalid")).toBeUndefined();
    // 回归网：migrateSettings 曾漏掉 computer 字段，写进 settings.json 的
    // {enabled:false} 重启即被丢弃，运行时总闸恒为 true（总闸形同虚设）。
    expect(migrateSettings({ computer: { enabled: false } }).settings.computer).toEqual({ enabled: false });
    expect(migrateSettings({ computer: { enabled: true } }).settings.computer).toEqual({ enabled: true });
    expect(migrateSettings({}).settings.computer).toBeUndefined();
  });
});
