/**
 * 浏览器标签 reveal 判定（纯函数，App 的 onBrowserTabsChanged 消费）。
 *
 * 背景（2026-09-28 用户实测报告）：AI 会话绑定标签后（bind 时 reveal 一次），
 * 后续 navigate 全走已绑定快速路径，不再发 automation-started。预览面板一旦被
 * 关闭（或渲染端重载丢失 React 状态），AI 的浏览器操作对用户完全不可见。
 *
 * reveal 语义分两档（主进程 BrowserAutomationController 决定）：
 * - force：无条件展开面板并激活该标签（bind / tabs switch / 截图——截图必须
 *   真的出帧，功能性依赖渲染）。
 * - when-hidden：仅当「面板未开」或「面板里没有该标签」时才展开+激活（navigate：
 *   面板开着且标签已在时不打扰正在看其他标签的用户——不把人拉回来）。
 */

/**
 * when-hidden 档是否应该展开面板并激活该标签。
 *
 * @param previewOpened 预览面板当前是否展开
 * @param openTabIds    面板里已有的标签 id（无面板/无标签时 undefined 或空数组）
 * @param tabId         AI 正在操作的标签 id
 */
export function shouldRevealBrowserTab(previewOpened: boolean, openTabIds: readonly string[] | undefined, tabId: string): boolean {
  if (!previewOpened) return true;
  return !(openTabIds ?? []).includes(tabId);
}
