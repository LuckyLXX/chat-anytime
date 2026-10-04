import type { CustomProviderModel, ProviderApiMode, ProviderModelSettings, ProviderSettings, ThinkingLevel, ThinkingLevelMap } from "../shared/protocol.js";
import { THINKING_LEVELS } from "../shared/thinking-levels.js";
import { isPositiveInt } from "./settings.js";

/**
 * 解析上游模型条目里的 token 数值：数字直接采用；字符串容忍 "128k" / "1m"
 * 等缩写后缀（部分中转站会序列化成字符串）。护栏 [1_000, 100_000_000]：
 * 过小是脏值，过大通常是把字节数/字符数写进了字段，都不如回退占位值。
 */
export function parseUpstreamTokenCount(value: unknown): number | undefined {
  let raw: number | undefined;
  if (typeof value === "number") raw = Number.isFinite(value) ? value : undefined;
  else if (typeof value === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM])?\s*$/u.exec(value);
    if (match) {
      const scale = match[2] ? (match[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
      raw = Number(match[1]) * scale;
    }
  }
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  const tokens = Math.round(raw);
  if (tokens < 1_000 || tokens > 100_000_000) return undefined;
  return tokens;
}

/**
 * 从 OpenAI 兼容 /models 条目里尽力提取 PiDesktop 消费的元数据
 * （上下文窗口 / 最大输出 / 图片输入声明）。
 *
 * 标准 OpenAI /v1/models 条目只有 id/object/created/owned_by，但中转站
 * （new-api 系返回 context_length / max_output_tokens / supports_images，
 * 2026-10 实测 workbuddy 渠道）与聚合网关（OpenRouter 的 architecture.*，
 * vLLM 的 max_model_len 等）普遍附带这些声明。此前拉取只取 id/name，声明
 * 全部丢弃，注册层落到 128000/16384 占位——「上下文参数不会自动获取」的
 * 根因（2026-10-04 修复）。字段候选按生态常见度取第一个有效值；缺失/无效
 * 返回 undefined，由调用方回退既有推断逻辑。
 */
