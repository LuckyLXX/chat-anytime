import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichContent } from "./RichContent";

/**
 * 流式渲染的性能行为契约（2026-09-25 P1）。
 *
 * 背景实测：`hljs.highlight` typescript 50 行 5.5ms / 200 行 12.9ms / 400 行 24.2ms，
 * 而流式期间代码块每帧都在变（LRU 的 key 含全文 → 每帧必然 miss），20fps 下就是
 * 半个核卡在主线程上。修法：流式中「还在长大」且超过阈值的大块先按纯文本转义渲染，
 * 定稿后再高亮一次；小块的实时着色保持不变（5ms 级，留着色体验）。
 */
function buildCode(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `const value${i} = ${i}; // 说明 ${i}`).join("\n");
}

function renderStreaming(codeLines: number, streaming: boolean): string {
  const text = `下面是实现：\n\n\`\`\`typescript\n${buildCode(codeLines)}\n${
    // 流式：围栏未闭合；定稿：围栏闭合
    streaming ? "" : "```\n"
  }`;
  return renderToStaticMarkup(
    <RichContent streaming={streaming} artifactPrefix="probe" onOpenArtifact={() => undefined}>{text}</RichContent>
  );
}

function hasHighlight(markup: string): boolean {
  return markup.includes("hljs-");
}

describe("流式代码块高亮降级", () => {
  it("流式中的大代码块按纯文本渲染（不跑同步高亮）", () => {
    const markup = renderStreaming(400, true);
    expect(hasHighlight(markup)).toBe(false);
    // 内容本身必须完整保留（只是不着色，不能丢字）
    expect(markup).toContain("const value399 = 399;");
  });

  it("流式中的小代码块仍然实时着色（不牺牲短块体验）", () => {
    const markup = renderStreaming(20, true);
    expect(hasHighlight(markup)).toBe(true);
  });

  it("定稿后（非流式）同一大代码块正常着色", () => {
    const markup = renderStreaming(400, false);
    expect(hasHighlight(markup)).toBe(true);
  });

  it("阈值边界：刚过 150 行走降级，150 行以内保持着色", () => {
    expect(hasHighlight(renderStreaming(149, true))).toBe(true);
    expect(hasHighlight(renderStreaming(151, true))).toBe(false);
  });

  it("无语言围栏照旧按纯文本（既有行为不被本次改动影响）", () => {
    const markup = renderToStaticMarkup(
      <RichContent streaming artifactPrefix="probe" onOpenArtifact={() => undefined}>{"```\nconst a = 1;\n```"}</RichContent>
    );
    expect(hasHighlight(markup)).toBe(false);
    expect(markup).toContain("const a = 1;");
  });
});
