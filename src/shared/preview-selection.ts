/** 选区在浏览器 preload、主进程与渲染端共用的限制，避免大文本跨 IPC 或塞满草稿。 */
export const MAX_PREVIEW_SELECTION_LENGTH = 12_000;
export const MAX_PREVIEW_SOURCE_LENGTH = 4_096;
export const MAX_PREVIEW_FEEDBACK_LENGTH = 2_000;

/** 按 UTF-16 长度截断，同时保留截断边界上的完整 Unicode 字符。 */
export function truncatePreviewText(value: string, limit: number): string {
  let text = value.slice(0, limit);
  if (text.length < value.length && /[\uD800-\uDBFF]/.test(text.slice(-1)) && /[\uDC00-\uDFFF]/.test(value.charAt(text.length))) {
    text = text.slice(0, -1);
  }
  return text;
}

/** 拒绝空白选区；保留原始缩进和换行，截断时不拆开 UTF-16 代理对。 */
export function normalizePreviewSelection(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = truncatePreviewText(value, MAX_PREVIEW_SELECTION_LENGTH);
  return text.trim() ? text : undefined;
}
