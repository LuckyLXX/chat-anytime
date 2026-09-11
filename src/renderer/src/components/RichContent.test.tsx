import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { workspaceFilePreviewUrl } from "../../../shared/protocol";
import { MarkdownPreviewContent, RichContent } from "./RichContent";

describe("RichContent preview rendering", () => {
  it("does not emit KaTeX markup for documents without math", () => {
    // 中文文档里的 ${sessionId} / $ARGUMENTS 曾被当 LaTeX 解析（性能 + 警告刷屏）。
    const markup = renderToStaticMarkup(
      <MarkdownPreviewContent
        content={"启动参数是 $ARGUMENTS，会话 id 是 ${sessionId}，预算 $100 到 $200 元。"}
        artifactPrefix="preview-doc"
        onOpenArtifact={() => undefined}
      />
    );
    expect(markup).not.toContain("katex");
    expect(markup).not.toContain("math-inline");
    // 原文照常显示（不做任何吞掉）
    expect(markup).toContain("$ARGUMENTS");
  });

  it("renders real LaTeX through KaTeX when present", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreviewContent content={"质能方程 $E = mc^2$ 很简洁。"} artifactPrefix="preview-math" onOpenArtifact={() => undefined} />
    );
    expect(markup).toContain("katex");
  });

  it("renders fences without a language as plain text instead of highlightAuto", () => {
    // highlightAuto 要遍历 192 种语法（150 行无语言围栏实测 703ms），改为纯文本输出。
    const code = Array.from({ length: 20 }, (_, i) => `const value${i} = ${i}; // 注释`).join("\n");
    const markup = renderToStaticMarkup(
      <MarkdownPreviewContent content={`\`\`\`\n${code}\n\`\`\``} artifactPrefix="preview-plain" onOpenArtifact={() => undefined} />
    );
    expect(markup).toContain("code-block");
    // 无语言时工具条显示 text，且不带任何 hljs 高亮 span。
    expect(markup).toContain("<span>text</span>");
    expect(markup).not.toContain("hljs");
  });

  it("still highlights code when a known language is declared", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreviewContent content={"```ts\nconst value = 1;\n```"} artifactPrefix="preview-ts" onOpenArtifact={() => undefined} />
    );
    expect(markup).toContain("hljs-keyword");
    expect(markup).toContain("<span>ts</span>");
  });

  it("injects heading ids for the outline and keeps them stable", () => {
    const content = "# 第一章\n\n正文\n\n## 小节\n\n### 第一章\n";
    const markup = renderToStaticMarkup(<MarkdownPreviewContent content={content} artifactPrefix="preview-outline" onOpenArtifact={() => undefined} />);
    expect(markup).toContain('<h1 id="第一章">');
    expect(markup).toContain('<h2 id="小节">');
    // 重名标题追加数字后缀（与 extractMarkdownHeadings 的 slugger 一致）。
    expect(markup).toContain('<h3 id="第一章-1">');
  });

  it("keeps heading ids aligned after the component re-renders", () => {
    // 回归（demo 冒烟实测发现）：早期实现用「闭包内计数器」按出现顺序分配 id，
    // 而 markdownComponents 被 useMemo 缓存、计数器会跨渲染持续累加，于是二次
    // 渲染后除个别标题外全部拿不到 id。现按 react-markdown 的 node.position
    // 行号查表，重复渲染必须每个标题都有稳定 id。
    const content = "# 标题甲\n\n## 标题乙\n\n### 标题丙\n\n#### 标题丁\n";
    const render = () => renderToStaticMarkup(<MarkdownPreviewContent content={content} artifactPrefix="preview-stable" onOpenArtifact={() => undefined} />);
    const first = render();
    const second = render();
    expect(first).toContain('<h1 id="标题甲">');
    expect(first).toContain('<h2 id="标题乙">');
    expect(first).toContain('<h3 id="标题丙">');
    expect(first).toContain('<h4 id="标题丁">');
    // 同一份内容重复渲染，id 序列完全一致（无漂移、无丢失）。
    expect(second).toBe(first);
  });

  it("assigns ids across segmented documents without drift", () => {
    // parseRichContent 会把含围栏 artifact 的文档切成多段，每段各自渲染。
    // 段内行号 → 全文条目对齐后，两段里的标题都能拿到正确 id。
    const content = ["# 开头", "", "正文", "", "```mermaid", "flowchart LR", " A --> B", "```", "", "## 图表之后", "", "### 结尾"].join("\n");
    const markup = renderToStaticMarkup(<MarkdownPreviewContent content={content} artifactPrefix="preview-seg" onOpenArtifact={() => undefined} />);
    expect(markup).toContain('id="开头"');
    expect(markup).toContain('id="图表之后"');
    expect(markup).toContain('id="结尾"');
  });

  it("does not inject heading ids when no outline is provided (chat bubbles)", () => {
    const markup = renderToStaticMarkup(
      <RichContent artifactPrefix="message-no-outline" onOpenArtifact={() => undefined}>{"# 气泡标题"}</RichContent>
    );
    expect(markup).toContain("气泡标题");
    expect(markup).not.toContain('id="气泡标题"');
  });

  it("resolves preview images against the markdown file directory", () => {
    const workspace = "D:\\\\workspace\\\\PiDesktop";
    const markup = renderToStaticMarkup(
      <MarkdownPreviewContent content={"![fig](../assets/fig.png)"} markdownPath="docs/guide/note.md" workspace={workspace} artifactPrefix="preview-img" onOpenArtifact={() => undefined} />
    );
    expect(markup).toContain(`src="${workspaceFilePreviewUrl(workspace, "docs/assets/fig.png")}"`);
  });
});

