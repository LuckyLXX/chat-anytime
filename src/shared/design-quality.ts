/**
 * 设计稿确定性质量门（借鉴 dsh-openpencil 的 design-quality 思路，子集实现）：
 * 纯函数检查 AI 生成结果里的常见硬伤——flex 容器装不下子内容（溢出）、空的
 * 结构性容器、文字与背景对比度不达 WCAG AA、内容超出画布——并把修复建议
 * 产成**可直接套用的 DesignOp[]（repairTargets）**而不是纯错误文本，模型把
 * 它们原样传给下一次 design_update 即可完成修复（受控修复事务）。
 *
 * 本文件被 utility（工具回执）与 renderer（可共享）共用，零 node API 依赖。
 */

import type { DesignCanvasInfo, DesignDoc, DesignLayout, DesignNode, DesignOp } from "./design-schema.js";

/** 诊断/修复目标上限（控制工具回执体积）。 */
const MAX_DIAGNOSTICS = 12;
const MAX_RULE_DIAGNOSTICS = 4;
const MAX_REPAIR_TARGETS = 32;
const MAX_MESSAGE_CHARS = 160;
/** 建议画布比内容包围盒多留的边距。 */
const CANVAS_MARGIN = 80;

export interface DesignQualityReport {
  /** 人类可读诊断（已截断、已限量）。 */
  diagnostics: string[];
  /** 可直接作为 design_update 的 ops 传入的修复操作（按节点合并，最多 32 条）。 */
  repairTargets: DesignOp[];
  unrepairableCount: number;
  /** 因超限被丢弃的诊断条数。 */
  omitted: number;
  /** 内容超出画布时的建议画布尺寸（width/height 至少为当前值）。 */
  suggestCanvas?: { width: number; height: number };
}

// —— 颜色解析与 WCAG 对比度 ——

const NAMED_COLORS: ReadonlyMap<string, string> = new Map([
  ["white", "#ffffff"], ["black", "#000000"], ["red", "#ff0000"], ["green", "#008000"], ["blue", "#0000ff"],
  ["yellow", "#ffff00"], ["orange", "#ffa500"], ["purple", "#800080"], ["gray", "#808080"], ["grey", "#808080"],
  ["silver", "#c0c0c0"], ["navy", "#000080"], ["teal", "#008080"], ["transparent", "rgba(0,0,0,0)"]
]);

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 解析 CSS 颜色为 RGB（支持 #rgb/#rrggbb/#rrggbbaa、rgb()/rgba()、常见命名色）；失败返回 undefined。 */
export function parseColor(value: string): Rgb | undefined {
  const text = value.trim().toLowerCase();
  const named = NAMED_COLORS.get(text);
  if (named) return parseColor(named);
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text);
  if (hex) {
    const digits = hex[1]!;
    const expand = (part: string): number => Number.parseInt(part.length === 1 ? part + part : part, 16);
    if (digits.length === 3 || digits.length === 4) {
      return { r: expand(digits[0]!), g: expand(digits[1]!), b: expand(digits[2]!), a: digits.length === 4 ? expand(digits[3]!) : 255 };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) : 255
      };
    }
    return undefined;
  }
  const fn = /^rgba?\(([^)]+)\)$/u.exec(text);
  if (fn) {
    const parts = fn[1]!.split(/[,/\s]+/u).filter(Boolean).map((part) => (part.endsWith("%") ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part)));
    if (parts.length >= 3 && parts.slice(0, 3).every((num) => Number.isFinite(num))) {
      return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3]! : 1 };
    }
  }
  return undefined;
}

function srgbChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: Rgb): number {
  return 0.2126 * srgbChannel(color.r) + 0.7152 * srgbChannel(color.g) + 0.0722 * srgbChannel(color.b);
}

/** parseColor 的 alpha 归一：hex8 量程是 0–255，rgba() 是 0–1。 */
function normAlpha(a: number): number {
  return a > 1 ? Math.min(1, a / 255) : Math.max(0, a);
}

/** 前景色以给定 alpha 合成到背景之上（结果不透明）。 */
function blendOver(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  if (alpha >= 1) return { r: foreground.r, g: foreground.g, b: foreground.b, a: 1 };
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1
  };
}

