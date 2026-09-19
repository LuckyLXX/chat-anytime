import { AlertCircle, Brain, Check, ClipboardList, Code2, Eye, File, FileCode2, FileDiff, FileText, Globe2, ListTree, LoaderCircle, Maximize2, Minimize2, Pause, Pencil, Play, Plus, Server, Terminal, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import type { BrowserElementPick, BrowserPreviewState, WorkspaceFilePreview } from "../../../shared/protocol";
import { IMAGE_PREVIEW_LIMIT_BYTES, workspaceFilePreviewUrl } from "../../../shared/protocol";
import { artifactSandbox, buildArtifactPreviewSource, DYNAMIC_PREVIEW_ACTIONS, isDynamicArtifact, PREVIEW_SIZE_MESSAGE, type Artifact, type DynamicPreviewAction } from "../lib/content";
import { extractMarkdownHeadings } from "../lib/content-pipeline";
import { layoutDeviceFrame, storedPreviewDevice, storedPreviewFit, storePreviewDevice, storePreviewFit, type PreviewDeviceId } from "../lib/preview-device";
import { DiffView } from "./DiffView";
import { MarkdownOutline } from "./MarkdownOutline";
import { MemoryPreviewContent } from "./MemoryPreview";
import { MarkdownEditor, type EditorSaveStatus } from "./MarkdownEditor";
import { CodeBlock, MarkdownPreviewContent } from "./RichContent";
import { PreviewDeviceMenu } from "./PreviewDeviceMenu";
import { BrowserPreview } from "./BrowserPreview";
import { TerminalPanel } from "./TerminalPanel";
import { SshPanel } from "./SshPanel";
import { SshTerminalPanel } from "./SshTerminalPanel";

export type PreviewTarget =
  | { type: "artifact"; artifact: Artifact }
  | { type: "browser"; id?: string; title?: string; loading?: boolean }
  | { type: "terminal" }
  | { type: "ssh" }
  | { type: "ssh-terminal"; terminalId: string; hostId: string; hostName: string }
  | { type: "file"; file: WorkspaceFilePreview; workspace?: string }
  | { type: "diff"; title: string; path?: string; patch: string }
  | { type: "plan"; title: string; content: string }
  | { type: "memory"; topicId: string; title: string }
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

/**
 * Markdown 预览内容块（memo）。
 *
 * 抽成独立 memo 组件的目的：预览内容与 App 的其它状态（对话框、toast、权限弹窗）
 * 在同一渲染树，父级每次状态变化都会重渲染 ArtifactPreview；而 markdown 渲染本身
 * 是这里最贵的一步。props 只含内容与身份标识，handler 由 App 的 useCallback 保证
 * 引用稳定，内容不变时 React 直接跳过整棵子树 diff。
 *
 * 大纲（outline）也在这里：滚动容器与内容根的 ref 是本地 ref（不走 props，避免
 * 每次渲染重建对象导致 memo 失效），大纲栏与滚动 spy 共享同一对 ref。
 */
const MarkdownPreviewBlock = memo(function MarkdownPreviewBlock({ content, identity, artifactPrefix, onOpenArtifact, workspace, markdownPath, outlineOpen }: { content: string; identity: string; artifactPrefix: string; onOpenArtifact(artifact: Artifact): void; workspace?: string; markdownPath?: string; outlineOpen: boolean }): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 大纲只依赖源文本，与滚动无关；空文档不算大纲，工具条按钮据此隐藏。
  const headings = useMemo(() => extractMarkdownHeadings(content), [content]);
  return (
    <div className={`preview-markdown-shell${outlineOpen ? " has-outline" : ""}`}>
      {outlineOpen && <MarkdownOutline headings={headings} scrollRef={scrollRef} contentRef={contentRef} measureKey={identity} />}
      {/* 滚动容器不加 content-visibility：它在视口内永远“与用户相关”，子内容会全量
          布局（零收益），而非渲染态下反而把内容塌成占位——cv 加在内容块上（styles.css）。 */}
      <div className="preview-scroll preview-markdown" ref={scrollRef}>
        <div ref={contentRef}>
          <MarkdownPreviewContent content={content} headings={headings} artifactPrefix={artifactPrefix} onOpenArtifact={onOpenArtifact} workspace={workspace} markdownPath={markdownPath} />
        </div>
      </div>
    </div>
  );
});