describe("RichContent dynamic bubbles", () => {
  it("renders dynamic assistant HTML directly in the chat bubble with an inert script", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-1"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><canvas id="stage"></canvas><script>requestAnimationFrame(() => {});</script></div></assistant_html>'}
      />
    );

    expect(markup).toContain("html-bubble");
    expect(markup).toContain('type="application/x-pidesktop-bubble-script"');
    expect(markup).not.toContain('class="artifact-card"');
  });

  it("carries the sanitized script source on data-script-source for the bubble runtime", () => {
    // Regression: the sanitizer never wrote dataScriptSource onto the script
    // node, so DynamicHtmlBubble's dataset.scriptSource read came back empty
    // and bubble scripts never executed despite passing the deny-regex gate.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-script-src"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><script>container.querySelector("canvas");</script></div></assistant_html>'}
      />
    );
    expect(markup).toContain('data-script-source="container.querySelector(&quot;canvas&quot;);"');
  });

  it("keeps file URLs on images inside assistant HTML bubbles", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-file-image"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><img src="file:///D:/workspace/PiDesktop/poster.png" alt="poster" /></div></assistant_html>'}
      />
    );

    expect(markup).toContain('src="file:///D:/workspace/PiDesktop/poster.png"');
    expect(markup).toContain('alt="poster"');
  });

  it("maps workspace-relative image paths onto the preview protocol", () => {
    const workspace = "D:\\默认工作区";
    const bubble = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-relative-image"
        workspace={workspace}
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><img src="outputs/fox.png" alt="fox" /></div></assistant_html>'}
      />
    );
    expect(bubble).toContain(`src="${workspaceFilePreviewUrl(workspace, "outputs/fox.png")}"`);

    const markdown = renderToStaticMarkup(
      <RichContent artifactPrefix="message-relative-markdown" workspace={workspace} onOpenArtifact={() => undefined}>
        {"![fox](outputs/fox.png)"}
      </RichContent>
    );
    expect(markdown).toContain(`src="${workspaceFilePreviewUrl(workspace, "outputs/fox.png")}"`);
  });

  it("leaves relative image paths untouched without a workspace context", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-relative-no-workspace"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><img src="outputs/fox.png" alt="fox" /></div></assistant_html>'}
      />
    );
    expect(markup).toContain('src="outputs/fox.png"');
  });

  it("renders unclosed assistant HTML as lightweight markdown while streaming", () => {
    // Before the assistant_html closing tag arrives the segment is unclosed and
    // must NOT enter the heavy DynamicHtmlBubble pipeline (rehypeRaw + double
    // sanitize) on every streaming frame. It renders as lightweight markdown;
    // the interactive bubble mounts only once the closing tag lands.
    const markup = renderToStaticMarkup(
      <RichContent
        streaming
        artifactPrefix="message-stream"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><canvas id="stage"></canvas><script>requestAnimationFrame(() => {});</script></div>'}
      />
    );
    expect(markup).not.toContain('type="application/x-pidesktop-bubble-script"');
  });

  it("renders indented HTML spans as elements, not a TEXT code block", () => {
    // Regression: assistant_html content with 4-space-indented <span> rows
    // after a blank line was being parsed by CommonMark as an indented code
    // block, producing a "TEXT" panel with escaped markup.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-spans"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div>\n\n    <span class="lg-spark s1">alpha</span>\n    <span class="lg-spark s2">beta</span>\n</div></assistant_html>'}
      />
    );
    expect(markup).not.toContain("<pre>");
    expect(markup).not.toContain("<code>");
    expect(markup).toContain('<span class="lg-spark s1"');
    expect(markup).toContain("alpha");
    expect(markup).toContain("beta");
  });

  it("preserves SVG gradient elements and keyframe animations inside bubbles", () => {
    // Regression: the heart bubble uses SVG <linearGradient>/<stop> and CSS
    // @keyframes. Both were silently stripped by the sanitizer and CSS pipeline.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-heart"
        onOpenArtifact={() => undefined}
        children={'<assistant_html>\n<style>\n@keyframes lg-heartbeat { 0%,100% { transform: scale(1); } 12% { transform: scale(1.16); } }\n.lg-heart-box { animation: lg-heartbeat 1.6s ease-in-out infinite; }\n</style>\n<div class="lg-heart-wrap">\n  <svg class="lg-heart-svg" viewBox="0 0 100 100">\n    <defs>\n      <linearGradient id="lgGrad" x1="0" y1="0" x2="0" y2="1">\n        <stop offset="0%" stop-color="#ff8fa3"></stop>\n        <stop offset="100%" stop-color="#c2253f"></stop>\n      </linearGradient>\n    </defs>\n    <path d="M50,88 C22,68 2,48 2,28" fill="url(#lgGrad)"></path>\n  </svg>\n</div>\n</assistant_html>'}
      />
    );
    expect(markup).not.toContain("<pre>");
    expect(markup).not.toContain("<code>");
    expect(markup).toContain("<svg");
    expect(markup).toContain("linearGradient");
    expect(markup).toContain("<stop");
    expect(markup).toContain("<path");
    // CSS @keyframes are sanitized via an offscreen stylesheet which requires
    // a real CSSOM; in the node test environment that path returns "" so the
    // style node is dropped. We assert the structure is preserved (no code
    // block) and verify keyframe sanitization in the dedicated sanitizer test.
    expect(markup).not.toContain("expression(");
  });

  it("strips dangerous attributes from SVG inside assistant HTML", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-svg-safe"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" onclick="alert(1)"></circle></svg></assistant_html>'}
      />
    );
    expect(markup).toContain("<circle");
    expect(markup).not.toContain("onclick");
  });

  it("keeps element ids unprefixed so CSS #id selectors and url(#id) references resolve", () => {
    // Regression: hast-util-sanitize's default clobber protection rewrites
    // id="badge" to id="user-content-badge", which silently broke every CSS
    // #id selector and SVG url(#id) reference inside bubbles.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-id-keep"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><span id="badge">ok</span></div></assistant_html>'}
      />
    );
    expect(markup).toContain('id="badge"');
    expect(markup).not.toContain("user-content-");
  });

  it("renders data-send buttons, canvas and structural tags as real elements", () => {
    // Regression: none of these tags were in the sanitize schema's tagNames,
    // so the tags were stripped and only their text content survived —
    // data-send quick replies rendered as plain text and Canvas animations
    // vanished entirely.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-structure"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><header class="card-head">标题</header><canvas id="stage" width="120" height="60"></canvas><button data-send="继续">下一步</button><figure><figcaption>说明</figcaption></figure></div></assistant_html>'}
      />
    );
    expect(markup).toContain('<header class="card-head"');
    expect(markup).toContain('<canvas id="stage" width="120" height="60"');
    expect(markup).toContain('class="html-action-button"');
    expect(markup).toContain('data-send="继续"');
    expect(markup).toContain("<figure>");
    expect(markup).toContain("<figcaption>");
  });

  it("preserves SVG filter, mask and clip-path definitions with url() references", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-svg-fx"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><svg viewBox="0 0 100 100"><defs><filter id="blurFx"><feGaussianBlur stdDeviation="3"></feGaussianBlur></filter><clipPath id="clipRound"><circle cx="50" cy="50" r="40"></circle></clipPath></defs><rect x="10" y="10" width="80" height="80" filter="url(#blurFx)" clip-path="url(#clipRound)"></rect></svg></assistant_html>'}
      />
    );
    expect(markup).toContain("<filter");
    expect(markup).toContain("feGaussianBlur");
    expect(markup).toContain('stdDeviation="3"');
    expect(markup).toContain("<clipPath");
    expect(markup).toContain('filter="url(#blurFx)"');
    expect(markup).toContain('clip-path="url(#clipRound)"');
  });

  it("compresses blank lines while streaming an unclosed bubble", () => {
    // dsh-raw-html v6.38 lesson: a blank line inside the card ends the
    // CommonMark HTML block, so indented follow-up lines would be parsed as
    // a code block (structure tearing / visible source). Compression keeps
    // the whole partial card inside a single HTML block.
    const markup = renderToStaticMarkup(
      <RichContent
        streaming
        artifactPrefix="message-stream-blank"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div>\n\n    <span class="s1">alpha</span>\n    <span class="s2">beta</span>\n</div>'}
      />
    );
    expect(markup).not.toContain("<pre>");
    expect(markup).not.toContain("<code>");
    expect(markup).toContain('<span class="s1"');
    expect(markup).toContain("beta");
  });
});
