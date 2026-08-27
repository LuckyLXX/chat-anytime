import { describe, expect, it } from "vitest";
import { buildBuiltinProviderEntry, filterProviderModels, formatTokenLimit, parseTokenLimit, setProviderModelsEnabled, selectableCatalogModels } from "./model-list";
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
