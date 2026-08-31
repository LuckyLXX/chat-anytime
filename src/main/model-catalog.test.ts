import { describe, expect, it } from "vitest";
import { applyModelOverrides, buildCatalogModels, imageInputOverride, isDesktopConfiguredProvider, isModelEnabled, pickFallbackModel, pruneDisabledModelRefs, resolveRestoredSessionModel } from "./model-catalog.js";
import type { ProviderSettings } from "../shared/protocol.js";

describe("desktop model catalog visibility", () => {
  it("hides providers configured only by inherited environment variables", () => {
    expect(isDesktopConfiguredProvider({ configured: true, source: "environment" })).toBe(false);
  });

  it("keeps explicit runtime, stored, and provider configuration visible", () => {
    expect(isDesktopConfiguredProvider({ configured: true, source: "runtime" })).toBe(true);
    expect(isDesktopConfiguredProvider({ configured: true, source: "stored" })).toBe(true);
    expect(isDesktopConfiguredProvider({ configured: true, source: "models_json_key" })).toBe(true);
  });

  it("hides providers without usable authentication", () => {
    expect(isDesktopConfiguredProvider(undefined)).toBe(false);
    expect(isDesktopConfiguredProvider({ configured: false })).toBe(false);
  });
});

const catalog = [
  { provider: "openrouter", id: "openai/gpt-4o", name: "GPT-4o", input: ["text", "image"] as ("text" | "image")[] },
  { provider: "openrouter", id: "openai/gpt-4o-mini", name: "GPT-4o mini", input: ["text"] as ("text" | "image")[] },
  { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", input: ["text"] as ("text" | "image")[] }
];

describe("buildCatalogModels", () => {
  it("keeps disabled models in the catalog and annotates them instead of filtering", () => {
    const providers: ProviderSettings[] = [{
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "",
      custom: false,
      models: [
        { id: "openai/gpt-4o", name: "GPT-4o", enabled: true },
        { id: "openai/gpt-4o-mini", name: "GPT-4o mini", enabled: false }
      ]
    }];
    const options = buildCatalogModels(catalog, providers, new Set(["openrouter"]));

    // 回归：旧实现直接 filter 掉禁用模型，设置页重进后只剩启用的模型，
    // 搜索框（length > 8 才出现）消失、其余模型不可见。
    expect(options).toHaveLength(3);
    expect(options.map((model) => model.enabled)).toEqual([true, false, undefined]);
    expect(options[2]!.enabled).toBeUndefined();
  });

  it("treats providers and models missing from settings as enabled", () => {
    const options = buildCatalogModels(catalog, undefined, new Set());
    expect(options.every((model) => model.enabled === undefined)).toBe(true);
  });

  it("derives configured/imageInput from inputs and passes through catalog fields", () => {
    const options = buildCatalogModels(catalog, [], new Set(["anthropic"]));
    expect(options[0]).toMatchObject({ provider: "openrouter", id: "openai/gpt-4o", name: "GPT-4o", configured: false, imageInput: true });
    expect(options[1]).toMatchObject({ imageInput: false });
    expect(options[2]).toMatchObject({ configured: true });
  });

  it("lets stored settings override the catalog's image input flag in both directions", () => {
    // 回归：内置服务商手动拉取的新模型只有 id/name、输入类型克隆模板，用户
    // 需要在设置里手动标记「图片输入」；目录推送必须尊重这个覆盖值，否则
    // 顶栏/附件逻辑仍按旧元数据判定。覆盖是双向的（false 也能封住误报的多模态）。
    const providers: ProviderSettings[] = [{
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "",
      custom: false,
      models: [
        { id: "openai/gpt-4o", name: "GPT-4o", imageInput: false },
        { id: "openai/gpt-4o-mini", name: "GPT-4o mini", imageInput: true }
      ]
    }];
    const options = buildCatalogModels(catalog, providers, new Set());
    expect(options[0]).toMatchObject({ id: "openai/gpt-4o", imageInput: false });
    expect(options[1]).toMatchObject({ id: "openai/gpt-4o-mini", imageInput: true });
    // 未标注的模型回退到目录元数据。
    expect(options[2]).toMatchObject({ id: "claude-sonnet-4", imageInput: false });
  });
});

describe("imageInputOverride", () => {
  it("looks up the per-model mark from settings providers", () => {
    const providers: ProviderSettings[] = [{
      id: "zai-coding-cn",
      name: "z.ai coding cn",
      baseUrl: "",
      custom: false,
      models: [{ id: "glm-4.6", name: "GLM-4.6", imageInput: true }]
    }];
    expect(imageInputOverride({ provider: "zai-coding-cn", id: "glm-4.6" }, providers)).toBe(true);
    expect(imageInputOverride({ provider: "zai-coding-cn", id: "glm-4.6" }, undefined)).toBeUndefined();
    expect(imageInputOverride({ provider: "other", id: "glm-4.6" }, providers)).toBeUndefined();
    expect(imageInputOverride({ provider: "zai-coding-cn", id: "missing" }, providers)).toBeUndefined();
    expect(imageInputOverride({}, providers)).toBeUndefined();
  });

  it("pushes effective token limits (user override first, catalog value otherwise)", () => {
    // 目录原值直接下发；用户手动修正后以修正值为准（设置页编辑框回显的口径）。
    const withLimits = [
      ...catalog,
      { provider: "openrouter", id: "x/limited", name: "Limited", input: ["text"] as ("text" | "image")[], contextWindow: 65536, maxTokens: 8192 }
    ];
    const providers: ProviderSettings[] = [{
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "",
      custom: false,
      models: [{ id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 400000 }]
    }];
    const options = buildCatalogModels(withLimits, providers, new Set());
    expect(options[0]).toMatchObject({ id: "openai/gpt-4o", contextWindow: 400000 });
    expect(options[0]!.maxTokens).toBeUndefined();
    expect(options.find((model) => model.id === "x/limited")).toMatchObject({ contextWindow: 65536, maxTokens: 8192 });
    // 无限额信息的条目不携带这两个字段。
    const bare = options.find((model) => model.id === "claude-sonnet-4");
    expect(bare).not.toHaveProperty("contextWindow");
  });
});

describe("isModelEnabled", () => {
  const providers: ProviderSettings[] = [{
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "",
    custom: false,
    models: [
      { id: "openai/gpt-4o", name: "GPT-4o", enabled: true },
      { id: "openai/gpt-4o-mini", name: "GPT-4o mini", enabled: false }
    ]
  }];

  it("treats explicit enabled:false as disabled and everything else as enabled", () => {
    expect(isModelEnabled("openrouter", "openai/gpt-4o", providers)).toBe(true);
    expect(isModelEnabled("openrouter", "openai/gpt-4o-mini", providers)).toBe(false);
  });

  it("defaults providers and models missing from settings to enabled", () => {
    expect(isModelEnabled("openrouter", "openai/gpt-4o", undefined)).toBe(true);
    expect(isModelEnabled("anthropic", "claude-sonnet-4", providers)).toBe(true);
    expect(isModelEnabled("openrouter", "not-listed", providers)).toBe(true);
  });
});

describe("pickFallbackModel", () => {
  const providers: ProviderSettings[] = [{
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "",
    custom: false,
    models: [{ id: "openai/gpt-4o-mini", name: "GPT-4o mini", enabled: false }]
  }];
  const candidates = [
    { provider: "openrouter", id: "openai/gpt-4o", name: "GPT-4o" },
    { provider: "openrouter", id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
    { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" }
  ];

  it("picks the first enabled model of a configured provider", () => {
    expect(pickFallbackModel(candidates, providers, (providerId) => providerId === "openrouter")?.id).toBe("openai/gpt-4o");
  });

  it("skips disabled models even when their provider is configured (2026-09 regression)", () => {
    // 用户取消了某模型勾选，回退绝不能又把它选回去。
    expect(pickFallbackModel(candidates, providers, () => true)?.id).toBe("openai/gpt-4o");
    expect(pickFallbackModel(candidates, providers, () => true, "openrouter")?.id).toBe("claude-sonnet-4");
  });

  it("requires the provider to be configured", () => {
    expect(pickFallbackModel(candidates, providers, () => false)).toBeUndefined();
  });
});

describe("pruneDisabledModelRefs", () => {
  const providers: ProviderSettings[] = [{
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "",
    custom: false,
    models: [
      { id: "openai/gpt-4o", name: "GPT-4o", enabled: true },
      { id: "openai/gpt-4o-mini", name: "GPT-4o mini", enabled: false }
    ]
  }];
  const base = {
    model: { provider: "openrouter", id: "openai/gpt-4o-mini" },
    agents: [
      { id: "a", defaultModel: { provider: "openrouter", id: "openai/gpt-4o-mini" } },
      { id: "b", defaultModel: { provider: "anthropic", id: "claude-sonnet-4" } },
      { id: "c" }
    ],
    vision: undefined as { provider: string; model: string; enabled?: boolean } | undefined
  };

  it("clears every reference to a disabled model of the provider", () => {
    const pruned = pruneDisabledModelRefs(base, "openrouter", providers[0]!.models);
    expect(pruned.model).toBeUndefined();
    expect(pruned.agents[0]!.defaultModel).toBeUndefined();
    // 其他服务商的引用与无默认模型的助手原样保留（引用相等）。
    expect(pruned.agents[1]!.defaultModel).toBe(base.agents[1]!.defaultModel);
    expect(pruned.agents[2]).toBe(base.agents[2]);
  });

  it("disables vision when it points at a removed model, keeps it otherwise", () => {
    const withVision = { ...base, vision: { provider: "openrouter", model: "openai/gpt-4o-mini", enabled: true } };
    expect(pruneDisabledModelRefs(withVision, "openrouter", providers[0]!.models).vision).toMatchObject({ provider: "openrouter", model: "openai/gpt-4o-mini", enabled: false });
    const untouched = { ...base, vision: { provider: "anthropic", model: "claude-sonnet-4", enabled: true } };
    expect(pruneDisabledModelRefs(untouched, "openrouter", providers[0]!.models).vision).toBe(untouched.vision);
  });

  it("is a no-op when every referenced model stays enabled", () => {
    const keep = {
      ...base,
      model: { provider: "openrouter", id: "openai/gpt-4o" },
      agents: [{ id: "a", defaultModel: { provider: "openrouter", id: "openai/gpt-4o" } }, { id: "c" }]
    };
    const pruned = pruneDisabledModelRefs(keep, "openrouter", providers[0]!.models);
    expect(pruned.model).toBe(keep.model);
    expect(pruned.agents).toBe(keep.agents);
  });
});

describe("applyModelOverrides", () => {
  const target = (input: ("text" | "image")[]) => ({ provider: "zai-coding-cn", id: "glm-5.3-flash", input });

  it("marks image input onto Model.input when the user forces it on", () => {
    // 回归：Pi 的各 API 适配器每次请求按 model.input 把图片降级成
    // "(image omitted: model does not support images)" 占位文本——应用侧的
    // hasImageInput 放行了，图片在 Pi 内部还是会被丢掉，勾选等于没生效。
    const result = applyModelOverrides(target(["text"]), [{ id: "zai-coding-cn", name: "z.ai", baseUrl: "", custom: false, models: [{ id: "glm-5.3-flash", name: "GLM", imageInput: true }] }]);
    expect(result.input).toEqual(["text", "image"]);
  });

  it("removes image input when the user explicitly unchecks it", () => {
    const result = applyModelOverrides(target(["text", "image"]), [{ id: "zai-coding-cn", name: "z.ai", baseUrl: "", custom: false, models: [{ id: "glm-5.3-flash", name: "GLM", imageInput: false }] }]);
    expect(result.input).toEqual(["text"]);
  });

  it("returns the same object when the mark matches the catalog or is absent", () => {
    const text = target(["text"]);
    expect(applyModelOverrides(text, [{ id: "zai-coding-cn", name: "z.ai", baseUrl: "", custom: false, models: [{ id: "glm-5.3-flash", name: "GLM", imageInput: false }] }])).toBe(text);
    expect(applyModelOverrides(text, [{ id: "zai-coding-cn", name: "z.ai", baseUrl: "", custom: false, models: [{ id: "glm-5.3-flash", name: "GLM" }] }])).toBe(text);
    expect(applyModelOverrides(text, [])).toBe(text);
  });

  it("clones once and combines token limits with the input patch", () => {
    const result = applyModelOverrides({ ...target(["text"]), contextWindow: 128000, maxTokens: 16384 }, [{ id: "zai-coding-cn", name: "z.ai", baseUrl: "", custom: false, models: [{ id: "glm-5.3-flash", name: "GLM", imageInput: true, contextWindow: 200000 }] }]);
    expect(result).toEqual({ provider: "zai-coding-cn", id: "glm-5.3-flash", input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 });
  });
});

describe("resolveRestoredSessionModel", () => {
  // 回归（2026-08-30）：恢复会话原先交给 Pi 的缺省恢复分支，它从注册表裸取
  // 模型绕过 applyModelOverrides——「拉取模型」注入的新模型只带模板克隆的限额
  // （glm-5.3-flash 落了模板 glm-4.5 的 204800），重启后 settings 修正丢失，
  // 上下文占用显示与自动压缩阈值同时失准。
  const registryModel = { provider: "zai-coding-cn", id: "glm-5.3-flash", name: "GLM", input: ["text"] as ("text" | "image")[], contextWindow: 204800, maxTokens: 131072 };
  const providers: ProviderSettings[] = [{
    id: "zai-coding-cn",
    name: "z.ai",
    baseUrl: "",
    custom: false,
    models: [{ id: "glm-5.3-flash", name: "GLM", imageInput: true, contextWindow: 1000000, maxTokens: 128000 }]
  }];

  it("applies the settings overrides onto the restored registry model", () => {
    const result = resolveRestoredSessionModel(registryModel, true, providers);
    expect(result).toEqual({ provider: "zai-coding-cn", id: "glm-5.3-flash", name: "GLM", input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000 });
    expect(result).not.toBe(registryModel);
    expect(registryModel.contextWindow).toBe(204800);
  });

  it("returns the registry model untouched when no override is stored", () => {
    const plain = { provider: "zai-coding-cn", id: "glm-5.3-flash", input: ["text"] as ("text" | "image")[] };
    expect(resolveRestoredSessionModel(plain, true, undefined)).toBe(plain);
  });

  it("keeps Pi's fallback by returning undefined when the model is missing or unauthenticated", () => {
    expect(resolveRestoredSessionModel(undefined, true, providers)).toBeUndefined();
    expect(resolveRestoredSessionModel(registryModel, false, providers)).toBeUndefined();
  });
});
