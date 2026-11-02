import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 大文档分块预览的接线断言（2026-11-02）。
 *
 * 纯逻辑（markdown-blocks.test.ts）与 SSR 契约（MarkdownBlocks.test.tsx）都可能在
 * 「组件根本没接上」的情况下全绿——这正是仓库里 app-subscription.test.ts /
 * artifact-preview-base-wiring.test.ts 存在的理由。这里逐处钉住：
 * 预览路由、块内标题切片、大纲跳转接管、流式双语法、编辑器节流。
 *
 * 读源码要归一化 CRLF（Windows runner 检出）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n/gu, "\n");

const richContent = read("../renderer/src/components/RichContent.tsx");
const markdownBlocks = read("../renderer/src/components/MarkdownBlocks.tsx");
const markdownOutline = read("../renderer/src/components/MarkdownOutline.tsx");
const artifactPreview = read("../renderer/src/components/ArtifactPreview.tsx");
const markdownEditor = read("../renderer/src/components/MarkdownEditor.tsx");
const contentPipeline = read("../renderer/src/lib/content-pipeline.ts");
const markdownBlocksLib = read("../renderer/src/lib/markdown-blocks.ts");

describe("预览分块窗口化接线", () => {
  it("MarkdownPreviewContent 按阈值把大 markdown 段路由到 MarkdownBlocks", () => {
    expect(richContent).toContain('import { PREVIEW_WINDOW_MIN_CHARS, planMarkdownBlocks } from "../lib/markdown-blocks";');
    expect(richContent).toContain("segment.content.length >= PREVIEW_WINDOW_MIN_CHARS");
    expect(richContent).toContain("<WindowedMarkdownSegment");
    expect(richContent).toContain("windowed = true");
  });

  it("预览走文档模式（不把正文里的 <assistant_html> 当成 HTML 片段）", () => {
    expect(richContent).toContain("parseRichContentLocated(content, { isStreaming: false, document: true })");
  });

  it("窗口化段用 located 解析（段偏移键）并按顺序切标题", () => {
    expect(richContent).toContain("parseRichContentLocated(content");
    expect(richContent).toContain("matchHeadings(headings, segment.content, cursor)");
    expect(richContent).toContain("distributeHeadings(headings, blocks)");
  });

  it("块组件具备四条不变量：观察器重放、Ctrl+F/A 展开、占位、大纲 reveal", () => {
    expect(markdownBlocks).toContain("for (const [start, element] of elementsRef.current) observer.register(String(start), element);");
    expect(markdownBlocks).toContain('if (key === "f" || key === "a") setExpanded(true);');
    expect(markdownBlocks).toContain("data-md-block-placeholder={block.start}");
    expect(markdownBlocks).toContain("onRegisterReveal?.((heading: MarkdownHeading) => {");
    // 挂载补偿：视口上方变高才补 scrollTop
    expect(markdownBlocks).toContain("if (top < 0) scroller.scrollTop += delta;");
  });

  it("大纲栏跳转先交给分块预览接管", () => {
    expect(markdownOutline).toContain("onJump?: (heading: MarkdownHeading) => boolean;");
    expect(markdownOutline).toContain("if (onJump?.(heading)) return;");
    expect(artifactPreview).toContain("onJump={jump}");
    expect(artifactPreview).toContain("onRegisterReveal={registerReveal}");
  });

  it("流式尾部走单语法（不装 math），定稿再切换", () => {
    expect(richContent).toContain("const math = useMemo(() => !streaming && hasMathSyntax(content), [content, streaming]);");
    expect(richContent).toContain("streaming={liveTail}");
  });
});

describe("O(n²) 回归的静态护栏", () => {
  it("段合并用片段数组 + join，绝不再写 `previous.content +=`", () => {
    // 旧写法在 1MB / 1000+ 围栏的文档上实测 5.5s；改成 join 后 0.17s。并发跑全量测试时
    // 墙钟不可信（同一用例 5ms ↔ 100ms），所以这条用源码形态钉，而不是计时断言。
    expect(contentPipeline).toContain("parts.join(\"\")");
    expect(contentPipeline).toContain("parts.push(");
    expect(contentPipeline).not.toContain("previous.content += separator");
  });

  it("块规划器保持单遍扫描，且支持超长无序列表切分", () => {
    expect(markdownBlocksLib).toContain("while (offset <= text.length)");
    expect(markdownBlocksLib).not.toContain("lines.slice(0,");
    // 真实 328KB 文档是 145 条 `* [X]` 的松列表：没有这条规则会退化成 4 块。
    expect(markdownBlocksLib).toContain("UNORDERED_ITEM_PATTERN.test(line)");
  });
});

describe("编辑器节流接线", () => {
  it("观察器节流与快照回写都走策略函数，且卸载/写盘前 flush", () => {
    expect(markdownEditor).toContain('import { editorContentSnapshotDelayMs, editorObserverThrottleMs } from "../lib/markdown-editor-policy";');
    expect(markdownEditor).toContain("editorObserverThrottleMs(latestValueRef.current.length)");
    expect(markdownEditor).toContain("editorContentSnapshotDelayMs(value.length)");
    expect(markdownEditor).toContain("flushContentSnapshot();");
    // 大文档快照定时器必须在卸载与远端重载时清掉，避免旧内容覆盖新内容
    expect(markdownEditor).toContain("if (contentTimerRef.current) {");
  });
});
