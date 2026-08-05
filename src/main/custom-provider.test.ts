import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { customProviderModelDefinition, inferCustomModelImageInput } from "./custom-provider.js";

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
      maxTokensField: "max_tokens",
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false,
      thinkingFormat: "openai",
      openRouterRouting: {},
      vercelGatewayRouting: {},
      chatTemplateKwargs: {},
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
