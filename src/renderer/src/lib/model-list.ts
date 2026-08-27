import type { ModelOption, ProviderModelSettings, ProviderSettings } from "../../../shared/protocol";

interface ModelListItem {
  id: string;
  name: string;
}

/**
 * 设置对话框「可用模型」列表的搜索过滤：大小写不敏感地匹配模型名称或 ID，
 * 空白查询返回原列表。OpenRouter 这类数百条模型的渠道靠它缩小范围。
 */
export function filterProviderModels<T extends ModelListItem>(models: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter((model) => model.name.toLowerCase().includes(normalized) || model.id.toLowerCase().includes(normalized));
}

/**
 * 解析模型限额编辑框的输入：空/空白 → undefined（清除覆盖，回退目录值）；
 * 正整数 → 数值；其余非法输入 → undefined。同时接受「128k / 1.5m」式的
 * 缩写，避免用户数零数到眼花。
 */
export function parseTokenLimit(input: string): number | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return undefined;
  const shorthand = trimmed.match(/^(\d+(?:\.\d+)?)(k|m)?$/u);
  if (shorthand) {
    const base = Number(shorthand[1]);
    const scale = shorthand[2] === "m" ? 1_000_000 : shorthand[2] === "k" ? 1000 : 1;
    return Number.isFinite(base) ? Math.round(base * scale) : undefined;
  }
  return undefined;
}

/** 编辑框回显：已设置的覆盖值转字符串；未设置显示空串（placeholder 承担提示）。 */
export function formatTokenLimit(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : "";
}
/**
 * 选择器类消费方（顶栏/菜单/默认模型下拉）的目录视图：只保留启用或缺省的模型。
 * 目录本身包含被禁用的模型（设置页要还原勾选），在这里统一剔除。
 */
export function selectableCatalogModels<T extends ModelOption>(models: T[]): T[] {
  return models.filter((model) => model.enabled !== false);
}

/**
 * 批量设置启用状态（全选/全取消）。只改 targets 命中的条目，其余保持原对象引用，
 * 与逐条 updateProviderModel 写出的 `{ enabled: boolean }` 形状一致。
 */
export function setProviderModelsEnabled<T extends ModelListItem & { enabled?: boolean }>(models: T[], targets: T[], enabled: boolean): T[] {
  if (targets.length === 0) return models;
  const targetIds = new Set(targets.map((model) => model.id));
  return models.map((model) => targetIds.has(model.id) ? { ...model, enabled } : model);
}

/**
 * 重建内置服务商的设置条目（只记录模型勾选，无自定义 baseUrl）。
 * 必须保留主进程推送设置时盖上的 keyConfigured 章（index.ts 会按凭据缓存回填）；
 * 条目尚不存在时用目录的「已配置」标记补上。否则勾一次模型，渲染端就忘了
 * 密钥已保存，保存按钮会因「无 API 密钥」被误置灰。
 */
export function buildBuiltinProviderEntry(providerId: string, existing: ProviderSettings | undefined, fallbackName: string, catalogConfigured: boolean | undefined, models: ProviderModelSettings[]): ProviderSettings {
  return {
    id: providerId,
    name: existing?.name ?? fallbackName,
    baseUrl: "",
    models,
    custom: false,
    keyConfigured: existing?.keyConfigured || catalogConfigured || undefined
  };
}
