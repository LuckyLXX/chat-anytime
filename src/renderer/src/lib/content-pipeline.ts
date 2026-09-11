import { withDynamicArtifactFlag, type Artifact } from "./content";

export type RichContentSegment =
  | { type: "markdown"; content: string }
  | { type: "html"; content: string; source: "assistant-html" | "fragment"; closed?: boolean }
  | { type: "mermaid"; content: string; language: string }
  | { type: "artifact"; artifact: Omit<Artifact, "id"> };

export interface RichContentParseOptions {
  isStreaming?: boolean;
}

const htmlBlockPattern = /^\s*<(?:style|div|section|article|aside|header|footer|nav|main|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|blockquote|figure|figcaption|details|summary|form|fieldset|label|button|img|video|audio|canvas|svg|p)\b/i;
const mermaidLanguages = new Set(["mermaid", "flowchart", "graph"]);
const epiloguePattern = /(总结|综上|以上就是|希望|祝你|如有|欢迎|随时|供你参考|希望对你|希望能|如果有|需要的话|如果还|麻烦|谢谢|感谢|辛苦|愉快|顺利|提问|哈|哦|呢|吧|哟)\s*[!?。！？~…]?\s*$/u;

function isFullHtmlDocument(text: string): boolean {
  return /^<!doctype\s/i.test(text) || /^<html\b/i.test(text) || /^<body\b/i.test(text);
}

function createHtmlArtifact(content: string, title = "HTML 预览"): Omit<Artifact, "id"> {
  return withDynamicArtifactFlag({ title, language: "html", content });
}

function looksLikeShellTranscript(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  const lineCount = raw.split(/\r?\n/u).filter(Boolean).length;
  if (lineCount < 4) return false;
  return /^\[(?:shell|cwd|stdout|stderr|退出码)\]/i.test(raw)
    || /^diff --git\s/i.test(raw)
    || /^index [0-9a-f]+\.{2}[0-9a-f]+/i.test(raw)
    || /^@@\s.+\s@@/.test(raw);
}

function looksLikeUnifiedDiff(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  return /^diff --git\s.+/i.test(raw)
    || (/^---\s(?:a\/|\/dev\/null)/.test(raw) && /^\+\+\+\s(?:b\/|\/dev\/null)/m.test(raw))
    || /^@@\s.+\s@@/.test(raw);
}

