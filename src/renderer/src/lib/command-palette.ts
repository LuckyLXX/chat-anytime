/**
 * 命令面板的纯逻辑：动作类型、过滤、分组。
 *
 * 动作本身由 App 构造（闭包里有真实的状态与命令），这里只负责「搜什么、
 * 怎么排、怎么分组」，因此可以脱离 React 单测。过滤是 NFKC + 小写子串 +
 * 多词 AND；排序按标题精确/前缀/包含、关键词命中依次加权，同分保持原顺序
 * （动作表的顺序本身就是一份人工优先级）。
 */

export interface PaletteAction {
  id: string;
  /** 主标题（用户看到并搜索的那一行）。 */
  title: string;
  /** 分组；顺序由 {@link PALETTE_GROUP_ORDER} 决定。 */
  group: string;
  /** 额外搜索词（英文/同义词），不展示。 */
  keywords?: string;
  /** 右侧提示（当前值、快捷键、目标会话等）。 */
  hint?: string;
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

/** 分组展示顺序：高频操作在前，设置类在后。 */
export const PALETTE_GROUP_ORDER: readonly string[] = ["会话", "模型", "权限", "视图", "模式", "主题", "设置", "其他"];

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
  if (!normalized) return actions.slice(0, limit);
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
