/// <reference lib="dom" />
import { MAX_PREVIEW_FEEDBACK_LENGTH, MAX_PREVIEW_SOURCE_LENGTH, normalizePreviewSelection, truncatePreviewText } from "../shared/preview-selection.js";
import { positionSelectionPopover, type SelectionRect } from "../shared/selection-popover.js";
import { keepPreviewSelectionHighlighted } from "../shared/selection-highlight.js";

export interface BrowserSelectionSubmission { requestId: string; url: string; text: string; note: string }
interface ActiveSelection {
  doc: Document;
  host: HTMLDivElement;
  range: Range;
  anchor: SelectionRect;
  text: string;
  send: (message: BrowserSelectionSubmission) => void;
  input?: HTMLInputElement;
  error?: HTMLSpanElement;
  requestId?: string;
  timer?: number;
  releaseHighlight?: () => void;
  dispose(): void;
}

const installedDocs = new WeakSet<Document>();
let active: ActiveSelection | undefined;
let automationBlocked = true;
let pickMode = false;
let unblockTimer: ReturnType<typeof setTimeout> | undefined;

function style(element: HTMLElement, properties: Partial<CSSStyleDeclaration>): void { Object.assign(element.style, properties); }
function closeSelection(): void {
  if (!active) return;
  if (active.timer !== undefined) active.doc.defaultView?.clearTimeout(active.timer);
  active.releaseHighlight?.();
  active.dispose();
  active.host.remove();
  active = undefined;
}
function setVisible(): void {
  if (active) active.host.style.display = automationBlocked || pickMode ? "none" : "";
}

/** AI 自动化的 CDP 鼠标事件也是 trusted；在页面侧同时隐藏控件，主进程仍做最终抑制。 */
export function setBrowserSelectionAutomation(blocked: boolean): void {
  if (unblockTimer !== undefined) clearTimeout(unblockTimer);
  if (blocked) { automationBlocked = true; setVisible(); return; }
  unblockTimer = setTimeout(() => { automationBlocked = false; setVisible(); }, 250);
}
export function setBrowserSelectionPickMode(enabled: boolean): void { pickMode = enabled; setVisible(); }

function isEditablePath(path: readonly EventTarget[]): boolean {
  return path.some((node) => {
    const element = node as Element;
    return element.nodeType === 1 && typeof element.matches === "function"
      && (element.matches("input, textarea, select, button, [contenteditable]:not([contenteditable='false'])") || (element as HTMLElement).isContentEditable);
  });
}
function rectFor(range: Range): SelectionRect | undefined {
  const rect = Array.from(range.getClientRects()).at(-1) ?? range.getBoundingClientRect();
  return rect && (rect.width || rect.height) ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : undefined;
}
function reposition(item: ActiveSelection): void {
  const win = item.doc.defaultView;
  if (!win) return;
  const anchor = rectFor(item.range) ?? item.anchor;
  const width = item.input ? Math.min(300, Math.max(80, win.innerWidth - 16)) : 82;
  const point = positionSelectionPopover(anchor, { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight }, width, item.input ? 42 : 30);
  style(item.host, { left: `${point.left}px`, top: `${point.top}px` });
}

