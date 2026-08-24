import { describe, expect, it } from "vitest";
import { buildCatalogModels, isDesktopConfiguredProvider } from "./model-catalog.js";
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
});
