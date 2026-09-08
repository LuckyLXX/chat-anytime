import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { builtinProviderOverlay, customProviderModelDefinition, inferCustomModelImageInput, resolveBuiltinOverlayAction, resolveCustomProviderRegistration } from "./custom-provider.js";

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

  it("carries a model-level api override into the registration definition", () => {
    // 模型级覆盖：同一服务商内部分模型走 /v1/responses，其余走 chat/completions。
    const definition = customProviderModelDefinition({ id: "gpt-5.6", name: "GPT-5.6", api: "openai-responses" });
    expect(definition).toMatchObject({ id: "gpt-5.6", api: "openai-responses" });
    expect(customProviderModelDefinition({ id: "m1", name: "M1" }).api).toBeUndefined();
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

  it("applies user-corrected token limits and keeps placeholders otherwise", () => {
    // 拉取的模型上游不给限额，注册定义只能占位；用户修正过的值优先。
    const payload = resolveCustomProviderRegistration({
      id: "provider-1",
      name: "中转",
      baseUrl: "https://api.example.com/v1",
      models: [
        { id: "m1", name: "M1" },
        { id: "m2", name: "M2", contextWindow: 200000, maxTokens: 32000 }
      ]
    });
    expect(payload?.models[0]).toMatchObject({ contextWindow: 128000, maxTokens: 16384 });
    expect(payload?.models[1]).toMatchObject({ contextWindow: 200000, maxTokens: 32000 });
    // 非法数值不进入注册定义（回退到占位值）。
    const guarded = resolveCustomProviderRegistration({
      id: "provider-1",
      name: "中转",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "m3", name: "M3", contextWindow: 0, maxTokens: -100 }]
    });
    expect(guarded?.models[0]).toMatchObject({ contextWindow: 128000, maxTokens: 16384 });
  });

  it("carries the provider-level api override when present", () => {
    // 服务商级默认 API：整个中转站走 /v1/responses（模型级未单独设置时兜底）。
    const payload = resolveCustomProviderRegistration({
      id: "provider-1",
      name: "中转",
      baseUrl: "https://api.example.com/v1",
      api: "openai-responses",
      models: [{ id: "m1", name: "M1" }]
    });
    expect(payload?.api).toBe("openai-responses");
    // 缺省不出现 api 键，注册方按 openai-completions 兜底（历史行为不变）。
    const plain = resolveCustomProviderRegistration({ id: "provider-1", name: "中转", baseUrl: "https://api.example.com/v1", models: [{ id: "m1", name: "M1" }] });
    expect(plain?.api).toBeUndefined();
  });

  it("carries a model-level api override through the whole registration path", () => {
    // 全链路断言（审查 P0-1）：中间映射不丢 api，注册定义里的模型级覆盖可达。
    const payload = resolveCustomProviderRegistration({
      id: "provider-1",
      name: "中转",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [
        { id: "m1", name: "M1", api: "openai-responses" },
        { id: "m2", name: "M2" }
      ]
    });
    expect(payload?.models.map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(payload?.models[0]).toMatchObject({ id: "m1", api: "openai-responses" });
    expect(payload?.models[1]?.api).toBeUndefined();
  });
});

