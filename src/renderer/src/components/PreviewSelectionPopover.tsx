import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MAX_PREVIEW_FEEDBACK_LENGTH } from "../../../shared/preview-selection";
import { positionSelectionPopover, type SelectionRect } from "../../../shared/selection-popover";
import { readPreviewDomSelection, type PreviewSelection } from "../lib/preview-selection";

interface PendingSelection { selection: PreviewSelection; range: Range; anchor: SelectionRect }

export function PreviewSelectionPopover({ rootRef, source, enabled, onSubmit }: {
  rootRef: RefObject<HTMLDivElement | null>;
  source: string;
  enabled: boolean;
  onSubmit(selection: PreviewSelection, feedback: string): Promise<void>;
}): ReactNode {
  const [pending, setPending] = useState<PendingSelection>();
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const popupRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  const sendingRef = useRef(false);
  editingRef.current = editing;
  sendingRef.current = sending;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) { setPending(undefined); return; }
    function updateSelection(target: EventTarget | null): void {
      if (editingRef.current || sendingRef.current) return;
      const selected = window.getSelection();
      const text = readPreviewDomSelection(root!, target, selected);
      if (!text || !selected) { setPending(undefined); return; }
      const range = selected.getRangeAt(0).cloneRange();
      const rects = Array.from(range.getClientRects());
      const rect = rects.at(-1) ?? range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { setPending(undefined); return; }
      setPending({ selection: { source, text }, range, anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } });
      setError(undefined);
    }
    const onPointerUp = (event: PointerEvent): void => {
      if (event.button !== 0 || !root.contains(event.target as Node)) return;
      updateSelection(event.target);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent): void => {
      if (!(event.shiftKey || event.key === "Shift" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a"))) return;
      const node = window.getSelection()?.anchorNode;
      if (node && root.contains(node)) updateSelection(node);
    };
    const onOutside = (event: PointerEvent): void => {
      if (popupRef.current?.contains(event.target as Node) || sendingRef.current) return;
      setPending(undefined);
      setEditing(false);
      setFeedback("");
      setError(undefined);
    };
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerdown", onOutside, true);
    return () => {
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerdown", onOutside, true);
    };
  }, [rootRef, source, enabled]);

  useEffect(() => {
    setPending(undefined);
    setEditing(false);
    setFeedback("");
    setError(undefined);
  }, [source, enabled]);

  useLayoutEffect(() => {
    if (!pending) return;
    const reposition = (): void => {
      const root = rootRef.current;
      if (!root) return;
      const rects = Array.from(pending.range.getClientRects());
      const rect = rects.at(-1) ?? pending.range.getBoundingClientRect();
      const anchor = rect && (rect.width || rect.height) ? rect : pending.anchor;
      const box = root.getBoundingClientRect();
      const bounds = { left: Math.max(0, box.left), top: Math.max(0, box.top), right: Math.min(window.innerWidth, box.right), bottom: Math.min(window.innerHeight, box.bottom) };
      const popup = popupRef.current?.getBoundingClientRect();
      const width = popup?.width || (editing ? Math.min(300, Math.max(80, bounds.right - bounds.left - 16)) : 82);
      const height = popup?.height || (editing ? 42 : 30);
      const next = positionSelectionPopover(anchor, bounds, width, height);
      setPosition((previous) => previous.left === next.left && previous.top === next.top ? previous : next);
    };
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!sendingRef.current) { setPending(undefined); setEditing(false); setFeedback(""); setError(undefined); }
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [pending, editing, error, rootRef]);

  if (!pending || !enabled) return null;
  const maxWidth = Math.max(80, Math.min(300, (rootRef.current?.getBoundingClientRect().width ?? 316) - 16));
  return createPortal(
    <div className="preview-selection-popover" ref={popupRef} style={{ left: position.left, top: position.top, maxWidth }} onPointerDown={(event) => event.stopPropagation()}>
      {!editing ? <button type="button" className="preview-selection-trigger" onPointerDown={(event) => event.preventDefault()} onClick={() => setEditing(true)}>AI优化</button> : (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!feedback.trim() || sendingRef.current) return;
          setSending(true);
          setError(undefined);
          void onSubmit(pending.selection, feedback).then(() => {
            setPending(undefined); setEditing(false); setFeedback("");
          }).catch((reason: unknown) => setError(reason instanceof Error && reason.message.trim() ? reason.message : "发送失败，请重试"))
            .finally(() => setSending(false));
        }}>
          <input autoFocus aria-label="修改意见" placeholder="输入修改意见，回车发送" maxLength={MAX_PREVIEW_FEEDBACK_LENGTH} value={feedback} disabled={sending} onChange={(event) => setFeedback(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} />
          {error && <span className="preview-selection-error" role="alert">{error}</span>}
        </form>
      )}
    </div>, document.body
  );
}
