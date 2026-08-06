import { Check, Code2, Copy, Expand, Eye, EyeOff, FileCode2, ExternalLink, Pause, Play, X } from "lucide-react";
import mermaid from "mermaid";
import { isValidElement, useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import hljs from "highlight.js";
import { artifactSandbox, buildArtifactPreviewSource, DYNAMIC_PREVIEW_ACTIONS, isDynamicArtifact, isFullArtifactDocument, type Artifact, type DynamicPreviewAction } from "../lib/content";
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

type ThemeAnchorRef = { current: HTMLElement | null };

function resolveThemeSource(anchor: HTMLElement | null): HTMLElement {
  return anchor?.closest<HTMLElement>("[data-theme-effective]") ?? document.documentElement;
}

function readThemeTokens(anchor?: HTMLElement | null): ThemeTokens {
  const source = resolveThemeSource(anchor ?? null);
  const computed = getComputedStyle(source);
  const value = (name: string, fallback: string): string => computed.getPropertyValue(name).trim() || fallback;
  const selected = source.dataset.theme;
  const effective = source.dataset.themeEffective;
  const dark = effective ? effective === "dark" : selected === "dark" || (selected !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const tokens = {
    dark,
    surface: value("--surface", dark ? "#172033" : "#ffffff"),
    surfaceRaised: value("--surface-raised", dark ? "#1e293b" : "#f1f5f9"),
    accent: value("--accent", "#4f46e5"),
    accentSoft: value("--accent-soft", dark ? "#25254b" : "#eef2ff"),
    text: value("--text", dark ? "#eef2ff" : "#1e293b"),
    muted: value("--text-muted", dark ? "#a6b1c5" : "#64748b"),
    border: value("--border", dark ? "#334155" : "#e2e8f0")
  };
  return { ...tokens, key: JSON.stringify(tokens) };
}

function useThemeTokens(anchorRef?: ThemeAnchorRef): ThemeTokens {
  const [tokens, setTokens] = useState<ThemeTokens>(() => readThemeTokens(anchorRef?.current));
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => {
      const next = readThemeTokens(anchorRef?.current);
      setTokens((current) => current.key === next.key ? current : next);
    };
    update();
    const observer = new MutationObserver(update);
    const source = resolveThemeSource(anchorRef?.current ?? null);
    const previewRoot = source.closest<HTMLElement>(".theme-preview");
    if (source === document.documentElement) {
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-effective", "data-theme-preset", "data-theme-custom"] });
      observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    } else {
      observer.observe(previewRoot ?? source, { attributes: true, childList: true, characterData: true, subtree: true });
    }
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, [anchorRef]);
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

function RichVideo({ src, poster, title, children }: { src?: string; poster?: string; title?: string; children?: ReactNode }): ReactNode {
  if (!src && !children) return null;
  return (
    <video className="rich-media-video" controls preload="metadata" poster={poster} title={title}>
      {src && <source src={src} />}
      {children}
    </video>
  );
}

function RichAudio({ src, title, children }: { src?: string; title?: string; children?: ReactNode }): ReactNode {
  if (!src && !children) return null;
  return (
    <audio className="rich-media-audio" controls preload="metadata" title={title}>
      {src && <source src={src} />}
      {children}
    </audio>
  );
}

function MermaidBlock({ code, language }: { code: string; language: string }): ReactNode {
  const id = useId().replaceAll(":", "");
  const blockRef = useRef<HTMLDivElement>(null);
  const tokens = useThemeTokens(blockRef);
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
      <div className="mermaid-block" data-mermaid-language={language} ref={blockRef}>
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
  const [previewPaused, setPreviewPaused] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewObserverRef = useRef<ResizeObserver | undefined>(undefined);
  const dynamic = isDynamicArtifact(artifact);
  const previewSource = buildArtifactPreviewSource(artifact);
  const fullPage = isFullArtifactDocument(artifact);

  function postPreviewAction(action: DynamicPreviewAction): void {
    previewFrameRef.current?.contentWindow?.postMessage({ action }, "*");
  }

  useEffect(() => {
    if (!previewOpen) {
      previewObserverRef.current?.disconnect();
      previewObserverRef.current = undefined;
    }
    return () => previewObserverRef.current?.disconnect();
  }, [previewOpen]);

  useEffect(() => {
    if (!dynamic || !previewOpen || typeof IntersectionObserver === "undefined" || !cardRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      if (entry.isIntersecting) {
        postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.resume);
        setPreviewPaused(false);
      } else {
        postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.pause);
        setPreviewPaused(true);
      }
    }, { threshold: 0.01 });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [dynamic, previewOpen]);

  useEffect(() => () => {
    if (dynamic) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.destroy);
  }, [dynamic]);

  function resizePreviewFrame(iframe: HTMLIFrameElement): void {
    if (fullPage) {
      const viewportHeight = typeof window === "undefined" ? 720 : window.innerHeight || 720;
      iframe.style.height = `${Math.min(720, Math.max(420, Math.round(viewportHeight * 0.62)))}px`;
      return;
    }
    try {
      const frameDocument = iframe.contentDocument;
      const height = Math.max(frameDocument?.body?.scrollHeight ?? 0, frameDocument?.documentElement?.scrollHeight ?? 0, 220);
      iframe.style.height = `${Math.min(height, 720)}px`;
    } catch {
      iframe.style.height = "520px";
    }
  }

  function handlePreviewLoad(event: SyntheticEvent<HTMLIFrameElement>): void {
    const iframe = event.currentTarget;
    previewFrameRef.current = iframe;
    resizePreviewFrame(iframe);
    if (previewPaused) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.pause);
    previewObserverRef.current?.disconnect();
    if (fullPage || typeof ResizeObserver === "undefined") return;
    try {
      const frameDocument = iframe.contentDocument;
      if (!frameDocument?.body) return;
      const observer = new ResizeObserver(() => resizePreviewFrame(iframe));
      observer.observe(frameDocument.body);
      if (frameDocument.documentElement) observer.observe(frameDocument.documentElement);
      previewObserverRef.current = observer;
    } catch {
      // Sandboxed frames may deny document observation; the load-time height remains valid.
    }
  }

  function togglePreview(): void {
    if (previewOpen) {
      if (dynamic) postPreviewAction(DYNAMIC_PREVIEW_ACTIONS.destroy);
      setPreviewOpen(false);
      setPreviewPaused(false);
      return;
    }
    setPreviewPaused(false);
    setPreviewOpen(true);
  }

  return (
    <article className={`artifact-card${dynamic ? " is-dynamic" : ""}`} ref={cardRef}>
      <header className="artifact-card-header">
        <span><FileCode2 size={15} /><strong>{artifact.title}</strong><small>{artifact.language.toUpperCase()}</small>{dynamic && <small className="artifact-dynamic-badge">动态</small>}</span>
        <div className="artifact-card-actions">
          <button className="secondary-button artifact-open-button" type="button" onClick={togglePreview}>{previewOpen ? <EyeOff size={14} /> : <Eye size={14} />}{previewOpen ? "隐藏预览" : "显示预览"}</button>
          {dynamic && previewOpen && <button className="secondary-button artifact-open-button" type="button" aria-pressed={previewPaused} onClick={() => { postPreviewAction(previewPaused ? DYNAMIC_PREVIEW_ACTIONS.resume : DYNAMIC_PREVIEW_ACTIONS.pause); setPreviewPaused((current) => !current); }}>{previewPaused ? <Play size={14} /> : <Pause size={14} />}{previewPaused ? "继续" : "暂停"}</button>}
          <button className="secondary-button artifact-open-button" type="button" onClick={() => onOpenArtifact(artifact)}><ExternalLink size={14} />打开预览</button>
        </div>
      </header>
      {previewOpen && <div className="artifact-inline-preview"><iframe ref={previewFrameRef} title={`${artifact.title}内嵌预览`} sandbox={artifactSandbox(artifact)} referrerPolicy="no-referrer" srcDoc={previewSource} onLoad={handlePreviewLoad} /></div>}
      <details className="artifact-source">
        <summary><Code2 size={14} />查看源代码</summary>
        <pre><code>{artifact.content}</code></pre>
      </details>
    </article>
  );
}

const richSanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "style"],
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

function markdownComponents(artifactIndex: { current: number }, artifactPrefix: string, onOpenArtifact: (artifact: Artifact) => void, dark: boolean, htmlBubble = false, onHtmlAction?: (text: string) => void): Components {
  function childrenText(value: ReactNode): string {
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map((item) => childrenText(item)).join("");
    if (isValidElement(value)) return childrenText((value.props as { children?: ReactNode }).children);
    return "";
  }

  function explicitHtmlAction(props: Record<string, unknown>, children: ReactNode, allowImplicit: boolean): string {
    for (const key of ["data-send", "data-prompt", "data-message"]) {
      const value = props[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
    }
    if (allowImplicit) {
      const labelled = [props["aria-label"], props.title].find((value) => typeof value === "string" && value.trim());
      if (typeof labelled === "string") return labelled.trim().slice(0, 500);
      const text = childrenText(children).replace(/\s+/gu, " ").trim();
      if (text) return text.slice(0, 500);
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
    video({ src, poster, title, children }) {
      return <RichVideo src={src} poster={poster} title={title}>{children}</RichVideo>;
    },
    audio({ src, title, children }) {
      return <RichAudio src={src} title={title}>{children}</RichAudio>;
    },
    input({ type, checked, disabled }) {
      return <input type={type} checked={checked} disabled={disabled} readOnly />;
    },
    button(props) {
      const { children, className, ...buttonProps } = props;
      const action = explicitHtmlAction(buttonProps as Record<string, unknown>, children, Boolean(htmlBubble));
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

function htmlBubbleScopeClass(prefix: string): string {
  let hash = 2166136261;
  for (const character of prefix) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `html-bubble-scope-${(hash >>> 0).toString(36)}`;
}

function MarkdownSurface({ content, htmlBubble, artifactPrefix, onOpenArtifact, onHtmlAction }: { content: string; htmlBubble?: boolean; artifactPrefix: string; onOpenArtifact(artifact: Artifact): void; onHtmlAction?: (text: string) => void }): ReactNode {
  const dark = useThemeTokens().dark;
  const artifactIndex = useRef(0);
  const components = markdownComponents(artifactIndex, artifactPrefix, onOpenArtifact, dark, htmlBubble, onHtmlAction);
  const scopeClass = htmlBubble ? htmlBubbleScopeClass(artifactPrefix) : "";
  const scopeSelector = scopeClass ? `.${scopeClass}` : "";
  return (
    <div className={htmlBubble ? `html-bubble ${scopeClass}` : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, [sanitizeRichHtmlTree, { allowStyleTags: Boolean(htmlBubble), scopeSelector }], [rehypeSanitize, richSanitizeSchema], rehypeKatex]} components={components}>
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
