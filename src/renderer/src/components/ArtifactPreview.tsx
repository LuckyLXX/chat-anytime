import { AlertCircle, Check, Code2, Eye, File, FileCode2, FileDiff, FileText, Globe2, LoaderCircle, MessageSquare, Pause, Pencil, Play, Plus, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { WorkspaceFilePreview } from "../../../shared/protocol";
import { IMAGE_PREVIEW_LIMIT_BYTES } from "../../../shared/protocol";
import { artifactSandbox, buildArtifactPreviewSource, DYNAMIC_PREVIEW_ACTIONS, isDynamicArtifact, type Artifact, type DynamicPreviewAction } from "../lib/content";
import { DiffView } from "./DiffView";
import { MarkdownEditor, type EditorSaveStatus } from "./MarkdownEditor";
import { CodeBlock, RichContent } from "./RichContent";
import { BrowserPreview } from "./BrowserPreview";
import { TerminalPanel } from "./TerminalPanel";

export type PreviewTarget =
  | { type: "artifact"; artifact: Artifact }
  | { type: "browser"; id?: string }
  | { type: "terminal" }
  | { type: "file"; file: WorkspaceFilePreview; workspace?: string }
  | { type: "diff"; title: string; path?: string; patch: string }
  | { type: "loading"; title: string; path: string }
  | { type: "error"; title: string; path: string; message: string };

export interface PreviewTab {
  id: string;
  target: PreviewTarget;
}

/** 预览面板中某个 markdown 文件 tab 的编辑器状态（由顶层持有，驱动编辑/预览与 AI 同步）。 */
export interface PreviewEditorState {
  editing: boolean;
  dirty: boolean;
  externalConflict: boolean;
  remoteReload?: { content: string; nonce: number };
  /** 最近一次保存状态，用于右上角指示器（idle 不展示）。 */
  saveStatus?: EditorSaveStatus;
}

function fileArtifact(file: WorkspaceFilePreview): Artifact | undefined {
  if ((file.kind !== "html" && file.kind !== "svg") || !file.content || file.truncated) return undefined;
  return { id: `workspace-file-${file.relativePath}`, title: file.name, language: file.kind, content: file.content };
}

function targetArtifact(target: PreviewTarget): Artifact | undefined {
  if (target.type === "artifact") return target.artifact;
  return target.type === "file" ? fileArtifact(target.file) : undefined;
}

function targetMetadata(target: PreviewTarget): { title: string; path?: string; label: string } {
  if (target.type === "artifact") return { title: target.artifact.title, label: target.artifact.language.toUpperCase() };
  if (target.type === "browser") return { title: "内置浏览器", label: "WEB" };
  if (target.type === "terminal") return { title: "终端", label: "TERM" };
  if (target.type === "file") return { title: target.file.name, path: target.file.relativePath, label: target.file.kind === "code" ? (target.file.language ?? "CODE").toUpperCase() : target.file.kind.toUpperCase() };
  if (target.type === "diff") return { title: target.title, path: target.path, label: "DIFF" };
  return { title: target.title, path: target.path, label: target.type === "loading" ? "LOADING" : "ERROR" };
}

function targetIcon(target: PreviewTarget): ReactNode {
  if (target.type === "diff") return <Code2 size={15} />;
  if (target.type === "browser") return <Globe2 size={15} />;
  if (target.type === "terminal") return <Terminal size={15} />;
  return <FileCode2 size={15} />;
}

function FilePreviewContent({ file, tabId, onOpenArtifact, workspace, editorState, onEditorChange, onEditorContentChange, onEditorSaved, onEditorStatusChange, onEditorSaveError, onResolveConflict }: { file: WorkspaceFilePreview; tabId: string; onOpenArtifact(artifact: Artifact): void; workspace?: string; editorState?: PreviewEditorState; onEditorChange?(patch: Partial<PreviewEditorState>): void; onEditorContentChange?(tabId: string, content: string): void; onEditorSaved?(tabId: string, content: string): void; onEditorStatusChange?(tabId: string, status: EditorSaveStatus): void; onEditorSaveError?(message: string): void; onResolveConflict?(choice: "keep-local" | "load-remote"): void }): ReactNode {
  if (file.kind === "image" && file.data && file.mimeType) {
    return <div className="preview-image"><img src={`data:${file.mimeType};base64,${file.data}`} alt={file.name} /></div>;
  }
  if (file.kind === "image" && !file.data) {
    return <div className="preview-empty preview-error"><FileText size={28} /><strong>图片数据缺失，无法预览</strong><span>{file.name}</span></div>;
  }
  // 超出内联上限的图片在读取端归类为 binary（仍带 mimeType），单独给出明确提示。
  if (file.kind === "binary" && file.mimeType?.startsWith("image/")) {
    return <div className="preview-empty preview-error"><FileText size={28} /><strong>图片超过 {(IMAGE_PREVIEW_LIMIT_BYTES / 1024 / 1024).toFixed(0)} MB，无法预览</strong><span>{file.name}（{file.size.toLocaleString("zh-CN")} bytes）</span></div>;
  }
  if (file.kind === "markdown" && file.content !== undefined) {
    if (editorState?.editing && !file.truncated) {
      return (
        <div className="preview-markdown-editor">
          <MarkdownEditor
            key={file.relativePath}
            tabId={tabId}
            relativePath={file.relativePath}
            initialContent={file.content}
            workspace={workspace}
            contentPersisted={editorState?.dirty !== true}
            externalConflict={editorState.externalConflict}
            remoteReload={editorState.remoteReload}
            onDirtyChange={(dirty) => onEditorChange?.({ dirty })}
            onContentChange={onEditorContentChange}
            onSaved={onEditorSaved}
            onStatusChange={onEditorStatusChange}
            onSaveError={onEditorSaveError}
            onResolveConflict={onResolveConflict}
          />
        </div>
      );
    }
    return <div className="preview-scroll preview-markdown"><RichContent streaming={false} artifactPrefix={`preview-${file.relativePath}`} onOpenArtifact={onOpenArtifact}>{file.content}</RichContent></div>;
  }
  if (file.kind === "code" && file.content !== undefined) {
    return <div className="preview-scroll preview-code"><CodeBlock language={file.language ?? "text"} code={file.content} /></div>;
  }
  if ((file.kind === "html" || file.kind === "svg") && file.content !== undefined && file.truncated) {
    return <div className="preview-scroll preview-code"><CodeBlock language={file.kind} code={file.content} /></div>;
  }
  if (file.kind === "text" && file.content !== undefined) {
    return <div className="preview-scroll"><pre className="preview-plain-text">{file.content}</pre></div>;
  }
  return <div className="preview-empty"><FileText size={28} /><strong>此文件无法预览</strong><span>{file.size.toLocaleString("zh-CN")} bytes</span></div>;
}

export function ArtifactPreview({ tabs, activeTabId, browserSuspended, onSelectTab, onCloseTab, onOpenArtifact, onAddBrowser, onAddTerminal, onAddFile, onAddReview, onAddMenuOpenChange, reviewAvailable, workspace, activeEditorState, onActiveEditorChange, onActiveEditorContentChange, onActiveEditorSaved, onActiveEditorStatusChange, onActiveEditorSaveError, onActiveEditorResolveConflict, onToggleEditing }: { tabs: PreviewTab[]; activeTabId: string; browserSuspended?: boolean; onSelectTab(id: string): void; onCloseTab(id: string): void; onOpenArtifact(artifact: Artifact): void; onAddBrowser?(): void; onAddTerminal?(): void; onAddFile?(): void; onAddReview?(): void; onAddMenuOpenChange?(open: boolean): void; reviewAvailable?: boolean; workspace?: string; activeEditorState?: PreviewEditorState; onActiveEditorChange?(patch: Partial<PreviewEditorState>): void; onActiveEditorContentChange?(tabId: string, content: string): void; onActiveEditorSaved?(tabId: string, content: string): void; onActiveEditorStatusChange?(tabId: string, status: EditorSaveStatus): void; onActiveEditorSaveError?(message: string): void; onActiveEditorResolveConflict?(choice: "keep-local" | "load-remote"): void; onToggleEditing?(): void }): ReactNode {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  if (!active) {
    return (
      <aside className="content-preview-panel" data-pane="preview" aria-label="预览面板">
        <div className="preview-empty-state">
          <strong>预览面板</strong>
          <em>点击以下项可打开对应的预览标签</em>
          <div className="preview-empty-state-list">
            <button type="button" className="preview-empty-state-item" title="新建浏览器预览" aria-label="新建浏览器预览" onClick={() => onAddBrowser?.()}>
              <span className="preview-empty-state-item-icon"><Globe2 size={17} /></span>
              <span className="preview-empty-state-item-name">浏览器</span>
              <span className="preview-empty-state-key">Ctrl+T</span>
            </button>
            <button type="button" className="preview-empty-state-item" title="新建文件预览" aria-label="新建文件预览" onClick={() => onAddFile?.()}>
              <span className="preview-empty-state-item-icon"><File size={17} /></span>
              <span className="preview-empty-state-item-name">文件</span>
              <span className="preview-empty-state-key">Ctrl+P</span>
            </button>
            <button type="button" className="preview-empty-state-item" title="新建终端" aria-label="新建终端" onClick={() => onAddTerminal?.()}>
              <span className="preview-empty-state-item-icon"><Terminal size={17} /></span>
              <span className="preview-empty-state-item-name">终端</span>
              <span className="preview-empty-state-key">Ctrl+`</span>
            </button>
            <button type="button" className="preview-empty-state-item disabled" disabled aria-label="侧边聊天预览暂不支持">
              <span className="preview-empty-state-item-icon"><MessageSquare size={17} /></span>
              <span className="preview-empty-state-item-name">侧边聊天</span>
              <span className="preview-empty-state-key">Ctrl+Alt+S</span>
            </button>
          </div>
        </div>
      </aside>
    );
  }
  const target = active.target;
  const artifact = targetArtifact(target);
  const dynamic = Boolean(artifact && isDynamicArtifact(artifact));
  const markdownEditable = !artifact && target.type === "file" && target.file.kind === "markdown" && target.file.content !== undefined && !target.file.truncated;
  const editing = activeEditorState?.editing !== false;
  const [paused, setPaused] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [sourceModes, setSourceModes] = useState<Record<string, boolean>>({});
  const addMenuRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const showSource = sourceModes[activeTabId] === true;
  const sourceable = Boolean(artifact) || (target.type === "file" && target.file.kind === "markdown" && target.file.content !== undefined);

  function postPreviewAction(action: DynamicPreviewAction): void {
    frameRef.current?.contentWindow?.postMessage({ action }, "*");
  }

  useEffect(() => {
    setPaused(false);
  }, [activeTabId]);

  useEffect(() => {
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") onCloseTab(activeTabId);
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCloseTab, activeTabId]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [addMenuOpen]);

  // The "+" dropdown extends over the preview body, where the browser tab's
  // native WebContentsView floats above all DOM: report open state so the
  // owner can suspend the view, otherwise the menu is unclickable.
  useEffect(() => {
    onAddMenuOpenChange?.(addMenuOpen);
  }, [addMenuOpen, onAddMenuOpenChange]);

  useEffect(() => () => {
    if (dynamic) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.destroy);
  }, [dynamic]);

  function handleLoad(event: SyntheticEvent<HTMLIFrameElement>): void {
    frameRef.current = event.currentTarget;
    if (paused) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.pause);
  }

  return (
    <aside className="content-preview-panel" data-pane="preview" aria-label={`${targetMetadata(target).title}预览`}>
      <div className="preview-tabs" role="tablist" aria-label="预览标签">
        {tabs.map((tab) => {
          const tabMeta = targetMetadata(tab.target);
          return (
            <div className={`preview-tab${tab.id === activeTabId ? " active" : ""}`} key={tab.id} role="presentation">
              <button type="button" className="preview-tab-main" role="tab" aria-selected={tab.id === activeTabId} title={tabMeta.path ?? tabMeta.title} onClick={() => onSelectTab(tab.id)}>
                {targetIcon(tab.target)}
                <span>{tabMeta.title}</span>
              </button>
              <button type="button" className="preview-tab-close" aria-label={`关闭 ${tabMeta.title}`} onClick={() => onCloseTab(tab.id)}><X size={12} /></button>
            </div>
          );
        })}
        <div className="preview-tab-add-shell" ref={addMenuRef}>
          <button type="button" className="preview-tab-add" aria-label="新建预览标签" aria-haspopup="menu" aria-expanded={addMenuOpen} title="新建预览标签" onClick={() => setAddMenuOpen((open) => !open)}><Plus size={14} /></button>
          {addMenuOpen && <div className="preview-open-menu" role="menu" aria-label="新建预览标签">
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddReview?.(); }} disabled={!reviewAvailable}><FileDiff size={16} /><span>审阅</span><kbd>Ctrl+Shift+G</kbd></button>
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddTerminal?.(); }}><Terminal size={16} /><span>终端</span><kbd>Ctrl+`</kbd></button>
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddBrowser?.(); }}><Globe2 size={16} /><span>浏览器</span><kbd>Ctrl+T</kbd></button>
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddFile?.(); }}><File size={16} /><span>文件</span><kbd>Ctrl+P</kbd></button>
            <button type="button" role="menuitem" disabled><MessageSquare size={16} /><span>侧边聊天</span><kbd>Ctrl+Alt+S</kbd></button>
          </div>}
        </div>
        <div className="preview-tab-actions">
          {markdownEditable && activeEditorState?.saveStatus && activeEditorState.saveStatus !== "idle" && (
            <span
              className={`editor-save-status ${activeEditorState.saveStatus}`}
              role="status"
              title={activeEditorState.saveStatus === "error" ? "保存失败，详见编辑器内的错误提示" : activeEditorState.saveStatus === "saved" ? "已保存到磁盘" : activeEditorState.saveStatus === "saving" ? "正在写入磁盘" : "有未保存的修改"}
            >
              {activeEditorState.saveStatus === "saving" ? <LoaderCircle size={12} className="spinning" /> : activeEditorState.saveStatus === "saved" ? <Check size={13} /> : activeEditorState.saveStatus === "error" ? <AlertCircle size={13} /> : <Pencil size={12} />}
              <span>{activeEditorState.saveStatus === "saving" ? "保存中…" : activeEditorState.saveStatus === "saved" ? "已保存" : activeEditorState.saveStatus === "error" ? "保存失败" : "未保存"}</span>
            </span>
          )}
          {markdownEditable && <button className="icon-button" type="button" title={editing ? "切换到预览" : "切换到编辑"} aria-label={editing ? "预览" : "编辑"} onClick={() => onToggleEditing?.()}>{editing ? <Eye size={15} /> : <Pencil size={15} />}</button>}
          {sourceable && <button className="icon-button" type="button" title={showSource ? "切换到预览" : "查看源代码"} aria-label={showSource ? "预览" : "源代码"} onClick={() => setSourceModes((prev) => ({ ...prev, [activeTabId]: !showSource }))}>{showSource ? <Eye size={15} /> : <Code2 size={15} />}</button>}
          {dynamic && <button className="icon-button" type="button" aria-label={paused ? "继续动态预览" : "暂停动态预览"} title={paused ? "继续" : "暂停"} onClick={() => { postPreviewAction(paused ? DYNAMIC_PREVIEW_ACTIONS.resume : DYNAMIC_PREVIEW_ACTIONS.pause); setPaused((current) => !current); }}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>}
          <button className="icon-button" type="button" title="关闭预览" aria-label="关闭预览" onClick={() => onCloseTab(activeTabId)}><X size={16} /></button>
        </div>
      </div>
      <div className="content-preview-body">
        {showSource && artifact && <div className="preview-scroll preview-code"><CodeBlock language={artifact.language} code={artifact.content} /></div>}
        {showSource && !artifact && target.type === "file" && target.file.content !== undefined && <div className="preview-scroll preview-code"><CodeBlock language={target.file.kind === "markdown" ? "markdown" : target.file.language ?? "text"} code={target.file.content} /></div>}
        {!showSource && artifact && <iframe ref={frameRef} title={artifact.title} sandbox={artifactSandbox(artifact)} referrerPolicy="no-referrer" srcDoc={buildArtifactPreviewSource(artifact)} onLoad={handleLoad} />}
        {!showSource && target.type === "browser" && <BrowserPreview suspended={browserSuspended} tabId={activeTabId} />}
        {target.type === "terminal" && <TerminalPanel terminalId={active.id} workspace={workspace} />}
        {!showSource && !artifact && target.type === "file" && <FilePreviewContent file={target.file} tabId={activeTabId} onOpenArtifact={onOpenArtifact} workspace={target.workspace ?? workspace} editorState={activeEditorState} onEditorChange={onActiveEditorChange} onEditorContentChange={onActiveEditorContentChange} onEditorSaved={onActiveEditorSaved} onEditorStatusChange={onActiveEditorStatusChange} onEditorSaveError={onActiveEditorSaveError} onResolveConflict={onActiveEditorResolveConflict} />}
        {target.type === "diff" && <div className="preview-scroll preview-diff"><DiffView patch={target.patch} /></div>}
        {target.type === "loading" && <div className="preview-empty"><LoaderCircle className="spinning" size={26} /><strong>正在读取文件</strong><span>{target.path}</span></div>}
        {target.type === "error" && <div className="preview-empty preview-error"><AlertCircle size={26} /><strong>无法打开预览</strong><span>{target.message}</span></div>}
      </div>
    </aside>
  );
}
