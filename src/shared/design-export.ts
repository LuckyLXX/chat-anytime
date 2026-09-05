/**
 * 设计稿 → HTML+CSS 单文件导出（内联样式）。纯函数、零 DOM 依赖（utility
 * 与 renderer 都可直接用）。节点树展开规则与画布渲染（DesignNodeView）同构：
 * 默认绝对定位 div（left/top/width/height 内联）；layout frame 自身 display:flex，
 * 其子节点发 position:relative 且省略 left/top（真实 flex 排布，x/y 忽略）。
 *
 * 安全：拼进 style 属性/样式块的值一律经 escapeHtml（设计字段是 AI 工具入参或
 * 用户粘贴值，属不可信输入——`"` 会闭合 HTML 属性、`</style>` 会断裂样式块）。
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

function paddingValue(padding: NonNullable<DesignLayout["padding"]>): string | undefined {
  if (typeof padding === "number") return padding > 0 ? `${padding}px` : undefined;
  const top = padding.top ?? 0;
  const right = padding.right ?? 0;
  const bottom = padding.bottom ?? 0;
  const left = padding.left ?? 0;
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return undefined;
  return `${top}px ${right}px ${bottom}px ${left}px`;
}

/**
 * 单节点共享的盒样式声明（画布/导出同构的单一来源）。
 * `inFlexParent`：父节点声明了 layout（flex）——此时本节点由父容器排布，
 * 发 position:relative 并省略 left/top（x/y 忽略），宽高作为弹性尺寸。
 */
export function designNodeDeclarations(node: DesignNode, inFlexParent = false): [string, string][] {
  const decls: [string, string][] = inFlexParent
    ? [
        ["position", "relative"],
        ["width", `${node.w}px`],
        ["height", `${node.h}px`]
      ]
    : [
        ["position", "absolute"],
        ["left", `${node.x}px`],
        ["top", `${node.y}px`],
        ["width", `${node.w}px`],
        ["height", `${node.h}px`]
      ];
  const layout = node.layout;
  if (layout) {
    decls.push(["display", "flex"]);
    decls.push(["flex-direction", layout.direction === "column" ? "column" : "row"]);
    if (layout.gap && layout.gap > 0) decls.push(["gap", `${layout.gap}px`]);
    if (layout.padding !== undefined) {
      const padding = paddingValue(layout.padding);
      if (padding) decls.push(["padding", padding]);
    }
    if (layout.justify) decls.push(["justify-content", layout.justify]);
    if (layout.align) decls.push(["align-items", layout.align]);
  }
  if (node.fill) decls.push(["background", node.fill]);
  if (node.stroke) decls.push(["border", `${node.strokeWidth ?? 1}px solid ${node.stroke}`]);
  if (node.radius) decls.push(["border-radius", `${node.radius}px`]);
  if (node.opacity !== undefined && node.opacity < 1) decls.push(["opacity", String(node.opacity)]);
  if (node.shadow) decls.push(["box-shadow", node.shadow]);
  if (node.type === "text") {
    decls.push(["font-size", `${node.fontSize ?? 14}px`]);
    decls.push(["font-weight", String(node.fontWeight ?? 400)]);
    if (node.color) decls.push(["color", node.color]);
    if (node.lineHeight) decls.push(["line-height", String(node.lineHeight)]);
    decls.push(["text-align", node.align ?? "left"]);
    decls.push(["white-space", "pre-wrap"]);
    decls.push(["overflow-wrap", "break-word"]);
  }
  if (node.type === "image") decls.push(["object-fit", "cover"]);
  return decls;
}

/** 内联样式字符串（HTML 导出用；值经 HTML 转义，可安全拼进属性）。 */
export function designNodeStyle(node: DesignNode, inFlexParent = false): string {
  return designNodeDeclarations(node, inFlexParent).map(([property, value]) => `${property}:${escapeHtml(value)};`).join("");
}

/** React style 对象（画布渲染用，与导出同源；键名转 camelCase 供 React 使用）。React 负责转义，值保持原样。 */
export function designNodeStyleObject(node: DesignNode, inFlexParent = false): Record<string, string> {
  return Object.fromEntries(designNodeDeclarations(node, inFlexParent).map(([property, value]) => [property.replace(/-([a-z])/gu, (_match, char: string) => char.toUpperCase()), value]));
}

function nodeHtml(node: DesignNode, indent: string, inFlexParent = false): string {
  if (node.visible === false) return "";
  const style = designNodeStyle(node, inFlexParent);
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
  const childInFlex = Boolean(node.layout);
  const inner = node.children.map((child) => nodeHtml(child, `${indent}  `, childInFlex)).join("");
  return `${open}\n${inner}${indent}</div>\n`;
}

/** 导出为可直接打开的 HTML 单文件（body margin 0、画布尺寸与背景）。 */
export function exportDesignHtml(doc: DesignDoc): string {
  const canvas = doc.canvas;
  const background = canvas.background ? `background:${escapeHtml(canvas.background)};` : "";
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
