/**
 * 大文档预览的块规划器（2026-11-02，参考 deepseek-harness 的 incremental.ts）。
 *
 * **为什么需要它**：右侧预览是一次性渲染的（文件先整篇读进内存），卡顿来自
 * 「整篇 markdown 一次解析 + 一次建 React 树」。实测（SSR 口径，本机快机）：
 * 120KB 0.52s、300KB 0.96–1.67s、600KB 3.0s、1MB 4.4–6.0s；工作区的
 * `docs/迭代记录/2026-09.md` 就有 328KB。而 `parseRichContent` 给不出可用的
 * 细粒度分段——带围栏的 301KB 文档实测只产出 **1 个 markdown segment**（匿名围栏
 * 的文本段会被 mergeMarkdownSegments 合并回去），所以必须在段内再切块。
 *
 * **实测收益**：301KB 切成 124 块（p50 2.5KB）后，首 2 块 52ms / 首 3 块 83ms；
 * 全部块逐个渲染合计 1584ms ≈ 整篇 1672ms——分块本身不放大总成本，只是把成本
 * 挪到滚动时按需支付（配合 components/MarkdownBlocks.tsx 的窗口化挂载）。
 *
 * **切分规则**（与 dsh 的「按 mdast position 冻结顶层块」等价，但不引入新依赖）：
 * 1. 围栏（``` / ~~~，闭合需同字符且长度不短于开围栏）内部永不切；
 * 2. 围栏外、行首的 ATX 标题（`^ {0,3}#{1,6}\s`）是首选切点——标题总能打断段落/
 *    列表/引用，是天然的顶层块边界；
 * 3. 围栏外、空行之后，累积长度到 maxChars 时切，但要先过 isSafeBoundary 的否决表
 *    （引用式定义会向后生效、松列表/松引用/缩进代码跨空行仍是同一块）；
 *    maxChars 是软约束——只在「已经有的块已经够长」时切，所以单块最多超出一个段落；
 * 4. 剩下的单个结构（例如一整块 200KB 的围栏）保留为 oversize 块，不硬切。
 *
 * **陷阱（都踩过/量过，别改回去）**：
 * - 切点候选必须单遍扫描：早期探针每遇候选就把已读的行重新拼一遍（O(n²)），1MB 实测
 *   **4.6s**；现在单遍 302k 字符 9.7ms、1MB 18.4ms。`markdown-blocks.test.ts` 里有一
 *   条 200KB < 50ms 的性能护栏。
 * - 块包装（见 MarkdownBlocks 的 `.markdown-block`）**不能**加 padding/border/
 *   overflow/contain：那会阻断块间外边距折叠，标题与段落的间距会变成两倍。
 * - 这里只处理 markdown 段文本；`parseRichContent` 已经把 HTML/artifact/mermaid
 *   切出去了，所以块内不会再遇到块级 HTML（`<div>` 开头的文本已经不在 markdown 段）。
 */

/** 低于此长度的预览走原路径（整篇一次渲染），不给小文档套一层包装。 */
export const PREVIEW_WINDOW_MIN_CHARS = 40_000;
/** 标题切点的最小块长：太小的块会让块数/占位 DOM 数失控。 */
export const BLOCK_MIN_CHARS = 2_000;
/** 空行切点的最大块长：没有标题的文档靠它把块压到「一次挂载 20–40ms」的量级。 */
export const BLOCK_MAX_CHARS = 6_000;
/** 首屏同步挂载的累计字符预算（实测 4 块 ≈ 10KB ≈ 60–80ms）。 */
export const INITIAL_MOUNT_CHARS = 12_000;
/** 首屏同步挂载的块数上限（标题密集的文档避免一次挂太多小块）。 */
export const INITIAL_MOUNT_MAX_BLOCKS = 4;
/** 视口上下各扩展多少（IntersectionObserver rootMargin）：约 1.2 屏。 */
export const BLOCK_OBSERVER_MARGIN = "120% 0px";

export interface MarkdownBlock {
  /** 段内起始偏移（含）。 */
  start: number;
  /** 段内结束偏移（独占）：`text === source.slice(start, end)`。 */
  end: number;
  /** 全文档 1-based 起始行号（段起始行 + 段内行偏移），供大纲对齐与跳转使用。 */
  startLine: number;
  text: string;
  /** 单个结构（超长围栏、整段无空行）导致超过 maxChars：保留整块，不做二次切分。 */
  oversize: boolean;
}

export interface MarkdownBlockOptions {
  minChars?: number;
  maxChars?: number;
  /** 本段文本在整篇里的起始行号（1-based）；跨段规划时由调用方传入。 */
  baseLine?: number;
}

/** 列表项行（`- x` / `* x` / `+ x` / `1. x` / `1) x`）。 */
const LIST_ITEM_PATTERN = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/u;
/** 引用块行。 */
const QUOTE_PATTERN = /^ {0,3}>/u;
/** 引用式链接/脚注定义 `[id]: url`——定义向后生效，切到前面会让引用退化成字面文本。 */
const REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[[^\]]*\]:/u;
/** 缩进行（4 空格/制表符）——缩进代码块允许内含空行，切开会变成两个代码块。 */
const INDENTED_LINE_PATTERN = /^(?: {4}|\t)/u;
/**
 * 行首的无序列表项（`- x` / `* x` / `+ x`，必须顶格）。
 * 允许在它前面切：无序列表拆成两段只多一点外边距，不会像有序列表那样重新从 1 编号。
 * 真实场景：`docs/迭代记录/2026-09.md` 是 145 条 `* [X]` 组成的超长松列表，只按
 * 空行切时退化成 4 块（等于没切），必须靠这条把大文件真正分片。
 */