function targetArtifact(target: PreviewTarget): Artifact | undefined {
  if (target.type === "artifact") return target.artifact;
  return target.type === "file" ? fileArtifact(target.file) : undefined;
}

function targetMetadata(target: PreviewTarget): { title: string; path?: string; label: string } {
  if (target.type === "artifact") return { title: target.artifact.title, label: target.artifact.language.toUpperCase() };
  if (target.type === "browser") return { title: target.title || "内置浏览器", label: "WEB" };
  if (target.type === "terminal") return { title: "终端", label: "TERM" };
  if (target.type === "ssh") return { title: "SSH 主机", label: "SSH" };
  if (target.type === "ssh-terminal") return { title: target.hostName, label: "SSH" };
  if (target.type === "file") return { title: target.file.name, path: target.file.relativePath, label: target.file.kind === "code" ? (target.file.language ?? "CODE").toUpperCase() : target.file.kind.toUpperCase() };
  if (target.type === "plan") return { title: target.title, label: "PLAN" };
  if (target.type === "memory") return { title: target.title, label: "MEMORY" };
  if (target.type === "diff") return { title: target.title, path: target.path, label: "DIFF" };
  return { title: target.title, path: target.path, label: target.type === "loading" ? "LOADING" : "ERROR" };
}

function targetIcon(target: PreviewTarget): ReactNode {
  if (target.type === "diff") return <Code2 size={15} />;
  if (target.type === "memory") return <Brain size={15} />;
  if (target.type === "browser") return <Globe2 size={15} />;
  if (target.type === "terminal") return <Terminal size={15} />;
  if (target.type === "ssh" || target.type === "ssh-terminal") return <Server size={15} />;
  if (target.type === "plan") return <ClipboardList size={15} />;
  return <FileCode2 size={15} />;
}

function FilePreviewContent({ file, tabId, onOpenArtifact, workspace, editorState, outlineOpen, onEditorChange, onEditorContentChange, onEditorSaved, onEditorStatusChange, onEditorSaveError, onResolveConflict }: { file: WorkspaceFilePreview; tabId: string; onOpenArtifact(artifact: Artifact): void; workspace?: string; editorState?: PreviewEditorState; outlineOpen: boolean; onEditorChange?(patch: Partial<PreviewEditorState>): void; onEditorContentChange?(tabId: string, content: string): void; onEditorSaved?(tabId: string, content: string): void; onEditorStatusChange?(tabId: string, status: EditorSaveStatus): void; onEditorSaveError?(message: string): void; onResolveConflict?(choice: "keep-local" | "load-remote"): void }): ReactNode {
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
    // 预览：markdownPath 让图片按「md 文件所在目录 → 工作区根」解析相对路径。
    return (
      <MarkdownPreviewBlock
        content={file.content}
        identity={file.relativePath}
        outlineOpen={outlineOpen}
        artifactPrefix={`preview-${file.relativePath}`}
        markdownPath={file.relativePath}
        onOpenArtifact={onOpenArtifact}
        workspace={file.workspace ?? workspace}
      />
    );
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
  if (file.kind === "pdf") {
    const root = file.workspace ?? workspace;
    if (!root) {
      return <div className="preview-empty preview-error"><FileText size={28} /><strong>PDF 预览需要有效工作区路径</strong><span>{file.name}</span></div>;
    }
    // 经自定义协议 pidesktop-file:// 流式读取，Chromium 内置 PDF 查看器渲染。
    const pdfUrl = workspaceFilePreviewUrl(root, file.relativePath);
    return <div className="preview-pdf"><iframe src={pdfUrl} title={file.name} /></div>;
  }
  return <div className="preview-empty"><FileText size={28} /><strong>此文件无法预览</strong><span>{file.size.toLocaleString("zh-CN")} bytes</span></div>;
}

