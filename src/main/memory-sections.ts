import { MEMORY_OUTLINE_MAX_SECTIONS, MEMORY_SECTION_CHUNK_CHARS } from "../shared/memory.js";

/**
 * 记忆主题的分节模型（纯函数，无文件 IO）。
 *
 * 设计目标是把「整篇 10–30k 字」拆成可按需读取的节：
 * - H2/H3 标题是天然边界；读 H2 会包含它的 H3 子节，读 H3 只到下一节；
 * - 没有标题的主题、以及没有子标题的超大节，按段落切成「片段 1..N」；
 * - 目录只含标题、字数、首行预览，不含正文；
 * - 追加只改目标节末尾（或文末），不重写整篇。
 *
 * 这些函数不依赖 store，方便单测边界：围栏代码、CRLF、重复标题、空节等。
 */

export interface MemorySection {
  /** 1-based 序号，供 `section="2"` 使用。 */
  index: number;
  /** 不含 # 的标题；合成节为「概述」「正文」或「片段 N」。 */
  heading: string;
  /** Markdown 标题层级；合成节为 0。 */
  level: number;
  /** 在正文中的绝对字符偏移（标题节含标题行；片段从正文起始）。 */
  start: number;
  /** 结束偏移（不含）。 */
  end: number;
  chars: number;
  /** 首行预览（去掉列表符号/标题，折叠空白，≤80 字）。 */
  preview: string;
  /** 包含的更深层节数（仅 H2 可能有）。 */
  childCount: number;
  /** 目录/读取回执展示用标签。 */
  label: string;
}

interface RawHeading {
  level: number;
  heading: string;
  start: number;
  contentStart: number;
}

type RawKind = "preamble" | "heading" | "plain";

interface RawSection {
  heading: string;
  level: number;
  start: number;
  contentStart: number;
  end: number;
  kind: RawKind;
}

const HEADING_PATTERN = /^(#{2,3})\s+(.+?)\s*#*\s*$/u;
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/u;

/** 扫描行首 H2/H3；跳过 ``` / ~~~ 围栏中的伪标题。 */
function scanHeadings(content: string): RawHeading[] {
  const headings: RawHeading[] = [];
  let fenceChar: string | undefined;
  let fenceLength = 0;
  let offset = 0;
  while (offset <= content.length) {
    const newline = content.indexOf("\n", offset);
    const lineEnd = newline === -1 ? content.length : newline;
    let line = content.slice(offset, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);

    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        fenceChar = undefined;
        fenceLength = 0;
      }
    } else if (!fenceChar) {
      const heading = HEADING_PATTERN.exec(line);
      if (heading) {
        headings.push({
          level: heading[1]!.length,
          heading: heading[2]!.trim(),
          start: offset,
          contentStart: newline === -1 ? content.length : newline + 1
        });
      }
    }

    if (newline === -1) break;
    offset = newline + 1;
  }
  return headings;
}

