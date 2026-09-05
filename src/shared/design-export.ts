/**
 * 设计稿 → HTML+CSS 单文件导出（内联样式）。纯函数、零 DOM 依赖（utility
 * 与 renderer 都可直接用）。节点树展开规则与画布渲染（DesignNodeView）同构：
 * 绝对定位 div（left/top/width/height 内联）+ layout frame 走 flex。
 */

import type { DesignDoc, DesignLayout, DesignNode } from "./design-schema.js";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paddingCss(padding: NonNullable<DesignLayout["padding"]>): string | undefined {
  if (typeof padding === "number") return padding > 0 ? `padding:${padding}px;` : undefined;
  const top = padding.top ?? 0;
  const right = padding.right ?? 0;
  const bottom = padding.bottom ?? 0;
  const left = padding.left ?? 0;
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return undefined;
  return `padding:${top}px ${right}px ${bottom}px ${left}px;`;
}

function layoutCss(node: DesignNode): string {
  const layout = node.layout;
  if (!layout) return "";
  let css = "display:flex;";
  css += `flex-direction:${layout.direction === "column" ? "column" : "row"};`;
  if (layout.gap && layout.gap > 0) css += `gap:${layout.gap}px;`;
  if (layout.padding !== undefined) {
    const padding = paddingCss(layout.padding);
    if (padding) css += padding;
  }
  if (layout.justify) css += `justify-content:${layout.justify};`;
  if (layout.align) css += `align-items:${layout.align};`;
  return css;
}

/** 单节点共享的盒样式（画布与导出同一套内联样式语义）。 */
export function designNodeStyle(node: DesignNode): string {
  let css = `position:absolute;left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px;`;
  css += layoutCss(node);
  if (node.fill) css += `background:${node.fill};`;
  if (node.stroke) css += `border:${node.strokeWidth ?? 1}px solid ${node.stroke};`;
  if (node.radius) css += `border-radius:${node.radius}px;`;
  if (node.opacity !== undefined && node.opacity < 1) css += `opacity:${node.opacity};`;
  if (node.shadow) css += `box-shadow:${node.shadow};`;
  if (node.type === "text") {
    css += `font-size:${node.fontSize ?? 14}px;`;
    css += `font-weight:${node.fontWeight ?? 400};`;
    if (node.color) css += `color:${node.color};`;
    if (node.lineHeight) css += `line-height:${node.lineHeight};`;
    css += `text-align:${node.align ?? "left"};`;
    css += "white-space:pre-wrap;overflow-wrap:break-word;";
  }
  if (node.type === "image") css += "object-fit:cover;";
  return css;
}

function nodeHtml(node: DesignNode, indent: string): string {
  if (node.visible === false) return "";
  const style = designNodeStyle(node);
  const name = node.name ? ` data-name="${escapeHtml(node.name)}"` : "";
  if (node.type === "image") {
    const src = node.src ?? "";
    const alt = escapeHtml(node.name ?? "图片");
    return `${indent}<img src="${escapeHtml(src)}" alt="${alt}" style="${style}"${name} />\n`;
  }
  const open = `${indent}<div style="${style}"${name}>`;
  if (node.type === "text") {
    const content = escapeHtml(node.text ?? "");
    return `${open}${content}</div>\n`;
  }
  if (!node.children || node.children.length === 0) return `${open}</div>\n`;
  const inner = node.children.map((child) => nodeHtml(child, `${indent}  `)).join("");
  return `${open}\n${inner}${indent}</div>\n`;
}

/** 导出为可直接打开的 HTML 单文件（body margin 0、画布尺寸与背景）。 */
export function exportDesignHtml(doc: DesignDoc): string {
  const canvas = doc.canvas;
  const background = canvas.background ? `background:${canvas.background};` : "";
  const nodesHtml = doc.nodes.map((node) => nodeHtml(node, "    ")).join("");
  return `<!DOCTYPE html>
<!-- 由 PiDesktop 设计模式导出：${escapeHtml(doc.name)} -->
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(doc.name)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { background: ${canvas.background ? escapeHtml(canvas.background) : "transparent"}; }
  .pi-design-canvas { position: relative; width: ${canvas.width}px; height: ${canvas.height}px; ${background} overflow: hidden; }
  .pi-design-canvas img { display: block; }
</style>
</head>
<body>
  <div class="pi-design-canvas">
${nodesHtml}  </div>
</body>
</html>
`;
}
