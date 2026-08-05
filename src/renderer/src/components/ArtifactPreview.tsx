import { Code2, ExternalLink, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { artifactSandbox, buildArtifactPreviewSource, DYNAMIC_PREVIEW_ACTIONS, isDynamicArtifact, type Artifact, type DynamicPreviewAction } from "../lib/content";

export function ArtifactPreview({ artifact, onClose }: { artifact: Artifact; onClose(): void }): ReactNode {
  const source = buildArtifactPreviewSource(artifact);
  const dynamic = isDynamicArtifact(artifact);
  const [paused, setPaused] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  function postPreviewAction(action: DynamicPreviewAction): void {
    frameRef.current?.contentWindow?.postMessage({ action }, "*");
  }

  useEffect(() => {
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  useEffect(() => () => {
    if (dynamic) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.destroy);
  }, [dynamic]);

  function handleLoad(event: SyntheticEvent<HTMLIFrameElement>): void {
    frameRef.current = event.currentTarget;
    if (paused) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.pause);
  }

  return (
    <div className="artifact-overlay" role="dialog" aria-modal="true" aria-label={artifact.title} onMouseDown={onClose}>
      <header className="artifact-header" onMouseDown={(event) => event.stopPropagation()}>
        <div>
          <Code2 size={17} />
          <strong>{artifact.title}</strong>
          <span>{artifact.language.toUpperCase()}</span>
          {dynamic && <span className="artifact-dynamic-badge">动态</span>}
        </div>
        <button className="icon-button" type="button" title="关闭预览" aria-label="关闭预览" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="artifact-content" onMouseDown={(event) => event.stopPropagation()}>
        <iframe
          ref={frameRef}
          title={artifact.title}
          sandbox={artifactSandbox(artifact)}
          referrerPolicy="no-referrer"
          srcDoc={source}
          onLoad={handleLoad}
        />
      </div>
      <footer className="artifact-footer"><ExternalLink size={14} />沙箱预览{dynamic && <button className="secondary-button artifact-preview-control" type="button" aria-pressed={paused} onClick={() => { postPreviewAction(paused ? DYNAMIC_PREVIEW_ACTIONS.resume : DYNAMIC_PREVIEW_ACTIONS.pause); setPaused((current) => !current); }}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? "继续动态" : "暂停动态"}</button>}</footer>
    </div>
  );
}