// ── 数学语法探测（KaTeX 按需启用） ────────────────────────────────────────
//
// 完整管线里 rehypeKatex 占据近一半的解析耗时（318KB 输入实测 +540ms），而中文
// 文档里的 `$ARGUMENTS`、`${sessionId}`、`价格 $100 到 $200 元` 会被当 LaTeX 解析，
// 除了变慢还会持续刷 `LaTeX-incompatible input` 警告。这里用启发式判断「这份文本
// 里是否真有 LaTeX」，无数学时不装配 remarkMath/rehypeKatex。
//
// 两道闸：① 候选段内不含反引号与空行（排除代码片段误配）；② 候选段内必须命中
// LaTeX 特征（反斜杠命令 / 上下标 / 等式）。任意一对 `$...$`、`$$...$$` 通过即真。
const latexCommandPattern = /\\[a-zA-Z]{2,}/u;
const latexScriptPattern = /[A-Za-z0-9)\]}*]\s*[\^_]\s*[A-Za-z0-9({\\]/u;
const latexEquationPattern = /[A-Za-z0-9)\]}*]\s*=\s*[A-Za-z0-9({\[]/u;
/** 候选段长度上限：越过它的「配对」几乎一定是两处无关的 `$` 之间夹了整段正文。 */
const MATH_CANDIDATE_LIMIT = 400;
/** 扫描的 `$` 数量上限（极端文本的保护；正常文档远低于此）。 */
const MATH_DOLLAR_SCAN_LIMIT = 500;

/** 把围栏代码块与行内代码清空，避免代码里的 `$x$` 被当成数学。 */
function stripCodeForMathScan(text: string): string {
  const out: string[] = [];
  let fence: { marker: string } | undefined;
  for (const line of text.split("\n")) {
    if (!fence) {
      const opening = isFenceLine(line);
      if (opening) {
        fence = { marker: opening.marker };
        out.push("");
        continue;
      }
      out.push(line.replace(/`[^`]*`/gu, " "));
      continue;
    }
    if (isClosingFence(line, fence.marker)) fence = undefined;
    out.push("");
  }
  return out.join("\n");
}

function isMathCandidate(body: string): boolean {
  const value = body.trim();
  if (!value || value.length > MATH_CANDIDATE_LIMIT) return false;
  if (value.includes("`")) return false;
  if (/\n[ \t]*\n/u.test(value)) return false;
  return latexCommandPattern.test(value) || latexScriptPattern.test(value) || latexEquationPattern.test(value);
}

/** 收集所有 `$$` 定界段的区间（先处理块级公式，再从扫描里挖掉）。 */
function displayMathSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of source.matchAll(/\$\$([\s\S]*?)\$\$/gu)) {
    if (isMathCandidate(match[1] ?? "")) return [[-1, -1]];
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length]);
  }
  return spans;
}

/**
 * 粗略判断 markdown 文本里是否含 LaTeX 数学语法（决定是否装配 KaTeX 插件）。
 * 纯函数、不依赖 DOM，误判代价是「无数学文档变慢」或「数学显示为原文」。
 */
export function hasMathSyntax(text: string): boolean {
  const source = stripCodeForMathScan(String(text ?? "").replace(/\r\n?/gu, "\n"));
  if (!source.includes("$")) return false;

  const display = displayMathSpans(source);
  if (display.length === 1 && display[0]![0] === -1) return true;
  // 挖掉已识别的 `$$...$$` 区间（保长度，避免后续下标错位）
  let scannable = source;
  for (const [start, end] of display) scannable = `${scannable.slice(0, start)}${" ".repeat(end - start)}${scannable.slice(end)}`;

  // 逐个 `$` 当作候选起点，取它之后**最近的** `$` 作终点。
  // 不做非重叠贪心配对：`$ARGUMENTS 与 $\frac{1}{2}$` 里第一个 `$` 会把真公式
  // 一起吞掉，导致漏判；从每一个 `$` 都试一次就能在后者处命中。
  const positions: number[] = [];
  for (let i = 0; i < scannable.length; i += 1) {
    if (scannable[i] !== "$") continue;
    positions.push(i);
    if (positions.length >= MATH_DOLLAR_SCAN_LIMIT) break;
  }
  for (let i = 0; i + 1 < positions.length; i += 1) {
    // 只把「最近的」下一个 `$` 当作终点：配对跨过另一个 `$` 时那不是公式定界
    //（`价格 $100 到 $200 元` 的两处 `$` 刚好配对但内容无数学特征，同样被否决）。
    if (isMathCandidate(scannable.slice(positions[i]! + 1, positions[i + 1]!))) return true;
  }
  return false;
}

// ── 文档大纲（标题提取 + GitHub 风格 slug） ────────────────────────────────

/** 文档大纲条目；`line` 是它在源文本里的行号（1 起），用于精确锚定渲染出的标题。 */
export interface MarkdownHeading {
  depth: number;
  text: string;
  index: number;
  id: string;
  /** 源文本行号（1 起）：react-markdown 的 `node.position.start.line` 用它对齐标题。 */
  line: number;
}

/**
 * GitHub 风格 slugger：小写、去标点、空格转 `-`、重名加数字后缀。
 * 与 dock-markdown 的 makeSlugger 同构（保留 CJK 字符，HTML5 id 允许）。
 */
export function createHeadingSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/gu, "-");
    const slug = base || "section";
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  };
}

/** 标题显示文本：去掉行内 markdown 标记（链接/图片/强调/行内代码/HTML 标签）。 */
function headingTextFromMarkdown(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/[*_~]{1,3}/gu, "")
    .replace(/<[^>]+>/gu, "")
    .trim();
}

/** 内部共用：扫描 markdown 文本里的标题行（`line` 为 1 起行号）。 */
function scanHeadings(text: string, slugger: (text: string) => string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { marker: string } | undefined;
  let line = 0;
  for (const raw of String(text ?? "").replace(/\r\n?/gu, "\n").split("\n")) {
    line += 1;
    if (!fence) {
      const opening = isFenceLine(raw);
      if (opening) {
        fence = { marker: opening.marker };
        continue;
      }
      const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(raw);
      if (!match) continue;
      const headingText = headingTextFromMarkdown(match[2] ?? "");
      if (!headingText) continue;
      headings.push({ depth: match[1]!.length, text: headingText, index: headings.length, id: slugger(headingText), line });
      continue;
    }
    if (isClosingFence(raw, fence.marker)) fence = undefined;
  }
  return headings;
}

/**
 * 从 markdown 源文本按行扫描标题（跳过围栏代码块内的 `#`），得到大纲列表。
 * 纯函数、不查 DOM。
 */
