import { Check, Copy, Expand, FileCode2 } from "lucide-react";
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

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
  fontFamily: "Inter, Segoe UI, sans-serif"
});

interface RichContentProps {
  children: string;
  streaming?: boolean;
  onOpenArtifact(artifact: Artifact): void;
  artifactPrefix: string;
}

function CopyButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button className="icon-button code-action" type="button" title={copied ? "已复制" : "复制代码"} aria-label={copied ? "已复制" : "复制代码"} onClick={copy}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function MermaidBlock({ code }: { code: string }): ReactNode {
  const id = useId().replaceAll(":", "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
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
  }, [code, id]);

  useEffect(() => {
    if (!expanded) return;
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  if (error) return <pre className="render-error">{error}</pre>;
  return (
    <>
      <div className="mermaid-block">
        <button className="icon-button mermaid-expand" type="button" title="放大图表" aria-label="放大图表" onClick={() => setExpanded(true)}>
          <Expand size={16} />
        </button>
        <button
          type="button"
          className="mermaid-canvas"
          aria-label="放大 Mermaid 图表"
          onClick={() => setExpanded(true)}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      {expanded && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setExpanded(false)}>
          <div className="diagram-modal" role="dialog" aria-modal="true" aria-label="放大的 Mermaid 图表" onMouseDown={(event) => event.stopPropagation()}>
            <button className="icon-button modal-close" type="button" title="关闭图表" aria-label="关闭图表" onClick={() => setExpanded(false)}>
              <span aria-hidden="true">x</span>
            </button>
            <div className="expanded-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </div>
      )}
    </>
  );
}

function CodeBlock({
  language,
  code,
  artifact,
  onOpenArtifact
}: {
  language: string;
  code: string;
  artifact?: Artifact;
  onOpenArtifact(artifact: Artifact): void;
}): ReactNode {
  if (language === "mermaid") return <MermaidBlock code={code} />;
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language }).value
    : hljs.highlightAuto(code).value;
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language || "text"}</span>
        <div className="code-actions">
          {artifact && (
            <button className="icon-button code-action" type="button" title="打开预览" aria-label="打开预览" onClick={() => onOpenArtifact(artifact)}>
              <FileCode2 size={15} />
            </button>
          )}
          <CopyButton text={code} />
        </div>
      </div>
      <pre><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
    </div>
  );
}

export function RichContent({ children, streaming, onOpenArtifact, artifactPrefix }: RichContentProps): ReactNode {
  const artifactIndex = useRef(0);
  artifactIndex.current = 0;
  const components: Components = {
    code(props) {
      const { className, children: codeChildren } = props;
      const language = /language-([\w-]+)/u.exec(className ?? "")?.[1]?.toLowerCase() ?? "";
      const code = String(codeChildren).replace(/\n$/u, "");
      if (!className) return <code>{codeChildren}</code>;
      const currentIndex = artifactIndex.current++;
      const artifact = language === "html" || language === "svg"
        ? {
            id: `${artifactPrefix}-artifact-${currentIndex}`,
            title: language === "svg" ? "SVG 预览" : "HTML 预览",
            language,
            content: code
          }
        : undefined;
      return <CodeBlock language={language} code={code} artifact={artifact} onOpenArtifact={onOpenArtifact} />;
    },
    a({ href, children: linkChildren }) {
      return <a href={href} target="_blank" rel="noreferrer">{linkChildren}</a>;
    }
  };

  return (
    <div className={`rich-content${streaming ? " is-streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeKatex]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
