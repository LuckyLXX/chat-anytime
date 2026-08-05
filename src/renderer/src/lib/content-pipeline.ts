import type { Artifact } from "./content";

export type RichContentSegment =
  | { type: "markdown"; content: string }
  | { type: "html"; content: string; source: "assistant-html" | "fragment" }
  | { type: "mermaid"; content: string; language: string }
  | { type: "artifact"; artifact: Omit<Artifact, "id"> };

export interface RichContentParseOptions {
  isStreaming?: boolean;
}

const htmlBlockPattern = /^\s*<(?:div|section|article|aside|header|footer|nav|main|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|blockquote|figure|figcaption|details|summary|form|fieldset|label|button|img|video|audio|canvas|svg|p)\b/i;
const mermaidLanguages = new Set(["mermaid", "flowchart", "graph"]);

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
      artifact: { title: "HTML 预览", language: "html", content: trimmed }
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

  const embeddedHtml = /\n\s*<(?:div|section|article|table|thead|tbody|tr|td|ul|ol|blockquote|details|img|svg)\b/i.exec(normalized);
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
    return [{ type: "artifact", artifact: { title: "HTML 预览", language: "html", content: normalized } }];
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
  return segments.length ? segments : parseTextPart(text, options);
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
        artifact: { title: language === "svg" ? "SVG 预览" : "HTML 预览", language, content: code }
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
  let inFence = false;
  return lines.map((line) => {
    const fence = isFenceLine(line);
    if (fence) {
      inFence = !inFence;
      return line.trimStart();
    }
    return inFence ? line : line.replace(/^(\s*)(<\/?(?:div|section|article|table|ul|ol|blockquote|details|img)\b)/iu, "$2");
  }).join("\n");
}

export function parseRichContent(text: string, options: RichContentParseOptions = {}): RichContentSegment[] {
  return splitFencedContent(normalizeRichContent(text), options);
}