function toHex(color: Rgb): string {
  return `#${[color.r, color.g, color.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 对比度（两色都按不透明处理；带 alpha 的前景先与背景合成，量程兼容 0–1 与 hex8 的 0–255）。 */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const alpha = normAlpha(foreground.a);
  const blended: Rgb = alpha >= 1 ? foreground : blendOver(foreground, background, alpha);
  const l1 = relativeLuminance(blended);
  const l2 = relativeLuminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// —— 质量检查 ——

interface FrameBox {
  node: DesignNode;
  /** 绝对坐标（仅绝对定位链上有效；flex 子树位置由浏览器布局决定，不参与出界判断）。 */
  absX: number;
  absY: number;
  /** 祖先链上是否出现过 flex（flex 子树的 x/y 不可靠）。 */
  inFlex: boolean;
}

function paddingSides(padding: DesignLayout["padding"]): { top: number; right: number; bottom: number; left: number } {
  if (typeof padding === "number") return { top: padding, right: padding, bottom: padding, left: padding };
  return { top: padding?.top ?? 0, right: padding?.right ?? 0, bottom: padding?.bottom ?? 0, left: padding?.left ?? 0 };
}

function collectBoxes(nodes: readonly DesignNode[], absX: number, absY: number, inFlex: boolean, into: FrameBox[]): void {
  for (const node of nodes) {
    if (node.visible === false) continue;
    const box: FrameBox = { node, absX: absX + node.x, absY: absY + node.y, inFlex };
    into.push(box);
    if (node.children) {
      collectBoxes(node.children, box.absX, box.absY, inFlex || Boolean(node.layout), into);
    }
  }
}

/** 大字号判定（WCAG：≥24px，或 ≥18.66px 且粗体）→ 对比度门槛降为 3:1。 */
function isLargeText(node: DesignNode): boolean {
  const fontSize = node.fontSize ?? 14;
  return fontSize >= 24 || (fontSize >= 18.66 && (node.fontWeight ?? 400) >= 700);
}

function describeNode(node: DesignNode): string {
  return node.name ? `「${node.name}」(${node.id})` : node.id;
}

/**
 * 确定性质量检查。返回的诊断与修复目标都已限量；repairTargets 是合法的
 * DesignOp[]（update/resize），模型原样传入 design_update 即可应用。
 */
export function inspectDesignQuality(doc: DesignDoc): DesignQualityReport {
  const diagnostics: string[] = [];
  const repairTargets: DesignOp[] = [];
  const ruleCounts = new Map<string, number>();
  let unrepairableCount = 0;
  let omitted = 0;

  const pushDiagnostic = (rule: string, message: string, repairable: boolean): void => {
    if ((ruleCounts.get(rule) ?? 0) >= MAX_RULE_DIAGNOSTICS) {
      omitted += 1;
      return;
    }
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      omitted += 1;
      return;
    }
    ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
    const text = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message;
    diagnostics.push(`[${rule}] ${text}`);
    if (!repairable) unrepairableCount += 1;
  };

  const boxes: FrameBox[] = [];
  collectBoxes(doc.nodes, 0, 0, false, boxes);

  // —— 1. flex 容器装不下子内容（主轴/交叉轴溢出）→ repairTarget 放大容器 ——
  for (const { node } of boxes) {
    if (node.type !== "frame" || !node.layout || !node.children || node.children.length === 0) continue;
    const layout = node.layout;
    const sides = paddingSides(layout.padding);
    const children = node.children.filter((child) => child.visible !== false);
    if (children.length === 0) continue;
    const gap = layout.gap ?? 0;
    const horizontal = layout.direction !== "column";
    const flowSize = (child: DesignNode): number => (horizontal ? child.w : child.h);
    const crossSize = (child: DesignNode): number => (horizontal ? child.h : child.w);
    const neededMain = (horizontal ? sides.left + sides.right : sides.top + sides.bottom) + children.reduce((sum, child) => sum + flowSize(child), 0) + gap * (children.length - 1);
    const neededCross = (horizontal ? sides.top + sides.bottom : sides.left + sides.right) + Math.max(...children.map(crossSize));
    const boxSize = horizontal ? node.w : node.h;
    const crossLimit = horizontal ? node.h : node.w;
    const patch: { w?: number; h?: number } = {};
    if (neededMain > boxSize + 0.5) {
      if (horizontal) patch.w = Math.ceil(neededMain);
      else patch.h = Math.ceil(neededMain);
    }
    if (neededCross > crossLimit + 0.5) {
      if (horizontal) patch.h = Math.ceil(neededCross);
      else patch.w = Math.ceil(neededCross);
    }
    if (Object.keys(patch).length === 0) continue;
    const dims = `${node.w}×${node.h}`;
    const need = `需要 ≥${Math.ceil(horizontal ? neededMain : neededCross)}×${Math.ceil(horizontal ? neededCross : neededMain)}`;
    if (repairTargets.length < MAX_REPAIR_TARGETS) {
      repairTargets.push({ op: "update", id: node.id, patch });
      pushDiagnostic("container-overflow", `${describeNode(node)} 容器 ${dims} 装不下 ${children.length} 个子内容（${need}）`, true);
    }
  }

  // —— 2. 空的结构性容器（无子内容也无外观）→ 建议删除或补内容（不可自动修复） ——
  for (const { node } of boxes) {
    if (node.type !== "frame") continue;
    if (node.children && node.children.length > 0) continue;
    if (node.fill || node.stroke) continue;
    pushDiagnostic("empty-container", `${describeNode(node)} 是空容器（无子节点且无填充/描边），建议删除或补充内容`, false);
  }

  // —— 3. 文字对比度：先合成「有效背景」再做 WCAG AA 判定 → repairTarget 换深/浅色 ——
  // 渲染模型：每层 fill 先合成到背后的底色上，再按该节点 opacity 整组淡出；文字自身
  // 也被祖先 opacity 链压暗。全部合成后与 AA 比较——容器级 opacity 压暗子文字在这里现形
  // （画布上看不出的「玻璃卡片 0.5 透明度把表单文字洗灰」，导出后就是真缺陷）。
  const OPAQUE_WHITE: Rgb = { r: 255, g: 255, b: 255, a: 1 };
  const canvasBg = doc.canvas.background ? parseColor(doc.canvas.background) : undefined;

  const checkText = (node: DesignNode, ancestors: readonly DesignNode[], absX: number, absY: number, inFlex: boolean, opacityProduct: number, rootIndex: number): void => {
    if (!node.color || !node.text?.trim()) return;
    const foregroundColor = parseColor(node.color);
    if (!foregroundColor) return;
    // 底色：画布背景 → 覆盖文字点位的更早根级 fill 节点（AI 常用满幅 rect 当底色，
    // z 序在文字之前；取全部覆盖者按 z 序叠加）→ 白。根级近似只在绝对定位链可信时做。
    let backdrop = canvasBg ?? OPAQUE_WHITE;
    if (!canvasBg && !inFlex) {
      for (let index = 0; index < rootIndex; index++) {
        const root = doc.nodes[index]!;
        if (root.visible === false) continue;
        if (absX < root.x || absX > root.x + root.w || absY < root.y || absY > root.y + root.h) continue;
        const fill = root.fill ? parseColor(root.fill) : undefined;
        if (!fill) continue;
        backdrop = blendOver(fill, backdrop, Math.min(1, normAlpha(fill.a) * (root.opacity ?? 1)));
      }
    }
    // 祖先链外→内逐层合成 fill：有效 alpha = fill alpha × 自身 opacity × 外层 opacity 累乘。
    let productAbove = 1;
    for (const ancestor of ancestors) {
      const ownOpacity = ancestor.opacity ?? 1;
      const fill = ancestor.fill ? parseColor(ancestor.fill) : undefined;
      if (fill) backdrop = blendOver(fill, backdrop, Math.min(1, normAlpha(fill.a) * ownOpacity * productAbove));
      productAbove *= ownOpacity;
    }
    const foreground: Rgb = { ...foregroundColor, a: normAlpha(foregroundColor.a) * opacityProduct };
    const threshold = isLargeText(node) ? 3 : 4.5;
    const ratio = contrastRatio(foreground, backdrop);
    if (ratio >= threshold - 0.01) return;
    // 修复建议改的是 color，opacity 链原样保留 → 候选色按同样的有效 alpha 计分。
    const candidates = ["#1c1917", "#ffffff"].map((hex) => ({ hex, rgb: parseColor(hex)! }));
    const scored = candidates
      .map((candidate) => ({ ...candidate, ratio: contrastRatio({ ...candidate.rgb, a: normAlpha(candidate.rgb.a) * opacityProduct }, backdrop) }))
      .sort((a, b) => b.ratio - a.ratio);
    const passing = scored.find((candidate) => candidate.ratio >= threshold);
    const chosen = passing ?? scored[0]!;
    if (repairTargets.length < MAX_REPAIR_TARGETS) {
      repairTargets.push({ op: "update", id: node.id, patch: { color: chosen.hex } });
    }
    pushDiagnostic(
      "text-contrast",
      `${describeNode(node)} 文字对比度 ${ratio.toFixed(1)}:1 低于 AA ${threshold}:1（有效背景 ≈ ${toHex(backdrop)}${opacityProduct < 0.999 ? `，透明度链 ×${opacityProduct.toFixed(2)}` : ""}），建议改 ${chosen.hex}`,
      true
    );
  };

  const walkContrast = (nodes: readonly DesignNode[], ancestors: readonly DesignNode[], absX: number, absY: number, inFlex: boolean, opacityProduct: number, rootIndex: number): void => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (node.visible === false) continue;
      const nodeAbsX = absX + node.x;
      const nodeAbsY = absY + node.y;
      const effectiveRootIndex = ancestors.length === 0 ? index : rootIndex;
      if (node.type === "text") checkText(node, ancestors, nodeAbsX, nodeAbsY, inFlex, opacityProduct, effectiveRootIndex);
      if (node.children) walkContrast(node.children, [...ancestors, node], nodeAbsX, nodeAbsY, inFlex || Boolean(node.layout), opacityProduct * (node.opacity ?? 1), effectiveRootIndex);
    }
  };
  walkContrast(doc.nodes, [], 0, 0, false, 1, 0);

  // —— 4. 内容超出画布 → 建议扩画布（resize repairTarget） ——
  let maxX = doc.canvas.width;
  let maxY = doc.canvas.height;
  let overflowNode: DesignNode | undefined;
  for (const root of doc.nodes) {
    if (root.visible === false) continue;
    const right = root.x + root.w;
    const bottom = root.y + root.h;
    if (right > maxX || bottom > maxY) overflowNode ??= root;
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, bottom);
  }
  let suggestCanvas: { width: number; height: number } | undefined;
  if (overflowNode) {
    suggestCanvas = {
      width: Math.min(100_000, Math.ceil(maxX + CANVAS_MARGIN)),
      height: Math.min(100_000, Math.ceil(maxY + CANVAS_MARGIN))
    };
    if (repairTargets.length < MAX_REPAIR_TARGETS) {
      repairTargets.unshift({ op: "resize", width: suggestCanvas.width, height: suggestCanvas.height });
    }
    pushDiagnostic("out-of-canvas", `内容超出画布（${describeNode(overflowNode)} 最远到 ${Math.ceil(maxX)}×${Math.ceil(maxY)}，画布 ${doc.canvas.width}×${doc.canvas.height}）`, true);
  }

  return {
    diagnostics,
    repairTargets,
    unrepairableCount,
    omitted,
    ...(suggestCanvas ? { suggestCanvas } : {})
  };
}

/** 布局摘要的行数与每行预算（控制回执体积）。 */
const DIGEST_MAX_LINES = 30;
const DIGEST_TEXT_PREVIEW = 12;

function digestLine(node: DesignNode, indent: string): string {
  const kind = node.type === "frame" ? "▤" : node.type === "text" ? "T" : node.type === "image" ? "▭" : "□";
  const layout = node.layout ? ` layout:${node.layout.direction}${node.layout.gap ? `/${node.layout.gap}` : ""}` : "";
  const children = node.children && node.children.length > 0 ? ` ${node.children.length}子` : "";
  const preview = node.type === "text" && node.text ? ` "${node.text.replace(/\s+/gu, " ").slice(0, DIGEST_TEXT_PREVIEW)}"` : "";
  return `${indent}${kind} ${node.name || node.id} ${node.type} ${node.w}×${node.h} @(${node.x},${node.y})${layout}${children}${preview}`;
}

/**
 * 确定性布局摘要（≤30 行）：画布行 + 顶层逐节点一行 + frame 下钻一层。
 * 给模型的「地图」——不拉全树 JSON 也能定位到该改哪一屏/哪个节点。
 */
export function summarizeDesignLayout(doc: DesignDoc): string {
  const lines: string[] = [];
  const visibleRoots = doc.nodes.filter((node) => node.visible !== false);
  lines.push(`画布 ${doc.canvas.width}×${doc.canvas.height}${doc.canvas.background ? ` 背景 ${doc.canvas.background}` : ""}；${visibleRoots.length}/${doc.nodes.length} 个顶层节点`);
  let budget = DIGEST_MAX_LINES - lines.length;
  const walk = (nodes: readonly DesignNode[], indent: string): void => {
    for (const node of nodes) {
      if (budget <= 0) return;
      if (node.visible === false) continue;
      budget -= 1;
      lines.push(digestLine(node, indent));
      if (node.children && node.children.length > 0 && indent.length < 2) walk(node.children, `${indent}  `);
    }
  };
  walk(doc.nodes, "");
  if (budget <= 0) lines.push(`…（已截断，共 ${doc.nodes.length} 个顶层节点；完整树用 design_read 获取）`);
  return lines.join("\n");
}
