// 浏览器预览地址栏的持久化（与 lib/preview-device.ts 同一模式：渲染端本地状态 +
// 可单测的纯读写层）。
//
// 关键约束（2026-09-16 事故修复）：地址栏**绝不编造默认值**。旧实现缺省返回
// `http://localhost:3000`，于是「AI 导航到某个地址、面板却显示 http://localhost:3000」
// 看起来像导航与页面地址对不上——实际是空标签页时地址栏自己编了个网址。空值交给
// placeholder 表达，真实地址只来自 (1) 该标签页真正导航过的记录，(2) 主进程推送的
// 页面状态。

function addressStorageKey(tabId: string): string {
  return `pidesktop.browser-preview-url-${tabId}`;
}

/** 该标签页上次真正导航到的地址；从未导航过时返回空串（由 placeholder 提示输入）。 */
export function storedBrowserAddress(tabId: string): string {
  try {
    return window.localStorage.getItem(addressStorageKey(tabId)) ?? "";
  } catch {
    // 浏览器演示模式等场景 localStorage 可能不可用：退化为空，而不是编一个网址。
    return "";
  }
}

export function saveBrowserAddress(tabId: string, address: string): void {
  try {
    window.localStorage.setItem(addressStorageKey(tabId), address);
  } catch {
    /* storage may be unavailable in browser demo */
  }
}
