import { Brain } from "lucide-react";
import type { ReactNode } from "react";
import { useDesktopStore } from "../store";
import type { Artifact } from "../lib/content";
import { MarkdownEditor, type EditorSaveStatus } from "./MarkdownEditor";
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
 * 长期记忆主题的预览窗口内容（记忆面板点击主题标题打开）。正文来自渲染端
 * store 的实时镜像，三种形态：
 * - 预览（默认，点开先读）：RichContent 渲染；
 * - 编辑（点工具栏铅笔进入）：Vditor IR，自动保存/Ctrl+S/切走冲刷
 *   都经 MarkdownEditor 的 persistContent 改道 memory.update（含标题/索引描述
 *   原样回传，只更新正文）；
 * - 源码：原始 markdown。
 * 主题被删除时给出空态提示。编辑期间助手侧 memory_write 改了同一主题：编辑器
 * 保存即整体替换（后写胜出），与面板删除/新建的治理语义一致。
 */
export function MemoryPreviewContent({ topicId, tabId, showSource, editorState, onEditorChange, onEditorSaved, onEditorStatusChange, onSaveError, onOpenArtifact }: MemoryPreviewContentProps): ReactNode {
  const topic = useDesktopStore((state) => state.memory.find((item) => item.id === topicId));
  if (!topic) {
    return (
      <div className="preview-empty">
        <Brain size={28} />
        <strong>记忆主题不存在</strong>
        <span>该主题可能已被删除，可关闭此预览标签</span>
      </div>
    );
  }
  if (showSource) return <div className="preview-scroll preview-code"><CodeBlock language="markdown" code={topic.content} /></div>;
  if (editorState?.editing !== false) {
    return (
      <div className="preview-markdown-editor">
        <MarkdownEditor
          key={topic.id}
          tabId={tabId}
          relativePath={`pidesktop-memory/${topic.id}.md`}
          initialContent={topic.content}
          persistContent={(content) => window.piDesktop.send({ type: "memory.update", topic: topic.title, description: topic.description, content })}
          onDirtyChange={(dirty) => onEditorChange?.({ dirty })}
          onSaved={onEditorSaved}
          onStatusChange={onEditorStatusChange}
          onSaveError={onSaveError}
        />
      </div>
    );
  }
  return <div className="preview-scroll preview-markdown"><RichContent streaming={false} artifactPrefix={`memory-${tabId}`} onOpenArtifact={onOpenArtifact}>{topic.content}</RichContent></div>;
}
