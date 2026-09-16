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
/**
 * 自定义服务商注册的模型直接透传用户声明的思考等级映射（缺省 = 不声明，Pi 按
 * 「关闭…高」处理）。上游 /models 不描述推理能力，而「很高/最高」需要显式声明
 * 才会被 Pi 放行——用户可在设置里逐模型声明（thinkingLevelMap），这里只负责
 * 把声明送到注册层。
 */
export function customProviderModelDefinition(model: CustomProviderModel) {
  return {
    id: model.id,
    name: model.name,
    reasoning: true,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
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
      // 思考等级声明透传（2026-09-16）：中间映射丢字段会让设置页的声明永远
      // 到不了注册层（同 2026-09-04 审查 P0-1 的 api 字段教训）。
      thinkingLevelMap: model.thinkingLevelMap,
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
 * 手动添加的模型（manual: true）不在运行时目录里——没有覆盖层注入它会话就无法
 * 使用。这里按「拉取新模型」同款策略克隆目录首个模型的完整元数据（流式/兼容
 * 字段），只覆盖 id/name，并套用设置里的图片输入/限额/API 覆盖。
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
  const manualModels = manualOverlayModels(config, currentModels);
  if (!providerBaseUrl && !providerApi && modelApiById.size === 0 && manualModels.length === 0) return undefined;
  // 手动条目与目录条目走同一套服务商级 baseUrl/api 覆盖（否则手动添加的模型
  // 会漏掉用户设置的接口地址，请求打到模板克隆携带的旧地址上）。
  return [...currentModels, ...manualModels].map((model) => {
    const api = modelApiById.get(model.id) ?? providerApi;
    const baseUrl = providerBaseUrl || undefined;
    const patch: { api?: string; baseUrl?: string } = {};
    if (api && api !== model.api) patch.api = api;
    if (baseUrl && baseUrl !== model.baseUrl) patch.baseUrl = baseUrl;
    return Object.keys(patch).length ? { ...model, ...patch } : model;
  });
}

/**
 * 设置条目里手动添加、目录尚未包含的模型 → 覆盖层条目（模板克隆）。
 * 目录已含同名 id 时不重复注入（用户手动添加了已存在的模型 = 只想勾选它）。
 * 无模板（该服务商目录为空）时退化为仅 id/name/provider 的最小条目。
 */
function manualOverlayModels<T extends { id: string }>(config: ProviderSettings, currentModels: readonly T[]): T[] {
  const existingIds = new Set(currentModels.map((model) => model.id));
  const manual = config.models.filter((model) => model.manual === true && !existingIds.has(model.id));
  if (manual.length === 0) return [];
  const template = currentModels[0] as (T & Record<string, unknown>) | undefined;
  return manual.map((model) => {
    const base: Record<string, unknown> = template ? { ...(template as unknown as Record<string, unknown>) } : { provider: config.id };
    base.id = model.id;
    base.name = model.name.trim() || model.id;
    if (model.api) base.api = model.api;
    if (isPositiveInt(model.contextWindow)) base.contextWindow = model.contextWindow;
    if (isPositiveInt(model.maxTokens)) base.maxTokens = model.maxTokens;
    // 图片输入标记落到 input 本身（口径同 applyModelOverrides：适配器按
    // model.input 决定是否降级图片，只改目录展示不够）。
    if (Array.isArray(base.input) && model.imageInput !== undefined) {
      const hasImage = base.input.includes("image");
      if (model.imageInput && !hasImage) base.input = [...base.input, "image"];
      else if (!model.imageInput && hasImage) base.input = base.input.filter((kind) => kind !== "image");
    }
    return base as T;
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
