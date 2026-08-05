import { Check, Code2, Copy, Expand, Eye, EyeOff, FileCode2, ExternalLink, X } from "lucide-react";
import mermaid from "mermaid";
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import hljs from "highlight.js";
import { artifactSandbox, buildArtifactPreviewSource, isFullArtifactDocument, type Artifact } from "../lib/content";
import { normalizeMermaidSource, parseRichContent, type RichContentSegment } from "../lib/content-pipeline";
import { sanitizeRichHtmlTree } from "../lib/html-sanitize";

interface RichContentProps {
  children: string;
  streaming?: boolean;
  onOpenArtifact(artifact: Artifact): void;
  onHtmlAction?: (text: string) => void;
  artifactPrefix: string;
}

interface ThemeTokens {
  dark: boolean;
  key: string;
  surface: string;
  surfaceRaised: string;
  accent: string;
  accentSoft: string;
  text: string;
  muted: string;
  border: string;
}

function readThemeTokens(): ThemeTokens {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const value = (name: string, fallback: string): string => computed.getPropertyValue(name).trim() || fallback;
  const selected = root.dataset.theme;
  const dark = selected === "dark" || (selected !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const tokens = {
    dark,
    surface: value("--surface", dark ? "#172033" : "#ffffff"),
    surfaceRaised: value("--surface-raised", dark ? "#1e293b" : "#f1f5f9"),
    accent: value("--accent", dark ? "#818cf8" : "#6366f1"),
    accentSoft: value("--accent-soft", dark ? "#25254b" : "#eef2ff"),
    text: value("--text", dark ? "#eef2ff" : "#1e293b"),
    muted: value("--text-muted", dark ? "#a6b1c5" : "#64748b"),
    border: value("--border", dark ? "#334155" : "#e2e8f0")
  };
  return { ...tokens, key: JSON.stringify(tokens) };
}

function useThemeTokens(): ThemeTokens {
  const [tokens, setTokens] = useState<ThemeTokens>(() => readThemeTokens());
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => {
      const next = readThemeTokens();
      setTokens((current) => current.key === next.key ? current : next);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return tokens;
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

function RichImage({ src, alt, title }: { src?: string; alt?: string; title?: string }): ReactNode {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  if (!src) return null;
  return (
    <>
      <button className="rich-image-button" type="button" aria-label={alt ? `放大图片：${alt}` : "放大图片"} onClick={() => setExpanded(true)}>
        <img src={src} alt={alt ?? ""} title={title} loading="lazy" />
      </button>
      {expanded && (
        <div className="modal-backdrop image-lightbox" role="presentation" onMouseDown={() => setExpanded(false)}>
          <div className="image-lightbox-content" role="dialog" aria-modal="true" aria-label={alt ? `图片预览：${alt}` : "图片预览"} onMouseDown={(event) => event.stopPropagation()}>
            <button className="icon-button modal-close" type="button" title="关闭图片" aria-label="关闭图片" onClick={() => setExpanded(false)}><X size={17} /></button>
            <img src={src} alt={alt ?? ""} title={title} />
          </div>
        </div>
      )}
    </>
  );
}

function MermaidBlock({ code, language }: { code: string; language: string }): ReactNode {
  const id = useId().replaceAll(":", "");
  const tokens = useThemeTokens();
  const source = normalizeMermaidSource(code, language);
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
      theme: tokens.dark ? "dark" : "neutral",
      themeVariables: {
        background: tokens.surface,
        primaryColor: tokens.accentSoft,
        primaryTextColor: tokens.text,
        primaryBorderColor: tokens.accent,
        lineColor: tokens.muted,
        secondaryColor: tokens.surfaceRaised,
        secondaryTextColor: tokens.text,
        tertiaryColor: tokens.surface,
        tertiaryTextColor: tokens.text,
        clusterBkg: tokens.surfaceRaised,
        clusterBorder: tokens.border
      },
      fontFamily: "Inter, Segoe UI, Microsoft YaHei, sans-serif"
    });
    void mermaid
      .render(`mermaid-${id}`, source)
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [source, id, tokens.key]);

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
         <div className="mermaid-toolbar"><span>{language === "mermaid" ? "Mermaid" : language}</span><div className="mermaid-actions"><CopyButton text={source} /><button className="icon-button" type="button" title="放大图表" aria-label="放大图表" onClick={() => setExpanded(true)}><Expand size={15} /></button></div></div>
         <button type="button" className="mermaid-canvas" aria-label="放大 Mermaid 图表" aria-busy={!svg} onClick={() => setExpanded(true)} dangerouslySetInnerHTML={{ __html: svg }} />
         <details className="mermaid-source"><summary>查看源码</summary><pre><code>{source}</code></pre></details>
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
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewSource = buildArtifactPreviewSource(artifact);
  const fullPage = isFullArtifactDocument(artifact);

  function resizePreview(event: SyntheticEvent<HTMLIFrameElement>): void {
    if (fullPage) return;
    try {
      const document = event.currentTarget.contentDocument;
      const height = Math.max(document?.body?.scrollHeight ?? 0, document?.documentElement?.scrollHeight ?? 0, 220);
      event.currentTarget.style.height = `${Math.min(height, 720)}px`;
    } catch {
      event.currentTarget.style.height = "280px";
    }
  }

  return (
    <article className="artifact-card">
      <header className="artifact-card-header">
        <span><FileCode2 size={15} /><strong>{artifact.title}</strong><small>{artifact.language.toUpperCase()}</small></span>
        <div className="artifact-card-actions">
          <button className="secondary-button artifact-open-button" type="button" onClick={() => setPreviewOpen((current) => !current)}>{previewOpen ? <EyeOff size={14} /> : <Eye size={14} />}{previewOpen ? "隐藏预览" : "显示预览"}</button>
          <button className="secondary-button artifact-open-button" type="button" onClick={() => onOpenArtifact(artifact)}><ExternalLink size={14} />打开预览</button>
        </div>
      </header>
      {previewOpen && <div className="artifact-inline-preview"><iframe title={`${artifact.title}内嵌预览`} sandbox={artifactSandbox(artifact)} referrerPolicy="no-referrer" srcDoc={previewSource} onLoad={resizePreview} /></div>}
      <details className="artifact-source">
        <summary><Code2 size={14} />查看源代码</summary>
        <pre><code>{artifact.content}</code></pre>
      </details>
    </article>
  );
}

const richSanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      ["className", /^[a-zA-Z0-9_:/.[\]%-]{1,96}$/u],
      ["style", /^[^<>]{0,5000}$/u],
      ["data-send", /^[^<>]{0,500}$/u],
      ["data-prompt", /^[^<>]{0,500}$/u],
      ["data-message", /^[^<>]{0,500}$/u]
    ]
  }
};

function markdownComponents(artifactIndex: { current: number }, artifactPrefix: string, onOpenArtifact: (artifact: Artifact) => void, dark: boolean, onHtmlAction?: (text: string) => void): Components {
  function explicitHtmlAction(props: Record<string, unknown>): string {
    for (const key of ["data-send", "data-prompt", "data-message"]) {
      const value = props[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
    }
    return "";
  }

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
      return <RichImage src={src} alt={alt} title={title} />;
    },
    input({ type, checked, disabled }) {
      return <input type={type} checked={checked} disabled={disabled} readOnly />;
    },
    button(props) {
      const { children, className, ...buttonProps } = props;
      const action = explicitHtmlAction(buttonProps as Record<string, unknown>);
      const classes = [typeof className === "string" ? className : "", action ? "html-action-button" : ""].filter(Boolean).join(" ");
      return <button {...buttonProps} className={classes || undefined} type="button" onClick={action && onHtmlAction ? () => onHtmlAction(action) : undefined}>{children}</button>;
    },
    // Keep the render contract explicit: complete documents never enter this
    // component; they become sandboxed Artifact previews in parseRichContent.
    html({ children }) {
      return <span data-html-node={dark ? "dark" : "light"}>{children}</span>;
    }
  };
}

function MarkdownSurface({ content, htmlBubble, artifactPrefix, onOpenArtifact, onHtmlAction }: { content: string; htmlBubble?: boolean; artifactPrefix: string; onOpenArtifact(artifact: Artifact): void; onHtmlAction?: (text: string) => void }): ReactNode {
  const dark = useThemeTokens().dark;
  const artifactIndex = useRef(0);
  const components = markdownComponents(artifactIndex, artifactPrefix, onOpenArtifact, dark, onHtmlAction);
  return (
    <div className={htmlBubble ? "html-bubble" : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, sanitizeRichHtmlTree, [rehypeSanitize, richSanitizeSchema], rehypeKatex]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function renderSegment(segment: RichContentSegment, index: number, artifactPrefix: string, onOpenArtifact: (artifact: Artifact) => void, onHtmlAction?: (text: string) => void): ReactNode {
  if (segment.type === "mermaid") return <MermaidBlock key={`mermaid-${index}`} code={segment.content} language={segment.language} />;
  if (segment.type === "artifact") {
    const artifact: Artifact = { ...segment.artifact, id: `${artifactPrefix}-artifact-${index}` };
    return <ArtifactCard key={`artifact-${index}`} artifact={artifact} onOpenArtifact={onOpenArtifact} />;
  }
  return <MarkdownSurface key={`${segment.type}-${index}`} content={segment.content} htmlBubble={segment.type === "html"} artifactPrefix={`${artifactPrefix}-${index}`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction} />;
}

export function RichContent({ children, streaming, onOpenArtifact, onHtmlAction, artifactPrefix }: RichContentProps): ReactNode {
  const segments = parseRichContent(children, { isStreaming: Boolean(streaming) });
  return (
    <div className={`rich-content${streaming ? " is-streaming" : ""}`}>
      {segments.map((segment, index) => renderSegment(segment, index, artifactPrefix, onOpenArtifact, onHtmlAction))}
    </div>
  );
}
