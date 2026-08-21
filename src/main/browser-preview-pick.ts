import type { BrowserElementPick } from "../shared/protocol.js";

/**
 * 页面 preload（browser-pick.cjs）经 ipcRenderer.send 发来的手选结果解析。
 * 消息形状是 { url, element, note? }（element 含 tag/path/text/...）——注意
 * 不能把 payload 整包当 element 校验：tag 在 payload.element.tag，形状不符
 * 返回 undefined 由调用方丢弃。note 是用户在就地输入卡里填的备注，截断到
 * 2000 字符。
 */
export function parseElementPickMessage(payload: unknown, fallbackUrl: string): { url: string; element: BrowserElementPick["element"]; note?: string } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const { url, element, note } = payload as { url?: unknown; element?: unknown; note?: unknown };
  if (!element || typeof element !== "object" || typeof (element as BrowserElementPick["element"]).tag !== "string") return undefined;
  return {
    url: typeof url === "string" && url ? url : fallbackUrl,
    element: element as BrowserElementPick["element"],
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 2000) : undefined
  };
}
