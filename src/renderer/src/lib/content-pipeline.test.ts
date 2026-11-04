import { describe, expect, it } from "vitest";
import { alignSegmentHeadings, createHeadingSlugger, extractMarkdownHeadings, findStableCutoff, hasMathSyntax, matchHeadings, normalizeMermaidSource, normalizeRichContent, parseRichContent, parseRichContentLocated } from "./content-pipeline";

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

  it("气泡内的 ``` 围栏不再把气泡拦腰斩断（2026-11-04 真实会话事故）", () => {
    // 复刻真实事故形态：模型在气泡 HTML 里引用一段带 ```ts 围栏的对话示例，
    // 旧行为是围栏扫描先切、气泡被斩成两段，后半段（含 </code></pre>、<p style>）
    // 整段按 Markdown 泄漏，用户侧表现为「输出格式不对 / 为啥在 md 里写 html」。
    const text = [
      '<assistant_html><div style="padding:16px">',
      "<h3>示例对话</h3>",
      "- [user] 把 auth.ts 里的 token 刷新改成单飞",
      "- [other] ```ts",
      "export async function refresh(){ /* ... */ }",
      "```",
      "本地备份不在这次请求里。",
      "<p>结论：见上。</p>",
      "</div></assistant_html>"
    ].join("\n");
    const segments = parseRichContent(text);
    expect(segments).toEqual([{
      type: "html",
      content: expect.stringContaining("```ts"),
      source: "assistant-html"
    }]);
    expect(segments[0]).toMatchObject({ type: "html", content: expect.stringContaining("</div>") });
  });

  it("流式中的气泡内围栏同样保持单一渐进气泡段", () => {
    const partial = "<assistant_html><div>\n<p>示例</p>\n```ts\nconst a = 1\n";
    const segments = parseRichContent(partial, { isStreaming: true });
    expect(segments).toEqual([{
      type: "html",
      content: expect.stringContaining("```ts"),
      source: "assistant-html",
      closed: false
    }]);
  });

  it("气泡外的围栏照常切分，多个气泡互不干扰", () => {
    const text = "<assistant_html><div>甲 ``` 内围栏</div></assistant_html>\n\n```js\nconst x = 1\n```\n\n<assistant_html><div>乙</div></assistant_html>";
    expect(parseRichContent(text).map((segment) => segment.type)).toEqual(["html", "markdown", "html"]);
  });

  it("围栏里的 <assistant_html> 保持字面，不当气泡起点", () => {
    const text = "说明\n```md\n<assistant_html><div>假气泡</div></assistant_html>\n```\n结尾";
    const segments = parseRichContent(text);
    expect(segments.some((segment) => segment.type === "html")).toBe(false);
    expect(segments.some((segment) => segment.type === "markdown" && segment.content.includes("假气泡"))).toBe(true);
  });

  it("行中提及 <assistant_html> 不开气泡区间，后续围栏照常切分", () => {
    const text = "正文提到 <assistant_html> 标签。\n\n```js\nconst x = 1\n```\n";
    const segments = parseRichContent(text);
    expect(segments.some((segment) => segment.type === "markdown" && segment.content.includes("```js"))).toBe(true);
    expect(segments.some((segment) => segment.type === "html" && segment.content.includes("const x = 1"))).toBe(false);
  });

  it("文档模式：单独成行的 <assistant_html> 也不吞掉后续围栏切分（2026-09-11 口径回归）", () => {
    const text = "正文\n\n<assistant_html>\n\n```js\nconst x = 1\n```\n";
    const segments = parseRichContent(text, { document: true });
    expect(segments.every((segment) => segment.type === "markdown")).toBe(true);
    expect(segments.some((segment) => segment.type === "markdown" && segment.content.includes("```js"))).toBe(true);
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

describe("段位置盖章（大文档分块预览的稳定 key）", () => {
  it("parseRichContentLocated 给每段盖上连续偏移与 1-based 起始行", () => {
    // 用 mermaid 围栏强制切段（普通围栏会被 mergeMarkdownSegments 并回同一个 markdown 段）
    const text = "## 第一节\n\n正文一。\n\n```mermaid\nflowchart TD\nA --> B\n```\n\n## 第二节\n\n正文二。\n";
    const segments = parseRichContentLocated(text);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]!.start).toBe(0);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]!.start).toBe(segments[index - 1]!.end);
      expect(segments[index]!.startLine).toBeGreaterThan(segments[index - 1]!.startLine!);
    }
    // markdown 段是原文的逐字切片，起始行必须真的落在对应行首
    // （mermaid 段会被 normalizeMermaidSource 改写首行，偏移只作 key，不做断言）
    const lines = text.split("\n");
    for (const segment of segments) {
      if (segment.type !== "markdown") continue;
      const firstLine = segment.content.split("\n")[0]!;
      if (!firstLine.trim()) continue;
      expect(lines[(segment.startLine ?? 1) - 1]).toBe(firstLine);
    }
  });

  it("parseRichContent 本身不改变既有结构（位置字段只走 located 入口）", () => {
    const segments = parseRichContent("## 标题\n\n正文\n");
    expect(Object.prototype.hasOwnProperty.call(segments[0]!, "start")).toBe(false);
  });

  it("matchHeadings 按顺序切片，同名标题不会锚到文档开头那一个", () => {
    const document = "# 甲\n\n## 踩坑\n\n正文\n\n# 乙\n\n## 踩坑\n\n正文\n";
    const global = extractMarkdownHeadings(document);
    expect(global.map((heading) => heading.line)).toEqual([1, 3, 7, 9]);
    const first = matchHeadings(global, "# 甲\n\n## 踩坑\n\n正文\n", 0);
    expect(first.headings.map((heading) => heading.line)).toEqual([1, 3]);
    // 第二段里的「踩坑」必须对到第 9 行那一个，而不是第 3 行
    const second = matchHeadings(global, "## 踩坑\n\n正文\n", first.next);
    expect(second.headings.map((heading) => heading.line)).toEqual([9]);
    // 切片之后交给 alignSegmentHeadings，块内行号 1 就是第二条「踩坑」
    expect(alignSegmentHeadings(second.headings, "## 踩坑\n\n正文\n").get(1)?.line).toBe(9);
  });
});

describe("围栏密集文档的合并", () => {
  it("五千段相邻围栏合并成一个 markdown 段（合并逻辑的形态契约）", () => {
    // 复杂度（旧实现是 O(n²) 字符串复制：1MB/1000+ 围栏 5.5s → 片段数组 + join 0.17s）
    // 由 src/main/markdown-window-wiring.test.ts 的源码断言钉住；
    // 这里只钉行为：相邻围栏必须并回同一段，且分隔符不能被吃掉。
    const block = "```bash\necho hi\n```";
    const text = Array.from({ length: 5_000 }, () => block).join("\n\n");
    const segments = parseRichContent(text);
    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    if (segment.type !== "markdown") throw new Error(`expected markdown segment, got ${segment.type}`);
    expect(segment.content.startsWith("```bash\necho hi\n```")).toBe(true);
  });
});
