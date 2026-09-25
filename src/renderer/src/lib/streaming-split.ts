import { useEffect, useMemo, useRef, useState } from "react";
import { safeSplitLimit } from "./content-pipeline";

/**
 * 流式长回复的增量渲染（2026-09-25 P1）。
 *
 * 问题（实测）：流式期间整篇 markdown 每帧（20fps）被 react-markdown 从头解析
 * 一遍，代价与文本长度线性相关——20KB 纯段落 63ms/帧、20KB 带列表表格 150ms/帧、
 * 50KB 结构化的 219ms/帧。核心解析本身占绝大部分（20KB：ReactMarkdown 核心 63ms
 * / 加满插件 70ms），不是插件或 sanitize 的锅。真实分布：assistant 文本 p50 仅 56
 * 字符，≥2K 字符只占 1.8%（但占全部字符 46.8%）——卡顿集中在长回复上。
 *
 * 修法（两件事，缺一不可）：
 * ① **多块冻结**：把已定稿的文本按「安全空行边界」切成若干块，每块渲染一次后
 *    内容永不变化 → 由 memo 化的块组件接管，React 直接跳过其子树。每块只解析
 *    一次，整段回复的增量渲染总工作量是 O(N)，每帧只剩尾部（有界）。
 *    ⚠️ 曾经的错误做法是「单块前缀」：每次前推都要重解析**整个**前缀，是 O(N²)
 *    的变体——实测比不改还慢 13%（37 次前缀重解析 ≈ 2220ms）。别再改回去。
 * ② **尾部节流**：尾部仍是每帧重渲染的部分，按 STREAM_TAIL_THROTTLE_MS 合帧
 *    （始终渲染最新文本，只是不每帧渲染），把「尾部 20fps」降到 10fps。
 *
 * 已知取舍（明确记录）：块边界会把文档切开渲染，而 markdown 是上下文敏感的——
 * 跨边界的松列表间距、引用式链接定义、setext 标题在**流式期间**可能与整篇渲染
 * 有细微差异。三道防线：① 边界只取空行处且逐条否决危险形态（见
 * isSafeFreezeBoundary）；② 不变量「各块 + 尾部 === 当前文本」由测试钉死；
 * ③ 流式结束后块归零，整篇以一次精确解析渲染，最终结果与改动前完全一致。
 */

/** 长于此长度才启用分块（低于它的回复本体就很便宜，走原路径）。 */
export const STREAM_SPLIT_MIN_CHARS = 4096;
/** 新冻结块的最小长度（太小的块会让边界数量与组件数失控）。 */
export const STREAM_CHUNK_MIN_CHARS = 1200;
/** 冻结后尾部至少保留的字符数（视野里正在写的这段始终是「活」的）。 */
export const STREAM_TAIL_MIN_CHARS = 800;
/** 尾部重渲染的合帧间隔（流式期间最多 10fps；内容不变时零成本）。 */
export const STREAM_TAIL_THROTTLE_MS = 100;

/** 列表项行（`- x` / `* x` / `+ x` / `1. x` / `1) x`）。 */
const LIST_ITEM_PATTERN = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/u;
/** 引用块行。 */
const QUOTE_PATTERN = /^ {0,3}>/u;
/** 引用式链接/脚注定义 `[id]: url`。 */
const REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[[^\]]*\]:/u;
/** 缩进行（4 空格/制表符）——缩进代码块允许内含空行，切开会变成两个代码块。 */
const INDENTED_LINE_PATTERN = /^(?: {4}|\t)/u;

const EMPTY_CHUNKS: string[] = [];

/**
 * 从 `cursor` 往前找最近的一个「空行之后的下一行行首」位置；找不到返回 -1。
 * 空行允许只含空格/制表符。
 */
function blankLineBoundary(text: string, cursor: number): number {
  let best = -1;
  let index = 0;
  while (index < cursor) {
    const lineEnd = text.indexOf("\n", index);
    const end = lineEnd < 0 ? text.length : lineEnd + 1;
    const line = text.slice(index, lineEnd < 0 ? text.length : lineEnd);
    if (!line.trim()) {
      if (end <= cursor) best = end;
      else break;
    }
    if (lineEnd < 0) break;
    index = end;
  }
  return best;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim()) return line;
  }
  return "";
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim()) return line;
  }
  return "";
}

/**
 * 切分点是否安全：跨过它拆成两篇 markdown 后，**不**会产生与整篇渲染不同的结果。
 * 只否决可判定的危险情形，其余照切（残余差异由流式结束时的整篇精确渲染兜底）。
 */
