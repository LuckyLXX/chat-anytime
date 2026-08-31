import { describe, expect, it } from "vitest";
import { buildBuiltinProviderEntry, filterProviderModels, formatTokenLimit, groupModelsByProvider, parseTokenLimit, providerFormBlocker, pruneDisabledModelRefs, setProviderModelsEnabled, selectableCatalogModels } from "./model-list";
import type { ModelOption } from "../../../shared/protocol";

const models = [
  { id: "openai/gpt-4o", name: "GPT-4o", enabled: true },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", enabled: false },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
  { id: "google/gemini-2.0-flash", name: "Gemini 2.0 Flash", enabled: true }
];

describe("provider model list", () => {
  it("returns the original list for blank queries", () => {
    expect(filterProviderModels(models, "")).toBe(models);
    expect(filterProviderModels(models, "   ")).toBe(models);
  });

  it("matches names and ids case-insensitively", () => {
    expect(filterProviderModels(models, "gpt-4o").map((model) => model.id)).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
    expect(filterProviderModels(models, "GPT").map((model) => model.id)).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
    expect(filterProviderModels(models, "claude").map((model) => model.id)).toEqual(["anthropic/claude-3.5-sonnet"]);
  });

  it("keeps models whose id matches even when the name does not", () => {
    expect(filterProviderModels(models, "anthropic/").map((model) => model.id)).toEqual(["anthropic/claude-3.5-sonnet"]);
  });

  it("enables or disables only the targeted models", () => {
    const targets = filterProviderModels(models, "gpt-4o");
    const disabled = setProviderModelsEnabled(models, targets, false);
    expect(disabled.map((model) => model.enabled)).toEqual([false, false, undefined, true]);
    // 未命中的条目保持原引用，命中的才生成新对象。
    expect(disabled[2]).toBe(models[2]);
    expect(disabled[0]).not.toBe(models[0]);

    const reEnabled = setProviderModelsEnabled(disabled, [disabled[0]!], true);
    expect(reEnabled.map((model) => model.enabled)).toEqual([true, false, undefined, true]);
  });

  it("deselects everything when handed the whole list", () => {
    const cleared = setProviderModelsEnabled(models, models, false);
    expect(cleared.every((model) => model.enabled === false)).toBe(true);
    expect(cleared).toHaveLength(models.length);
  });

  it("is a no-op for an empty target set", () => {
    expect(setProviderModelsEnabled(models, [], true)).toBe(models);
  });
});

describe("selectable catalog view", () => {
  const option = (overrides: Partial<ModelOption>): ModelOption => ({ provider: "p", id: "m", name: "M", configured: true, input: ["text"], imageInput: false, ...overrides });

  it("drops disabled models and keeps enabled or default ones", () => {
    const catalog = [option({ enabled: true }), option({ id: "off", enabled: false }), option({ id: "default" })];
    expect(selectableCatalogModels(catalog).map((model) => model.id)).toEqual(["m", "default"]);
  });

  it("returns an empty view when every model is disabled", () => {
    const catalog = [option({ enabled: false }), option({ id: "off2", enabled: false })];
    expect(selectableCatalogModels(catalog)).toEqual([]);
  });
});

