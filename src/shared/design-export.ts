/**
 * 设计稿 → HTML+CSS 单文件导出（内联样式）。纯函数、零 DOM 依赖（utility
 * 与 renderer 都可直接用）。节点树展开规则与画布渲染（DesignNodeView）同构：
 * 默认绝对定位 div（left/top/width/height 内联）；layout frame 自身 display:flex，
 * 其子节点发 position:relative 且省略 left/top（真实 flex 排布，x/y 忽略）。
 *
 * 安全：拼进 style 属性/样式块的值一律经 escapeHtml（设计字段是 AI 工具入参或
 * 用户粘贴值，属不可信输入——`"` 会闭合 HTML 属性、`</style>` 会断裂样式块）。
 */

import { DESIGN_DEFAULT_FONT_FAMILY, type DesignDoc, type DesignLayout, type DesignNode } from "./design-schema.js";

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
    // font-family 一律显式发出（未声明时用默认栈）：曾经导出 HTML 里一个 font-family
    // 都没有，中文稿落到浏览器默认衬线字体；画布靠 styles.css 继承看着正常，导出即崩。
    decls.push(["font-family", node.fontFamily ?? DESIGN_DEFAULT_FONT_FAMILY]);
    decls.push(["font-size", `${node.fontSize ?? 14}px`]);
    decls.push(["font-weight", String(node.fontWeight ?? 400)]);
    if (node.letterSpacing) decls.push(["letter-spacing", `${node.letterSpacing}px`]);
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

/** 导出边界：画布矩形与全部顶层可见节点矩形的并集。多画板（整套原型）内容
 *  可以摆在画布矩形之外，导出按并集出图、绝不裁剪；内容都在画布内时退化为
 *  画布矩形本身（输出与旧版逐字节一致）。 */
/** 画布 ∪ 顶层可见内容包围盒（导出容器与缩略图视口共用的求界逻辑）。 */
export function exportBounds(doc: DesignDoc): { ox: number; oy: number; width: number; height: number } {
  const canvas = doc.canvas;
  let minX = 0;
  let minY = 0;
  let maxX = canvas.width;
  let maxY = canvas.height;
  for (const node of doc.nodes) {
    if (node.visible === false) continue;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w);
    maxY = Math.max(maxY, node.y + node.h);
  }
  return { ox: minX, oy: minY, width: maxX - minX, height: maxY - minY };
}

/** 导出为可直接打开的 HTML 单文件（body margin 0、画布尺寸与背景；内容超出
 *  画布矩形时以画布背景层 + 平移包装层完整呈现，不裁剪）。 */
export function exportDesignHtml(doc: DesignDoc): string {
  const canvas = doc.canvas;
  const background = canvas.background ? `background:${escapeHtml(canvas.background)};` : "";
  const bounds = exportBounds(doc);
  // 内容越界时：容器放大到并集，画布背景层与节点包装层都平移回原位（节点
  // 样式保持 left:x 不变，由包装层承担偏移）。
  const shifted = bounds.ox !== 0 || bounds.oy !== 0 || bounds.width !== canvas.width || bounds.height !== canvas.height;
  const nodesHtml = doc.nodes.map((node) => nodeHtml(node, "    ")).join("");
  const canvasCss = shifted
    ? `.pi-design-canvas { position: relative; width: ${bounds.width}px; height: ${bounds.height}px; overflow: hidden; }`
    : `.pi-design-canvas { position: relative; width: ${canvas.width}px; height: ${canvas.height}px; ${background} overflow: hidden; }`;
  const canvasLayers = shifted
    ? `    <div style="position:absolute;left:${-bounds.ox}px;top:${-bounds.oy}px;width:${canvas.width}px;height:${canvas.height}px;${background}"></div>\n    <div style="position:absolute;left:${-bounds.ox}px;top:${-bounds.oy}px;width:0;height:0">\n${nodesHtml}    </div>\n`
    : nodesHtml;
  return `<!DOCTYPE html>
<!-- 由 PiDesktop 设计模式导出：${escapeHtml(doc.name)} -->
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(doc.name)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: ${escapeHtml(DESIGN_DEFAULT_FONT_FAMILY)}; background: ${canvas.background ? escapeHtml(canvas.background) : "transparent"}; }
  ${canvasCss}
  .pi-design-canvas img { display: block; }
</style>
</head>
<body>
  <div class="pi-design-canvas">
${canvasLayers}  </div>
</body>
</html>
`;
}
