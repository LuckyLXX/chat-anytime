import type { Artifact } from "./content";

export type RichContentSegment =
  | { type: "markdown"; content: string }
  | { type: "html"; content: string; source: "assistant-html" | "fragment" }
  | { type: "mermaid"; content: string; language: string }
  | { type: "artifact"; artifact: Omit<Artifact, "id"> };

const htmlBlockPattern = /^\s*<(?:div|section|article|aside|header|footer|nav|main|table|ul|ol|dl|blockquote|figure|details|form|fieldset|img|video|audio|canvas|svg)\b/i;
const mermaidLanguages = new Set(["mermaid", "flowchart", "graph"]);

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

function parseTextPart(text: string): RichContentSegment[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/gu, "\n");
  const trimmed = normalized.trim();
  if (!trimmed) return [{ type: "markdown", content: normalized }];

  if (/^<!doctype\s/i.test(trimmed) || /^<html\b/i.test(trimmed)) {
    return [{
      type: "artifact",
      artifact: { title: "HTML 预览", language: "html", content: trimmed }
    }];
  }

  if (htmlBlockPattern.test(trimmed)) {
    return [{ type: "html", content: trimmed, source: "fragment" }];
  }

  const embeddedHtml = /\n\s*<(?:div|section|article|table|ul|ol|blockquote|details|img)\b/i.exec(normalized);
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

function splitAssistantHtml(text: string): RichContentSegment[] {
  const segments: RichContentSegment[] = [];
  const pattern = /<assistant_html>([\s\S]*?)(<\/assistant_html>|$)/giu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push(...parseTextPart(text.slice(cursor, start)));
    const content = match[1]?.trim();
    if (content) segments.push({ type: "html", content, source: "assistant-html" });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push(...parseTextPart(text.slice(cursor)));
  return segments.length ? segments : parseTextPart(text);
}

function splitFencedContent(text: string): RichContentSegment[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const segments: RichContentSegment[] = [];
  let markdownLines: string[] = [];
  let fence: { marker: string; info: string; lines: string[] } | undefined;

  function flushMarkdown(): void {
    if (markdownLines.length) {
      segments.push(...splitAssistantHtml(markdownLines.join("\n")));
      markdownLines = [];
    }
  }

  function flushFence(closed: boolean): void {
    if (!fence) return;
    const language = fence.info.split(/\s+/u)[0]?.toLowerCase() ?? "";
    const code = fence.lines.join("\n");
    if (closed && mermaidLanguages.has(language)) {
      segments.push({ type: "mermaid", content: code, language });
    } else if (closed && (language === "html" || language === "svg")) {
      segments.push({
        type: "artifact",
        artifact: { title: language === "svg" ? "SVG 预览" : "HTML 预览", language, content: code }
      });
    } else {
      const opening = `\`\`\`${fence.info}`;
      segments.push({ type: "markdown", content: `${opening}\n${code}\n\`\`\`` });
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

export function parseRichContent(text: string): RichContentSegment[] {
  return splitFencedContent(normalizeRichContent(text));
}
