/**
 * 设计稿确定性质量门（借鉴 dsh-openpencil 的 design-quality 思路，子集实现）：
 * 纯函数检查 AI 生成结果里的常见硬伤——flex 容器装不下子内容（溢出）、空的
 * 结构性容器、文字与背景对比度不达 WCAG AA、内容超出画布——并把修复建议
 * 产成**可直接套用的 DesignOp[]（repairTargets）**而不是纯错误文本，模型把
 * 它们原样传给下一次 design_update 即可完成修复（受控修复事务）。
 *
 * 本文件被 utility（工具回执）与 renderer（可共享）共用，零 node API 依赖。
 */

import { findNode, type DesignCanvasInfo, type DesignDoc, type DesignLayout, type DesignNode, type DesignOp } from "./design-schema.js";
import {
  DEFAULT_DESIGN_TOKENS,
  formatScale,
  nearestRadius,
  nearestScaleValue,
  radiusOnScale,
  snapToScale,
  tokensFromScales,
  type DesignTokens
} from "./design-tokens.js";

/** 诊断/修复目标上限（控制工具回执体积）。 */
const MAX_DIAGNOSTICS = 12;
const MAX_RULE_DIAGNOSTICS = 4;
const MAX_REPAIR_TARGETS = 32;
/** 审美标尺规则的诊断配额：单独特算，不占结构规则的 12 条额度。
 *  审美规则已聚合（每规则一条），所以 3 条就是「圆角/间距/字号各一条」的满额。
 *  两侧各自限额是为了避免结构问题（溢出/对比度）多到 12 条时把审美提示挤光——
 *  那恰好就回到了「只有防错、没有审美」的老样子。 */
const MAX_AESTHETIC_DIAGNOSTICS = 3;
const MAX_MESSAGE_CHARS = 160;
/** 建议画布比内容包围盒多留的边距。 */
const CANVAS_MARGIN = 80;

/** 审美标尺规则的修复 op 总上限（跨三条规则共享；与结构规则的 MAX_REPAIR_TARGETS 分开计数，
 *  新增审美规则不得挤占「容器装不下 / 内容出界」这类必须修的修复位）。
 *  分配方式是按规则轮转（圆角→字号→间距→圆角…），保证回执里可见的那一批（设计_update 只展示
 *  前 12 条）三条规则都覆盖得到，而不是被数量最多的圆角占满。 */
const MAX_AESTHETIC_REPAIR_TARGETS = 24;
/** 聚合诊断里列出的示例数（超出的用「等」收尾）。 */
const MAX_SCALE_EXAMPLES = 3;
/** 至少这么多子节点才当作「一叠」评间距节奏（两两以上才有内边距可谈）。 */
const MIN_STACK_SIZE = 2;

export interface DesignQualityOptions {
  /**
   * 审美标尺：间距/圆角/字号白名单。缺省用 {@link DEFAULT_DESIGN_TOKENS}；
   * 文档绑定了风格指南时由调用方传该指南的标尺（指南可自带更贴合自身的档位）。
   */
  tokens?: Partial<DesignTokens>;
}

