import { AlertCircle, Brain, LoaderCircle, RefreshCw } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { MemoryTopic } from "../../../shared/protocol";
import { useDesktopStore } from "../store";
import type { Artifact } from "../lib/content";
import type { EditorSaveStatus } from "./MarkdownEditor";

const MarkdownEditor = lazy(() => import("./MarkdownEditor").then((module) => ({ default: module.MarkdownEditor })));
import { CodeBlock, RichContent } from "./RichContent";
import type { PreviewEditorState } from "./ArtifactPreview";

interface MemoryPreviewContentProps {
  topicId: string;
  /** 所属预览 tab 的 id（透传给编辑器，避免异步完成后写错 tab）。 */
  tabId: string;
  showSource: boolean;
  editorState?: PreviewEditorState;
  onEditorChange?(patch: Partial<PreviewEditorState>): void;
  onEditorSaved?(tabId: string, content: string): void;
  onEditorStatusChange?(tabId: string, status: EditorSaveStatus): void;
  onSaveError?(message: string): void;
  onOpenArtifact(artifact: Artifact): void;
}

/**
 * 长期记忆主题的预览窗口内容（记忆面板点击主题标题打开）。
 *
 * v3：列表只同步摘要，正文在点开时经 `memory.read` 按需拉取（`memoryContents`
 * 缓存，`contentRevision` 变化时失效）。三种形态不变：
 * - 预览（默认，点开先读）：RichContent 渲染；
 * - 编辑（点工具栏铅笔进入）：Vditor IR，自动保存/Ctrl+S/切走冲刷
 *   都经 MarkdownEditor 的 persistContent 改道 memory.update（含标题/索引描述
 *   原样回传，只更新正文）；
 * - 源码：原始 markdown。
 * 编辑期间后台 revision 变化不覆盖编辑器（保存仍是后写胜出，与面板删除/新建
 * 的治理语义一致）；主题被删除时给出空态提示。
 */
export function MemoryPreviewContent({ topicId, tabId, showSource, editorState, onEditorChange, onEditorSaved, onEditorStatusChange, onSaveError, onOpenArtifact }: MemoryPreviewContentProps): ReactNode {
  const summary = useDesktopStore((state) => state.memory.find((item) => item.id === topicId));
  const cached = useDesktopStore((state) => state.memoryContents[topicId]);
  const error = useDesktopStore((state) => state.memoryTopicErrors[topicId]);
  const editing = editorState?.editing === true;
  const lastTopic = useRef<MemoryTopic | undefined>(cached);
  if (cached) lastTopic.current = cached;
  const requestedRevision = useRef<number | undefined>(undefined);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!summary) return;
    if (cached && cached.contentRevision === summary.contentRevision) return;
    // 编辑中保留编辑器现有内容；退出编辑后再补拉最新版本。
    if (editing && lastTopic.current?.id === topicId) return;
    if (requestedRevision.current === summary.contentRevision) return;
    requestedRevision.current = summary.contentRevision;
    void window.piDesktop.send({ type: "memory.read", topicId });
  }, [summary?.id, summary?.contentRevision, cached?.contentRevision, editing, topicId, retry]);

  if (!summary) {
    return (
      <div className="preview-empty">
        <Brain size={28} />
        <strong>记忆主题不存在</strong>
        <span>该主题可能已被删除，可关闭此预览标签</span>
      </div>
    );
  }

  const topic = cached ?? (editing && lastTopic.current?.id === topicId ? lastTopic.current : undefined);
  if (!topic) {
    if (error) {
      return (
        <div className="preview-empty memory-preview-loading">
          <AlertCircle size={24} />
          <strong>记忆正文读取失败</strong>
          <span>{error}</span>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              requestedRevision.current = undefined;
              setRetry((value) => value + 1);
            }}
          >
            <RefreshCw size={13} />
            <span>重试</span>
          </button>
        </div>
      );
    }
    return (
      <div className="preview-empty memory-preview-loading">
        <LoaderCircle size={24} className="spinning" />
        <strong>正在读取记忆正文…</strong>
        <span>列表只同步摘要，正文按需加载</span>
      </div>
    );
  }

  if (showSource) return <div className="preview-scroll preview-code"><CodeBlock language="markdown" code={topic.content} /></div>;
  if (editing) {
    return (
      <div className="preview-markdown-editor">
        <Suspense fallback={<div className="preview-empty-state"><LoaderCircle size={18} className="spinning" /><span>正在载入编辑器…</span></div>}>
        <MarkdownEditor
          key={topic.id}
          tabId={tabId}
          relativePath={`pidesktop-memory/${topic.id}.md`}
          initialContent={topic.content}
          persistContent={(content) => window.piDesktop.send({ type: "memory.update", topic: summary.title, description: summary.description, content })}
          onDirtyChange={(dirty) => onEditorChange?.({ dirty })}
          onSaved={onEditorSaved}
          onStatusChange={onEditorStatusChange}
          onSaveError={onSaveError}
        />
        </Suspense>
      </div>
    );
  }
  return <div className="preview-scroll preview-markdown"><RichContent streaming={false} artifactPrefix={`memory-${tabId}`} onOpenArtifact={onOpenArtifact}>{topic.content}</RichContent></div>;
}
