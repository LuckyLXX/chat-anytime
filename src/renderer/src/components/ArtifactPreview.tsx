import { AlertCircle, Code2, FileCode2, FileText, Globe2, LoaderCircle, Pause, Play, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { WorkspaceFilePreview } from "../../../shared/protocol";
import { artifactSandbox, buildArtifactPreviewSource, DYNAMIC_PREVIEW_ACTIONS, isDynamicArtifact, type Artifact, type DynamicPreviewAction } from "../lib/content";
import { DiffView } from "./DiffView";
import { CodeBlock, RichContent } from "./RichContent";
import { BrowserPreview } from "./BrowserPreview";

export type PreviewTarget =
  | { type: "artifact"; artifact: Artifact }
  | { type: "browser" }
  | { type: "file"; file: WorkspaceFilePreview }
  | { type: "diff"; title: string; path?: string; patch: string }
  | { type: "loading"; title: string; path: string }
  | { type: "error"; title: string; path: string; message: string };

export interface PreviewTab {
  id: string;
  target: PreviewTarget;
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
  if (target.type === "file") return { title: target.file.name, path: target.file.relativePath, label: target.file.kind === "code" ? (target.file.language ?? "CODE").toUpperCase() : target.file.kind.toUpperCase() };
  if (target.type === "diff") return { title: target.title, path: target.path, label: "DIFF" };
  return { title: target.title, path: target.path, label: target.type === "loading" ? "LOADING" : "ERROR" };
}

function targetIcon(target: PreviewTarget): ReactNode {
  if (target.type === "diff") return <Code2 size={15} />;
  if (target.type === "browser") return <Globe2 size={15} />;
  return <FileCode2 size={15} />;
}

function footerLabel(target: PreviewTarget, artifact?: Artifact): string {
  if (artifact) return "沙箱预览";
  if (target.type === "browser") return "隔离浏览器";
  if (target.type === "diff") return "会话变更";
  return "只读预览";
}

function FilePreviewContent({ file, onOpenArtifact }: { file: WorkspaceFilePreview; onOpenArtifact(artifact: Artifact): void }): ReactNode {
  if (file.kind === "image" && file.data && file.mimeType) {
    return <div className="preview-image"><img src={`data:${file.mimeType};base64,${file.data}`} alt={file.name} /></div>;
  }
  if (file.kind === "markdown" && file.content !== undefined) {
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

export function ArtifactPreview({ tabs, activeTabId, browserSuspended, onSelectTab, onCloseTab, onOpenArtifact }: { tabs: PreviewTab[]; activeTabId: string; browserSuspended?: boolean; onSelectTab(id: string): void; onCloseTab(id: string): void; onOpenArtifact(artifact: Artifact): void }): ReactNode {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  if (!active) return null;
  const target = active.target;
  const artifact = targetArtifact(target);
  const dynamic = Boolean(artifact && isDynamicArtifact(artifact));
  const metadata = targetMetadata(target);
  const [paused, setPaused] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

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

  useEffect(() => () => {
    if (dynamic) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.destroy);
  }, [dynamic]);

  function handleLoad(event: SyntheticEvent<HTMLIFrameElement>): void {
    frameRef.current = event.currentTarget;
    if (paused) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.pause);
  }

  return (
    <aside className="content-preview-panel" aria-label={`${metadata.title}预览`}>
      {tabs.length > 1 && (
        <div className="preview-tabs" role="tablist" aria-label="预览标签">
          {tabs.map((tab) => {
            const tabMeta = targetMetadata(tab.target);
            return (
              <div className={`preview-tab${tab.id === activeTabId ? " active" : ""}`} key={tab.id} role="presentation">
                <button type="button" className="preview-tab-main" title={tabMeta.path ?? tabMeta.title} onClick={() => onSelectTab(tab.id)}>
                  {targetIcon(tab.target)}
                  <span>{tabMeta.title}</span>
                </button>
                <button type="button" className="preview-tab-close" aria-label={`关闭 ${tabMeta.title}`} onClick={() => onCloseTab(tab.id)}><X size={12} /></button>
              </div>
            );
          })}
        </div>
      )}
      <header className="content-preview-header">
        <div className="content-preview-title">
          {targetIcon(target)}
          <span><strong>{metadata.title}</strong>{metadata.path && <small title={metadata.path}>{metadata.path}</small>}</span>
          <em>{metadata.label}</em>
        </div>
        <div className="content-preview-actions">
          {dynamic && <button className="icon-button" type="button" aria-label={paused ? "继续动态预览" : "暂停动态预览"} title={paused ? "继续" : "暂停"} onClick={() => { postPreviewAction(paused ? DYNAMIC_PREVIEW_ACTIONS.resume : DYNAMIC_PREVIEW_ACTIONS.pause); setPaused((current) => !current); }}>{paused ? <Play size={16} /> : <Pause size={16} />}</button>}
          <button className="icon-button" type="button" title="关闭预览" aria-label="关闭预览" onClick={() => onCloseTab(activeTabId)}><X size={18} /></button>
        </div>
      </header>
      <div className="content-preview-body">
        {artifact && <iframe ref={frameRef} title={artifact.title} sandbox={artifactSandbox(artifact)} referrerPolicy="no-referrer" srcDoc={buildArtifactPreviewSource(artifact)} onLoad={handleLoad} />}
        {target.type === "browser" && <BrowserPreview suspended={browserSuspended} />}
        {!artifact && target.type === "file" && <FilePreviewContent file={target.file} onOpenArtifact={onOpenArtifact} />}
        {target.type === "diff" && <div className="preview-scroll preview-diff"><DiffView patch={target.patch} /></div>}
        {target.type === "loading" && <div className="preview-empty"><LoaderCircle className="spinning" size={26} /><strong>正在读取文件</strong><span>{target.path}</span></div>}
        {target.type === "error" && <div className="preview-empty preview-error"><AlertCircle size={26} /><strong>无法打开预览</strong><span>{target.message}</span></div>}
      </div>
      <footer className="content-preview-footer">
        <ShieldCheck size={13} />
        <span>{footerLabel(target, artifact)}</span>
        {target.type === "file" && target.file.truncated && <em>已显示前 1 MB</em>}
      </footer>
    </aside>
  );
}
