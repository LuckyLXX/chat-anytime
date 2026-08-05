import { Code2, ExternalLink, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { Artifact } from "../lib/content";

export function ArtifactPreview({ artifact, onClose }: { artifact: Artifact; onClose(): void }): ReactNode {
  const source = artifact.language === "svg"
    ? `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:sans-serif">${artifact.content}</body></html>`
    : artifact.content;
  useEffect(() => {
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="artifact-overlay" role="dialog" aria-modal="true" aria-label={artifact.title} onMouseDown={onClose}>
      <header className="artifact-header" onMouseDown={(event) => event.stopPropagation()}>
        <div>
          <Code2 size={17} />
          <strong>{artifact.title}</strong>
          <span>{artifact.language.toUpperCase()}</span>
        </div>
        <button className="icon-button" type="button" title="关闭预览" aria-label="关闭预览" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="artifact-content" onMouseDown={(event) => event.stopPropagation()}>
        <iframe
          title={artifact.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={source}
        />
      </div>
      <footer className="artifact-footer"><ExternalLink size={14} />沙箱预览</footer>
    </div>
  );
}
