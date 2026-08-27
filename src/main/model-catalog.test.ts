import { describe, expect, it } from "vitest";
import { buildCatalogModels, imageInputOverride, isDesktopConfiguredProvider } from "./model-catalog.js";
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
