import type { BrowserElementPick } from "../shared/protocol.js";
import { MAX_PREVIEW_FEEDBACK_LENGTH, MAX_PREVIEW_SOURCE_LENGTH, normalizePreviewSelection, truncatePreviewText } from "../shared/preview-selection.js";

/** 对网页 preload 的选区提交进行主进程校验；不信任跨 IPC 的形状与长度。 */
export function parseBrowserTextSelection(payload: unknown, fallbackUrl: string): { url: string; text: string; note: string; requestId: string } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const { url, text: rawText, note: rawNote, requestId } = payload as { url?: unknown; text?: unknown; note?: unknown; requestId?: unknown };
  const text = normalizePreviewSelection(rawText);
  const note = typeof rawNote === "string" ? truncatePreviewText(rawNote.trim(), MAX_PREVIEW_FEEDBACK_LENGTH) : "";
  if (!text || !note || typeof requestId !== "string" || !/^[\w-]{1,100}$/.test(requestId)) return undefined;
  const source = typeof url === "string" && url.trim() ? url : fallbackUrl;
  return { url: truncatePreviewText(source, MAX_PREVIEW_SOURCE_LENGTH), text, note, requestId };
}

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
