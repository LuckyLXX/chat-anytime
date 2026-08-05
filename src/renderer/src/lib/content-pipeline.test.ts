import { describe, expect, it } from "vitest";
import { findStableCutoff, normalizeMermaidSource, normalizeRichContent, parseRichContent } from "./content-pipeline";

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

  it("keeps assistant HTML inert until streaming has finished", () => {
    const segments = parseRichContent("<assistant_html><div>正在生成</div></assistant_html>", { isStreaming: true });
    expect(segments).toEqual([{ type: "markdown", content: "```html\n<div>正在生成</div>\n```" }]);
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

  it("shows an unfinished assistant HTML block as code while streaming", () => {
    const segments = parseRichContent("<assistant_html><div>尚未闭合", { isStreaming: true });
    expect(segments).toEqual([{ type: "markdown", content: "```html\n<div>尚未闭合\n```" }]);
  });

  it("renders an unfinished assistant HTML block after streaming completes", () => {
    const segments = parseRichContent("<assistant_html><div>最终片段", { isStreaming: false });
    expect(segments).toEqual([{ type: "html", content: "<div>最终片段", source: "assistant-html" }]);
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
