import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { customProviderModelDefinition, inferCustomModelImageInput, resolveCustomProviderRegistration } from "./custom-provider.js";

describe("custom OpenAI-compatible models", () => {
  it("keeps thinking levels available when the upstream catalog omits capabilities", () => {
    const model = customProviderModelDefinition({ id: "reasoning-model", name: "Reasoning Model" });

    expect(model.reasoning).toBe(true);
    expect(model.id).toBe("reasoning-model");
    expect(model.input).toEqual(["text"]);
    expect(model.compat).toMatchObject({ supportsDeveloperRole: false, supportsStore: false });
    const registeredModel = {
      ...model,
      api: "openai-completions" as const,
      provider: "chatanytime-openai-compatible",
      baseUrl: "https://api.example.com/v1"
    } as Parameters<typeof getSupportedThinkingLevels>[0];
    expect(getSupportedThinkingLevels(registeredModel)).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("uses conservative image capability inference", () => {
    expect(inferCustomModelImageInput("gpt-4o-mini")).toBe(true);
    expect(inferCustomModelImageInput("qwen2.5-vl-instruct")).toBe(true);
    expect(inferCustomModelImageInput("text-embedding-3-large")).toBe(false);
    expect(inferCustomModelImageInput("custom-reasoning-model")).toBe(false);
  });

  it("keeps custom relay system prompts on the standard system role", () => {
    const definition = customProviderModelDefinition({ id: "sense-model", name: "Sense Model" });
    const model = {
      ...definition,
      api: "openai-completions" as const,
      provider: "chatanytime-openai-compatible",
      baseUrl: "https://api.sensetime.com/v1"
    };
    const messages = convertMessages(model, { systemPrompt: "你是开发助手", messages: [], tools: [] }, {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsFinishReason: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false,
      thinkingFormat: "openai",
      openRouterRouting: {},
      vercelGatewayRouting: {},
      chatTemplateKwargs: {},
      chatTemplateArgs: {},
      zaiToolStream: false,
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
      cacheControlFormat: undefined,
      sendSessionAffinityHeaders: false,
      deferredToolsMode: undefined,
      sessionAffinityFormat: "openai",
      supportsLongCacheRetention: false
    });
    expect(messages[0]).toMatchObject({ role: "system", content: "你是开发助手" });
  });
});

describe("resolveCustomProviderRegistration", () => {
  it("skips built-in model-visibility entries instead of failing validation", () => {
    // Regression: initialize() feeds every settings.providers entry through
    // registerCustomProvider. A `custom: false` entry (empty baseUrl by
    // design) used to throw 「自定义服务商需要填写名称和接口地址」 and abort
    // startup — sessions never loaded and the error popped up as a dialog.
    const entry = { id: "openrouter", name: "OpenRouter", baseUrl: "", models: [{ id: "a", name: "A" }], custom: false as const };
    expect(resolveCustomProviderRegistration(entry)).toBeNull();
  });

  it("rejects custom entries missing name or baseUrl", () => {
    expect(() => resolveCustomProviderRegistration({ id: "provider-1", name: "", baseUrl: "https://api.example.com/v1", models: [] }))
      .toThrow("自定义服务商需要填写名称和接口地址");
    expect(() => resolveCustomProviderRegistration({ id: "provider-1", name: "中转", baseUrl: "  ", models: [] }))
      .toThrow("自定义服务商需要填写名称和接口地址");
  });

  it("rejects a baseUrl that is not a valid URL", () => {
    expect(() => resolveCustomProviderRegistration({ id: "provider-1", name: "中转", baseUrl: "not-a-url", models: [] }))
      .toThrow("接口地址必须是有效的 URL");
  });

  it("trims name/baseUrl and keeps only enabled models with real ids", () => {
    const payload = resolveCustomProviderRegistration({
      id: "provider-1",
      name: "  中转  ",
      baseUrl: "https://api.example.com/v1///",
      models: [
        { id: " m1 ", name: "", imageInput: true },
        { id: "m2", name: "M2", enabled: false },
        { id: "  ", name: "blank id" }
      ]
    });
    expect(payload?.name).toBe("中转");
    expect(payload?.baseUrl).toBe("https://api.example.com/v1");
    expect(payload?.models.map((model) => model.id)).toEqual(["m1"]);
    expect(payload?.models[0]?.name).toBe("m1");
    expect(payload?.models[0]?.input).toEqual(["text", "image"]);
  });
});
