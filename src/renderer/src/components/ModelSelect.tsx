import { useMemo, type ReactNode } from "react";
import type { ModelOption, ProviderOption } from "../../../shared/protocol";
import { groupModelsByProvider } from "../lib/model-list";

/**
 * 全应用统一的「选择模型」下拉：任何选模型的地方都用它，保证口径一致——
 * ① 按供应商分组（optgroup，供应商名缺失时回退 id）；
 * ② 只显示已勾选（enabled !== false）且已配置的模型（调用方传过滤后的目录，
 *    常用组合见下）；③ 当前值不在选项里时附加「（已停用）」兜底 option，避免
 *    受控 select 显示空白。
 *
 * 调用方负责按场景过滤 models：模型选择器一律
 * `selectableCatalogModels(models).filter((model) => model.configured)`，
 * 视觉类再加 `.filter((model) => model.imageInput)`。
 */
export function ModelSelect({
  models,
  providers,
  value,
  onChange,
  placeholder,
  emptyMessage,
  disabled,
  id,
  className,
  innerRef
}: {
  models: ModelOption[];
  providers: ProviderOption[];
  /** 当前值：「provider/id」；空串表示未选（配合 placeholder）。 */
  value: string;
  onChange(value: string): void;
  /** 空 option 的文案（例如「跟随全局默认模型」）；不传则不渲染空 option。 */
  placeholder?: string;
  /** 无任何可选模型时显示的禁用 option（例如「暂无已配置的多模态模型」）。 */
  emptyMessage?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** 透传给原生 select（需要 focus/滚动的调用方，如问询面板的键盘导航）。 */
  innerRef?: (element: HTMLSelectElement | null) => void;
}): ReactNode {
  const groups = useMemo(
    () => groupModelsByProvider(models, (providerId) => providers.find((item) => item.id === providerId)?.name),
    [models, providers]
  );
  const valueListed = !value || groups.some((group) => group.models.some((model) => `${group.provider}/${model.id}` === value));
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} id={id} className={className} ref={innerRef}>
      {groups.length === 0 && emptyMessage ? <option value="" disabled>{emptyMessage}</option> : !value && placeholder ? <option value="">{placeholder}</option> : null}
      {value && !valueListed && <option value={value}>{value}（已停用）</option>}
      {groups.map((group) => (
        <optgroup key={group.provider} label={group.providerName}>
          {group.models.map((model) => <option key={model.id} value={`${group.provider}/${model.id}`}>{model.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}