import { PencilLine } from "lucide-react";
import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { MAX_PREVIEW_FEEDBACK_LENGTH, MAX_PREVIEW_SELECTION_LENGTH, truncatePreviewText } from "../../../shared/preview-selection";
import type { PreviewSelection } from "../lib/preview-selection";

export function PreviewSelectionDialog({ selection, onCancel, onSubmit }: {
  selection: PreviewSelection;
  onCancel(): void;
  onSubmit(feedback: string): void;
}): ReactNode {
  const [feedback, setFeedback] = useState("");
  const excerpt = selection.text.length > 600 ? `${truncatePreviewText(selection.text, 600)}…` : selection.text;

  useEffect(() => {
    // 预览面板自己也监听 window Escape：在捕获阶段消费，避免取消弹窗时关掉标签。
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [onCancel]);

  function submit(): void {
    if (feedback.trim()) onSubmit(feedback);
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="modal-backdrop permission-backdrop in-chat" onClick={onCancel}>
      <div className="permission-dialog preview-selection-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-selection-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <div className="risk-icon browse"><PencilLine size={20} /></div>
          <div><h2 id="preview-selection-title">修改选中内容</h2><p>修改意见会写入聊天输入框，发送前仍可编辑。</p></div>
        </header>
        <form onSubmit={handleSubmit}>
          <div className="preview-selection-body">
            <div className="preview-selection-source" title={selection.source}><span>来源</span><strong>{selection.source || "预览内容"}</strong></div>
            <div className="preview-selection-label">选中内容</div>
            <pre className="preview-selection-excerpt">{excerpt}</pre>
            <p className="preview-selection-hint">这里只展示摘要；选区最多保留 {MAX_PREVIEW_SELECTION_LENGTH.toLocaleString("zh-CN")} 字符。</p>
            <label className="preview-selection-label" htmlFor="preview-selection-feedback">修改意见</label>
            <textarea id="preview-selection-feedback" autoFocus rows={4} maxLength={MAX_PREVIEW_FEEDBACK_LENGTH} value={feedback} onChange={(event) => setFeedback(event.target.value)} onKeyDown={handleKeyDown} placeholder="描述你希望如何修改这段内容…" />
            <div className="preview-selection-meta"><span>Ctrl / ⌘ + Enter 写入聊天框</span><span>{feedback.length} / {MAX_PREVIEW_FEEDBACK_LENGTH}</span></div>
          </div>
          <footer><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" type="submit" disabled={!feedback.trim()}>发送到聊天框</button></footer>
        </form>
      </div>
    </div>
  );
}
