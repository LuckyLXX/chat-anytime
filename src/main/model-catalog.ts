import type { ModelOption, ProviderSettings } from "../shared/protocol.js";
import { isPositiveInt } from "./settings.js";

export interface CatalogAuthStatus {
  configured: boolean;
  source?: string;
}

/**
 * Environment variables are inherited by Electron and are not an explicit
 * model configuration in PiDesktop. Keep them out of the desktop catalog so
 * a host shell cannot silently add an entire provider's model list.
 */
export function isDesktopConfiguredProvider(auth: CatalogAuthStatus | undefined): boolean {
  return auth?.configured === true && auth.source !== "environment";
}

/** 目录模型的最小输入形状（与 Pi `ModelRuntime.getModels()` 的条目对齐）。 */
export interface CatalogModelInput {
  provider: string;
  id: string;
  name: string;
  input: ("text" | "image")[];
  /** SDK 目录的限额原值；用户在设置里手动修正后以此覆盖。 */
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * 单个模型的图片输入覆盖值（settings.providers 条目里用户勾选的结果）。
 * 内置服务商的 catalog 元数据滞后且不完整——尤其「拉取最新模型」新到的
 * 模型只有 id/name、输入类型克隆模板；允许用户在设置里手动标记，未标记
 * （undefined）时回退到目录元数据。自定义服务商注册时就把 imageInput 写
 * 进了 input，查出的覆盖值与之同源，行为不变。
 */
export function imageInputOverride(model: { provider?: string; id?: string }, providers: ProviderSettings[] | undefined): boolean | undefined {
  if (!model.provider || !model.id) return undefined;
  return providers?.find((provider) => provider.id === model.provider)?.models.find((item) => item.id === model.id)?.imageInput;
}

/** applyModelOverrides 的输入下界（Pi `Model` 的相关子集，避免本文件依赖 Pi 类型）。 */
export interface ModelOverrideTarget {
  provider?: string;
  id?: string;
  input: ("text" | "image")[];
}

/**
 * 把设置里的用户修正（token 限额、图片输入标记）覆盖到目录 Model 上；命中
 * 任何覆盖时返回浅克隆，绝不改动共享的运行时对象。图片输入标记必须落到
 * Model.input 本身：Pi 的各 API 适配器每次请求都按 model.input 把图片降级成
 * "(image omitted: …)" 占位文本，只改应用侧的 hasImageInput 判定挡不住它。
 * 覆盖是双向的：true 补上 image，false 摘掉（目录误报多模态时封住）。
 */
export function applyModelOverrides<T extends ModelOverrideTarget>(model: T, providers: ProviderSettings[] | undefined): T {
  const entry = providers?.find((provider) => provider.id === model.provider)?.models.find((item) => item.id === model.id);
  if (!entry) return model;
  const contextWindow = isPositiveInt(entry.contextWindow) ? entry.contextWindow : undefined;
  const maxTokens = isPositiveInt(entry.maxTokens) ? entry.maxTokens : undefined;
  const hasImage = model.input.includes("image");
  const input = entry.imageInput === true && !hasImage
    ? [...model.input, "image" as const]
    : entry.imageInput === false && hasImage
      ? model.input.filter((kind) => kind !== "image")
      : undefined;
  if (contextWindow === undefined && maxTokens === undefined && input === undefined) return model;
  return {
    ...model,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input !== undefined ? { input: input as T["input"] } : {})
  };
}

/**
 * 构建推送给渲染端的模型目录：不剔除被禁用的模型，而是逐条标注 enabled。
 *
 * 历史教训（2026-08-24）：旧实现直接 filter 掉 settings.providers 里
 * enabled === false 的模型——顶栏模型选择器因此正确地只显示启用的模型，
 * 但设置对话框「可用模型」列表也从这份目录构建，导致筛选保存后重进设置页
 * 目录只剩上次启用的几个（搜索框因 length ≤ 8 消失、其余模型不可见）。
 * 现在目录永远完整，勾选状态随条目下发；选择器类消费方自行过滤
 * enabled !== false。未出现在 settings.providers 的服务商/模型视为启用，
 * 不写 enabled 字段（协议缺省即启用）。
 */
export function buildCatalogModels(models: readonly CatalogModelInput[], providers: ProviderSettings[] | undefined, configuredProviders: ReadonlySet<string>): ModelOption[] {
  return models.map((model) => {
    const stored = providers?.find((provider) => provider.id === model.provider)?.models.find((item) => item.id === model.id);
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      configured: configuredProviders.has(model.provider),
      input: model.input,
      // 目录元数据可被设置里的手动标记覆盖（内置服务商拉取的新模型没有输入类型信息，靠用户勾选）。
      imageInput: stored?.imageInput ?? model.input.includes("image"),
      // 同理，token 限额的手动修正优先于目录原值。
      ...(isPositiveInt(stored?.contextWindow) || isPositiveInt(model.contextWindow) ? { contextWindow: stored?.contextWindow ?? model.contextWindow } : {}),
      ...(isPositiveInt(stored?.maxTokens) || isPositiveInt(model.maxTokens) ? { maxTokens: stored?.maxTokens ?? model.maxTokens } : {}),
      ...(stored ? { enabled: stored.enabled !== false } : {})
    };
  });
}
