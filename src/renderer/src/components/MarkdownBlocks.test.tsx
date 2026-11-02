import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreviewContent } from "./RichContent";
import { MarkdownBlocks } from "./MarkdownBlocks";
import { initialMountCount, planMarkdownBlocks } from "../lib/markdown-blocks";

/**
 * 窗口化的 SSR 契约（2026-11-02）。
 *
 * 这里能钉住的是「首屏只挂载前几块、其余是等高占位」——IntersectionObserver 在
 * happy-dom/SSR 里不回调，滚动挂载与 Ctrl+F 展开由真机验收覆盖（与聊天窗口化同一
 * 取舍）。反过来说：如果这层被改回「一次全渲染」，本文件的占位断言会立刻转红。
 */
function buildDoc(sections: number): string {
  return Array.from({ length: sections }, (_, index) => [
    `## 第 ${index} 节标题`,
    "",
    `第 ${index} 节的正文内容，用来把文档撑大，含中文与英文术语。`.repeat(6),
    "",
    "- 列表项一",
    "- 列表项二",
    ""
  ].join("\n")).join("\n");
}

describe("MarkdownBlocks 首屏挂载预算", () => {
  it("只同步渲染前几块，其余留占位（占位数量 = 总块数 - 首屏块数）", () => {
    const text = buildDoc(400);
    const blocks = planMarkdownBlocks(text, { minChars: 200 });
    expect(blocks.length).toBeGreaterThan(10);
    const markup = renderToStaticMarkup(
      <MarkdownBlocks blocks={blocks} renderBlock={(block) => <p>{block.text.slice(0, 24)}</p>} />
    );
    const placeholders = markup.match(/data-md-block-placeholder=/g)?.length ?? 0;
    expect(placeholders).toBe(blocks.length - initialMountCount(blocks));
    expect(placeholders).toBeGreaterThan(0);
    // 首块真的渲染了，最后一块没有
    expect(markup).toContain(blocks[0]!.text.slice(0, 24));
    expect(markup).not.toContain(blocks.at(-1)!.text.slice(0, 24));
  });

  it("块数很少时全部渲染，不出现占位", () => {
    const text = "## 一\n\n正文。\n\n## 二\n\n正文。\n";
    const blocks = planMarkdownBlocks(text, { minChars: 10 });
    const markup = renderToStaticMarkup(
      <MarkdownBlocks blocks={blocks} renderBlock={(block) => <p>{block.text.slice(0, 8)}</p>} />
    );
    expect(markup).not.toContain("data-md-block-placeholder=");
  });

  it("占位块带估算高度、aria-hidden，且不渲染块内容", () => {
    const text = buildDoc(200);
    const blocks = planMarkdownBlocks(text, { minChars: 200 });
    const markup = renderToStaticMarkup(
      <MarkdownBlocks blocks={blocks} renderBlock={(block) => <p>{block.text.slice(0, 12)}</p>} />
    );
    const placeholder = markup.match(/<div class="markdown-block is-placeholder"[^>]*>/)?.[0] ?? "";
    expect(placeholder).toContain("height:");
    expect(placeholder).toContain("aria-hidden");
  });
});

describe("MarkdownPreviewContent 大文档路由", () => {
  it("超过阈值走分块窗口化（markdown-blocks + 占位）", () => {
    const content = buildDoc(300);
    expect(content.length).toBeGreaterThanOrEqual(40_000);
    const markup = renderToStaticMarkup(
      <MarkdownPreviewContent content={content} artifactPrefix="preview-window" onOpenArtifact={() => undefined} />
    );
    expect(markup).toContain("markdown-blocks");
    expect(markup).toContain("data-md-block-placeholder=");
    // 最后一节的标题不在首屏 DOM 里——这正是省下来的解析量
    expect(markup).not.toContain("第 299 节标题");
  });

  it("小文档保持原路径（不套分块包装）", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreviewContent content={"## 标题\n\n正文。\n"} artifactPrefix="preview-small" onOpenArtifact={() => undefined} />
    );
    expect(markup).not.toContain("markdown-blocks");
    expect(markup).toContain("标题");
  });

  it("windowed=false 时大文档退回整篇渲染（回滚开关）", () => {
    const content = buildDoc(300);
    const markup = renderToStaticMarkup(
      <MarkdownPreviewContent content={content} windowed={false} artifactPrefix="preview-off" onOpenArtifact={() => undefined} />
    );
    expect(markup).not.toContain("markdown-blocks");
    expect(markup).toContain("第 299 节标题");
  });
});
