import type { CustomProviderModel, ProviderSettings } from "../shared/protocol.js";

export function inferCustomModelImageInput(modelId: string): boolean {
  const value = modelId.trim().toLowerCase();
  if (!value || /embedding|rerank|audio|tts|whisper/u.test(value)) return false;
  return /(^|[-_.])(vision|multimodal|vl)([-_.]|$)/u.test(value)
    || /(^|[-_.])gpt-4o(?:[-_.]|$)/u.test(value)
    || /(^|[-_.])gemini(?:[-_.]|$)/u.test(value)
    || /(^|[-_.])claude-(?:3|4)(?:[-_.]|$)/u.test(value)
    || /(^|[-_.])qwen[-_.](?:2|3)[-_.]?vl(?:[-_.]|$)/u.test(value);
}

/**
 * OpenAI-compatible model metadata used by Pi's runtime.
 *
 * The upstream /models response usually does not describe reasoning support.
 * Treating every fetched custom model as non-reasoning makes Pi clamp every
 * selected level to "off", so the desktop selector can never take effect.
 * Pi still applies provider-specific compatibility and level clamping when a
 * request is sent.
 */
export function customProviderModelDefinition(model: CustomProviderModel) {
  return {
    id: model.id,
    name: model.name,
    reasoning: true,
    input: (model.imageInput ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    // OpenAI-compatible relays are not guaranteed to implement the newer
    // `developer` role. Keep the system prompt on the broadly supported
    // `system` role (required by providers such as SenseTime).
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384
  };
}

/**
 * Validate a settings provider entry and build its registration payload.
 *
 * `custom: false` entries only record per-model visibility for built-in
 * providers (no baseUrl of their own — the catalog already defines them);
 * they return null instead of failing name/baseUrl validation. Startup feeds
 * every settings.providers entry through this path, so treating them as
 * malformed custom providers used to abort the whole initialize (sessions
 * never load, error dialog on every launch).
 */
export function resolveCustomProviderRegistration(config: ProviderSettings): {
  name: string;
  baseUrl: string;
  models: ReturnType<typeof customProviderModelDefinition>[];
} | null {
  if (config.custom === false) return null;
  const baseUrl = config.baseUrl.trim().replace(/\/+$/u, "");
  const name = config.name.trim();
  if (!name || !baseUrl) throw new Error("自定义服务商需要填写名称和接口地址");
  try {
    new URL(baseUrl);
  } catch {
    throw new Error("接口地址必须是有效的 URL，例如 https://api.example.com/v1");
  }
  const configuredModels = (config.models?.length ? config.models : [])
    .filter((model) => model.id.trim())
    .filter((model) => model.enabled !== false)
    .map((model) => ({ id: model.id.trim(), name: model.name.trim() || model.id.trim(), imageInput: model.imageInput, enabled: true }));
  return {
    name,
    baseUrl,
    models: configuredModels.map((model) => customProviderModelDefinition(model))
  };
}