export function extractMarkdownHeadings(text: string): MarkdownHeading[] {
  return scanHeadings(text, createHeadingSlugger());
}

/**
 * 把「某个 markdown segment 的局部标题」对齐到「全文大纲条目」，返回「段内行号 → 全局条目」映射。
 *
 * 为什么需要对齐：`parseRichContent` 会把正文按围栏/HTML 片段切成多段，每段各自交给
 * 一个 `MarkdownSurface` 渲染，react-markdown 报的 `node.position.start.line` 是**段内**
 * 行号；而大纲是全文级别的。两边的标题（层级 + 文本）用同一套规范化扫描得到，按顺序
 * 匹配即可精确对齐，无需往 segment 里塞行号偏移。
 *
 * 对齐不上的标题（例如只在段内出现、与全文扫描不一致的异常情况）不入映射，调用方
 * 就不给它注 id——宁缺不锚错。
 */
export function alignSegmentHeadings(globalHeadings: MarkdownHeading[], segmentContent: string): Map<number, MarkdownHeading> {
  const aligned = new Map<number, MarkdownHeading>();
  if (globalHeadings.length === 0) return aligned;
  // 用一次性 slugger 取层级/文本/行号（id 不取，用全文那份）。
  const local = scanHeadings(segmentContent, createHeadingSlugger());
  let cursor = 0;
  for (const heading of local) {
    while (cursor < globalHeadings.length) {
      const candidate = globalHeadings[cursor]!;
      cursor += 1;
      if (candidate.depth === heading.depth && candidate.text === heading.text) {
        aligned.set(heading.line, candidate);
        break;
      }
    }
  }
  return aligned;
}

export function normalizeMermaidSource(code: string, language = "mermaid"): string {
  const normalized = String(code || "").replace(/[—–－]/gu, "--").trim();
  if (!normalized) return "";
  const normalizedLanguage = language.trim().toLowerCase();
  if ((normalizedLanguage === "flowchart" || normalizedLanguage === "graph") && !new RegExp(`^${normalizedLanguage}\\b`, "iu").test(normalized)) {
    return `${normalizedLanguage} ${normalized}`;
  }
  return normalized;
}

function isFenceLine(line: string): { marker: string; info: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
  return match ? { marker: match[1]!, info: match[2]!.trim() } : undefined;
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  const first = marker[0] ?? "";
  return trimmed.length >= marker.length
    && trimmed.startsWith(first)
    && [...trimmed].every((character) => character === first);
}

