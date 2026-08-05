import { describe, expect, it } from "vitest";
import { normalizeMermaidSource, normalizeRichContent, parseRichContent } from "./content-pipeline";

describe("rich content pipeline", () => {
  it("keeps ordinary code fences as markdown and promotes special fences", () => {
    const segments = parseRichContent("说明\n```ts\nconst value = 1\n```\n```mermaid\nflowchart LR\n A --> B\n```\n```html\n<h1>预览</h1>\n```");
    expect(segments.map((segment) => segment.type)).toEqual(["markdown", "mermaid", "artifact"]);
    expect(segments[0]).toMatchObject({ type: "markdown", content: expect.stringContaining("const value = 1") });
    expect(segments[1]).toMatchObject({ type: "mermaid", language: "mermaid" });
    expect(segments[2]).toMatchObject({ type: "artifact", artifact: { language: "html", content: "<h1>预览</h1>" } });
  });

  it("renders assistant_html as a separate visual segment", () => {
    const segments = parseRichContent("前言\n\n<assistant_html><div class=\"ai-card\"><strong>卡片</strong></div></assistant_html>\n\n结尾");
    expect(segments).toEqual([
      { type: "markdown", content: "前言\n\n" },
      { type: "html", content: '<div class="ai-card"><strong>卡片</strong></div>', source: "assistant-html" },
      { type: "markdown", content: "\n\n结尾" }
    ]);
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
