import type { CustomProviderModel, ProviderApiMode, ProviderSettings } from "../shared/protocol.js";
import { isPositiveInt } from "./settings.js";

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
    // 模型级 API 模式覆盖：缺省由 provider 级 api（或 openai-completions）兜底。
    ...(model.api ? { api: model.api } : {}),
    // OpenAI-compatible relays are not guaranteed to implement the newer
    // `developer` role. Keep the system prompt on the broadly supported
    // `system` role (required by providers such as SenseTime).
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 上游 /models 不提供限额信息，这里只能给保守占位；用户在设置里手动
    // 修正过的值（settings.providers 的 contextWindow/maxTokens）优先。
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxTokens ?? 16384
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
  /** 服务商级 API 模式覆盖；缺省由注册方按 openai-completions 兜底解析。 */
  api?: ProviderApiMode;
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
    .map((model) => ({
      id: model.id.trim(),
      name: model.name.trim() || model.id.trim(),
      imageInput: model.imageInput,
      // 模型级 API 模式覆盖透传（缺失回退 provider 级 api）；2026-09-04 审查
      // P0-1：此前中间映射丢字段导致注册层永远看到 undefined。
      ...(model.api ? { api: model.api } : {}),
      contextWindow: isPositiveInt(model.contextWindow) ? model.contextWindow : undefined,
      maxTokens: isPositiveInt(model.maxTokens) ? model.maxTokens : undefined,
      enabled: true
    }));
  return {
    name,
    baseUrl,
    ...(config.api ? { api: config.api } : {}),
    models: configuredModels.map((model) => customProviderModelDefinition(model))
  };
}

/**
 * 内置服务商的 models-store 覆盖层构造：以运行时当前目录（base + 已应用覆盖层）
 * 为基线，叠加设置条目的接口地址/API 模式覆盖，返回覆盖后的完整模型列表。
 *
 * 覆盖规则：服务商级 baseUrl 非空 → 全部模型 baseUrl 覆盖；服务商级 api 非空 →
 * 全部模型 api 覆盖；模型级 api → 对应模型 api 覆盖（优先级最高）。未命中任何
 * 覆盖的模型保持原对象引用（幂等），无任何覆盖时返回 undefined（调用方不写覆盖层）。
 *
 * 为什么是覆盖层而非 registerProvider：applyExtension 的 models 数组是整体替换
 * 语义，对内置服务商传部分模型会丢掉目录其余模型；覆盖层模型带完整元数据，
 * 只改 api/baseUrl 不会丢失流式所需字段。
 */
export function builtinProviderOverlay<T extends { id: string; api?: string; baseUrl?: string }>(
  config: ProviderSettings,
  currentModels: readonly T[]
): T[] | undefined {
  if (config.custom !== false) {
    // 自定义服务商走 registerProvider 通道，这里只处理内置条目。
    return undefined;
  }
  const providerBaseUrl = config.baseUrl.trim().replace(/\/+$/u, "");
  const providerApi = config.api;
  const modelApiById = new Map<string, ProviderApiMode>();
  for (const model of config.models) {
    if (model.api) modelApiById.set(model.id, model.api);
  }
  if (!providerBaseUrl && !providerApi && modelApiById.size === 0) return undefined;
  return currentModels.map((model) => {
    const api = modelApiById.get(model.id) ?? providerApi;
    const baseUrl = providerBaseUrl || undefined;
    const patch: { api?: string; baseUrl?: string } = {};
    if (api && api !== model.api) patch.api = api;
    if (baseUrl && baseUrl !== model.baseUrl) patch.baseUrl = baseUrl;
    return Object.keys(patch).length ? { ...model, ...patch } : model;
  });
}

/** models-store 覆盖层条目的来源标记（SDK 合层只读 models/lastModified 等字段，容忍多余键）。 */
export type OverlayEntrySource = "settings" | "pull";

/**
 * 单个内置条目的覆盖层处置决策（纯函数，syncBuiltinProviderOverlays 使用）：
 * - 有设置覆盖 → 返回写入对象（models 已叠加接口地址/API 覆盖，来源标记 settings）；
 * - 无设置覆盖但现存条目是「设置覆盖残留」→ 返回 "drop"（用户已清空覆盖，删键还原目录）；
 * - 其余（拉取目录 / SDK 远程目录 / 无条目）→ 返回 undefined（不动）。
 *
 * 区分来源是 2026-09-04 审查 P1-1 的修复：此前「无覆盖即删键」会把
 * refreshBuiltinModelsFallback 刚写入的拉取目录一并删除（同命令内自噬），
 * 「拉取最新模型」退化为报成功但目录回退静态表。
 */
export function resolveBuiltinOverlayAction<T extends { id: string; api?: string; baseUrl?: string }>(
  config: ProviderSettings | undefined,
  currentModels: readonly T[],
  existingSource: OverlayEntrySource | undefined
): { models: T[]; source: "settings" } | "drop" | undefined {
  const overlay = config ? builtinProviderOverlay(config, currentModels) : undefined;
  if (overlay) return { models: overlay, source: "settings" };
  return existingSource === "settings" ? "drop" : undefined;
}
