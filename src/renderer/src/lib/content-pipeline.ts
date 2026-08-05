import { withDynamicArtifactFlag, type Artifact } from "./content";

export type RichContentSegment =
  | { type: "markdown"; content: string }
  | { type: "html"; content: string; source: "assistant-html" | "fragment" }
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
      previous.content += segment.content;
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
    return [{
      type: "artifact",
      artifact: withDynamicArtifactFlag({ title: "HTML 预览", language: "html", content: trimmed })
    }];
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
    return [{ type: "html", content: trimmed, source: "fragment" }];
  }

  const embeddedHtml = /\n\s*<(?:style|div|section|article|table|thead|tbody|tr|td|ul|ol|blockquote|details|img|svg)\b/i.exec(normalized);
  if (embeddedHtml && embeddedHtml.index !== undefined) {
    const before = normalized.slice(0, embeddedHtml.index);
    const after = normalized.slice(embeddedHtml.index).trim();
    return [
      ...(before.trim() ? [{ type: "markdown", content: before } satisfies RichContentSegment] : []),
      { type: "html", content: after, source: "fragment" }
    ];
  }

  return [{ type: "markdown", content: normalized }];
}

function parseAssistantHtmlPart(content: string, options: RichContentParseOptions): RichContentSegment[] {
  const normalized = content.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];
  if (isFullHtmlDocument(normalized)) {
    if (options.isStreaming) {
      return [{ type: "markdown", content: `\`\`\`html\n${normalized}\n\`\`\`` }];
    }
    return [{ type: "artifact", artifact: withDynamicArtifactFlag({ title: "HTML 预览", language: "html", content: normalized }) }];
  }
  return [{ type: "html", content: normalized, source: "assistant-html" }];
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
      // Keep assistant-authored HTML inert until the assistant turn is done.
      // This avoids repeatedly mounting half-written cards during streaming.
      if (!options.isStreaming) {
        segments.push(...parseAssistantHtmlPart(content, options));
      } else {
        segments.push({ type: "markdown", content: `\`\`\`html\n${content}\n\`\`\`` });
      }
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
