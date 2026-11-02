import { describe, expect, it } from "vitest";
import { BLOCK_MAX_CHARS, initialMountCount, planMarkdownBlocks, estimateMarkdownBlockHeight, isSafeBlockBoundary } from "./markdown-blocks";

/**
 * 块规划器的纯函数契约（2026-11-02）。
 *
 * 每条都对应一个真实的踩坑点：切进围栏会把代码块劈成两半；在引用式定义前切会让
 * 前缀里的引用退化成字面文本；松列表/缩进代码跨空行仍是同一块；性能护栏防止退回
 * 「每遇候选就回扫」的 O(n²) 写法（1MB 实测 4.6s → 单遍 18ms）。
 */
function buildDoc(targetChars: number, options: { fences?: boolean } = {}): string {
  const sections: string[] = [];
  let size = 0;
  let index = 0;
  while (size < targetChars) {
    index += 1;
    const section = [
      `## ${index}. 第 ${index} 节标题`,
      "",
      `本节的正文段落，含中文标点、英文术语（content-visibility）与数字 ${index}。`.repeat(3),
      "",
      "| 项目 | 数值 | 说明 |",
      "| --- | --- | --- |",
      `| 第 ${index} 行 | ${index * 37} | 单元格 |`,
      "",
      "- 列表项一",
      "- 列表项二",
      "",
      ...(options.fences === false ? [] : ["```bash", `npm test -- --filter=${index}`, "```", ""]),
      `### ${index}.1 子标题`,
      "",
      `子节正文，继续补充一些内容让篇幅增长。`.repeat(4),
      ""
    ].join("\n");
    sections.push(section);
    size += section.length;
  }
  return sections.join("\n");
}

function fenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let open: { at: number; marker: string; length: number } | undefined;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (!open && match) {
      open = { at: offset, marker: match[1]![0]!, length: match[1]!.length };
    } else if (open && line.trim().length >= open.length && [...line.trim()].every((character) => character === open!.marker)) {
      ranges.push([open.at, offset + line.length]);
      open = undefined;
    }
    offset += line.length + 1;
  }
  if (open) ranges.push([open.at, text.length]);
  return ranges;
}

describe("planMarkdownBlocks 不变量", () => {
  it("切块后逐块拼回原文，且偏移首尾相接", () => {
    const text = buildDoc(120_000);
    const blocks = planMarkdownBlocks(text);
    expect(blocks.length).toBeGreaterThan(20);
    expect(blocks.map((block) => block.text).join("")).toBe(text);
    expect(blocks[0]!.start).toBe(0);
    expect(blocks.at(-1)!.end).toBe(text.length);
    for (let index = 1; index < blocks.length; index += 1) expect(blocks[index]!.start).toBe(blocks[index - 1]!.end);
  });

  it("块内起始行号单调，且换算成整篇行号时可对上原文", () => {
    const text = buildDoc(60_000);
    const blocks = planMarkdownBlocks(text);
    const lines = text.split("\n");
    for (const block of blocks) {
      expect(lines[block.startLine - 1]?.startsWith(block.text.split("\n")[0]!.slice(0, 8))).toBe(true);
    }
    for (let index = 1; index < blocks.length; index += 1) expect(blocks[index]!.startLine).toBeGreaterThan(blocks[index - 1]!.startLine);
  });

  it("同一输入两次规划完全一致（键值必须稳定，React 才能 reconcile）", () => {
    const text = buildDoc(60_000);
    expect(planMarkdownBlocks(text)).toEqual(planMarkdownBlocks(text));
  });

  it("baseLine 让跨段规划的行号接续", () => {
    const blocks = planMarkdownBlocks("a\n\nb\n", { baseLine: 100 });
    expect(blocks[0]!.startLine).toBe(100);
  });
});