describe("builtinProviderOverlay", () => {
  const baseline = [
    { id: "a", name: "A", api: "openai-completions", baseUrl: "https://example.com/v1", input: ["text"] },
    { id: "b", name: "B", api: "openai-completions", baseUrl: "https://example.com/v1", input: ["text"] },
    { id: "c", name: "C", api: "openai-responses", baseUrl: "https://example.com/v1", input: ["text", "image"] }
  ];
  const entry = (patch: Partial<import("../shared/protocol.js").ProviderSettings>): import("../shared/protocol.js").ProviderSettings => ({
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "",
    models: [{ id: "a", name: "A" }],
    custom: false as const,
    ...patch
  });

  it("returns undefined when the entry has no overrides or is not built-in", () => {
    expect(builtinProviderOverlay(entry({}), baseline)).toBeUndefined();
    // 自定义服务商不走覆盖层通道。
    expect(builtinProviderOverlay({ ...entry({}), custom: undefined }, baseline)).toBeUndefined();
  });

  it("applies a provider-level baseUrl override to every model", () => {
    const overlay = builtinProviderOverlay(entry({ baseUrl: "https://new.example.com" }), baseline);
    expect(overlay?.every((model) => model.baseUrl === "https://new.example.com")).toBe(true);
    // baseUrl 全部变更：每个模型都是带覆盖的克隆，保留其余字段。
    expect(overlay![2]).not.toBe(baseline[2]);
    expect(overlay![2]).toMatchObject({ id: "c", api: "openai-responses", input: ["text", "image"] });
  });

  it("applies a provider-level api override to every model", () => {
    const overlay = builtinProviderOverlay(entry({ api: "openai-responses" }), baseline);
    expect(overlay?.map((model) => model.api)).toEqual(["openai-responses", "openai-responses", "openai-responses"]);
    // 与目录一致时不产生新对象。
    expect(overlay![2]).toBe(baseline[2]);
  });

  it("lets a model-level api override win over the provider level", () => {
    const overlay = builtinProviderOverlay(entry({ api: "openai-completions", models: [{ id: "c", name: "C", api: "openai-responses" }] }), baseline);
    expect(overlay?.map((model) => model.api)).toEqual(["openai-completions", "openai-completions", "openai-responses"]);
  });

  it("keeps untouched models on their original api", () => {
    const overlay = builtinProviderOverlay(entry({ models: [{ id: "a", name: "A", api: "openai-responses" }] }), baseline);
    expect(overlay).toBeDefined();
    expect(overlay![0]).toMatchObject({ api: "openai-responses" });
    // b（未覆盖）保持目录默认 openai-completions；c 本就是 responses。
    expect(overlay![1]).toBe(baseline[1]);
    expect(overlay![2]).toBe(baseline[2]);
  });

  it("injects manually added models by cloning the template with their overrides", () => {
    const overlay = builtinProviderOverlay(entry({ models: [{ id: "a", name: "A" }, { id: "manual-1", name: "手动模型", manual: true, imageInput: true, contextWindow: 200000, maxTokens: 8192 }] }), baseline);
    expect(overlay).toHaveLength(4);
    // 克隆目录首模型的完整元数据（流式/兼容字段），覆盖 id/name，套用图片输入与限额。
    expect(overlay![3]).toMatchObject({ id: "manual-1", name: "手动模型", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, baseUrl: "https://example.com/v1" });
    // 无覆盖的目录模型保持原对象引用（幂等）。
    expect(overlay![0]).toBe(baseline[0]);
  });

  it("writes an overlay for manual models even without other overrides", () => {
    const overlay = builtinProviderOverlay(entry({ models: [{ id: "m", name: "M", manual: true }] }), baseline);
    expect(overlay).toBeDefined();
    expect(overlay?.map((model) => model.id)).toEqual(["a", "b", "c", "m"]);
  });

  it("strips image input on a manual model when the template is multimodal", () => {
    const overlay = builtinProviderOverlay(entry({ models: [{ id: "m", name: "M", manual: true, imageInput: false }] }), baseline);
    expect(overlay![3]?.input).toEqual(["text"]);
  });

  it("does not write an overlay when the manual model already exists in the catalog", () => {
    // 目录已含同名 id：无需注入（用户手动添加已存在的模型 = 只想勾选它），也无其他覆盖 → 不写覆盖层。
    expect(builtinProviderOverlay(entry({ models: [{ id: "c", name: "C", manual: true }] }), baseline)).toBeUndefined();
  });

  it("falls back to a minimal entry when the provider catalog is empty", () => {
    const overlay = builtinProviderOverlay(entry({ models: [{ id: "m", name: "M", manual: true }] }), []);
    expect(overlay).toEqual([expect.objectContaining({ id: "m", name: "M", provider: "opencode-go" })]);
  });
});

describe("resolveBuiltinOverlayAction", () => {
  const baseline = [{ id: "a", name: "A", api: "openai-completions", baseUrl: "https://example.com/v1" }];
  const entry = (patch: Partial<import("../shared/protocol.js").ProviderSettings>): import("../shared/protocol.js").ProviderSettings => ({
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "",
    models: [{ id: "a", name: "A" }],
    custom: false as const,
    ...patch
  });

  it("returns a settings overlay when the entry has overrides", () => {
    const action = resolveBuiltinOverlayAction(entry({ baseUrl: "https://new.example.com" }), baseline, "pull");
    expect(action).not.toBeUndefined();
    expect(action).not.toBe("drop");
    if (action !== "drop" && action !== undefined) {
      expect(action.source).toBe("settings");
      expect(action.models[0]).toMatchObject({ baseUrl: "https://new.example.com" });
    }
  });

  it("treats manual models as an overlay trigger and drops it once they are gone", () => {
    // 只有手动模型、无 baseUrl/api 覆盖也要写覆盖层（否则目录里没有该模型，会话无法使用）。
    const withManual = resolveBuiltinOverlayAction(entry({ models: [{ id: "m", name: "M", manual: true }] }), baseline, undefined);
    expect(withManual).toEqual({ models: expect.any(Array), source: "settings" });
    // 手动模型移除后（无其他覆盖）：覆盖层还原目录。
    const withoutManual = resolveBuiltinOverlayAction(entry({ models: [{ id: "m", name: "M" }] }), baseline, "settings");
    expect(withoutManual).toBe("drop");
  });

  it("drops only a leftover settings overlay when overrides were cleared", () => {
    // 用户清空覆盖后：residue（_overlaySource=settings）应被删除还原目录。
    expect(resolveBuiltinOverlayAction(entry({}), baseline, "settings")).toBe("drop");
    // 拉取目录 / SDK 远程目录（无标记或 pull）不能误删——审查 P1-1 回归防线。
    expect(resolveBuiltinOverlayAction(entry({}), baseline, "pull")).toBeUndefined();
    expect(resolveBuiltinOverlayAction(entry({}), baseline, undefined)).toBeUndefined();
    // 条目已删（用户删除服务）等同清空覆盖。
    expect(resolveBuiltinOverlayAction(undefined, baseline, "settings")).toBe("drop");
    expect(resolveBuiltinOverlayAction(undefined, baseline, "pull")).toBeUndefined();
  });
});
