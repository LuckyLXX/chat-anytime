import { describe, expect, it } from "vitest";
import {
  appendToMemoryContent,
  findMemorySection,
  outlineMemorySections,
  splitMemorySections
} from "./memory-sections.js";

describe("memory sections", () => {
  it("parses H2/H3 boundaries, preamble and child counts", () => {
    const content = [
      "# 主题标题",
      "",
      "前言一句话。",
      "",
      "## 一、第一节",
      "正文 A。",
      "",
      "### 小节 A1",
      "正文 A1。",
      "",
      "## 二、第二节",
      "正文 B。",
      ""
    ].join("\n");

    const sections = splitMemorySections(content);
    expect(sections.map((section) => section.label)).toEqual(["概述", "一、第一节", "小节 A1", "二、第二节"]);
    const first = sections[1]!;
    expect(first.level).toBe(2);
    expect(first.childCount).toBe(1);
    expect(content.slice(first.start, first.end)).toContain("正文 A1");
    expect(sections[2]!.level).toBe(3);
    expect(sections[2]!.childCount).toBe(0);
    expect(sections[0]!.preview).toBe("前言一句话。");
    expect(findMemorySection(sections, "二")).toBe(sections[3]);
    expect(findMemorySection(sections, "3")).toBe(sections[2]);
    expect(findMemorySection(sections, "小节")).toBe(sections[2]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const content = [
      "## 真标题",
      "```md",
      "## 假标题",
      "```",
      "## 另一个真标题",
      "内容"
    ].join("\n");
    const sections = splitMemorySections(content);
    expect(sections.map((section) => section.label)).toEqual(["真标题", "另一个真标题"]);
  });

  it("chunks a topic without headings and finds a chunk by label or index", () => {
    const paragraph = "这是一段用于测试自动分段的文字。".repeat(50);
    const content = [paragraph, paragraph, paragraph].join("\n\n");
    const sections = splitMemorySections(content, 800);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[0]!.label).toBe("片段 1");
    expect(sections[0]!.preview.length).toBeLessThanOrEqual(80);
    expect(findMemorySection(sections, "片段 2")).toBe(sections[1]);
    expect(findMemorySection(sections, "2")).toBe(sections[1]);
  });

  it("chunks a huge heading section without children and appends to the last chunk", () => {
    const body = "细节段落。\n\n".repeat(900);
    const content = `## 二、大节\n${body}## 三、下一节\n尾部`;
    const sections = splitMemorySections(content);
    const chunks = sections.filter((section) => section.label.startsWith("二、大节 · 片段"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(sections.some((section) => section.label === "三、下一节")).toBe(true);

    const appended = appendToMemoryContent(content, "二、大节", "追加的一行");
    // 父节标题命中第一个片段，但追加应落在最后一个片段之后、三、下一节之前。
    expect(appended.label).toBe(`二、大节 · 片段 ${chunks.length}`);
    expect(appended.content.indexOf("追加的一行")).toBeGreaterThan(appended.content.indexOf("二、大节"));
    expect(appended.content.indexOf("追加的一行")).toBeLessThan(appended.content.indexOf("三、下一节"));
  });

  it("handles CRLF content", () => {
    const content = "## 一、A\r\n正文 A\r\n\r\n## 二、B\r\n正文 B\r\n";
    const sections = splitMemorySections(content);
    expect(sections.map((section) => section.label)).toEqual(["一、A", "二、B"]);
    const appended = appendToMemoryContent(content, "一、A", "新增");
    expect(appended.content).toContain("正文 A");
    expect(appended.content).toContain("新增");
    expect(appended.content).toContain("## 二、B");
    expect(appended.content.indexOf("新增")).toBeLessThan(appended.content.indexOf("## 二、B"));
  });

  it("builds an outline with sizes, child counts and omission", () => {
    const sections = Array.from({ length: 12 }, (_, index) => ({
      index: index + 1,
      heading: `节${index + 1}`,
      level: index % 2 === 0 ? 2 : 3,
      start: 0,
      end: 100,
      chars: 100 + index,
      preview: `预览${index + 1}`,
      childCount: index === 0 ? 2 : 0,
      label: `节${index + 1}`
    }));
    const outline = outlineMemorySections(sections, 5);
    expect(outline.lines).toHaveLength(5);
    expect(outline.omitted).toBe(7);
    expect(outline.lines[0]).toContain("[1] 节1（100 字，含 2 个子节）");
    expect(outline.lines[1]).toContain("  - [2]");
  });

  it("appends into an existing section, creates a new section, or appends at the end", () => {
    const content = "## 一、A\n正文 A\n\n## 二、B\n正文 B\n";
    const intoSection = appendToMemoryContent(content, "一", "新增 A");
    expect(intoSection.created).toBe(false);
    expect(intoSection.label).toBe("一、A");
    expect(intoSection.content).toContain("正文 A\n\n新增 A\n\n## 二、B");

    const newSection = appendToMemoryContent(content, "三、新节", "新增 C");
    expect(newSection.created).toBe(true);
    expect(newSection.content).toContain("## 三、新节\n\n新增 C");

    const atEnd = appendToMemoryContent(content, undefined, "结尾追加");
    expect(atEnd.label).toBe("末尾");
    expect(atEnd.content.endsWith("结尾追加\n")).toBe(true);

    expect(() => appendToMemoryContent(content, "9", "x")).toThrow("没有找到");
    expect(() => appendToMemoryContent(content, undefined, "   ")).toThrow("不能为空");
  });
});
