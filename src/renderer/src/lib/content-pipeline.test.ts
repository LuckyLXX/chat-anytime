import { describe, expect, it } from "vitest";
import { alignSegmentHeadings, createHeadingSlugger, extractMarkdownHeadings, findStableCutoff, hasMathSyntax, normalizeMermaidSource, normalizeRichContent, parseRichContent } from "./content-pipeline";

describe("hasMathSyntax", () => {
  it("detects real LaTeX in display and inline math", () => {
    for (const source of [
      "$E = mc^2$",
      "$E=mc^2$",
      "$$E=mc^2$$",
      String.raw`$$\int_0^1 x dx$$`,
      String.raw`$\frac{a}{b}$`,
      String.raw`$\alpha + \beta$`,
      String.raw`$\sqrt{2}$`,
      String.raw`$x \to \infty$`,
      "$x^2+y^2=z^2$",
      "前文说明\n\n$$\\sum_{i=1}^n i$$\n\n后文"
    ]) {
      expect(hasMathSyntax(source), source).toBe(true);
    }
  });

  it("ignores dollar signs that come from scripts, prices and code", () => {
    // 中文文档最常见的三类误报：shell 变量、模板字符串、价格区间。
    for (const source of [
      "$ARGUMENTS",
      "${sessionId}",
      "价格 $100 到 $200 元",
      "导出到 $HOME/.config 目录",
      "没有美元符号的普通中文",
      "a $ b $$ c",
      // 数学特征不足：单个变量名不算公式（计划已知取舍）。
      "$x$",
      "$foo$"
    ]) {
      expect(hasMathSyntax(source), source).toBe(false);
    }
  });

  it("skips fenced and inline code", () => {
    expect(hasMathSyntax("```\n$x^2=4$\n```")).toBe(false);
    expect(hasMathSyntax("~~~text\n$a = b$\n~~~")).toBe(false);
    expect(hasMathSyntax("行内 `$x^2=4$` 是代码")).toBe(false);
  });

  it("still detects math alongside unrelated dollar signs", () => {
    expect(hasMathSyntax("价格 $100 到 $200 元，但 $x^2=4$ 是数学")).toBe(true);
    expect(hasMathSyntax("$ARGUMENTS 与 $\\frac{1}{2}$ 混排")).toBe(true);
  });

  it("does not pair dollar signs across distant prose", () => {
    // 配对内容超过候选上限（含整段正文）时直接否决，避免整篇误开 KaTeX。
    const long = `价格 $100，${'这是一段很长的中文正文。'.repeat(40)} 编号 $200`;
    expect(hasMathSyntax(long)).toBe(false);
  });
});

describe("extractMarkdownHeadings", () => {
  it("collects h1-h6 with depth, display text, source line and stable slugs", () => {
    const headings = extractMarkdownHeadings("# 标题一\n\n### 深一层\n\n## 标题一\n");
    expect(headings).toEqual([
      { depth: 1, text: "标题一", index: 0, id: "标题一", line: 1 },
      { depth: 3, text: "深一层", index: 1, id: "深一层", line: 3 },
      // 重名追加数字后缀（GitHub slugger 同构）
      { depth: 2, text: "标题一", index: 2, id: "标题一-1", line: 5 }
    ]);
  });

  it("ignores `#` inside fenced code blocks", () => {
    const headings = extractMarkdownHeadings("# 真标题\n\n```bash\n# 这是注释不是标题\n```\n\n~~~\n## 也不是\n~~~\n");
    expect(headings.map((heading) => heading.text)).toEqual(["真标题"]);
  });

  it("strips inline markdown from the heading text", () => {
    const headings = extractMarkdownHeadings("## [链接](docs/a.md) 与 `代码` 和 **强调**\n");
    expect(headings[0]?.text).toBe("链接 与 代码 和 强调");
  });

  it("returns an empty list for documents without headings", () => {
    expect(extractMarkdownHeadings("只有正文，没有标题。")).toEqual([]);
    expect(extractMarkdownHeadings("####### 七级不算标题")).toEqual([]);
  });

  it("aligns a segment's local line numbers onto the global outline", () => {
    // parseRichContent 切段后，react-markdown 报的是段内行号；对齐靠「层级 + 文本」。
    const global = extractMarkdownHeadings("# 开头\n\n正文\n\n## 图表之后\n\n### 结尾\n");
    const aligned = alignSegmentHeadings(global, "## 图表之后\n\n正文\n\n### 结尾\n");
    expect(aligned.get(1)?.id).toBe("图表之后");
    expect(aligned.get(5)?.id).toBe("结尾");
    // 不在全文大纲里的标题不入映射（宁缺不锚错）。
    expect(aligned.size).toBe(2);
  });

  it("dedupes punctuation-only headings into a shared slug", () => {
    const slugger = createHeadingSlugger();
    // 去标点后为空 → 固定 "section"，重名走数字后缀。
    expect(slugger("!!!")).toBe("section");
    expect(slugger("???")).toBe("section-1");
    expect(slugger("Hello World")).toBe("hello-world");
    expect(slugger("hello world")).toBe("hello-world-1");
  });
});