export function ArtifactPreview({ tabs, activeTabId, browserSuspended, fullscreen, onFullscreenChange, onSelectTab, onCloseTab, onOpenArtifact, onAddBrowser, onAddTerminal, onAddSsh, onAddFile, onAddReview, onAddMenuOpenChange, reviewAvailable, workspace, activeEditorState, onActiveEditorChange, onActiveEditorContentChange, onActiveEditorSaved, onActiveEditorStatusChange, onActiveEditorSaveError, onActiveEditorResolveConflict, onToggleEditing, onBrowserStateChange, onBrowserPickSend, onSshConnect }: { tabs: PreviewTab[]; activeTabId: string; browserSuspended?: boolean; fullscreen?: boolean; onFullscreenChange?(next: boolean): void; onSelectTab(id: string): void; onCloseTab(id: string): void; onOpenArtifact(artifact: Artifact): void; onAddBrowser?(): void; onAddTerminal?(): void; onAddSsh?(): void; onAddFile?(): void; onAddReview?(): void; onAddMenuOpenChange?(open: boolean): void; reviewAvailable?: boolean; workspace?: string; activeEditorState?: PreviewEditorState; onActiveEditorChange?(patch: Partial<PreviewEditorState>): void; onActiveEditorContentChange?(tabId: string, content: string): void; onActiveEditorSaved?(tabId: string, content: string): void; onActiveEditorStatusChange?(tabId: string, status: EditorSaveStatus): void; onActiveEditorSaveError?(message: string): void; onActiveEditorResolveConflict?(choice: "keep-local" | "load-remote"): void; onToggleEditing?(): void; onBrowserStateChange?(tabId: string, state: BrowserPreviewState): void; onBrowserPickSend?(pick: BrowserElementPick, note: string): void; onSshConnect?(host: import("../../../shared/protocol").SshHostSummary): void }): ReactNode {
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
            </button>
            <button type="button" className="preview-empty-state-item" title="新建文件预览" aria-label="新建文件预览" onClick={() => onAddFile?.()}>
              <span className="preview-empty-state-item-icon"><File size={17} /></span>
              <span className="preview-empty-state-item-name">文件</span>
            </button>
            <button type="button" className="preview-empty-state-item" title="新建终端" aria-label="新建终端" onClick={() => onAddTerminal?.()}>
              <span className="preview-empty-state-item-icon"><Terminal size={17} /></span>
              <span className="preview-empty-state-item-name">终端</span>
            </button>
            <button type="button" className="preview-empty-state-item" title="SSH 远程终端" aria-label="SSH 远程终端" onClick={() => onAddSsh?.()}>
              <span className="preview-empty-state-item-icon"><Server size={17} /></span>
              <span className="preview-empty-state-item-name">SSH</span>
            </button>
          </div>
        </div>
      </aside>
    );
  }
  const target = active.target;
  const artifact = targetArtifact(target);
  const dynamic = Boolean(artifact && isDynamicArtifact(artifact));
  const markdownEditable = (!artifact && target.type === "file" && target.file.kind === "markdown" && target.file.content !== undefined && !target.file.truncated) || target.type === "memory";
  const editing = activeEditorState?.editing !== false;
  const [paused, setPaused] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [sourceModes, setSourceModes] = useState<Record<string, boolean>>({});
  // 大纲栏按标签页记忆（默认关闭：窄面板下不抢内容宽度）。
  const [outlineModes, setOutlineModes] = useState<Record<string, boolean>>({});
  // 设备视口按标签页记忆（新标签继承上次全局选择）；iframe 树形稳定，
  // 切换设备只改尺寸/缩放不重挂载，动态预览的运行时状态不丢。
  const [deviceModes, setDeviceModes] = useState<Record<string, PreviewDeviceId>>({});
  const [deviceFits, setDeviceFits] = useState<Record<string, boolean>>({});
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>();
  // 沙箱 iframe 的实测内容宽度（适应窗口按它放宽视口并整体缩小——设计导出的
  // 多画板并排页远宽于任何预设，只按预设宽缩放仍会内部溢出）。
  const [contentSizes, setContentSizes] = useState<Record<string, { width: number; height: number }>>({});
  const addMenuRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const fragmentTimersRef = useRef<number[]>([]);

  const showSource = sourceModes[activeTabId] === true;
  const outlineOpen = outlineModes[activeTabId] === true;
  // 大纲按钮只对 markdown 类预览有意义（文件预览 / 计划）。
  const outlineable = !showSource && !artifact && (target.type === "plan" || (target.type === "file" && target.file.kind === "markdown" && target.file.content !== undefined && !target.file.truncated));
  const sourceable = Boolean(artifact) || (target.type === "file" && target.file.kind === "markdown" && target.file.content !== undefined) || target.type === "plan" || target.type === "memory";
  const device = deviceModes[activeTabId] ?? storedPreviewDevice();
  const fit = deviceFits[activeTabId] ?? storedPreviewFit();
  const deviceable = Boolean(artifact);
  const contentSize = contentSizes[activeTabId];

  function changeDeviceMode(id: PreviewDeviceId): void {
    setDeviceModes((prev) => ({ ...prev, [activeTabId]: id }));
    storePreviewDevice(id);
  }

  function changeDeviceFit(next: boolean): void {
    setDeviceFits((prev) => ({ ...prev, [activeTabId]: next }));
    storePreviewFit(next);
  }

  function postPreviewAction(action: DynamicPreviewAction): void {
    frameRef.current?.contentWindow?.postMessage({ action }, "*");
  }

  useEffect(() => {
    setPaused(false);
  }, [activeTabId]);

  useEffect(() => {
    function close(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      // 全屏时 Esc 只退全屏，不误关标签页。
      if (fullscreen) {
        event.stopPropagation();
        onFullscreenChange?.(false);
        return;
      }
      onCloseTab(activeTabId);
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCloseTab, activeTabId, fullscreen, onFullscreenChange]);

  // 量测设备舞台尺寸（工件 iframe 的可用空间），驱动设备框缩放换算。
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      setStageSize(undefined);
      return;
    }
    const measure = (): void => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setStageSize((prev) => prev && prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, [activeTabId, showSource, deviceable]);

  const stageLayout = useMemo(
    () => (deviceable && stageSize ? layoutDeviceFrame(stageSize, device, { fit, clampWidth: false, contentWidth: contentSize?.width }) : undefined),
    [deviceable, stageSize, device, fit, contentSize?.width]
  );
  const deviceActive = deviceable && device !== "responsive" && stageLayout !== undefined;
  const frameStyle: CSSProperties = deviceActive && stageLayout
    ? { width: stageLayout.contentWidth, height: stageLayout.contentHeight, marginLeft: stageLayout.offsetX, transform: stageLayout.scale < 1 ? `scale(${stageLayout.scale})` : undefined, transformOrigin: "0 0" }
    : { width: "100%", height: "100%" };

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

  // 完整 HTML 文档（allow-scripts）由注入脚本 postMessage 上报内容尺寸；
  // 校验 event.source 防止页面伪造/串台。
  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const data = event.data as { type?: string; width?: unknown; height?: unknown } | null;
      if (!data || data.type !== PREVIEW_SIZE_MESSAGE) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const width = Number(data.width);
      const height = Number(data.height);
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height)) return;
      setContentSizes((prev) => {
        const cur = prev[activeTabId];
        return cur && Math.abs(cur.width - width) < 1 && Math.abs(cur.height - height) < 1 ? prev : { ...prev, [activeTabId]: { width, height } };
      });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [activeTabId]);

  useEffect(() => () => {
    for (const timer of fragmentTimersRef.current) window.clearTimeout(timer);
    fragmentTimersRef.current = [];
  }, [activeTabId]);

  function recordContentSize(tabKey: string, width: number, height: number): void {
    setContentSizes((prev) => {
      const cur = prev[tabKey];
      return cur && Math.abs(cur.width - width) < 1 && Math.abs(cur.height - height) < 1 ? prev : { ...prev, [tabKey]: { width, height } };
    });
  }

  // 纯片段沙箱（allow-same-origin 无脚本）读不到注入脚本，父页面直接量测；
  // 完整文档的沙箱访问 contentDocument 会抛 SecurityError——静默放弃（走上报）。
  function measureFragmentSize(frame: HTMLIFrameElement, tabKey: string, retries: number): void {
    try {
      const doc = frame.contentDocument;
      const width = Math.max(doc?.documentElement?.scrollWidth ?? 0, doc?.body?.scrollWidth ?? 0);
      const height = Math.max(doc?.documentElement?.scrollHeight ?? 0, doc?.body?.scrollHeight ?? 0);
      if (width > 0) {
        recordContentSize(tabKey, width, height);
        return;
      }
    } catch {
      return;
    }
    if (retries > 0) fragmentTimersRef.current.push(window.setTimeout(() => measureFragmentSize(frame, tabKey, retries - 1), 400));
  }

  function handleLoad(event: SyntheticEvent<HTMLIFrameElement>): void {
    frameRef.current = event.currentTarget;
    if (paused) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.pause);
    measureFragmentSize(event.currentTarget, activeTabId, 3);
  }

  return (
    <aside className={`content-preview-panel${fullscreen ? " preview-fullscreen" : ""}`} data-pane="preview" aria-label={`${targetMetadata(target).title}预览`}>
      <div className="preview-tabs" role="tablist" aria-label="预览标签">
        {tabs.map((tab) => {
          const tabMeta = targetMetadata(tab.target);
          return (
            <div className={`preview-tab${tab.id === activeTabId ? " active" : ""}`} key={tab.id} role="presentation">
              <button type="button" className="preview-tab-main" role="tab" aria-selected={tab.id === activeTabId} title={tabMeta.path ?? tabMeta.title} onClick={() => onSelectTab(tab.id)}>
                {tab.target.type === "browser" && tab.target.loading ? <LoaderCircle className="spinning" size={15} /> : targetIcon(tab.target)}
                <span>{tabMeta.title}</span>
              </button>
              <button type="button" className="preview-tab-close" aria-label={`关闭 ${tabMeta.title}`} onClick={() => onCloseTab(tab.id)}><X size={12} /></button>
            </div>
          );
        })}
        <div className="preview-tab-add-shell" ref={addMenuRef}>
          <button type="button" className="preview-tab-add" aria-label="新建预览标签" aria-haspopup="menu" aria-expanded={addMenuOpen} title="新建预览标签" onClick={() => setAddMenuOpen((open) => !open)}><Plus size={14} /></button>
          {addMenuOpen && <div className="preview-open-menu" role="menu" aria-label="新建预览标签">
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddReview?.(); }} disabled={!reviewAvailable}><FileDiff size={16} /><span>审阅</span></button>
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddTerminal?.(); }}><Terminal size={16} /><span>终端</span></button>
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddSsh?.(); }}><Server size={16} /><span>SSH</span></button>
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddBrowser?.(); }}><Globe2 size={16} /><span>浏览器</span></button>
            <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAddFile?.(); }}><File size={16} /><span>文件</span></button>
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
          {outlineable && <button className="icon-button" data-control="preview-outline-toggle" type="button" aria-pressed={outlineOpen} title={outlineOpen ? "隐藏大纲" : "显示文档大纲"} aria-label={outlineOpen ? "隐藏大纲" : "显示文档大纲"} onClick={() => setOutlineModes((prev) => ({ ...prev, [activeTabId]: !outlineOpen }))}><ListTree size={15} /></button>}
          {sourceable && <button className="icon-button" type="button" title={showSource ? "切换到预览" : "查看源代码"} aria-label={showSource ? "预览" : "源代码"} onClick={() => setSourceModes((prev) => ({ ...prev, [activeTabId]: !showSource }))}>{showSource ? <Eye size={15} /> : <Code2 size={15} />}</button>}
          {deviceable && !showSource && <PreviewDeviceMenu device={device} fit={fit} scalePercent={(stageLayout?.scale ?? 1) * 100} onDeviceChange={changeDeviceMode} onFitChange={changeDeviceFit} />}
          {dynamic && <button className="icon-button" type="button" aria-label={paused ? "继续动态预览" : "暂停动态预览"} title={paused ? "继续" : "暂停"} onClick={() => { postPreviewAction(paused ? DYNAMIC_PREVIEW_ACTIONS.resume : DYNAMIC_PREVIEW_ACTIONS.pause); setPaused((current) => !current); }}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>}
          <button className="icon-button" type="button" title={fullscreen ? "退出全屏（Esc）" : "全屏预览（预览面板覆盖整个窗口，Esc 退出）"} aria-label={fullscreen ? "退出全屏" : "全屏预览"} onClick={() => onFullscreenChange?.(!fullscreen)}>{fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          <button className="icon-button" type="button" title="关闭预览" aria-label="关闭预览" onClick={() => onCloseTab(activeTabId)}><X size={16} /></button>
        </div>
      </div>
      <div className="content-preview-body">
        {showSource && artifact && <div className="preview-scroll preview-code"><CodeBlock language={artifact.language} code={artifact.content} /></div>}
        {showSource && !artifact && target.type === "file" && target.file.content !== undefined && <div className="preview-scroll preview-code"><CodeBlock language={target.file.kind === "markdown" ? "markdown" : target.file.language ?? "text"} code={target.file.content} /></div>}
        {showSource && target.type === "plan" && <div className="preview-scroll preview-code"><CodeBlock language="markdown" code={target.content} /></div>}
        {!showSource && artifact && (
          <div className={`artifact-device-stage${deviceActive ? " device-mode" : ""}${deviceActive && !fit ? " device-overflow" : ""}`} ref={stageRef}>
            <div className="artifact-device-frame" style={frameStyle}>
              <iframe ref={frameRef} title={artifact.title} sandbox={artifactSandbox(artifact)} referrerPolicy="no-referrer" srcDoc={buildArtifactPreviewSource(artifact)} onLoad={handleLoad} />
            </div>
          </div>
        )}
        {!showSource && target.type === "browser" && <BrowserPreview suspended={browserSuspended} tabId={activeTabId} onPickSend={onBrowserPickSend} onStateChange={(state) => onBrowserStateChange?.(activeTabId, state)} />}
        {target.type === "terminal" && <TerminalPanel terminalId={active.id} workspace={workspace} />}
        {target.type === "ssh" && <SshPanel onConnect={(host) => onSshConnect?.(host)} />}
        {target.type === "ssh-terminal" && <SshTerminalPanel terminalId={target.terminalId} hostId={target.hostId} hostName={target.hostName} />}
        {!showSource && target.type === "plan" && <MarkdownPreviewBlock content={target.content} identity={`plan-${activeTabId}`} outlineOpen={outlineOpen} artifactPrefix={`plan-${activeTabId}`} onOpenArtifact={onOpenArtifact} workspace={workspace} />}
        {target.type === "memory" && <MemoryPreviewContent topicId={target.topicId} tabId={activeTabId} showSource={showSource} editorState={activeEditorState} onEditorChange={onActiveEditorChange} onEditorSaved={onActiveEditorSaved} onEditorStatusChange={onActiveEditorStatusChange} onSaveError={onActiveEditorSaveError} onOpenArtifact={onOpenArtifact} />}
        {!showSource && !artifact && target.type === "file" && <FilePreviewContent file={target.file} tabId={activeTabId} onOpenArtifact={onOpenArtifact} workspace={target.workspace ?? workspace} editorState={activeEditorState} outlineOpen={outlineOpen} onEditorChange={onActiveEditorChange} onEditorContentChange={onActiveEditorContentChange} onEditorSaved={onActiveEditorSaved} onEditorStatusChange={onActiveEditorStatusChange} onEditorSaveError={onActiveEditorSaveError} onResolveConflict={onActiveEditorResolveConflict} />}
        {target.type === "diff" && <div className="preview-scroll preview-diff"><DiffView patch={target.patch} /></div>}
        {target.type === "loading" && <div className="preview-empty"><LoaderCircle className="spinning" size={26} /><strong>正在读取文件</strong><span>{target.path}</span></div>}
        {target.type === "error" && <div className="preview-empty preview-error"><AlertCircle size={26} /><strong>无法打开预览</strong><span>{target.message}</span></div>}
      </div>
    </aside>
  );
}
