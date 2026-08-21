import type { ProviderModelSettings, ProviderSettings } from "../../../shared/protocol";

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
