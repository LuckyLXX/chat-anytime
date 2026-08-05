import type { CustomProviderModel } from "../shared/protocol.js";

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