function collapsePreview(text: string): string {
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  return firstLine
    .replace(/^[-*>#\s]+/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

function chunkRanges(content: string, start: number, end: number, maxChars: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = start;
  while (cursor < end) {
    let limit = Math.min(cursor + maxChars, end);
    if (limit < end) {
      const slice = content.slice(cursor, limit);
      const boundary = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\r\n\r\n"));
      if (boundary >= Math.floor(maxChars / 2)) limit = cursor + boundary;
    }
    if (limit <= cursor) limit = Math.min(cursor + maxChars, end);
    ranges.push({ start: cursor, end: limit });
    cursor = limit;
  }
  return ranges;
}

function sectionFromRaw(content: string, raw: RawSection, index: number): MemorySection {
  const text = content.slice(raw.start, raw.end);
  let previewSource = text;
  if (raw.kind === "heading") previewSource = text.replace(/^[^\n]*(\r?\n)?/u, "");
  if (raw.kind === "preamble") previewSource = text.replace(/^\s*#\s+[^\n]*(\r?\n)?/u, "");
  return {
    index,
    heading: raw.heading,
    level: raw.level,
    start: raw.start,
    end: raw.end,
    chars: raw.end - raw.start,
    preview: collapsePreview(previewSource),
    childCount: 0,
    label: raw.heading
  };
}

/**
 * 解析正文为分节列表。没有标题时整篇按段落切成片段；有标题时只把行首
 * H2/H3 当边界（H1 与前言归入「概述」，若前言除标题外为空则不生成）。
 */
export function splitMemorySections(content: string, maxChunkChars = MEMORY_SECTION_CHUNK_CHARS): MemorySection[] {
  const headings = scanHeadings(content);
  const rawSections: RawSection[] = [];

  if (headings.length === 0) {
    rawSections.push({ heading: "正文", level: 0, start: 0, contentStart: 0, end: content.length, kind: "plain" });
  } else {
    const firstHeading = headings[0]!;
    const preambleEnd = firstHeading.start;
    const preamble = content.slice(0, preambleEnd);
    if (preamble.replace(/^\s*#\s+[^\n]*(\r?\n)?/u, "").trim()) {
      rawSections.push({ heading: "概述", level: 0, start: 0, contentStart: 0, end: preambleEnd, kind: "preamble" });
    }
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index]!;
      let end = content.length;
      for (let next = index + 1; next < headings.length; next += 1) {
        if (headings[next]!.level <= heading.level) {
          end = headings[next]!.start;
          break;
        }
      }
      rawSections.push({
        heading: heading.heading,
        level: heading.level,
        start: heading.start,
        contentStart: heading.contentStart,
        end,
        kind: "heading"
      });
    }
  }

  // 计算子节数量；只有「没有子节且体积超过 chunk 上限」的节才继续切分，
  // 避免把已经能按 H3 读取的 H2 又切碎。
  const childCounts = rawSections.map((section) => rawSections.filter((candidate) => (
    candidate.start > section.start && candidate.start < section.end && candidate.level > section.level
  )).length);

  const result: MemorySection[] = [];
  rawSections.forEach((section, sectionIndex) => {
    const childCount = childCounts[sectionIndex] ?? 0;
    if (childCount === 0 && section.end - section.start > maxChunkChars) {
      // 标题节的片段从标题行之后开始，避免每个片段都带同一行标题；
      // 读完片段后工具回执会带上节标签，上下文不丢。
      const chunkStart = section.kind === "heading" ? Math.min(section.contentStart, section.end) : section.start;
      if (section.end - chunkStart > maxChunkChars || section.kind !== "heading") {
        const ranges = chunkRanges(content, chunkStart, section.end, maxChunkChars);
        ranges.forEach((range, rangeIndex) => {
          const label = section.kind === "plain"
            ? `片段 ${rangeIndex + 1}`
            : section.heading
              ? `${section.heading} · 片段 ${rangeIndex + 1}`
              : `片段 ${rangeIndex + 1}`;
          result.push({
            index: 0,
            heading: label,
            level: section.level,
            start: range.start,
            end: range.end,
            chars: range.end - range.start,
            preview: collapsePreview(content.slice(range.start, range.end).replace(/^\s*#\s+[^\n]*(\r?\n)?/u, "")),
            childCount: 0,
            label
          });
        });
        return;
      }
    }
    const mapped = sectionFromRaw(content, section, 0);
    mapped.childCount = childCount;
    result.push(mapped);
  });

  return result.map((section, index) => ({ ...section, index: index + 1 }));
}

/** 按编号/标题片段定位分节；找不到返回 undefined。 */
export function findMemorySection(sections: readonly MemorySection[], selector: string): MemorySection | undefined {
  const cleaned = selector.trim().replace(/^[#§\s]+/u, "").replace(/[:：\s]+$/u, "");
  if (!cleaned) return undefined;
  const lower = cleaned.toLowerCase();
  const exact = sections.find((section) => section.heading.toLowerCase() === lower || section.label.toLowerCase() === lower);
  if (exact) return exact;
  if (/^\d+$/u.test(cleaned)) {
    const index = Number(cleaned);
    return sections.find((section) => section.index === index);
  }
  const startsWith = sections.find((section) => section.heading.toLowerCase().startsWith(lower) || section.label.toLowerCase().startsWith(lower));
  if (startsWith) return startsWith;
  return sections.find((section) => section.heading.toLowerCase().includes(lower) || section.label.toLowerCase().includes(lower));
}

/** 目录行（不含主题头/尾注，由工具层拼装）。 */
export function outlineMemorySections(sections: readonly MemorySection[], maxSections = MEMORY_OUTLINE_MAX_SECTIONS): { lines: string[]; omitted: number } {
  const shown = sections.slice(0, maxSections);
  const lines = shown.map((section) => {
    const indent = section.level >= 3 ? "  " : "";
    const children = section.childCount > 0 ? `，含 ${section.childCount} 个子节` : "";
    const preview = section.preview ? ` — ${section.preview}` : "";
    return `${indent}- [${section.index}] ${section.label}（${section.chars.toLocaleString("en-US")} 字${children}）${preview}`;
  });
  return { lines, omitted: Math.max(0, sections.length - shown.length) };
}

/** 追加结果：新正文、目标节标签、是否新建了节。 */
export interface MemoryAppendResult {
  content: string;
  label: string;
  created: boolean;
}

/**
 * 追加到既有节末尾 / 文末；`section` 未命中且不是纯数字时在文末新建 `## section`。
 * 纯数字未命中视为错误（避免生成 `## 2` 这种无意义标题）。
 */
export function appendToMemoryContent(content: string, section: string | undefined, addition: string): MemoryAppendResult {
  const block = addition.trim();
  if (!block) throw new Error("追加内容不能为空");
  const sections = splitMemorySections(content);
  const selector = section?.trim();
  let target = selector ? findMemorySection(sections, selector) : undefined;

  // 传入父节标题、但父节已被切成片段时，追加应该落在最后一个片段之后，
  // 而不是插到第一节中间。
  if (target && target.label.includes(" · 片段 ") && !selector?.includes("片段")) {
    const parent = target.label.split(" · 片段 ")[0]!;
    const family = sections.filter((candidate) => candidate.label.startsWith(`${parent} · 片段 `));
    target = family[family.length - 1] ?? target;
  }

  if (target) {
    const before = content.slice(0, target.end).replace(/[ \t\r\n]+$/u, "");
    const after = content.slice(target.end).replace(/^[ \t\r\n]+/u, "");
    const next = after
      ? `${before}\n\n${block}\n\n${after}`
      : `${before}\n\n${block}\n`;
    return { content: next, label: target.label, created: false };
  }

  if (selector) {
    const cleaned = selector.replace(/^#+\s*/u, "").trim();
    if (/^[一二三四五六七八九十百]+$|^\d+$/u.test(cleaned)) {
      throw new Error(`没有找到第「${selector}」节；先用 memory_read 查看目录，或传一个标题名新建节`);
    }
    if (!cleaned) throw new Error("节标题不能为空");
    return {
      content: `${content.replace(/[ \t\r\n]+$/u, "")}\n\n## ${cleaned}\n\n${block}\n`,
      label: cleaned,
      created: true
    };
  }

  return { content: `${content.replace(/[ \t\r\n]+$/u, "")}\n\n${block}\n`, label: "末尾", created: false };
}
