/**
 * 命令面板的纯逻辑：动作类型、过滤、分组。
 *
 * 动作本身由 App 构造（闭包里有真实的状态与命令），这里只负责「搜什么、
 * 怎么排、怎么分组」，因此可以脱离 React 单测。过滤是 NFKC + 小写子串 +
 * 多词 AND；排序按标题精确/前缀/包含、关键词命中依次加权，同分保持原顺序
 * （动作表的顺序本身就是一份人工优先级）。
 *
 * 「真入口」口径（2026-11-05 重做）：默认视图只放**没有更短路径**的动作
 * （打开浏览器/终端/文件/SSH、新建话题、搜索会话、作品墙、自动化、设置）；
 * 模型切换这类在聊天框里一步就能做完的动作不再进面板，助手/主题/访问模式/
 * 模式开关/侧栏与预览开合/最近工作区/设置各 tab 这类低频或重复入口用
 * `searchOnly` 收进搜索结果——输入关键词仍然找得到，不占默认列表。
 */
import type { ComponentType } from "react";

export interface PaletteAction {
  id: string;
  /** 主标题（用户看到并搜索的那一行）。 */
  title: string;
  /** 分组；顺序由 {@link PALETTE_GROUP_ORDER} 决定。 */
  group: string;
  /** 额外搜索词（英文/同义词），不展示。 */
  keywords?: string;
  /** 右侧提示（当前值、目标会话、数量等）。 */
  hint?: string;
  /** 右侧快捷键徽章（展示用；真正的按键分发在 lib/keyboard-shortcuts.ts）。 */
  shortcut?: string;
  /** 行首图标（lucide 组件）；渲染层只负责画，不参与过滤。 */
  icon?: ComponentType<{ size?: number | string; strokeWidth?: number }>;
  /**
   * 默认视图（未输入查询）隐藏，输入关键词时才参与匹配。
   * 用于「有常驻控件 / 低频 / 只是重复入口」的动作，避免默认列表被噪声填满。
   */
  searchOnly?: boolean;
  /** 禁用时仍展示，但 Enter / 点击不执行。 */
  disabled?: boolean;
  /**
   * 执行体；与 {@link PaletteAction.enterSearch} 二选一。
   * 纯模式切换动作（「搜索会话内容」）没有可执行逻辑，因此可以省略。
   */
  run?: () => void | Promise<void>;
  /**
   * 进入面板内的会话内容检索模式：面板不关闭，输入框文字变成检索词，
   * 列表换成命中结果（回车打开会话并定位到那条消息）。
   */
  enterSearch?: boolean;
}

export interface PaletteGroup {
  title: string;
  actions: PaletteAction[];
}

/** 分组展示顺序：真入口在前（会话 → 打开 → 视图），搜索项与设置类在后。 */
export const PALETTE_GROUP_ORDER: readonly string[] = ["会话", "打开", "视图", "工作区", "设置", "助手", "权限", "模式", "主题", "其他"];

/** 一次最多展示多少条动作（过滤后）。 */
export const PALETTE_RESULT_LIMIT = 60;

export function normalizePaletteQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

export function filterPaletteActions(
  actions: readonly PaletteAction[],
  query: string,
  limit = PALETTE_RESULT_LIMIT
): PaletteAction[] {
  const normalized = normalizePaletteQuery(query);
  // 空查询 = 默认视图：只列真入口。searchOnly 的动作仍在动作表里，
  // 输入关键词后照常参与匹配（这正是「不删功能、只降噪」的落点）。
  if (!normalized) return actions.filter((action) => action.searchOnly !== true).slice(0, limit);
  const terms = normalized.split(/\s+/u).filter(Boolean);
  const scored: { action: PaletteAction; score: number; index: number }[] = [];

  actions.forEach((action, index) => {
    const title = normalizePaletteQuery(action.title);
    const keywords = normalizePaletteQuery(action.keywords ?? "");
    const group = normalizePaletteQuery(action.group);
    const haystack = `${title} ${keywords} ${group}`;
    if (!terms.every((term) => haystack.includes(term))) return;
    let score = 0;
    if (title === normalized) score += 100;
    else if (title.startsWith(normalized)) score += 60;
    else if (title.includes(normalized)) score += 30;
    if (keywords.includes(normalized)) score += 10;
    scored.push({ action, score, index });
  });

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.slice(0, limit).map((entry) => entry.action);
}

/** 按固定顺序分组；未登记的分组按首次出现顺序追加到末尾。 */
export function groupPaletteActions(actions: readonly PaletteAction[]): PaletteGroup[] {
  const byGroup = new Map<string, PaletteAction[]>();
  for (const action of actions) {
    const list = byGroup.get(action.group);
    if (list) list.push(action);
    else byGroup.set(action.group, [action]);
  }
  const groups: PaletteGroup[] = [];
  for (const title of PALETTE_GROUP_ORDER) {
    const list = byGroup.get(title);
    if (!list) continue;
    groups.push({ title, actions: list });
    byGroup.delete(title);
  }
  for (const [title, list] of byGroup) groups.push({ title, actions: list });
  return groups;
}