describe("rich content pipeline", () => {
  it("keeps ordinary code fences as markdown and promotes special fences", () => {
    const segments = parseRichContent("说明\n```ts\nconst value = 1\n```\n```mermaid\nflowchart LR\n A --> B\n```\n```html\n<h1>预览</h1>\n```");
    expect(segments.map((segment) => segment.type)).toEqual(["markdown", "mermaid", "artifact"]);
    expect(segments[0]).toMatchObject({ type: "markdown", content: expect.stringContaining("const value = 1") });
    expect(segments[1]).toMatchObject({ type: "mermaid", language: "mermaid" });
    expect(segments[2]).toMatchObject({ type: "artifact", artifact: { language: "html", content: "<h1>预览</h1>" } });
  });

  it("marks HTML artifacts with scripts or canvas as dynamic previews", () => {
    const segments = parseRichContent("```html\n<div><canvas id=\"chart\"></canvas><script>requestAnimationFrame(() => {});</script></div>\n```");
    expect(segments).toEqual([{
      type: "artifact",
      artifact: {
        title: "HTML 预览",
        language: "html",
        content: "<div><canvas id=\"chart\"></canvas><script>requestAnimationFrame(() => {});</script></div>",
        dynamic: true
      }
    }]);
  });

  it("renders assistant_html as a separate visual segment", () => {
    const segments = parseRichContent("前言\n\n<assistant_html><div class=\"ai-card\"><strong>卡片</strong></div></assistant_html>\n\n结尾");
    expect(segments).toEqual([
      { type: "markdown", content: "前言\n\n" },
      { type: "html", content: '<div class="ai-card"><strong>卡片</strong></div>', source: "assistant-html" },
      { type: "markdown", content: "\n\n结尾" }
    ]);
  });

  it("keeps dynamic assistant_html in the direct chat-bubble path", () => {
    const segments = parseRichContent("<assistant_html><div><canvas id=\"stage\"></canvas><script>requestAnimationFrame(() => {});</script></div></assistant_html>");
    expect(segments).toEqual([{
      type: "html",
      content: "<div><canvas id=\"stage\"></canvas><script>requestAnimationFrame(() => {});</script></div>",
      source: "assistant-html"
    }]);
  });

  it("moves dynamic raw HTML fragments out of the renderer HTML path", () => {
    const segments = parseRichContent("<div><canvas></canvas><script>setInterval(() => {}, 1000);</script></div>");
    expect(segments).toMatchObject([{ type: "artifact", artifact: { language: "html", dynamic: true } }]);
  });

  it("folds a short trailing epilogue into the completed HTML bubble", () => {
    const segments = parseRichContent("<assistant_html><div>卡片</div></assistant_html>\n\n希望对你有帮助。\n如有问题欢迎继续提问。");
    expect(segments).toEqual([{
      type: "html",
      content: '<div>卡片</div>\n<div class="ai-epilogue">希望对你有帮助。<br />如有问题欢迎继续提问。</div>',
      source: "assistant-html"
    }]);
  });

  it("keeps substantive Markdown after an HTML bubble separate", () => {
    const segments = parseRichContent("<assistant_html><div>卡片</div></assistant_html>\n\n## 后续说明");
    expect(segments.map((segment) => segment.type)).toEqual(["html", "markdown"]);
  });

  it("preserves a CSS-led HTML fragment as a styled HTML segment", () => {
    const segments = parseRichContent("<style>.card { color: red; }</style>\n<div class=\"card\">内容</div>");
    expect(segments).toEqual([{
      type: "html",
      content: '<style>.card { color: red; }</style>\n<div class="card">内容</div>',
      source: "fragment"
    }]);
  });

  it("renders closed assistant HTML while streaming but defers script activation to the renderer", () => {
    const segments = parseRichContent("<assistant_html><div>正在生成</div></assistant_html>", { isStreaming: true });
    expect(segments).toEqual([{ type: "html", content: "<div>正在生成</div>", source: "assistant-html" }]);
  });

  it("takes completed assistant HTML over the stable prefix while streaming the tail", () => {
    const segments = parseRichContent("前言\n<assistant_html><div>已完成</div></assistant_html>\n\n正在生成", { isStreaming: true });
    expect(segments.map((segment) => segment.type)).toEqual(["markdown", "html", "markdown"]);
    expect(segments[1]).toMatchObject({ type: "html", content: "<div>已完成</div>", source: "assistant-html" });
    expect(segments[2]).toMatchObject({ type: "markdown", content: expect.stringContaining("正在生成") });
  });

  it("keeps an unfinished structural block in the streaming tail", () => {
    const text = "说明\n```ts\nconst value = 1\n";
    expect(findStableCutoff(text)).toBe(0);
    expect(parseRichContent(text, { isStreaming: true })[0]).toMatchObject({ type: "markdown" });
  });

  it("advances stable cutoff across multiple fence styles without crossing types", () => {
    const text = "```ts\nconst a = 1\n```\n~~~mermaid\nflowchart LR\n A --> B\n~~~\n尾部";
    const cutoff = findStableCutoff(text);
    expect(text.slice(0, cutoff)).toContain("~~~mermaid");
    expect(text.slice(cutoff)).toBe("尾部");
  });

  it("renders an unfinished assistant HTML block in the streaming bubble", () => {
    const segments = parseRichContent("<assistant_html><div>尚未闭合", { isStreaming: true });
    expect(segments).toEqual([{ type: "html", content: "<div>尚未闭合", source: "assistant-html", closed: false }]);
  });

  it("renders an unfinished assistant HTML block after streaming completes", () => {
    const segments = parseRichContent("<assistant_html><div>最终片段", { isStreaming: false });
    expect(segments).toEqual([{ type: "html", content: "<div>最终片段", source: "assistant-html", closed: false }]);
  });

  it("treats an unfinished html fence as code while streaming", () => {
    const segments = parseRichContent("```html\n<div>正在生成");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: "markdown", content: expect.stringContaining("正在生成") });
    expect(segments[0]).not.toMatchObject({ type: "artifact" });
  });

  it("defers a closed HTML fence until streaming has finished", () => {
    const segments = parseRichContent("```html\n<div>完整但仍在生成</div>\n```", { isStreaming: true });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: "markdown", content: expect.stringContaining("完整但仍在生成") });
    expect(segments[0]).not.toMatchObject({ type: "artifact" });
    expect(parseRichContent("```html\n<div>完成</div>\n```", { isStreaming: false })[0]).toMatchObject({ type: "artifact" });
  });

  it("promotes complete documents inside assistant_html to sandbox artifacts", () => {
    const segments = parseRichContent("<assistant_html><!doctype html><html><body><h1>页面</h1></body></html></assistant_html>");
    expect(segments).toEqual([{ type: "artifact", artifact: { title: "HTML 预览", language: "html", content: "<!doctype html><html><body><h1>页面</h1></body></html>" } }]);
  });

  it("normalizes indented block markup without changing fenced code", () => {
    expect(normalizeRichContent("  <div>卡片</div>\n```text\n  <div>代码</div>\n```")).toBe("<div>卡片</div>\n```text\n  <div>代码</div>\n```");
  });

  it("normalizes bare tildes outside fenced code", () => {
    expect(normalizeRichContent("~draft\n~~strike~~\n~~~text\n~code\n~~~")).toBe("~ draft\n~~strike~~\n~~~text\n~code\n~~~");
  });

  it("keeps cross-type fence-looking lines inside code fences", () => {
    const content = [
      "  ```text",
      "  ~~~",
      "~draft",
      "~~~",
      "~outside-code",
      "  ```",
      "~after"
    ].join("\n");

    expect(normalizeRichContent(content)).toBe([
      "```text",
      "  ~~~",
      "~draft",
      "~~~",
      "~outside-code",
      "```",
      "~ after"
    ].join("\n"));
  });

  it("does not close a longer fence with a shorter marker", () => {
    const content = [
      "````text",
      "```",
      "~draft",
      "````",
      "~after"
    ].join("\n");

    expect(normalizeRichContent(content)).toBe([
      "````text",
      "```",
      "~draft",
      "````",
      "~ after"
    ].join("\n"));
  });

  it("keeps shell transcripts in a stable text code block", () => {
    const segments = parseRichContent("[shell] pnpm test\n[cwd] D:/workspace\n[stdout] ok\n[退出码] 0");
    expect(segments).toEqual([{ type: "markdown", content: "```text\n[shell] pnpm test\n[cwd] D:/workspace\n[stdout] ok\n[退出码] 0\n```" }]);
  });

  it("keeps adjacent reconstructed fences on separate lines after merge", () => {
    // Simulates the common "outer ```TEXT fence containing inner ``` fences"
    // shape. The outer fence gets closed by the first inner ```, then the
    // inner fence becomes its own markdown fence. When mergeMarkdownSegments
    // joins them, the closing and opening fences must not fuse into a single
    // line like ``````js — that fuses them into one malformed code block.
    const content = [
      "```text",
      "```bash",
      "cargo add anydoc",
      "```",
      "```js",
      "const x = 1",
      "```"
    ].join("\n");
    const segments = parseRichContent(content);
    const merged = segments
      .map((segment) => (segment as { content?: string }).content ?? "")
      .join("\n");
    expect(merged).not.toContain("``````js");
    expect(merged).toContain("```text\n```bash");
    expect(merged).toContain("```\n```js");
  });

  it("keeps unified diffs in a diff code block", () => {
    const segments = parseRichContent("diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new");
    expect(segments).toEqual([{ type: "markdown", content: "```diff\ndiff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n```" }]);
  });

  it("does not swallow prose that merely mentions a shell transcript", () => {
    const segments = parseRichContent("执行结果如下：\n[shell] pnpm test\n[cwd] D:/workspace\n[stdout] ok\n[退出码] 0");
    expect(segments[0]).toMatchObject({ type: "markdown", content: expect.stringContaining("执行结果如下") });
    expect(segments[0]).not.toMatchObject({ content: expect.stringMatching(/^```text/u) });
  });

  it("supports flowchart and graph aliases for Mermaid", () => {
    const segments = parseRichContent("```flowchart\nflowchart TD\n A --> B\n```\n```graph\ngraph LR\n A --> B\n```");
    expect(segments).toMatchObject([
      { type: "mermaid", language: "flowchart" },
      { type: "mermaid", language: "graph" }
    ]);
  });

  it("normalizes Mermaid aliases and full-width dash arrows", () => {
    expect(normalizeMermaidSource("A —> B", "flowchart")).toBe("flowchart A --> B");
    expect(normalizeMermaidSource("graph LR\nA --> B", "graph")).toBe("graph LR\nA --> B");
  });
});
