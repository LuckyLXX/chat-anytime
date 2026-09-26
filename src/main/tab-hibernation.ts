/**
 * 浏览器预览标签的休眠策略（T12a，2026-09-26）。
 *
 * **实测动机**：预览标签每个都是独立渲染进程（`WebContentsView`），隐藏时只做
 * `setVisible(false)`——Chromium 会节流它的定时器，但**不释放内存**。真机采样：
 * 7 个 renderer 合计 **890MB**，其中闲置标签约 157MB（几个 1–5MB 的空标签 + 一个
 * 148MB 的真实页面）。用户标签没有数量上限，原有的闲置清扫只收 `pi-browser-*`
 * 自动化标签。
 *
 * **做法（对齐 Chrome 的 memory saver 语义）**：把**长时间未激活、且没在显示**的用户
 * 标签「休眠」——拆掉视图并关闭 webContents（渲染进程随之回收），**保留标签记录与
 * 地址**；下次激活时重建视图并重新加载该地址。代价是页面内部状态丢失（滚动位置、
 * 表单、SPA 内存态），与 Chrome 丢弃标签页的取舍一致；收益是那部分内存真的还回去。
 *
 * 这条策略是**纯函数**：把「能不能休眠」的判断与 Electron 完全分开，便于逐条钉住
 * 不可休眠的情形（正在显示、被 AI 绑定、没有可恢复地址、自动化标签…）。
 */

/** 隐藏超过这么久才有资格休眠。 */
export const TAB_HIBERNATE_IDLE_MS = 15 * 60 * 1000;
/** 存活用户标签不超过这么多时完全不动手（日常两三个标签的工作流零感知）。 */
export const TAB_HIBERNATE_KEEP_LIVE = 4;

export interface TabHibernationCandidate {
  tabId: string;
  /** 自动化建的标签（`pi-browser-*`）：由原有清扫负责关闭，不走休眠。 */
  automation: boolean;
  /** 已经休眠。 */
  hibernated: boolean;
  /** 正在显示（visible + 已拿到布局矩形）。 */
  rendered: boolean;
  /** 被 AI 会话绑定或正在执行工具。 */
  inUse: boolean;
  /** 有可恢复的地址（没有的话保留记录也没意义）。 */
  restorable: boolean;
  /** 距最近一次活动的毫秒数。 */
  idleMs: number;
}

export interface TabHibernationOptions {
  idleMs?: number;
  keepLive?: number;
}

/**
 * 选出应当休眠的标签（按「最久未用」优先，只休眠到存活数降到 keepLive 为止）。
 * 返回空数组表示什么都不做。
 */
export function planTabHibernation(candidates: readonly TabHibernationCandidate[], options: TabHibernationOptions = {}): string[] {
  const idleMs = options.idleMs ?? TAB_HIBERNATE_IDLE_MS;
  const keepLive = Math.max(0, options.keepLive ?? TAB_HIBERNATE_KEEP_LIVE);
  let live = 0;
  const eligible: TabHibernationCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.automation || candidate.hibernated) continue;
    live += 1;
    if (candidate.rendered || candidate.inUse || !candidate.restorable) continue;
    if (candidate.idleMs < idleMs) continue;
    eligible.push(candidate);
  }
  const excess = live - keepLive;
  if (excess <= 0) return [];
  // 最久未用的先休眠（LRU），最多休眠到正好降到 keepLive。
  return eligible
    .sort((left, right) => right.idleMs - left.idleMs)
    .slice(0, excess)
    .map((candidate) => candidate.tabId);
}
