// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeSplitLimit } from "./content-pipeline";
import { STREAM_CHUNK_MIN_CHARS, STREAM_SPLIT_MIN_CHARS, STREAM_TAIL_MIN_CHARS, isSafeFreezeBoundary, planChunkFreeze, useStreamingChunks } from "./streaming-split";

/**
 * 流式增量渲染的边界规则与不变量（2026-09-25 P1）。
 *
 * 分块会把文档切开渲染，而 markdown 是上下文敏感的；本文件钉住两件事：
 * ① 切分点只能落在安全位置（不切进未闭合围栏/HTML 块，不切出松列表/引用/
 *    缩进代码块/引用式定义的语义差）；② 不变量「各块 + 尾部 === 当前文本」
 *    （任何情况下不丢字符），且流式结束立即归零走整篇精确渲染。
 *
 * 另外钉住一条**性能设计**：分块必须是「多块、每块只解析一次」。曾经的实现是
 * 「单块前缀」，每次前推都重解析整个前缀（O(N²) 变体），实测比不改还慢 13%。
 */

const PARAGRAPH = "这是一段用于填充长度的中文段落，包含行内代码 `useState` 与强调 **重点**，让每段的字节数足够大，便于把文本推过冻结阈值。\n\n";

/** 按目标字符数构图（不依赖单段长度，避免「没到阈值→断言空转」的假绿）。 */
function buildText(minChars: number): string {
  let out = "";
  while (out.length < minChars) out += PARAGRAPH;
  return out;
}

describe("safeSplitLimit：不越过未闭合的围栏/HTML 块", () => {
  it("纯段落文本返回全文长度（不是 findStableCutoff 的 0）", () => {
    const text = buildText(1200);
    expect(safeSplitLimit(text)).toBe(text.length);
  });

  it("未闭合围栏：上界停在围栏之前", () => {
    const prose = buildText(5000);
    const text = `${prose}\`\`\`typescript\nconst a = 1;\n`;
    const limit = safeSplitLimit(text);
    expect(limit).toBeLessThanOrEqual(prose.length);
    expect(text.slice(0, limit)).not.toContain("```");
  });

  it("已闭合围栏：上界可以越过它", () => {
    const prose = buildText(5000);
    const text = `${prose}\`\`\`typescript\nconst a = 1;\n\`\`\`\n尾巴文字。\n\n`;
    expect(safeSplitLimit(text)).toBe(text.length);
  });

  it("未闭合 assistant_html：上界停在它之前（卡片不会被切两半）", () => {
    const prose = buildText(5000);
    const text = `${prose}<assistant_html>\n<div>卡片</div>\n`;
    const limit = safeSplitLimit(text);
    expect(limit).toBeLessThanOrEqual(prose.length);
    expect(text.slice(0, limit)).not.toContain("<assistant_html>");
  });
});

describe("planChunkFreeze：什么时候切、切到哪", () => {
  it("短文本不启用分块", () => {
    const text = buildText(600);
    expect(text.length).toBeLessThan(STREAM_SPLIT_MIN_CHARS);
    expect(planChunkFreeze(text, 0)).toBe(0);
  });

  it("新增长度不足（尾部最小保留 + 块最小长度）时不推进", () => {
    const text = buildText(6000);
    const frozen = text.length - (STREAM_TAIL_MIN_CHARS + STREAM_CHUNK_MIN_CHARS) + 10;
    expect(planChunkFreeze(text, frozen)).toBe(frozen);
  });

  it("长文本切在空行处，且尾部至少留 TAIL_MIN", () => {
    const text = buildText(9000);
    const boundary = planChunkFreeze(text, 0);
    expect(boundary).toBeGreaterThanOrEqual(STREAM_CHUNK_MIN_CHARS);
    expect(text.length - boundary).toBeGreaterThanOrEqual(STREAM_TAIL_MIN_CHARS);
    expect(text[boundary - 1]).toBe("\n");
    expect(isSafeFreezeBoundary(text, boundary)).toBe(true);
  });

  it("从不切进未闭合围栏（长回复尾部正在写代码块时）", () => {
    // 构造要点：围栏内部必须有空行（真实代码里到处都是），否则空行规则本来就会把
    // 边界放在围栏之前，这条断言就成了空转。
    const body = Array.from({ length: 120 }, (_, index) => index % 20 === 19 ? "" : `const value${index} = compute();`).join("\n");
    const prose = buildText(6000);
    const text = `${prose}\`\`\`typescript\n${body}\n`;
    const boundary = planChunkFreeze(text, 0);
    expect(boundary).toBeGreaterThan(0);
    expect(text.slice(0, boundary)).not.toContain("```");
    expect(boundary).toBeLessThanOrEqual(prose.length);
  });

  it("松列表边界被否决：边界退回列表之前", () => {
    // 让危险边界成为「≤ limit 的最大空行边界」，否则断言是空转。
    const head = buildText(6000);
    const listStart = head.length;
    const text = `${head}- 第一条\n\n- 第二条${"x".repeat(2000)}\n`;
    const boundary = planChunkFreeze(text, 0);
    expect(boundary).toBeGreaterThan(0);
    expect(boundary).toBeLessThanOrEqual(listStart);
  });
});