describe("provider-grouped model view", () => {
  const option = (overrides: Partial<ModelOption>): ModelOption => ({ provider: "p", id: "m", name: "M", configured: true, input: ["text"], imageInput: false, ...overrides });

  it("groups models by provider keeping first-seen order", () => {
    const models = [
      option({ provider: "openrouter", id: "openai/gpt-4o", name: "GPT-4o" }),
      option({ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" }),
      option({ provider: "openrouter", id: "openai/gpt-4o-mini", name: "GPT-4o mini" })
    ];
    const groups = groupModelsByProvider(models);
    expect(groups.map((group) => group.provider)).toEqual(["openrouter", "anthropic"]);
    expect(groups[0]!.models.map((model) => model.id)).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
  });

  it("uses the provider name resolver and falls back to the id", () => {
    const models = [option({ provider: "openrouter", id: "a", name: "A" }), option({ provider: "unknown", id: "b", name: "B" })];
    const groups = groupModelsByProvider(models, (providerId) => providerId === "openrouter" ? "OpenRouter" : undefined);
    expect(groups[0]!.providerName).toBe("OpenRouter");
    expect(groups[1]!.providerName).toBe("unknown");
  });
});

describe("renderer pruneDisabledModelRefs", () => {
  it("clears global default, agent defaults and vision pointing at disabled models", () => {
    const models = [{ id: "keep", enabled: true }, { id: "gone", enabled: false }];
    const settings = {
      model: { provider: "p", id: "gone" },
      agents: [
        { id: "a", defaultModel: { provider: "p", id: "gone" } },
        { id: "b", defaultModel: { provider: "p", id: "keep" } },
        { id: "c" }
      ],
      vision: { provider: "p", model: "gone", enabled: true }
    };
    const pruned = pruneDisabledModelRefs(settings, "p", models);
    expect(pruned.model).toBeUndefined();
    expect(pruned.agents[0]!.defaultModel).toBeUndefined();
    expect(pruned.agents[1]!.defaultModel).toBe(settings.agents[1]!.defaultModel);
    expect(pruned.agents[2]).toBe(settings.agents[2]);
    expect(pruned.vision).toMatchObject({ provider: "p", model: "gone", enabled: false });
  });

  it("keeps references untouched when everything is still enabled", () => {
    const models = [{ id: "keep", enabled: true }];
    const settings = {
      model: { provider: "p", id: "keep" },
      agents: [{ id: "a", defaultModel: { provider: "p", id: "keep" } }],
      vision: { provider: "p", model: "keep", enabled: true }
    };
    const pruned = pruneDisabledModelRefs(settings, "p", models);
    expect(pruned.model).toBe(settings.model);
    expect(pruned.agents).toBe(settings.agents);
    expect(pruned.vision).toBe(settings.vision);
  });
});

describe("builtin provider entry rebuild", () => {
  const models = [
    { id: "glm-4-plus", name: "GLM-4-Plus", enabled: true },
    { id: "glm-4-flash", name: "GLM-4-Flash", enabled: false }
  ];

  it("keeps keyConfigured when rebuilding an existing entry", () => {
    const entry = buildBuiltinProviderEntry("zhipu", { id: "zhipu", name: "智谱", baseUrl: "", models: [], keyConfigured: true }, "智谱开放平台", false, models);
    expect(entry).toEqual({ id: "zhipu", name: "智谱", baseUrl: "", models, custom: false, keyConfigured: true });
  });

  it("stamps keyConfigured from the provider catalog when no entry exists yet", () => {
    const entry = buildBuiltinProviderEntry("zhipu", undefined, "智谱开放平台", true, models);
    expect(entry.keyConfigured).toBe(true);
    expect(entry.name).toBe("智谱开放平台");
  });

  it("leaves keyConfigured unset when neither source says the key is saved", () => {
    expect(buildBuiltinProviderEntry("zhipu", undefined, "智谱开放平台", false, models).keyConfigured).toBeUndefined();
    expect(buildBuiltinProviderEntry("zhipu", { id: "zhipu", name: "智谱", baseUrl: "", models: [], keyConfigured: false }, "智谱开放平台", false, models).keyConfigured).toBeUndefined();
  });
});

describe("provider form save check", () => {
  const valid = { hasApiKey: true, isCustomProvider: false, customName: "x", customBaseUrl: "https://api.example.com/v1", customModelId: "m1", totalModels: 3 };

  it("blocks when no API key is present (saved or typed)", () => {
    expect(providerFormBlocker({ ...valid, hasApiKey: false })).toContain("API 密钥");
  });

  it("never blocks on zero enabled models — clearing a whole provider is legal", () => {
    // 内置服务：即使把全部模型取消勾选，只要密钥在位就可保存。
    expect(providerFormBlocker({ ...valid, totalModels: 2 })).toBeUndefined();
    // 自定义服务：拉到列表后同样由勾选决定，模型 ID 不再必需。
    expect(providerFormBlocker({ ...valid, isCustomProvider: true, customModelId: "" })).toBeUndefined();
  });

  it("requires name and baseUrl for custom providers", () => {
    expect(providerFormBlocker({ ...valid, isCustomProvider: true, customName: "  " })).toContain("服务名称");
    expect(providerFormBlocker({ ...valid, isCustomProvider: true, customBaseUrl: "" })).toContain("接口地址");
  });

  it("requires a model id only when no model list was fetched yet", () => {
    expect(providerFormBlocker({ ...valid, isCustomProvider: true, totalModels: 0, customModelId: "" })).toContain("模型 ID");
    expect(providerFormBlocker({ ...valid, isCustomProvider: true, totalModels: 0, customModelId: "m1" })).toBeUndefined();
  });
});

describe("token limit editor helpers", () => {
  it("parses raw numbers and k/m shorthands, rejecting garbage", () => {
    expect(parseTokenLimit("128000")).toBe(128000);
    expect(parseTokenLimit(" 65536 ")).toBe(65536);
    expect(parseTokenLimit("128k")).toBe(128000);
    expect(parseTokenLimit("1.5m")).toBe(1_500_000);
    expect(parseTokenLimit("1K")).toBe(1000);
    expect(parseTokenLimit("abc")).toBeUndefined();
    expect(parseTokenLimit("-5")).toBeUndefined();
    expect(parseTokenLimit("12x")).toBeUndefined();
    expect(parseTokenLimit("")).toBeUndefined();
    expect(parseTokenLimit("   ")).toBeUndefined();
  });

  it("formats stored overrides for echo-back and clears to empty", () => {
    expect(formatTokenLimit(200000)).toBe("200000");
    expect(formatTokenLimit(undefined)).toBe("");
    expect(formatTokenLimit(-3)).toBe("");
    expect(formatTokenLimit(Number.NaN)).toBe("");
  });
});