function showSelection(doc: Document, text: string, range: Range, anchor: SelectionRect, send: (message: BrowserSelectionSubmission) => void): void {
  closeSelection();
  const win = doc.defaultView;
  if (!win) return;
  const host = doc.createElement("div");
  host.setAttribute("data-pi-selection", "1");
  style(host, { position: "fixed", zIndex: "2147483647", left: "0px", top: "0px" });
  const shadow = host.attachShadow({ mode: "closed" });
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "AI优化";
  style(button, { height: "30px", padding: "0 12px", border: "1px solid #526074", borderRadius: "8px", background: "#1d2330", color: "#ffc37e", boxShadow: "0 8px 24px rgba(0,0,0,.35)", font: '600 11px system-ui, "Microsoft YaHei", sans-serif', cursor: "pointer" });
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    const item = active;
    if (!item || item.host !== host || automationBlocked || pickMode) return;
    const form = doc.createElement("form");
    style(form, { width: `${Math.min(300, Math.max(80, win.innerWidth - 16))}px`, boxSizing: "border-box", padding: "4px", border: "1px solid #526074", borderRadius: "9px", background: "#1d2330", boxShadow: "0 8px 24px rgba(0,0,0,.35)" });
    const input = doc.createElement("input");
    input.placeholder = "输入修改意见，回车发送";
    input.setAttribute("aria-label", "修改意见");
    input.maxLength = MAX_PREVIEW_FEEDBACK_LENGTH;
    style(input, { display: "block", width: "100%", height: "32px", boxSizing: "border-box", padding: "0 9px", border: "0", outline: "0", color: "#f3f5f9", background: "transparent", font: '12px system-ui, "Microsoft YaHei", sans-serif' });
    const error = doc.createElement("span");
    error.setAttribute("role", "alert");
    style(error, { display: "block", color: "#ffb4ac", font: '11px/1.4 system-ui, "Microsoft YaHei", sans-serif' });
    form.append(input, error);
    shadow.replaceChildren(form);
    item.input = input;
    item.error = error;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const note = truncatePreviewText(input.value.trim(), MAX_PREVIEW_FEEDBACK_LENGTH);
      if (!note || input.disabled || automationBlocked || pickMode) return;
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      item.requestId = requestId;
      input.disabled = true;
      error.textContent = "";
      item.timer = win.setTimeout(() => {
        if (active !== item || item.requestId !== requestId) return;
        input.disabled = false;
        error.textContent = "状态未确认，请先检查聊天或队列再重试";
      }, 15_000);
      item.send({ requestId, url: truncatePreviewText(doc.URL || "", MAX_PREVIEW_SOURCE_LENGTH), text: item.text, note });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault();
      event.stopPropagation();
    });
    item.releaseHighlight = keepPreviewSelectionHighlighted(doc, item.range, false);
    reposition(item);
    input.focus();
  });
  shadow.append(button);
  (doc.body ?? doc.documentElement).appendChild(host);
  const onOutside = (event: PointerEvent): void => {
    if (event.composedPath().includes(host) || active?.input?.disabled) return;
    closeSelection();
  };
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || active?.doc !== doc) return;
    event.preventDefault(); event.stopPropagation();
    if (!active?.input?.disabled) closeSelection();
  };
  const onReposition = (): void => { if (active?.host === host) reposition(active); };
  const onPageHide = (): void => { if (active?.host === host) closeSelection(); };
  doc.addEventListener("pointerdown", onOutside, true);
  win.addEventListener("keydown", onEscape, true);
  win.addEventListener("scroll", onReposition, true);
  win.addEventListener("resize", onReposition);
  win.addEventListener("pagehide", onPageHide);
  active = { doc, host, range, anchor, text, send, dispose: () => {
    doc.removeEventListener("pointerdown", onOutside, true);
    win.removeEventListener("keydown", onEscape, true);
    win.removeEventListener("scroll", onReposition, true);
    win.removeEventListener("resize", onReposition);
    win.removeEventListener("pagehide", onPageHide);
  } };
  reposition(active);
}

/** 仅响应可信的用户选区完成事件；页面脚本主动修改选区不会单独弹出按钮。 */
export function captureBrowserSelection(doc: Document, event: Event, send: (message: BrowserSelectionSubmission) => void): void {
  if (!event.isTrusted || automationBlocked || pickMode || isEditablePath(event.composedPath())) return;
  if (active && event.composedPath().includes(active.host)) return;
  const selection = doc.getSelection();
  const text = normalizePreviewSelection(selection?.toString());
  if (!selection || !text || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0).cloneRange();
  for (const node of [range.startContainer, range.endContainer]) {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (element?.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false'])")) return;
  }
  const anchor = rectFor(range);
  if (anchor) showSelection(doc, text, range, anchor, send);
}

export function installBrowserSelectionUI(doc: Document, send: (message: BrowserSelectionSubmission) => void): void {
  if (installedDocs.has(doc)) return;
  installedDocs.add(doc);
  const win = doc.defaultView;
  if (!win) return;
  win.addEventListener("pointerup", (event) => { if (event.button === 0) captureBrowserSelection(doc, event, send); }, true);
  win.addEventListener("keyup", (event) => {
    if (event.shiftKey || event.key === "Shift" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")) captureBrowserSelection(doc, event, send);
  }, true);
}

export function resolveBrowserSelectionReply(reply: unknown): void {
  if (!active || !reply || typeof reply !== "object") return;
  const message = reply as { requestId?: unknown; ok?: unknown; error?: unknown };
  if (message.requestId !== active.requestId || typeof message.ok !== "boolean") return;
  if (active.timer !== undefined) active.doc.defaultView?.clearTimeout(active.timer);
  if (message.ok) { closeSelection(); return; }
  if (active.input) active.input.disabled = false;
  if (active.error) active.error.textContent = typeof message.error === "string" && message.error.trim() ? message.error.slice(0, 240) : "发送失败，请重试";
  active.input?.focus();
}