export function extractUpstreamModelMeta(item: Record<string, unknown>): {
  contextWindow?: number;
  maxTokens?: number;
  imageInput?: boolean;
} {
  const readTop = (keys: string[]): unknown => {
    for (const key of keys) {
      const value = item[key];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };
  const architecture = item.architecture;
  const arch = architecture && typeof architecture === "object" && !Array.isArray(architecture) ? (architecture as Record<string, unknown>) : undefined;
  const contextWindow = parseUpstreamTokenCount(
    readTop(["context_length", "context_window", "contextWindow", "max_context_length", "max_context_tokens", "max_input_tokens", "max_model_len"])
      ?? arch?.max_input_tokens
  );
  let maxTokens = parseUpstreamTokenCount(readTop(["max_output_tokens", "max_completion_tokens"]) ?? arch?.max_output_tokens);
  // 一致性护栏：输出上限不可能超过上下文窗口，越过说明上游字段口径异常
  //（如把请求体大小写进了输出字段），丢弃脏值保留上下文。
  if (maxTokens !== undefined && contextWindow !== undefined && maxTokens > contextWindow) maxTokens = undefined;
  // 图片输入只采纳明确的 true 声明（supports_images / supports_vision / 输入
  // 模态数组含 image，顶层或 architecture 下都认）；显式 false 不采纳——部分
  // 中转站字段默认值恒为 false，误杀视觉模型的代价高于漏报（漏报可手动勾选）。
  const modalities = Array.isArray(item.input_modalities) ? (item.input_modalities as unknown[]) : Array.isArray(arch?.input_modalities) ? (arch!.input_modalities as unknown[]) : undefined;
  const imageInput = readTop(["supports_images", "supports_vision"]) === true
    || (modalities?.some((kind) => typeof kind === "string" && kind.toLowerCase() === "image") ?? false)
    || undefined;
  const result: { contextWindow?: number; maxTokens?: number; imageInput?: boolean } = {};
  if (contextWindow !== undefined) result.contextWindow = contextWindow;
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  if (imageInput) result.imageInput = true;
  return result;
}

/**
 * 从上游 /models 条目提取思考等级支持声明（无明确信号时返回 undefined，保持
 * Pi 的未声明口径：关闭…高可用、很高/最高需显式声明）。
 *
 * 只采纳三类明确信号（2026-10-04 workbuddy 渠道实测 46 模型分布）：
 *
 * 1. `reasoning_supported_efforts`（或 `supported_reasoning_efforts`）非空列表，
 *    且档名落在 Pi 七档内（本渠道 low/medium/high/xhigh/max 完全同名）→
 *    同名直通（可选 + 发同名值），未列出的档位**显式 `null`**——Pi 语义里
 *    缺键是「默认可用」，必须显式排除才能表达「只支持这些」。xhigh/max
 *    正是 PiDesktop 缺省锁死、需要声明才放行的「很高/最高」档。
 *    off 不在 effort 值域内，能否关推理由 `only_reasoning` 决定。
 * 2. `supports_reasoning === false`（或 OpenRouter architecture.supports_
 *    reasoning: false）→ 全部推理档显式 null、off 缺省可用（口径同
 *    defaultThinkingLevelMapFor 的非推理模型），档位选择器收敛到「关闭」。
 * 3. 无列表但 `only_reasoning === true` → 单独声明 `off: null`（仅推理、
 *    不能关闭），其余档位维持缺省口径。
 *
 * 刻意不采纳：`reasoning_effort` / `reasoning_default_effort` 是「默认档」
 * 而非支持范围（本渠道两种命名并存可互证，auto/快速/均衡/极致四个模型只有
 * 它），据此禁档会误杀；列表档名全部不在 Pi 七档内时同样放弃（无从映射）。
 */
export function extractUpstreamThinkingLevelMap(item: Record<string, unknown>): ThinkingLevelMap | undefined {
  const architecture = item.architecture;
  const arch = architecture && typeof architecture === "object" && !Array.isArray(architecture) ? (architecture as Record<string, unknown>) : undefined;
  if (item.supports_reasoning === false || arch?.supports_reasoning === false) {
    return { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
  }
  const rawEfforts = item.reasoning_supported_efforts ?? item.supported_reasoning_efforts;
  if (Array.isArray(rawEfforts)) {
    const supported = new Set(rawEfforts.filter((level): level is ThinkingLevel =>
      typeof level === "string" && (THINKING_LEVELS as readonly string[]).includes(level)));
    if (supported.size > 0) {
      const map: ThinkingLevelMap = {};
      for (const level of THINKING_LEVELS) {
        if (supported.has(level)) map[level] = level;
        else if (level !== "off" || item.only_reasoning === true) map[level] = null;
      }
      return map;
    }
  }
  if (item.only_reasoning === true) return { off: null };
  return undefined;
}

/**
 * 把上游 /models 响应条目映射为设置页模型列表（fetchCustomProviderModels 的
 * 纯函数部分，可单测）：id 必填，name 缺省回退 id，图片输入取上游声明优先、
 * 无声明回退模型名推断；按 id 去重（重复 id 保留首个——主条目通常在前，
 * 声明更完整）排序。空列表返回 []（是否报错由调用方定）。
 */
export function buildFetchedProviderModels(items: unknown[]): ProviderModelSettings[] {
  const models = items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || !record.id.trim()) return undefined;
      const id = record.id.trim();
      const meta = extractUpstreamModelMeta(record);
      const thinkingLevelMap = extractUpstreamThinkingLevelMap(record);
      return {
        id,
        name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
        imageInput: meta.imageInput ?? inferCustomModelImageInput(id),
        ...(meta.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
        ...(meta.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
        ...(thinkingLevelMap ? { thinkingLevelMap } : {})
      } satisfies ProviderModelSettings;
    })
    .filter(Boolean) as ProviderModelSettings[];
  const deduped = new Map<string, ProviderModelSettings>();
  for (const model of models) if (!deduped.has(model.id)) deduped.set(model.id, model);
  return [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id));
}

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