function findMatchingFenceEnd(raw: string, startIndex: number, marker: string): number {
  const openingLineEnd = raw.indexOf("\n", startIndex);
  if (openingLineEnd < 0) return -1;
  let lineStart = openingLineEnd + 1;
  while (lineStart < raw.length) {
    const lineEnd = raw.indexOf("\n", lineStart);
    const line = raw.slice(lineStart, lineEnd < 0 ? raw.length : lineEnd);
    if (isClosingFence(line, marker)) return lineEnd < 0 ? raw.length : lineEnd + 1;
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return -1;
}

function findInlineBlockEnd(raw: string, startIndex: number): number {
  const head = raw.slice(startIndex, startIndex + 32);
  if (!/^<assistant_html>/iu.test(head)) return -2;
  const closingTag = /<\/assistant_html>/giu;
  closingTag.lastIndex = startIndex + "<assistant_html>".length;
  const match = closingTag.exec(raw);
  return match ? match.index + match[0].length : -1;
}

/**
 * Return the end of the last complete structural block in a streamed reply.
 * Plain text is intentionally left in the tail so the caller can keep it
 * cheap to update while completed fences and HTML bubbles keep their DOM.
 */
export function findStableCutoff(text: string, previousCutoff = 0): number {
  const raw = String(text || "");
  const safePreviousCutoff = Math.min(Math.max(0, previousCutoff), raw.length);
  let index = safePreviousCutoff;
  let stableCutoff = safePreviousCutoff;

  while (index < raw.length) {
    const atLineStart = index === 0 || raw[index - 1] === "\n";
    if (atLineStart) {
      const lineEnd = raw.indexOf("\n", index);
      const line = raw.slice(index, lineEnd < 0 ? raw.length : lineEnd);
      const opening = isFenceLine(line);
      if (opening) {
        const fenceEnd = findMatchingFenceEnd(raw, index, opening.marker);
        if (fenceEnd < 0) return stableCutoff;
        stableCutoff = fenceEnd;
        index = fenceEnd;
        continue;
      }
    }

    if (raw[index] === "<") {
      const blockEnd = findInlineBlockEnd(raw, index);
      if (blockEnd === -1) return stableCutoff;
      if (blockEnd >= 0) {
        stableCutoff = blockEnd;
        index = blockEnd;
        continue;
      }
    }

    const nextLine = raw.indexOf("\n", index);
    index = nextLine < 0 ? raw.length : nextLine + 1;
  }

  return stableCutoff;
}

function normalizeTildeSpacing(line: string): string {
  return line.replace(/(^|[^\w/\\=~])~(?![\s~])/gu, "$1~ ");
}

function escapeHtmlText(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function mergeTrailingEpilogue(segments: RichContentSegment[], isStreaming = false): RichContentSegment[] {
  if (isStreaming) return segments;
  if (segments.length < 2) return segments;
  const lastIndex = segments.length - 1;
  const previous = segments[lastIndex - 1];
  const last = segments[lastIndex];
  if (previous?.type !== "html" || previous.source !== "assistant-html" || last?.type !== "markdown") return segments;

  const trimmed = last.content.trim();
  if (!trimmed || last.content.length > 160 || /^#{1,6}\s|^\|.*\||^>\s|^```|^<|^\*{1,2}\[|^-\s|^\d+\.\s/mu.test(trimmed) || !epiloguePattern.test(trimmed)) return segments;
  const epilogue = `<div class="ai-epilogue">${escapeHtmlText(trimmed).replace(/\n/gu, "<br />")}</div>`;
  return [
    ...segments.slice(0, lastIndex - 1),
    { ...previous, content: `${previous.content.trimEnd()}\n${epilogue}` }
  ];
}

function mergeMarkdownSegments(segments: RichContentSegment[]): RichContentSegment[] {
  const merged: RichContentSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (segment.type === "markdown" && previous?.type === "markdown") {
      // Adjacent reconstructed fences (e.g. an outer ```TEXT fence that gets
      // closed by an inner ``` fence) must keep their delimiter lines on
      // separate lines; concatenating them raw would fuse the trailing
      // closing fence with the next opening fence into one line like
      // ``````js, which breaks Markdown parsing downstream.
      const separator = previous.content.endsWith("\n") || segment.content.startsWith("\n") ? "" : "\n";
      previous.content += separator + segment.content;
    } else if (segment.type === "markdown" && !segment.content.trim()) {
      if (previous?.type === "markdown") previous.content += segment.content;
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function parseTextPart(text: string, options: RichContentParseOptions = {}): RichContentSegment[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/gu, "\n");
  const trimmed = normalized.trim();
  if (!trimmed) return [{ type: "markdown", content: normalized }];

  if (isFullHtmlDocument(trimmed)) {
    if (options.isStreaming) {
      return [{ type: "markdown", content: `\`\`\`html\n${trimmed}\n\`\`\`` }];
    }
    return [{ type: "artifact", artifact: createHtmlArtifact(trimmed) }];
  }

  // Shell transcripts and unified diffs are common assistant/tool output. Keep
  // them in a code surface so indentation, prefixes and +/- markers survive
  // Markdown parsing just as they do in ChatAnyTime.
  if (looksLikeUnifiedDiff(trimmed)) {
    return [{ type: "markdown", content: `\`\`\`diff\n${trimmed}\n\`\`\`` }];
  }
  if (looksLikeShellTranscript(trimmed)) {
    return [{ type: "markdown", content: `\`\`\`text\n${trimmed}\n\`\`\`` }];
  }

  if (htmlBlockPattern.test(trimmed)) {
    const artifact = createHtmlArtifact(trimmed);
    if (artifact.dynamic) return [{ type: "artifact", artifact }];
    return [{ type: "html", content: trimmed, source: "fragment" }];
  }

  const embeddedHtml = /\n\s*<(?:style|div|section|article|table|thead|tbody|tr|td|ul|ol|blockquote|details|img|svg)\b/i.exec(normalized);
  if (embeddedHtml && embeddedHtml.index !== undefined) {
    const before = normalized.slice(0, embeddedHtml.index);
    const after = normalized.slice(embeddedHtml.index).trim();
    const artifact = createHtmlArtifact(after);
    return [
      ...(before.trim() ? [{ type: "markdown", content: before } satisfies RichContentSegment] : []),
      artifact.dynamic
        ? { type: "artifact", artifact }
        : { type: "html", content: after, source: "fragment" }
    ];
  }

  return [{ type: "markdown", content: normalized }];
}

function parseAssistantHtmlPart(content: string, closed: boolean): RichContentSegment[] {
  const normalized = content.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];
  if (isFullHtmlDocument(normalized)) {
    return [{ type: "artifact", artifact: createHtmlArtifact(normalized) }];
  }
  return [{ type: "html", content: normalized, source: "assistant-html", ...(closed ? {} : { closed: false }) }];
}

function splitAssistantHtml(text: string, options: RichContentParseOptions): RichContentSegment[] {
  const segments: RichContentSegment[] = [];
  const pattern = /<assistant_html>([\s\S]*?)(<\/assistant_html>|$)/giu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push(...parseTextPart(text.slice(cursor, start), options));
    const content = match[1]?.trim();
    const isClosed = Boolean(match[2]);
    if (content) {
      // Assistant bubbles are rendered as soon as useful markup arrives. Scripts
      // remain inert until the matching closing tag is present and the turn ends.
      segments.push(...parseAssistantHtmlPart(content, isClosed));
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push(...parseTextPart(text.slice(cursor), options));
  return segments.length ? mergeTrailingEpilogue(segments, options.isStreaming) : parseTextPart(text, options);
}

function splitFencedContent(text: string, options: RichContentParseOptions = {}): RichContentSegment[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const segments: RichContentSegment[] = [];
  let markdownLines: string[] = [];
  let fence: { marker: string; info: string; lines: string[] } | undefined;

  function flushMarkdown(): void {
    if (markdownLines.length) {
      segments.push(...splitAssistantHtml(markdownLines.join("\n"), options));
      markdownLines = [];
    }
  }

  function flushFence(closed: boolean): void {
    if (!fence) return;
    const language = fence.info.split(/\s+/u)[0]?.toLowerCase() ?? "";
    const code = fence.lines.join("\n");
    if (closed && mermaidLanguages.has(language)) {
      segments.push({ type: "mermaid", content: normalizeMermaidSource(code, language), language });
    } else if (closed && (language === "html" || language === "svg") && !options.isStreaming) {
      segments.push({
        type: "artifact",
        artifact: withDynamicArtifactFlag({ title: language === "svg" ? "SVG 预览" : "HTML 预览", language, content: code })
      });
    } else {
      const opening = `${fence.marker}${fence.info}`;
      const closing = fence.marker[0]?.repeat(fence.marker.length) ?? "```";
      segments.push({ type: "markdown", content: `${opening}\n${code}\n${closing}` });
    }
    fence = undefined;
  }

  for (const line of lines) {
    if (!fence) {
      const opening = isFenceLine(line);
      if (opening) {
        flushMarkdown();
        fence = { marker: opening.marker, info: opening.info, lines: [] };
      } else {
        markdownLines.push(line);
      }
      continue;
    }
    if (fence.marker[0] === "`" && isClosingFence(line, fence.marker)) {
      flushFence(true);
    } else if (fence.marker[0] === "~" && isClosingFence(line, fence.marker)) {
      flushFence(true);
    } else {
      fence.lines.push(line);
    }
  }
  if (fence) flushFence(false);
  flushMarkdown();
  return mergeMarkdownSegments(segments);
}

/**
 * Normalizes the common malformed fence shapes produced during streaming while
 * keeping unfinished HTML/Markdown visible as text instead of executing it.
 */
export function normalizeRichContent(text: string): string {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  let activeFence: { marker: string } | undefined;
  return lines.map((line) => {
    const fence = isFenceLine(line);
    if (!activeFence) {
      if (!fence) {
        const normalizedLine = line.replace(/^(\s*)(<\/?(?:div|section|article|table|ul|ol|blockquote|details|img)\b)/iu, "$2");
        return normalizeTildeSpacing(normalizedLine);
      }
      activeFence = { marker: fence.marker };
      return line.trimStart();
    }

    if (isClosingFence(line, activeFence.marker)) {
      activeFence = undefined;
      return line.trimStart();
    }

    return line;
  }).join("\n");
}

export function parseRichContent(text: string, options: RichContentParseOptions = {}): RichContentSegment[] {
  const normalized = normalizeRichContent(text);
  if (!options.isStreaming) return splitFencedContent(normalized, options);

  const stableCutoff = findStableCutoff(normalized);
  if (stableCutoff <= 0 || stableCutoff >= normalized.length) return splitFencedContent(normalized, options);

  const stable = splitFencedContent(normalized.slice(0, stableCutoff), { ...options, isStreaming: false });
  const tail = splitFencedContent(normalized.slice(stableCutoff), options);
  return mergeTrailingEpilogue(mergeMarkdownSegments([...stable, ...tail]), false);
}
