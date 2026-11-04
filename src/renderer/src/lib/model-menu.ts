import type { ModelOption, ProviderOption } from "../../../shared/protocol";
import { groupModelsByProvider } from "./model-list";

/**
 * 输入框「模型快捷切换」菜单的纯逻辑（2026-11-04 两段式改造）。
 *
 * 交互契约：一级只列供应商，点开某个供应商才在侧边展开二级面板列出它的模型。
 * 需要两段式的原因是模型数量——OpenRouter 这类中转站一个供应商就几百条模型，
 * 平铺（哪怕带 optgroup 分组与吸顶标题）在 280px 宽、400px 高的弹层里等于让用户
 * 在一条长列表里翻。供应商是稳定的第一维，先收窄到一个供应商，再在几百条里搜。
 *
 * 几何与分组的判断都放这里（不变量式），组件只做渲染与键盘：
 * ① 分组顺序 = 目录首次出现顺序（与设置页「可用模型」一致，不重新排序）；
 * ② 供应商展示名缺失时回退 provider id（与 ModelSelect 同一口径）；
 * ③ 二级面板优先向右展开，右侧放不下翻左侧，两侧都放不下退化成单列（就地替换
 *    供应商列）——`.conversation-pane` 是 `overflow: hidden`，在分屏窄格里硬把
 *    300px 的面板推到格子外面会被裁掉，所以必须有第三档。
 */

/**
 * 二级面板里出现搜索框的最小模型数。少于它就直接列（省一个输入框、少一次焦点），
 * 与设置页「可用模型」的 8 条阈值同口径（ModelSettings 的 `providerModels.length > 8`）。
 */
export const MODEL_MENU_SEARCH_MIN = 8;

/** 一级弹层与二级面板之间的横向间距（CSS 里的 `calc(100% + 4px)` 必须与它一致）。 */
export const MODEL_MENU_GAP = 4;

/** 面板与容器（`.conversation-pane`）边缘的最小留白。 */
export const MODEL_MENU_EDGE_PAD = 8;

/** 量不到宽度时的兜底（happy-dom / 未布局）：与 CSS `min(300px, …)` 同值。 */
export const MODEL_MENU_PANEL_WIDTH = 300;

/** 一级菜单的一行：一个供应商 + 它下面可选的模型。 */
export interface ProviderMenuEntry {
  /** 供应商 id（目录的 provider 字段，也是选项值的前缀）。 */
  provider: string;
  /** 展示名：目录名优先，缺失回退 id。 */
  providerName: string;
  models: ModelOption[];
  /** 当前选中的模型是否落在这个供应商下（一级行高亮 + 二级里的勾选）。 */
  active: boolean;
}

/** 把可选模型按供应商收成一级菜单的行（`selected` 为 `provider/id`，空串表示未选）。 */
export function providerMenuEntries(models: ModelOption[], providers: ProviderOption[], selected: string): ProviderMenuEntry[] {
  return groupModelsByProvider(models, (providerId) => providers.find((provider) => provider.id === providerId)?.name).map((group) => ({
    provider: group.provider,
    providerName: group.providerName,
    models: group.models,
    active: Boolean(selected) && group.models.some((model) => `${group.provider}/${model.id}` === selected)
  }));
}

/** 当前选中模型在某个供应商下的展示名（一级行的副标题用）。 */
export function activeModelName(entry: ProviderMenuEntry, selected: string): string | undefined {
  return entry.models.find((model) => `${entry.provider}/${model.id}` === selected)?.name;
}

export interface ModelMenuPlacementInput {
  /** 一级弹层的左右边界（视口坐标）。 */
  popoverLeft: number;
  popoverRight: number;
  /** 允许占用的左右边界：会话格（`.conversation-pane`）的矩形，量不到时传视口。 */
  boundsLeft: number;
  boundsRight: number;
  /** 二级面板实际宽度（0 / 未布局时按 MODEL_MENU_PANEL_WIDTH 算）。 */
  panelWidth: number;
}

/** 二级面板的展开方向：side = 侧边展开；compact = 单列（就地替换供应商列）。 */
export type ModelMenuPlacement = "right" | "left" | "compact";

export function modelMenuPlacement({ popoverLeft, popoverRight, boundsLeft, boundsRight, panelWidth }: ModelMenuPlacementInput): ModelMenuPlacement {
  const width = panelWidth > 0 ? panelWidth : MODEL_MENU_PANEL_WIDTH;
  const need = width + MODEL_MENU_GAP + MODEL_MENU_EDGE_PAD;
  if (boundsRight - popoverRight >= need) return "right";
  if (popoverLeft - boundsLeft >= need) return "left";
  return "compact";
}
