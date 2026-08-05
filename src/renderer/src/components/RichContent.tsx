import { Check, Code2, Copy, Expand, FileCode2, ExternalLink, X } from "lucide-react";
import mermaid from "mermaid";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import hljs from "highlight.js";
import type { Artifact } from "../lib/content";
import { parseRichContent, type RichContentSegment } from "../lib/content-pipeline";

interface RichContentProps {
  children: string;
  streaming?: boolean;
  onOpenArtifact(artifact: Artifact): void;
  artifactPrefix: string;
}

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => {
      const selected = document.documentElement.dataset.theme;
      setDark(selected === "dark" || (selected !== "light" && media.matches));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return dark;
}

function CopyButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button className="icon-button code-action" type="button" title={copied ? "已复制" : "复制代码"} aria-label={copied ? "已复制" : "复制代码"} onClick={() => void copy()}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function MermaidBlock({ code, language }: { code: string; language: string }): ReactNode {
  const id = useId().replaceAll(":", "");
  const dark = useDarkTheme();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    setError("");
    setSvg("");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      themeVariables: dark
        ? { primaryColor: "#26324e", primaryTextColor: "#edf2ff", lineColor: "#94a3b8", secondaryColor: "#1e293b" }
        : { primaryColor: "#eef2ff", primaryTextColor: "#1f2937", lineColor: "#64748b", secondaryColor: "#f8fafc" },
      fontFamily: "Inter, Segoe UI, Microsoft YaHei, sans-serif"
    });
    void mermaid
      .render(`mermaid-${id}`, code)
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [code, dark, id]);

  useEffect(() => {
    if (!expanded) return;
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  if (error) {
    return (
      <details className="render-error mermaid-error">
        <summary>Mermaid 渲染失败，查看源码</summary>
        <pre>{code}\n\n{error}</pre>
      </details>
    );
  }
  return (
    <>
      <div className="mermaid-block" data-mermaid-language={language}>
        <div className="mermaid-toolbar"><span>{language === "mermaid" ? "Mermaid" : language}</span><button className="icon-button" type="button" title="放大图表" aria-label="放大图表" onClick={() => setExpanded(true)}><Expand size={15} /></button></div>
        <button type="button" className="mermaid-canvas" aria-label="放大 Mermaid 图表" onClick={() => setExpanded(true)} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      {expanded && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setExpanded(false)}>
          <div className="diagram-modal" role="dialog" aria-modal="true" aria-label="放大的 Mermaid 图表" onMouseDown={(event) => event.stopPropagation()}>
            <button className="icon-button modal-close" type="button" title="关闭图表" aria-label="关闭图表" onClick={() => setExpanded(false)}><X size={17} /></button>
            <div className="expanded-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </div>
      )}
    </>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }): ReactNode {
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language }).value
    : hljs.highlightAuto(code).value;
  return (
    <div className="code-block">
      <div className="code-toolbar"><span>{language || "text"}</span><div className="code-actions"><CopyButton text={code} /></div></div>
      <pre><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
    </div>
  );
}

function ArtifactCard({ artifact, onOpenArtifact }: { artifact: Artifact; onOpenArtifact(artifact: Artifact): void }): ReactNode {
  return (
    <article className="artifact-card">
      <header className="artifact-card-header">
        <span><FileCode2 size={15} /><strong>{artifact.title}</strong><small>{artifact.language.toUpperCase()}</small></span>
        <button className="secondary-button artifact-open-button" type="button" onClick={() => onOpenArtifact(artifact)}><ExternalLink size={14} />打开预览</button>
      </header>
      <details className="artifact-source">
        <summary><Code2 size={14} />查看源代码</summary>
        <pre><code>{artifact.content}</code></pre>
      </details>
    </article>
  );
}

function markdownComponents(artifactIndex: { current: number }, artifactPrefix: string, onOpenArtifact: (artifact: Artifact) => void, dark: boolean): Components {
  return {
    code(props) {
      const { className, children: codeChildren } = props;
      const language = /language-([\w-]+)/u.exec(className ?? "")?.[1]?.toLowerCase() ?? "";
      const code = String(codeChildren).replace(/\n$/u, "");
      if (!className && !code.includes("\n")) return <code>{codeChildren}</code>;
      return <CodeBlock language={language} code={code} />;
    },
    a({ href, children: linkChildren }) {
      return <a href={href} target="_blank" rel="noreferrer">{linkChildren}</a>;
    },
    img({ src, alt, title }) {
      return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
    },
    input({ type, checked, disabled }) {
      return <input type={type} checked={checked} disabled={disabled} readOnly />;
    },
    // Keep the render contract explicit: complete documents never enter this
    // component; they become sandboxed Artifact previews in parseRichContent.
    html({ children }) {
      return <span data-html-node={dark ? "dark" : "light"}>{children}</span>;
    }
  };
}

function MarkdownSurface({ content, htmlBubble, artifactPrefix, onOpenArtifact }: { content: string; htmlBubble?: boolean; artifactPrefix: string; onOpenArtifact(artifact: Artifact): void }): ReactNode {
  const dark = useDarkTheme();
  const artifactIndex = useRef(0);
  const components = markdownComponents(artifactIndex, artifactPrefix, onOpenArtifact, dark);
  return (
    <div className={htmlBubble ? "html-bubble" : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeKatex]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function renderSegment(segment: RichContentSegment, index: number, artifactPrefix: string, onOpenArtifact: (artifact: Artifact) => void): ReactNode {
  if (segment.type === "mermaid") return <MermaidBlock key={`mermaid-${index}`} code={segment.content} language={segment.language} />;
  if (segment.type === "artifact") {
    const artifact: Artifact = { ...segment.artifact, id: `${artifactPrefix}-artifact-${index}` };
    return <ArtifactCard key={`artifact-${index}`} artifact={artifact} onOpenArtifact={onOpenArtifact} />;
  }
  return <MarkdownSurface key={`${segment.type}-${index}`} content={segment.content} htmlBubble={segment.type === "html"} artifactPrefix={`${artifactPrefix}-${index}`} onOpenArtifact={onOpenArtifact} />;
}

export function RichContent({ children, streaming, onOpenArtifact, artifactPrefix }: RichContentProps): ReactNode {
  const segments = parseRichContent(children);
  return (
    <div className={`rich-content${streaming ? " is-streaming" : ""}`}>
      {segments.map((segment, index) => renderSegment(segment, index, artifactPrefix, onOpenArtifact))}
    </div>
  );
}
