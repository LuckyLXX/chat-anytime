import { MAX_PREVIEW_FEEDBACK_LENGTH, MAX_PREVIEW_SOURCE_LENGTH, normalizePreviewSelection, truncatePreviewText } from "../../../shared/preview-selection";

const EDITABLE_OR_CONTROL = "input, textarea, select, button, [contenteditable]:not([contenteditable='false']), .preview-markdown-editor";

/** 同步读取当前预览文本区的选区；拒绝跨区选取和编辑控件。 */
export function readPreviewDomSelection(root: HTMLElement, target: EventTarget | null, selection: Selection | null): string | undefined {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element || !root.contains(element) || element.closest(EDITABLE_OR_CONTROL)) return undefined;
  const content = element.closest(".preview-scroll");
  if (!content || !root.contains(content) || !selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return undefined;
    for (const node of [range.startContainer, range.endContainer]) {
      const parent = node instanceof Element ? node : node.parentElement;
      if (parent?.closest(EDITABLE_OR_CONTROL)) return undefined;
    }
  }
  return normalizePreviewSelection(selection.toString());
}

export interface PreviewSelection {
  /** 文件相对路径、网页 URL 或预览标题。 */
  source: string;
  text: string;
}

/** 把选区和意见组成一条独立聊天消息。 */
export function composePreviewSelectionMessage(selection: PreviewSelection, feedback: string): string | undefined {
  const text = normalizePreviewSelection(selection.text);
  const note = truncatePreviewText(feedback.trim(), MAX_PREVIEW_FEEDBACK_LENGTH);
  if (!text || !note) return undefined;
  const source = truncatePreviewText(selection.source.trim(), MAX_PREVIEW_SOURCE_LENGTH) || "预览内容";
  return ["【预览选区修改】", `来源：${source}`, "", "选中内容：", text, "", "修改意见：", note].join("\n");
}