describe("planMarkdownBlocks 切分规则", () => {
  it("围栏内部永不切（哪怕里面有二级标题行）", () => {
    const fenceLines = Array.from({ length: 120 }, (_, index) => `## 这行在代码块里 ${index}`);
    const text = `## 开头\n\n${"正文。".repeat(200)}\n\n\`\`\`bash\n${fenceLines.join("\n")}\n\`\`\`\n\n## 结尾\n\n${"收尾。".repeat(400)}`;
    const blocks = planMarkdownBlocks(text, { minChars: 100, maxChars: 200 });
    for (const [start, end] of fenceRanges(text)) {
      for (const block of blocks) expect(block.end <= start || block.end >= end).toBe(true);
    }
    // 代码块里的 `## 这行在代码块里` 不能成为块首行
    expect(blocks.some((block) => block.text.startsWith("## 这行在代码块里"))).toBe(false);
  });

  it("行首 ATX 标题是首选切点，四空格缩进的 `##` 不是", () => {
    const text = `## A\n\n${"甲。".repeat(150)}\n\n## B\n\n${"乙。".repeat(150)}\n\n    ## 这是缩进代码\n\n${"丙。".repeat(150)}`;
    const blocks = planMarkdownBlocks(text, { minChars: 100 });
    // 两个行首标题各起一块；四空格缩进的那个不是块首（它属于上一块里的缩进代码）
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.some((block) => block.text.startsWith("## B"))).toBe(true);
    expect(blocks.some((block) => block.text.startsWith("    ## 这是缩进代码"))).toBe(false);
  });

  it("没有标题的文档按空行切块（上限是软约束：最多超出最后一个段落）", () => {
    const paragraph = "这是一段没有标题的正文。".repeat(20);
    const text = Array.from({ length: 20 }, () => paragraph).join("\n\n");
    const blocks = planMarkdownBlocks(text, { maxChars: 800 });
    expect(blocks.length).toBeGreaterThan(3);
    for (const block of blocks) expect(block.text.length).toBeLessThanOrEqual(800 + paragraph.length + 2);
  });

  it("单个超长围栏保留为 oversize 块，不被硬切", () => {
    const code = Array.from({ length: 2_000 }, (_, index) => `const value${index} = ${index};`).join("\n");
    const text = `\`\`\`ts\n${code}\n\`\`\``;
    const blocks = planMarkdownBlocks(text, { maxChars: 500 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.oversize).toBe(true);
  });
});

describe("isSafeBlockBoundary 否决表", () => {
  it("引用式定义前不切（定义向后生效，前缀里的引用会变字面文本）", () => {
    expect(isSafeBlockBoundary("正文", "[id]: https://example.com")).toBe(false);
    expect(isSafeBlockBoundary("正文", "  [footnote]: note")).toBe(false);
  });

  it("松列表 / 松引用 / 缩进代码跨空行不切", () => {
    expect(isSafeBlockBoundary("- 项一", "- 项二")).toBe(false);
    expect(isSafeBlockBoundary("1. 项一", "2) 项二")).toBe(false);
    expect(isSafeBlockBoundary("> 引用一", "> 引用二")).toBe(false);
    expect(isSafeBlockBoundary("    code", "\tcode2")).toBe(false);
  });

  it("普通段落与标题之间可以切", () => {
    expect(isSafeBlockBoundary("普通段落", "另一段")).toBe(true);
    expect(isSafeBlockBoundary("普通段落", "## 标题")).toBe(true);
  });

  it("规划器真的不会把引用式定义切到块首", () => {
    const text = `第一段正文，写得长一点。${"补。".repeat(50)}\n\n[id]: https://example.com\n\n引用它的段落 [id] 继续。${"补。".repeat(50)}`;
    const blocks = planMarkdownBlocks(text, { maxChars: 10 });
    expect(blocks.some((block) => block.text.startsWith("[id]:"))).toBe(false);
  });
});

describe("estimateMarkdownBlockHeight / initialMountCount", () => {
  it("高度随文本增长且夹在 [120, 8000]", () => {
    const small = estimateMarkdownBlockHeight("短");
    const medium = estimateMarkdownBlockHeight("中".repeat(2_000));
    const huge = estimateMarkdownBlockHeight("长".repeat(200_000));
    expect(small).toBeGreaterThanOrEqual(120);
    expect(medium).toBeGreaterThan(small);
    expect(huge).toBeLessThanOrEqual(8_000);
  });

  it("首屏挂载按字符预算与块数上限取较小者", () => {
    const text = buildDoc(80_000);
    const blocks = planMarkdownBlocks(text);
    const count = initialMountCount(blocks, 12_000, 4);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(4);
    const chars = blocks.slice(0, count).reduce((sum, block) => sum + block.text.length, 0);
    expect(chars >= 12_000 || count === 4).toBe(true);
  });
});