export function isSafeFreezeBoundary(text: string, boundary: number): boolean {
  const nextLine = firstNonEmptyLine(text.slice(boundary));
  if (!nextLine) return false;
  // 引用式定义会「向后」生效：切到尾部后，前缀里的引用链接会退化成字面文本。
  if (REFERENCE_DEFINITION_PATTERN.test(nextLine)) return false;
  const lastLine = lastNonEmptyLine(text.slice(0, boundary));
  if (!lastLine) return false;
  // 松列表（空行分隔的列表项）与松散引用块会被切成两个块，间距不同。
  if (LIST_ITEM_PATTERN.test(lastLine) && LIST_ITEM_PATTERN.test(nextLine)) return false;
  if (QUOTE_PATTERN.test(lastLine) && QUOTE_PATTERN.test(nextLine)) return false;
  // 缩进代码块允许内含空行，切开会从「一个代码块」变成两个。
  if (INDENTED_LINE_PATTERN.test(lastLine) && INDENTED_LINE_PATTERN.test(nextLine)) return false;
  return true;
}

/**
 * 规划下一个冻结边界（返回该位置；`frozenLength` = 不推进）。
 * 纯函数，便于逐条钉住边界规则。
 */
export function planChunkFreeze(text: string, frozenLength: number): number {
  if (text.length < STREAM_SPLIT_MIN_CHARS) return 0;
  if (text.length - frozenLength < STREAM_TAIL_MIN_CHARS + STREAM_CHUNK_MIN_CHARS) return frozenLength;
  // 边界不得越过未闭合的围栏/HTML 块（safeSplitLimit），且冻结后要留足尾部。
  const limit = Math.min(safeSplitLimit(text), text.length - STREAM_TAIL_MIN_CHARS);
  if (limit - frozenLength < STREAM_CHUNK_MIN_CHARS) return frozenLength;
  let cursor = limit;
  // 最多回退几个空行候选，避免在一段长列表里来回扫。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const boundary = blankLineBoundary(text, cursor);
    if (boundary - frozenLength < STREAM_CHUNK_MIN_CHARS) return frozenLength;
    if (isSafeFreezeBoundary(text, boundary)) return boundary;
    cursor = boundary - 1;
  }
  return frozenLength;
}

export interface StreamingChunks {
  /** 已定稿的文本块（每块内容永不变化，渲染一次后由 memo 接管）。 */
  chunks: string[];
  /** 仍在增长的尾部（未启用分块时等于整段文本）。 */
  tail: string;
}

/**
 * 维护分块状态。不变量：`chunks.join("") + tail === shown`，且 `shown` 是当前
 * 文本的前缀（节流窗口内可能少最后几百毫秒）。文本被替换（重生成）时整体归零，
 * 绝不按旧边界切。
 */
export function useStreamingChunks(text: string, streaming: boolean): StreamingChunks {
  const [chunks, setChunks] = useState<string[]>(EMPTY_CHUNKS);
  const [shown, setShown] = useState(text);

  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  });

  // ② 尾部节流：内容变化时排一次刷新，但在途的刷新不重复排（否则每帧变化会把
  //    定时器一直往后推、显示永久卡住）。内容停止变化后这次刷新仍会落地。
  const pendingRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!streaming) {
      if (pendingRef.current !== undefined) {
        clearTimeout(pendingRef.current);
        pendingRef.current = undefined;
      }
      setShown(text);
      return;
    }
    if (text === shown) return;
    if (pendingRef.current !== undefined) return;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = undefined;
      setShown(textRef.current);
    }, STREAM_TAIL_THROTTLE_MS);
  }, [text, streaming, shown]);

  useEffect(() => () => {
    if (pendingRef.current !== undefined) clearTimeout(pendingRef.current);
  }, []);

  // ① 分块：每次推进只把「新增的那一段」切出去，已冻结的块不再重算。
  useEffect(() => {
    const frozenLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!streaming) {
      if (chunks.length > 0) setChunks(EMPTY_CHUNKS);
      return;
    }
    if (frozenLength > shown.length || frozenLength > text.length) {
      setChunks(EMPTY_CHUNKS);
      return;
    }
    // 文本被替换（不是原前缀）→ 归零重来。只校验最后一块，代价是 O(块长) 的 memcmp。
    if (chunks.length > 0) {
      const last = chunks[chunks.length - 1]!;
      const offset = frozenLength - last.length;
      if (!shown.startsWith(last, offset)) {
        setChunks(EMPTY_CHUNKS);
        return;
      }
    }
    const next = planChunkFreeze(shown, frozenLength);
    if (next > frozenLength) setChunks([...chunks, shown.slice(frozenLength, next)]);
  }, [shown, text, streaming, chunks]);

  return useMemo(() => {
    const frozenLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (frozenLength === 0 || frozenLength >= shown.length) return { chunks: EMPTY_CHUNKS, tail: shown };
    return { chunks, tail: shown.slice(frozenLength) };
  }, [chunks, shown]);
}