/** 一条审美标尺问题的聚合结果。 */
export interface DesignScaleIssue {
  rule: "off-scale-radius" | "off-scale-spacing" | "off-scale-font-size";
  /** 聚合后的一条诊断文本（不是逐节点刷屏）。 */
  message: string;
  /** 可直接套用的修复 ops（已按目标节点去重、已限量）。 */
  repairs: DesignOp[];
}

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
export function inspectDesignQuality(doc: DesignDoc, options: DesignQualityOptions = {}): DesignQualityReport {
  const diagnostics: string[] = [];
  const repairTargets: DesignOp[] = [];
  const ruleCounts = new Map<string, number>();
  let unrepairableCount = 0;
  let omitted = 0;

  const pushDiagnostic = (rule: string, message: string, repairable: boolean): void => {
    // 审美规则走独立配额（见 MAX_AESTHETIC_DIAGNOSTICS）。
    const reserved = rule.startsWith("off-scale-");
    if ((ruleCounts.get(rule) ?? 0) >= MAX_RULE_DIAGNOSTICS) {
      omitted += 1;
      return;
    }
    if (reserved) {
      const reservedUsed = [...ruleCounts.keys()].filter((key) => key.startsWith("off-scale-")).length;
      if (reservedUsed >= MAX_AESTHETIC_DIAGNOSTICS) {
        omitted += 1;
        return;
      }
    } else if (diagnostics.length >= MAX_DIAGNOSTICS) {
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

  // —— 5–7. 审美标尺（间距/圆角/字号）：聚合诊断 + 吸附修复 ——
  // 结构规则跑完之后才追加，且修复预算（MAX_AESTHETIC_REPAIR_TARGETS）独立于结构修复：
  // 新增审美规则绝不挤占「容器装不下 / 内容出界」这类必须修的修复位。
  for (const issue of inspectDesignScale(doc, options)) {
    pushDiagnostic(issue.rule, issue.message, issue.repairs.length > 0);
    for (const repair of issue.repairs) {
      if (repairTargets.length >= MAX_REPAIR_TARGETS + MAX_AESTHETIC_REPAIR_TARGETS) break;
      repairTargets.push(repair);
    }
  }

  return {
    diagnostics,
    repairTargets,
    unrepairableCount,
    omitted,
    ...(suggestCanvas ? { suggestCanvas } : {})
  };
}

/**
 * 审美标尺检查（间距/圆角/字号）：把「22 种圆角、37 种间距」这类散沙聚合成
 * 一条条可执行的提示（而非逐节点刷屏），并给出可直接套用的吸附修复 ops。
 *
 * 与 {@link inspectDesignQuality} 分开导出（后者也调用它并把结果合并进回执）：
 * 风格指南可以带自己的标尺，文档绑定了指南时调用方传对应的 `tokens`。
 */
export function inspectDesignScale(doc: DesignDoc, options: DesignQualityOptions = {}): DesignScaleIssue[] {
  const tokens = tokensFromScales(options.tokens);
  const issues: DesignScaleIssue[] = [];
  const seen = new Set<string>();
  const push = (rule: DesignScaleIssue["rule"], message: string, repair: DesignOp, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const existing = issues.find((candidate) => candidate.rule === rule);
    if (!existing) {
      issues.push({ rule, message, repairs: [repair] });
      return;
    }
    if (existing.repairs.length < MAX_AESTHETIC_REPAIR_TARGETS) existing.repairs.push(repair);
  };

  // —— 5. 圆角不在标尺上 ——
  const offRadius = new Map<string, { node: DesignNode; next: number }>();
  const radiusNodes: DesignNode[] = [];
  const collectRadius = (nodes: readonly DesignNode[]): void => {
    for (const node of nodes) {
      if (node.visible === false) continue;
      if (node.radius !== undefined && !radiusOnScale(node.radius, tokens.radius)) {
        radiusNodes.push(node);
        offRadius.set(node.id, { node, next: nearestRadius(node.radius, tokens.radius) });
      }
      if (node.children) collectRadius(node.children);
    }
  };
  collectRadius(doc.nodes);
  if (radiusNodes.length > 0) {
    const examples = radiusNodes.slice(0, MAX_SCALE_EXAMPLES).map((node) => `${node.radius}→${offRadius.get(node.id)!.next}`).join("、");
    const message = `${radiusNodes.length} 个节点圆角不在标尺上（${examples}${radiusNodes.length > MAX_SCALE_EXAMPLES ? " 等" : ""}）；建议吸附到 ${formatScale(tokens.radius)}`;
    for (const [id, entry] of offRadius) push("off-scale-radius", message, { op: "update", id, patch: { radius: entry.next } }, `radius:${id}`);
  }

  // —— 6. 字号不在标尺上 ——
  const offFont: { node: DesignNode; next: number }[] = [];
  const collectFont = (nodes: readonly DesignNode[]): void => {
    for (const node of nodes) {
      if (node.visible === false) continue;
      if (node.type === "text" && node.fontSize !== undefined && snapToScale(node.fontSize, tokens.fontSize) === undefined) {
        const next = nearestScaleValue(node.fontSize, tokens.fontSize);
        if (next !== undefined) offFont.push({ node, next });
      }
      if (node.children) collectFont(node.children);
    }
  };
  collectFont(doc.nodes);
  if (offFont.length > 0) {
    const examples = offFont.slice(0, MAX_SCALE_EXAMPLES).map((entry) => `${entry.node.fontSize}→${entry.next}`).join("、");
    const message = `${offFont.length} 个文本字号不在标尺上（${examples}${offFont.length > MAX_SCALE_EXAMPLES ? " 等" : ""}）；建议吸附到 ${formatScale(tokens.fontSize)}`;
    for (const entry of offFont) push("off-scale-font-size", message, { op: "update", id: entry.node.id, patch: { fontSize: entry.next } }, `font:${entry.node.id}`);
  }

  // —— 7. 同级重叠兄弟的视觉间隙不在标尺上（只评确实叠在一起的，不误判并排内容） ——
  const offSpace: { node: DesignNode; next: number }[] = [];
  const collectSpacing = (nodes: readonly DesignNode[]): void => {
    // 至少 3 个兄弟才当作一叠列表；两两相邻容易是刻意的排版组合。
    const candidates = nodes.filter((node) => node.visible !== false).sort((left, right) => left.y - right.y);
    if (candidates.length >= 3) {
      for (let index = 1; index < candidates.length; index++) {
        const previous = candidates[index - 1]!;
        const current = candidates[index]!;
        const centerX = current.x + current.w / 2;
        if (centerX < previous.x || centerX > previous.x + previous.w) continue;
        const gap = current.y - (previous.y + previous.h);
        if (gap <= 0) continue;
        if (snapToScale(gap, tokens.spacing) === undefined) {
          const next = nearestScaleValue(gap, tokens.spacing);
          if (next !== undefined && next !== gap) offSpace.push({ node: current, next });
        }
      }
    }
    for (const node of nodes) if (node.children) collectSpacing(node.children);
  };
  collectSpacing(doc.nodes);
  if (offSpace.length > 0) {
    const examples = offSpace.slice(0, MAX_SCALE_EXAMPLES).map((entry) => `${entry.node.name ?? entry.node.id} 上移到 y=${entry.next}`).join("、");
    const message = `${offSpace.length} 处同级间隙不在标尺上（${examples}${offSpace.length > MAX_SCALE_EXAMPLES ? " 等" : ""}）；建议吸附到 ${formatScale(tokens.spacing)}`;
    for (const entry of offSpace) {
      // 只提交非重叠部分（同层重叠会乱套，交给模型自己调）。
      const found = findNode(doc.nodes, entry.node.id);
      if (!found || !found.parent) continue;
      const previousBottom = found.parent.children!
        .filter((sibling) => sibling !== entry.node && sibling.visible !== false && sibling.y + sibling.h <= entry.node.y)
        .reduce((lowest, sibling) => Math.max(lowest, sibling.y + sibling.h), Number.NEGATIVE_INFINITY);
      if (!Number.isFinite(previousBottom)) continue;
      push("off-scale-spacing", message, { op: "update", id: entry.node.id, patch: { y: Math.round((previousBottom + entry.next) * 100) / 100 } }, `space:${entry.node.id}`);
    }
  }

  const capped = (): DesignScaleIssue[] => {
    // 轮转截断：每条规则轮流取一条，直到总额度用完（不是把额度先给排在前面的规则）。
    const queues = issues.map((issue) => [...issue.repairs]);
    const out: DesignScaleIssue[] = issues.map((issue) => ({ ...issue, repairs: [] }));
    let budget = MAX_AESTHETIC_REPAIR_TARGETS;
    let moved = true;
    while (budget > 0 && moved) {
      moved = false;
      for (let index = 0; index < queues.length && budget > 0; index++) {
        const next = queues[index]!.shift();
        if (!next) continue;
        out[index]!.repairs.push(next);
        budget -= 1;
        moved = true;
      }
    }
    return out.filter((issue) => issue.repairs.length > 0);
  };

  return capped();
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