const UNORDERED_ITEM_PATTERN = /^(?:[-*+])\s/u;
/** 行首 ATX 标题。 */
const HEADING_PATTERN = /^ {0,3}#{1,6}\s/u;

interface FenceState {
  marker: string;
  length: number;
}

function openingFence(line: string): FenceState | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
  if (!match) return undefined;
  const marker = match[1]!;
  // 反引号围栏的信息串里不能再出现反引号（CommonMark 规定），否则那是行内代码。
  if (marker[0] === "`" && (match[2] ?? "").includes("`")) return undefined;
  return { marker: marker[0]!, length: marker.length };
}

function closesFence(line: string, fence: FenceState): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fence.length) return false;
  for (const character of trimmed) if (character !== fence.marker) return false;
  return true;
}

/**
 * 跨过这个空行会不会改变渲染结果？只否决可判定的危险形态；残余差异（例如
 * setext 标题被拆开）由「只在空行且不在围栏内才切」这条硬约束兜住。
 */
export function isSafeBlockBoundary(previousNonEmptyLine: string, nextLine: string): boolean {
  if (REFERENCE_DEFINITION_PATTERN.test(nextLine)) return false;
  if (LIST_ITEM_PATTERN.test(previousNonEmptyLine) && LIST_ITEM_PATTERN.test(nextLine)) return false;
  if (QUOTE_PATTERN.test(previousNonEmptyLine) && QUOTE_PATTERN.test(nextLine)) return false;
  if (INDENTED_LINE_PATTERN.test(previousNonEmptyLine) && INDENTED_LINE_PATTERN.test(nextLine)) return false;
  return true;
}

function pushBlock(blocks: MarkdownBlock[], text: string, start: number, end: number, startLine: number, maxChars: number): void {
  if (end <= start) return;
  blocks.push({ start, end, startLine, text: text.slice(start, end), oversize: end - start > maxChars });
}

/**
 * 把一段 markdown 切成顶层块。纯函数、单遍扫描；不变量见文件头与测试：
 * `blocks.map(b => b.text).join("") === text`、块首尾相接、结束位置不在围栏内。
 */
export function planMarkdownBlocks(text: string, options: MarkdownBlockOptions = {}): MarkdownBlock[] {
  const minChars = options.minChars ?? BLOCK_MIN_CHARS;
  const maxChars = options.maxChars ?? BLOCK_MAX_CHARS;
  const baseLine = options.baseLine ?? 1;
  if (!text) return [];

  const blocks: MarkdownBlock[] = [];
  let offset = 0;
  let lineNo = baseLine;
  let blockStart = 0;
  let blockStartLine = baseLine;
  let fence: FenceState | undefined;
  let previousNonEmptyLine = "";
  let previousLineBlank = false;

  const cut = (end: number, line: number): void => {
    pushBlock(blocks, text, blockStart, end, blockStartLine, maxChars);
    blockStart = end;
    blockStartLine = line;
  };

  while (offset <= text.length) {
    const nextBreak = text.indexOf("\n", offset);
    const lineEnd = nextBreak < 0 ? text.length : nextBreak;
    const line = text.slice(offset, lineEnd);

    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
    } else {
      const opening = openingFence(line);
      if (opening) {
        fence = opening;
      } else if (HEADING_PATTERN.test(line)) {
        // 标题是首选切点：它总能打断段落/列表/引用，切在这里语义不变。
        if (offset - blockStart >= minChars) cut(offset, lineNo);
      } else if (UNORDERED_ITEM_PATTERN.test(line) && offset - blockStart >= maxChars) {
        // 超长无序列表：顶格条目是安全的顶层边界（有序列表不切，否则编号会重新开始）。
        cut(offset, lineNo);
      } else if (previousLineBlank && offset > blockStart && offset - blockStart >= maxChars) {
        // 没有标题的文档：攒到上限后在安全空行处切。
        if (isSafeBlockBoundary(previousNonEmptyLine, line)) cut(offset, lineNo);
      }
    }

    const blank = line.trim().length === 0;
    if (!blank) previousNonEmptyLine = line;
    previousLineBlank = blank;
    if (nextBreak < 0) break;
    offset = nextBreak + 1;
    lineNo += 1;
  }

  pushBlock(blocks, text, blockStart, text.length, blockStartLine, maxChars);
  return blocks;
}

/**
 * 未挂载块的占位高度（px）。只影响「从未滚到过的区域」的滚动条刻度：
 * 滚到后会被实测高度取代，并做一次 scrollTop 补偿（见 MarkdownBlocks）。
 * 中文按 42 字/行、行高 25px 估；来源行数与折算行数取大者（表格/代码行更密）。
 */
export function estimateMarkdownBlockHeight(text: string): number {
  let sourceLines = 1;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) sourceLines += 1;
  const wrapped = Math.ceil(text.length / 42);
  const visual = Math.max(sourceLines, wrapped);
  return Math.min(8_000, Math.max(120, visual * 25 + 32));
}

/**
 * 首屏同步挂载的块数：按累计字符预算取，且不超过块数上限。
 * 纯函数便于单测（渲染组件只需要它的结果，不关心实现）。
 */
export function initialMountCount(blocks: readonly MarkdownBlock[], charBudget = INITIAL_MOUNT_CHARS, maxBlocks = INITIAL_MOUNT_MAX_BLOCKS): number {
  let chars = 0;
  let count = 0;
  for (const block of blocks) {
    if (count >= maxBlocks) break;
    chars += block.text.length;
    count += 1;
    if (chars >= charBudget) break;
  }
  return count;
}