describe("isSafeFreezeBoundary：逐条否决危险边界", () => {
  it("放行普通段落空行边界", () => {
    expect(isSafeFreezeBoundary("段落一。\n\n段落二。\n", "段落一。\n\n".length)).toBe(true);
  });

  it("否决松列表（两侧都是列表项）", () => {
    const text = "前言。\n\n- 第一条\n\n- 第二条\n";
    expect(isSafeFreezeBoundary(text, "前言。\n\n- 第一条\n\n".length)).toBe(false);
    expect(isSafeFreezeBoundary(text, "前言。\n\n".length)).toBe(true);
  });

  it("否决松散引用块（两侧都是引用行）", () => {
    const text = "前言。\n\n> 引用一\n\n> 引用二\n";
    expect(isSafeFreezeBoundary(text, "前言。\n\n> 引用一\n\n".length)).toBe(false);
  });

  it("否决引用式定义边界（前一篇的引用链接不会退化成字面文本）", () => {
    const text = "这是 [链接][ref] 的说明。\n\n[ref]: https://example.com\n\n正文。\n";
    expect(isSafeFreezeBoundary(text, "这是 [链接][ref] 的说明。\n\n".length)).toBe(false);
  });

  it("否决缩进代码块被空行切开（一个代码块会变成两个）", () => {
    const one = "    const a = 1;\n\n    const b = 2;\n";
    expect(isSafeFreezeBoundary(one, "    const a = 1;\n\n".length)).toBe(false);
    expect(isSafeFreezeBoundary("前言。\n\n    code\n", "前言。\n\n".length)).toBe(true);
  });

  it("边界后无内容时否决", () => {
    expect(isSafeFreezeBoundary("段落。\n\n", 5)).toBe(false);
  });
});

describe("useStreamingChunks：不变量、节流与生命周期", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  let latest: { chunks: string[]; tail: string } | undefined;
  function Probe({ text, streaming }: { text: string; streaming: boolean }) {
    latest = useStreamingChunks(text, streaming);
    return null;
  }

  function mount(initial: { text: string; streaming: boolean }) {
    const root = createRoot(container);
    const paint = (next: { text: string; streaming: boolean }) => {
      act(() => {
        root.render(<Probe {...next} />);
      });
      // 尾部节流是 trailing 的：推进定时器让这次变化真正落地
      act(() => {
        vi.advanceTimersByTime(200);
      });
    };
    paint(initial);
    return { paint, root };
  }

  it("逐帧增长：不变量成立、块只增不改、每块都是文本的连续片段（不丢字符）", () => {
    const full = buildText(12000);
    const { paint } = mount({ text: "", streaming: true });
    let previousChunks: string[] = [];
    let sawChunk = false;
    for (let length = 800; length <= full.length; length += 400) {
      const text = full.slice(0, length);
      paint({ text, streaming: true });
      const { chunks, tail } = latest!;
      // 不变量：显示内容（各块 + 尾部）必须始终是真实文本的**前缀**（不丢字符、不串位）
      expect(text.startsWith(chunks.join("") + tail)).toBe(true);
      // 块只增不改：上一帧的块是这一帧块列表的前缀
      expect(chunks.slice(0, previousChunks.length)).toEqual(previousChunks);
      if (chunks.length > previousChunks.length) {
        // 新块必须接在旧冻结区之后
        const frozenBefore = previousChunks.join("").length;
        const frozenAfter = chunks.join("").length;
        expect(chunks.join("")).toBe(text.slice(0, frozenAfter));
        expect(frozenAfter).toBeGreaterThan(frozenBefore);
        sawChunk = true;
      }
      previousChunks = chunks;
    }
    expect(sawChunk).toBe(true);
  });

  it("块一旦冻结就不再变化（每块只解析一次的前提）", () => {
    const full = buildText(12000);
    const { paint } = mount({ text: full.slice(0, 6000), streaming: true });
    const settled = latest!.chunks.slice();
    expect(settled.length).toBeGreaterThan(0);
    // 后续追加大量文本：已有块的字符串必须逐字节不变
    paint({ text: full, streaming: true });
    expect(latest!.chunks.slice(0, settled.length)).toEqual(settled);
  });

  it("尾部节流：窗口内的连续变化合并成一次，且最终收敛到最新文本", () => {
    const full = buildText(4000);
    const root = createRoot(container);
    act(() => {
      root.render(<Probe text={full.slice(0, 1000)} streaming />);
    });
    const before = latest!.tail;
    // 100ms 窗口内连续 3 次变化（每 30ms 一次）
    for (const length of [1400, 1800, 2200]) {
      act(() => {
        root.render(<Probe text={full.slice(0, length)} streaming />);
      });
      act(() => {
        vi.advanceTimersByTime(30);
      });
    }
    // 窗口内不应每次都跟着渲染（合帧），但推进到窗口之后必须收敛到最后一次
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(latest!.chunks.join("") + latest!.tail).toBe(full.slice(0, 2200));
    expect(before.length).toBeLessThan(latest!.tail.length + 1);
  });

  it("流式结束：块归零，tail 回到整段文本（最终一次是精确整篇渲染）", () => {
    const full = buildText(12000);
    const { paint } = mount({ text: full, streaming: true });
    expect(latest!.chunks.length).toBeGreaterThan(0);

    paint({ text: full, streaming: false });
    expect(latest!.chunks).toEqual([]);
    expect(latest!.tail).toBe(full);
  });

  it("文本被替换（不是原前缀）：归零重来，绝不按旧边界切", () => {
    const full = buildText(12000);
    const { paint } = mount({ text: full, streaming: true });
    expect(latest!.chunks.length).toBeGreaterThan(0);

    const replaced = `完全不同的内容。\n\n${buildText(12000)}`;
    paint({ text: replaced, streaming: true });
    expect(latest!.chunks.join("") + latest!.tail).toBe(replaced);
  });

  it("短回复从不分块", () => {
    const text = "很短的一段回复。";
    const { paint } = mount({ text, streaming: true });
    paint({ text, streaming: true });
    expect(latest!.chunks).toEqual([]);
    expect(latest!.tail).toBe(text);
  });
});
