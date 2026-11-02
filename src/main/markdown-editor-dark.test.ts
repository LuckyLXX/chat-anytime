import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 编辑器深色表格契约（2026-11-02，用户报「编辑模式下表格的背景色没有适配深色模式」）。
 *
 * 根因：Vditor 的 `.vditor-reset table` 系列把行底色/斑马纹/边框写死成浅色
 * （#fafbfc / #fff / #dfe2e5 / #c6cbd1），它的 `.vditor--dark` 只换 CSS 变量，
 * 没覆盖这几条 ⇒ 深色模式下表格是一块浅色板 + 浅色字。
 *
 * 为什么是源码断言：happy-dom 不解析外部样式表，真值只能截图看；但「这几条规则
 * 在不在、有没有再写死浅色」用文本就能钉死（同 team-board-type-scale.test.ts 先例）。
 */
const here = dirname(fileURLToPath(import.meta.url));
// 读入即归一化行尾：CI（Windows runner，core.autocrlf=true）检出的是 CRLF。
const css = readFileSync(join(here, "../renderer/src/styles.css"), "utf8").replace(/\r\n/gu, "\n");

function slice(from: string, to: string): string {
  const start = css.indexOf(from);
  if (start < 0) return "";
  const end = css.indexOf(to, start);
  return css.slice(start, end < 0 ? css.length : end);
}

describe("编辑器深色表格", () => {
  const block = slice(".markdown-editor-host .vditor-reset table tr {", ".markdown-editor-host .vditor-reset blockquote {");

  it("表格行 / 斑马纹 / 表头 / 单元格边框 / 分隔线 / kbd 都有覆盖规则", () => {
    expect(block).toContain("table tr { background-color: transparent; border-top: 1px solid var(--border); }");
    expect(block).toContain("table tbody tr:nth-child(2n) { background-color: color-mix(in srgb, var(--surface-raised) 55%, transparent); }");
    expect(block).toContain("table th { background-color: var(--surface-raised); }");
    expect(block).toContain("border: 1px solid var(--border);");
    expect(block).toContain("hr { background-color: var(--border); }");
    expect(block).toContain("kbd {");
  });

  it("不再残留 vditor 的浅色字面量", () => {
    for (const hardcoded of ["#fafbfc", "#fff", "#dfe2e5", "#c6cbd1", "#f6f8fa"]) {
      expect(block.toLowerCase()).not.toContain(hardcoded);
    }
  });

  it("所有颜色都走项目 token（主题可覆盖）", () => {
    const declarations = [...block.matchAll(/(?:background|background-color|border|border-top|border-color|color|box-shadow):([^;]+);/g)].map((match) => match[1]!);
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      if (declaration.includes("transparent") || declaration.includes("color-mix")) continue;
      expect(declaration).toContain("var(--");
    }
  });
});

describe("分块预览的块容器样式", () => {
  const block = slice(".markdown-block { display: block; }", ".preview-markdown-shell {");

  it("块包装是零样式（不阻断外边距折叠）", () => {
    const rule = block.match(/\.markdown-block \{([^}]*)\}/)?.[1] ?? "";
    expect(rule.trim()).toBe("display: block;");
    for (const forbidden of ["contain", "overflow", "padding", "border-width", "content-visibility"]) {
      expect(rule).not.toContain(forbidden);
    }
  });

  it("首末块的上下外边距被抹平（与整篇渲染的首末元素一致）", () => {
    expect(block).toContain(".rich-content > .markdown-blocks:first-child > .markdown-block:first-child .markdown-surface > :first-child { margin-top: 0; }");
    expect(block).toContain(".rich-content > .markdown-blocks:last-child > .markdown-block:last-child .markdown-surface > :last-child { margin-bottom: 0; }");
  });
});
