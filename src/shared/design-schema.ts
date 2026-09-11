/**
 * 设计模式（Design Studio）数据模型：设计稿是结构化 JSON 节点树（Design-as-Code），
 * AI 经 design_* 工具、用户经画布编辑都走同一组纯函数（本文件），两端语义一致。
 *
 * 坐标系：x/y/w/h 相对父节点。frame 可声明 layout（flex）——有 layout 时子节点按
 * flex 排布（x/y 忽略），无 layout 则绝对定位。导出与画布渲染同构。
 *
 * 本文件被 utility（node）与 renderer（浏览器）共用，必须零 node API 依赖。
 */

export type DesignNodeType = "frame" | "rect" | "text" | "image";

/** frame 的 auto-layout（flex）声明。 */
export interface DesignLayout {
  direction: "row" | "column";
  gap?: number;
  /** 数字 = 四周等值；对象 = 逐边。 */
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  /** CSS justify-content 的安全子集（flex-start/flex-end/center/space-between/space-around/space-evenly）。 */
  justify?: string;
  /** CSS align-items 的安全子集（flex-start/flex-end/center/stretch/baseline）。 */
  align?: string;
}

export interface DesignNode {
  id: string;
  type: DesignNodeType;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible?: boolean;
  /** 画布锁定：用户在画布上不可拖动/缩放/删除（图层树/检查器仍可选可改；AI 不受限）。 */
  locked?: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  /** 0–1。 */
  opacity?: number;
  /** CSS box-shadow 值（原样透传给渲染与导出）。 */
  shadow?: string;
  // —— text 节点 ——
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  /** 行高（数字 = 字号倍数）。 */
  lineHeight?: number;
  /** CSS font-family 字体栈（缺省用 {@link DESIGN_DEFAULT_FONT_FAMILY}；导出与画布同源）。 */
  fontFamily?: string;
  /** 字距（px）：负值收紧（大标题常用），正值放开（全大写标签常用）。 */
  letterSpacing?: number;
  align?: "left" | "center" | "right";
  // —— image 节点：http(s) / data URL（v1 不做本地文件路径） ——
  src?: string;
  // —— frame 专属：auto-layout（flex）与子节点 ——
  layout?: DesignLayout;
  children?: DesignNode[];
}

export interface DesignCanvasInfo {
  width: number;
  height: number;
  background?: string;
}

export interface DesignDoc {
  version: 1;
  id: string;
  name: string;
  canvas: DesignCanvasInfo;
  nodes: DesignNode[];
  /** 已绑定的风格指南名（可选；旧文件无此字段照常加载）。
   *  绑定时质量门用该指南自带的间距/圆角/字号标尺，未绑定则用默认标尺。 */
  guide?: string;
  /** 单调递增的文档版本号；由 design-store 写入时推进，applyDesignOps 不触碰。 */
  revision: number;
}

export type DesignNodePatch = Partial<Omit<DesignNode, "id" | "type" | "children">>;

/** create/replace 接受的节点草稿：只要求 type，其余字段（含递归 children）由 normalizeDesignNode 容错补齐（AI 原始 JSON 直传）。 */
export type DesignNodeDraft = Partial<Omit<DesignNode, "children">> & Pick<DesignNode, "type"> & { children?: DesignNodeDraft[] };

export type DesignOp =
  | { op: "create"; parentId?: string | null; index?: number; node: DesignNodeDraft }
  /** patch 不允许改 id/type/children（结构变化用 move/create/delete）。 */
  | { op: "update"; id: string; patch: DesignNodePatch }
  | { op: "delete"; id: string }
  /** dx/dy 对移动后的子树根做整体平移（子树坐标相对父节点，平移根即平移整树；多画板重排一 op 搞定）。 */
  | { op: "move"; id: string; parentId?: string | null; index?: number; dx?: number; dy?: number }
  /** 画布尺寸/背景调整（多画板：新屏幕放不下时先扩画布，节点允许留在画布矩形外）。 */
  | { op: "resize"; width?: number; height?: number; background?: string | null }
  /** 整树替换（undo 回写 / 大改）。 */
  | { op: "replace"; nodes: DesignNodeDraft[] };

/** applyDesignOps 的原子结果：任一 op 失败整批拒绝，绝无半应用状态。 */
export type DesignOpResult =
  | { ok: true; doc: DesignDoc }
  | { ok: false; error: string };

/** 单文档节点数上限（防 AI 一次生成天文数字节点拖垮画布与导出）。 */
export const MAX_DESIGN_NODES = 2000;
/** 节点树最大深度（防病态嵌套爆栈）。 */
export const MAX_DESIGN_DEPTH = 32;
/**
 * 默认字体栈：text 节点没显式声明 fontFamily 时导出与画布都用它。
 * 曾经导出 HTML 里一个 font-family 都没有，中文稿落到浏览器默认衬线字体（宋体）——
 * 画布看着正常、导出立刻崩坏。现在每个 text 节点都发字体栈，这里是唯一来源。
 */
export const DESIGN_DEFAULT_FONT_FAMILY = "Inter, system-ui, sans-serif";
/** fontFamily 字符上限（值会拼进导出 HTML 的 style 属性，只允许有限长度）。 */
export const MAX_FONT_FAMILY_CHARS = 200;

const NODE_TYPES: readonly DesignNodeType[] = ["frame", "rect", "text", "image"];
/** update patch 的合法字段集（白名单之外的字段拒绝，防 AI 拼错字段被静默忽略）。 */
const PATCHABLE_KEYS: ReadonlySet<string> = new Set(["name", "x", "y", "w", "h", "visible", "locked", "fill", "stroke", "strokeWidth", "radius", "opacity", "shadow", "text", "fontSize", "fontWeight", "color", "lineHeight", "fontFamily", "letterSpacing", "align", "src", "layout"]);
/** create/replace 节点草稿的合法字段集（= patch 字段 + 结构字段；与 update patch 同哲学：
 *  自造字段如 props.strokeOpacity 直接报错而不是被 normalizeDesignNode 静默丢弃——
 *  静默丢弃会让模型拿到「成功」回执却丢样式，导出后才发现）。 */
const NODE_DRAFT_KEYS: ReadonlySet<string> = new Set([...PATCHABLE_KEYS, "id", "type", "children"]);
/** 每种 op 的合法顶层参数集（防 AI 幻觉出 edits 之类的顶层参数被静默忽略）。 */
const OP_ALLOWED_KEYS: Readonly<Record<DesignOp["op"], ReadonlySet<string>>> = {
  create: new Set(["op", "parentId", "index", "node"]),
  update: new Set(["op", "id", "patch"]),
  delete: new Set(["op", "id"]),
  move: new Set(["op", "id", "parentId", "index", "dx", "dy"]),
  resize: new Set(["op", "width", "height", "background"]),
  replace: new Set(["op", "nodes"])
};
const TEXT_ALIGNS: readonly DesignNode["align"][] = ["left", "center", "right"];
const JUSTIFY_VALUES = new Set(["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"]);
const ITEM_ALIGN_VALUES = new Set(["flex-start", "flex-end", "center", "stretch", "baseline"]);
/** 文档/文件名净化：Windows 非法字符与控制符。 */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/gu;

function randomId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return `n-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return `n-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function finiteOr(value: unknown, fallback: number): number {
  const num = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** fontFamily 归一：去首尾空白 + 长度上限（空串 = 未设置）；字体栈内部空格保留。 */
function normalizeFontFamily(value: unknown): string | undefined {
  return boundedString(typeof value === "string" ? value.trim() : value, MAX_FONT_FAMILY_CHARS);
}

/** image src 只接受 http(s) 与 data:image URL（v1 不做本地文件路径）。 */
function normalizeImageSrc(value: unknown): string | undefined {
  const src = boundedString(value, 200_000);
  if (!src) return undefined;
  return /^https?:\/\//iu.test(src) || /^data:image\//iu.test(src) ? src : undefined;
}

function normalizeLayoutPadding(value: unknown): DesignLayout["padding"] {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, round2(value));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    const padding: NonNullable<DesignLayout["padding"]> & object = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const num = source[side];
      if (typeof num === "number" && Number.isFinite(num)) padding[side] = Math.max(0, round2(num));
    }
    return Object.keys(padding).length > 0 ? padding : undefined;
  }
  return undefined;
}

function normalizeLayout(value: unknown): DesignLayout | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const direction = source.direction === "column" ? "column" : "row";
  const gap = finiteOr(source.gap, 0);
  const layout: DesignLayout = {
    direction,
    ...(gap > 0 ? { gap: Math.min(400, round2(gap)) } : {}),
    padding: normalizeLayoutPadding(source.padding)
  };
  const justify = typeof source.justify === "string" && JUSTIFY_VALUES.has(source.justify) ? source.justify : undefined;
  const align = typeof source.align === "string" && ITEM_ALIGN_VALUES.has(source.align) ? source.align : undefined;
  if (justify) layout.justify = justify;
  if (align) layout.align = align;
  return layout;
}

/**
 * 容错归一化单个节点（递归子树）：非法类型/形状丢弃、缺失 id 补新、几何 clamp、
 * 数值字段夹取；children 仅 frame 保留。超深/超量（{@link MAX_DESIGN_NODES}）按
 * 深度优先顺序丢弃溢出部分。返回 undefined 表示整个节点不可救。
 */
export function normalizeDesignNode(raw: unknown, budget: { count: number }, depth = 0): DesignNode | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (depth > MAX_DESIGN_DEPTH) return undefined;
  const source = raw as Record<string, unknown>;
  const type = NODE_TYPES.find((candidate) => candidate === source.type);
  if (!type) return undefined;
  if (budget.count >= MAX_DESIGN_NODES) return undefined;
  budget.count += 1;
  const id = typeof source.id === "string" && source.id.trim() ? source.id.trim().slice(0, 64) : randomId();
  const node: DesignNode = {
    id,
    type,
    x: round2(finiteOr(source.x, 0)),
    y: round2(finiteOr(source.y, 0)),
    w: Math.max(1, round2(finiteOr(source.w, 100))),
    h: Math.max(1, round2(finiteOr(source.h, 100)))
  };
  const name = boundedString(source.name, 80);
  if (name) node.name = name;
  if (source.visible === false) node.visible = false;
  if (source.locked === true) node.locked = true;
  const fill = boundedString(source.fill, 512);
  if (fill) node.fill = fill;
  const stroke = boundedString(source.stroke, 512);
  if (stroke) node.stroke = stroke;
  const strokeWidth = finiteOr(source.strokeWidth, 0);
  if (strokeWidth > 0) node.strokeWidth = Math.min(64, round2(strokeWidth));
  const radius = finiteOr(source.radius, 0);
  if (radius > 0) node.radius = Math.min(9999, round2(radius));
  const opacity = finiteOr(source.opacity, 1);
  if (opacity < 1) node.opacity = clamp(opacity, 0, 1);
  const shadow = boundedString(source.shadow, 1024);
  if (shadow) node.shadow = shadow;
  if (type === "text") {
    const text = typeof source.text === "string" ? source.text.slice(0, 10_000) : "";
    node.text = text;
    const fontSize = finiteOr(source.fontSize, 14);
    node.fontSize = clamp(round2(fontSize), 1, 400);
    const fontWeight = finiteOr(source.fontWeight, 400);
    node.fontWeight = Math.round(clamp(fontWeight, 1, 1000));
    const color = boundedString(source.color, 512);
    if (color) node.color = color;
    const lineHeight = finiteOr(source.lineHeight, 0);
    if (lineHeight > 0) node.lineHeight = clamp(round2(lineHeight), 0.5, 10);
    const fontFamily = normalizeFontFamily(source.fontFamily);
    if (fontFamily) node.fontFamily = fontFamily;
    if (source.letterSpacing !== undefined) {
      const letterSpacing = finiteOr(source.letterSpacing, 0);
      if (letterSpacing !== 0) node.letterSpacing = clamp(round2(letterSpacing), -10, 20);
    }
    const align = TEXT_ALIGNS.find((candidate) => candidate === source.align);
    if (align) node.align = align;
  }
  if (type === "image") {
    const src = normalizeImageSrc(source.src);
    if (src) node.src = src;
  }
  if (type === "frame") {
    const layout = normalizeLayout(source.layout);
    if (layout) node.layout = layout;
    if (Array.isArray(source.children)) {
      const children: DesignNode[] = [];
      for (const child of source.children) {
        if (budget.count >= MAX_DESIGN_NODES) break;
        const normalized = normalizeDesignNode(child, budget, depth + 1);
        if (normalized) children.push(normalized);
      }
      if (children.length > 0) node.children = children;
    }
  }
  return node;
}

/** 风格指南名上限（仅作字符串长度防呆；合法性由 runtime-design 查目录校验）。 */
export const MAX_GUIDE_NAME_CHARS = 120;

/** 文档名净化：只留文件名安全字符，截断 80；空输入回落 fallback。 */
export function sanitizeDesignName(value: unknown, fallback = "未命名设计"): string {
  const name = typeof value === "string" ? value.replace(INVALID_FILENAME_CHARS, "-").replace(/\s+/gu, " ").trim().slice(0, 80) : "";
  return name || fallback;
}

function canvasOf(raw: unknown): DesignCanvasInfo {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const canvas: DesignCanvasInfo = {
    width: clamp(Math.round(finiteOr(source.width, 1440)), 1, 100_000),
    height: clamp(Math.round(finiteOr(source.height, 1024)), 1, 100_000)
  };
  const background = boundedString(source.background, 512);
  if (background) canvas.background = background;
  return canvas;
}

/**
 * 容错归一化整份文档：根不是对象返回 undefined；nodes 逐个 normalize（非法丢弃），
 * revision 缺失/非法重置为 1。
 */
export function normalizeDesignDoc(raw: unknown): DesignDoc | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const budget = { count: 0 };
  const nodes: DesignNode[] = [];
  if (Array.isArray(source.nodes)) {
    for (const item of source.nodes) {
      if (budget.count >= MAX_DESIGN_NODES) break;
      const normalized = normalizeDesignNode(item, budget);
      if (normalized) nodes.push(normalized);
    }
  }
  const revision = Math.round(finiteOr(source.revision, 1));
  const guide = boundedString(typeof source.guide === "string" ? source.guide.trim() : source.guide, MAX_GUIDE_NAME_CHARS);
  return {
    version: 1,
    id: typeof source.id === "string" && source.id.trim() ? source.id.trim().slice(0, 64) : randomId(),
    name: sanitizeDesignName(source.name),
    canvas: canvasOf(source.canvas),
    nodes,
    ...(guide ? { guide } : {}),
    revision: clamp(revision, 1, Number.MAX_SAFE_INTEGER)
  };
}

/** 新建空文档（design_create / 空态「新建设计」共用）。 */
export function createDesignDoc(name: string, width = 1440, height = 1024): DesignDoc {
  return {
    version: 1,
    id: randomId(),
    name: sanitizeDesignName(name),
    canvas: { width: clamp(Math.round(finiteOr(width, 1440)), 1, 100_000), height: clamp(Math.round(finiteOr(height, 1024)), 1, 100_000) },
    nodes: [],
    revision: 1
  };
}

/** 生成一个新节点 id（工具回执映射 / cloneNodeWithNewIds / 渲染端新建共用）。 */
export function makeNodeId(): string {
  return randomId();
}

export interface FoundNode {
  node: DesignNode;
  /** 父节点（根层级时为 undefined）。 */
  parent: DesignNode | undefined;
  /** 兄弟数组（根层级 = 文档根数组）；对它的引用可直接做插入/移除。 */
  siblings: DesignNode[];
  index: number;
}

/** 深度优先查找节点，返回节点 + 父 + 兄弟数组的活引用；找不到返回 undefined。 */
export function findNode(nodes: DesignNode[], id: string): FoundNode | undefined {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.id === id) return { node, parent: undefined, siblings: nodes, index };
    if (node.children) {
      const found = findNode(node.children, id);
      if (found) return found.parent ? found : { ...found, parent: node };
    }
  }
  return undefined;
}

/** 统计子树节点数（含自身）。 */
export function countNodes(nodes: readonly DesignNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children) total += countNodes(node.children);
  }
  return total;
}

/** id 是否在 target 子树中（防 move 成环）。 */
function subtreeHas(nodes: readonly DesignNode[], id: string): boolean {
  for (const node of nodes) {
    if (node.id === id) return true;
    if (node.children && subtreeHas(node.children, id)) return true;
  }
  return false;
}

/** 规范化插入下标：非法/越界回落到尾部。 */
function clampIndex(index: unknown, length: number): number {
  const num = Math.round(finiteOr(index, length));
  return clamp(num, 0, length);
}

/** 深拷贝节点子树并重新生成全部 id（Ctrl+D 复制 / AI 复制用）。 */
export function cloneNodeWithNewIds(node: DesignNode): DesignNode {
  const clone: DesignNode = { ...node, id: randomId() };
  if (node.children) clone.children = node.children.map(cloneNodeWithNewIds);
  return clone;
}

/**
 * 递归校验 create/replace 的节点草稿字段（仅 AI op 路径调用；文件加载走
 * normalizeDesignNode 保持容错，两套语义各司其职）。发现未知字段返回错误串。
 */
function draftKeyError(node: unknown, path: string): string | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  const source = node as Record<string, unknown>;
  const unknownKeys = Object.keys(source).filter((key) => !NODE_DRAFT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return `${path}含未知字段：${unknownKeys.join("、")}（可用字段：${[...NODE_DRAFT_KEYS].join("/")}；半透明直接写进 fill/stroke 的 rgba/hex8）`;
  }
  const children = source.children;
  if (Array.isArray(children)) {
    for (let index = 0; index < children.length; index++) {
      const error = draftKeyError(children[index], `${path}children[${index}].`);
      if (error) return error;
    }
  }
  return undefined;
}

/**
 * 原子批量应用 DesignOp：先深拷贝整份文档，逐个 op 应用；任一失败返回
 * {@link DesignOpResult} 的 error 形态并保留原文档不动（防半应用状态）。
 * revision 由调用方（design-store 写盘 / 渲染端提交）管理，这里不触碰。
 */
export function applyDesignOps(doc: DesignDoc, ops: readonly DesignOp[]): DesignOpResult {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: "ops 必须是非空数组" };
  const next: DesignDoc = structuredClone(doc);
  const applyOne = (op: DesignOp): string | undefined => {
    // op 级未知参数直接拒绝（同 patch 未知字段：宁可报错也不静默忽略）。
    const allowedKeys = OP_ALLOWED_KEYS[op.op];
    const unknownOpKeys = Object.keys(op as Record<string, unknown>).filter((key) => !allowedKeys.has(key));
    if (unknownOpKeys.length > 0) {
      return `op '${op.op}' 含未知参数：${unknownOpKeys.join("、")}（允许：${[...allowedKeys].join("/")}）`;
    }
    switch (op.op) {
      case "replace": {
        if (!Array.isArray(op.nodes)) return "replace 的 nodes 必须是数组";
        for (let index = 0; index < op.nodes.length; index++) {
          const keyError = draftKeyError(op.nodes[index], `replace 的 nodes[${index}].`);
          if (keyError) return keyError;
        }
        const budget = { count: 0 };
        const nodes: DesignNode[] = [];
        for (const item of op.nodes) {
          if (budget.count >= MAX_DESIGN_NODES) break;
          const normalized = normalizeDesignNode(item, budget);
          if (normalized) nodes.push(normalized);
        }
        // 新树内 id 重复拒绝（findNode/React key 歧义）。
        const seenIds = new Set<string>();
        const collect = (item: DesignNode): string | undefined => {
          if (seenIds.has(item.id)) return item.id;
          seenIds.add(item.id);
          for (const child of item.children ?? []) {
            const duplicate = collect(child);
            if (duplicate) return duplicate;
          }
          return undefined;
        };
        for (const root of nodes) {
          const duplicate = collect(root);
          if (duplicate) return `新树内节点 id 重复：${duplicate}`;
        }
        next.nodes = nodes;
        return undefined;
      }
      case "create": {
        const keyError = draftKeyError(op.node, "create 的 node.");
        if (keyError) return keyError;
        const budget = { count: countNodes(next.nodes) };
        if (budget.count >= MAX_DESIGN_NODES) return `节点数已达上限 ${MAX_DESIGN_NODES}`;
        const node = normalizeDesignNode(op.node, budget);
        if (!node) return "create 的 node 无效（缺 type 或形状非法）";
        if (node.id && findNode(next.nodes, node.id)) return `节点 id 已存在：${node.id}`;
        // 子树内 id 重复/与现有文档冲突都会让 findNode 歧义（React key 同理），拒绝。
        const subtreeIds: string[] = [];
        const collect = (item: DesignNode): void => { subtreeIds.push(item.id); item.children?.forEach(collect); };
        collect(node);
        const seen = new Set<string>();
        for (const id of subtreeIds) {
          if (seen.has(id)) return `新节点子树内 id 重复：${id}`;
          seen.add(id);
        }
        for (const id of seen) {
          if (findNode(next.nodes, id)) return `节点 id 已存在：${id}`;
        }
        let siblings: DesignNode[];
        if (op.parentId == null || op.parentId === "") {
          siblings = next.nodes;
        } else {
          const parent = findNode(next.nodes, op.parentId);
          if (!parent) return `父节点不存在：${op.parentId}`;
          if (parent.node.type !== "frame") return `父节点必须是 frame（${op.parentId} 是 ${parent.node.type}）`;
          siblings = parent.node.children ?? (parent.node.children = []);
        }
        siblings.splice(clampIndex(op.index, siblings.length), 0, node);
        return undefined;
      }
      case "update": {
        const found = findNode(next.nodes, op.id);
        if (!found) return `节点不存在：${op.id}`;
        const patch = op.patch;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "update 的 patch 必须是对象";
        if ("id" in patch || "type" in patch || "children" in patch) return "update 不允许修改 id/type/children（结构变化用 create/move/delete）";
        const node = found.node;
        const source = patch as Record<string, unknown>;
        // 未知字段直接拒绝而不是静默忽略：否则 AI 打错字段名（如 fontsize）会拿到
        // 「成功」回执却什么都没改（reported success but did not apply）。
        const unknownKeys = Object.keys(source).filter((key) => !PATCHABLE_KEYS.has(key));
        if (unknownKeys.length > 0) return `patch 含未知字段：${unknownKeys.join("、")}（可用字段：${[...PATCHABLE_KEYS].join("/")}）`;
        if ("name" in source) {
          const name = boundedString(source.name, 80);
          if (name) node.name = name;
          else delete node.name;
        }
        if ("x" in source) node.x = round2(finiteOr(source.x, node.x));
        if ("y" in source) node.y = round2(finiteOr(source.y, node.y));
        if ("w" in source) node.w = Math.max(1, round2(finiteOr(source.w, node.w)));
        if ("h" in source) node.h = Math.max(1, round2(finiteOr(source.h, node.h)));
        if ("visible" in source) {
          if (source.visible === false) node.visible = false;
          else delete node.visible;
        }
        if ("locked" in source) {
          if (source.locked === true) node.locked = true;
          else delete node.locked;
        }
        if ("fill" in source) {
          const fill = boundedString(source.fill, 512);
          if (fill) node.fill = fill;
          else delete node.fill;
        }
        if ("stroke" in source) {
          const stroke = boundedString(source.stroke, 512);
          if (stroke) node.stroke = stroke;
          else delete node.stroke;
        }
        if ("strokeWidth" in source) {
          const strokeWidth = finiteOr(source.strokeWidth, 0);
          if (strokeWidth > 0) node.strokeWidth = Math.min(64, round2(strokeWidth));
          else delete node.strokeWidth;
        }
        if ("radius" in source) {
          const radius = finiteOr(source.radius, 0);
          if (radius > 0) node.radius = Math.min(9999, round2(radius));
          else delete node.radius;
        }
        if ("opacity" in source) {
          const opacity = finiteOr(source.opacity, 1);
          if (opacity < 1) node.opacity = clamp(opacity, 0, 1);
          else delete node.opacity;
        }
        if ("shadow" in source) {
          const shadow = boundedString(source.shadow, 1024);
          if (shadow) node.shadow = shadow;
          else delete node.shadow;
        }
        if ("text" in source) node.text = typeof source.text === "string" ? source.text.slice(0, 10_000) : "";
        if ("layout" in source) {
          const layout = source.layout == null ? undefined : normalizeLayout(source.layout);
          if (layout) node.layout = layout;
          else delete node.layout;
        }
        if ("fontSize" in source) node.fontSize = clamp(round2(finiteOr(source.fontSize, 14)), 1, 400);
        if ("fontWeight" in source) node.fontWeight = Math.round(clamp(finiteOr(source.fontWeight, 400), 1, 1000));
        if ("color" in source) {
          const color = boundedString(source.color, 512);
          if (color) node.color = color;
          else delete node.color;
        }
        if ("lineHeight" in source) {
          const lineHeight = finiteOr(source.lineHeight, 0);
          if (lineHeight > 0) node.lineHeight = clamp(round2(lineHeight), 0.5, 10);
          else delete node.lineHeight;
        }
        if ("fontFamily" in source) {
          const fontFamily = normalizeFontFamily(source.fontFamily);
          if (fontFamily) node.fontFamily = fontFamily;
          else delete node.fontFamily;
        }
        if ("letterSpacing" in source) {
          const letterSpacing = source.letterSpacing === undefined || source.letterSpacing === null ? 0 : finiteOr(source.letterSpacing, 0);
          if (letterSpacing !== 0) node.letterSpacing = clamp(round2(letterSpacing), -10, 20);
          else delete node.letterSpacing;
        }
        if ("align" in source) {
          const align = TEXT_ALIGNS.find((candidate) => candidate === source.align);
          if (align) node.align = align;
          else delete node.align;
        }
        if ("src" in source) {
          const src = normalizeImageSrc(source.src);
          if (src) node.src = src;
          else delete node.src;
        }
        return undefined;
      }
      case "delete": {
        const found = findNode(next.nodes, op.id);
        if (!found) return `节点不存在：${op.id}`;
        found.siblings.splice(found.index, 1);
        return undefined;
      }
      case "resize": {
        if ("width" in op) next.canvas.width = clamp(Math.round(finiteOr(op.width, next.canvas.width)), 1, 100_000);
        if ("height" in op) next.canvas.height = clamp(Math.round(finiteOr(op.height, next.canvas.height)), 1, 100_000);
        if ("background" in op) {
          const background = boundedString(op.background, 512);
          if (background) next.canvas.background = background;
          else delete next.canvas.background;
        }
        return undefined;
      }
      case "move": {
        const found = findNode(next.nodes, op.id);
        if (!found) return `节点不存在：${op.id}`;
        let siblings: DesignNode[];
        if (op.parentId == null || op.parentId === "") {
          siblings = next.nodes;
        } else {
          const parent = findNode(next.nodes, op.parentId);
          if (!parent) return `目标父节点不存在：${op.parentId}`;
          if (parent.node.type !== "frame") return `目标父节点必须是 frame（${op.parentId} 是 ${parent.node.type}）`;
          if (parent.node.id === found.node.id) return "不能把节点移动到自己下面";
          // 目标父在待移动节点自己的子树内 → 成环，拒绝。
          if (subtreeHas([found.node], parent.node.id)) return "不能把节点移动到它自己的子树内";
          siblings = parent.node.children ?? (parent.node.children = []);
        }
        found.siblings.splice(found.index, 1);
        siblings.splice(clampIndex(op.index, siblings.length), 0, found.node);
        // dx/dy 平移子树根（子树坐标相对父节点，children 跟随根移动）。
        const dx = typeof op.dx === "number" && Number.isFinite(op.dx) ? round2(op.dx) : 0;
        const dy = typeof op.dy === "number" && Number.isFinite(op.dy) ? round2(op.dy) : 0;
        if (dx !== 0) found.node.x = round2(found.node.x + dx);
        if (dy !== 0) found.node.y = round2(found.node.y + dy);
        return undefined;
      }
      default:
        return `未知 op：${String((op as { op?: unknown }).op)}`;
    }
  };
  for (const op of ops) {
    const error = applyOne(op);
    if (error) return { ok: false, error };
  }
  return { ok: true, doc: next };
}

/** 按 id 收集节点 id → 节点映射（工具回执的新建 id 映射等场景）。 */
export function indexNodes(nodes: readonly DesignNode[], into = new Map<string, DesignNode>()): Map<string, DesignNode> {
  for (const node of nodes) {
    into.set(node.id, node);
    if (node.children) indexNodes(node.children, into);
  }
  return into;
}

/**
 * 「发给 AI」的选中节点摘要：剔除渲染冗余字段，压缩成紧凑 JSON（属性面板/
 * 工具栏注入 composer 用）。截断超长 text。
 */
export function summarizeNode(node: DesignNode): string {
  const slim = (item: DesignNode): Record<string, unknown> => {
    const entry: Record<string, unknown> = {
      id: item.id,
      type: item.type,
      ...(item.name ? { name: item.name } : {}),
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h
    };
    if (item.fill) entry.fill = item.fill;
    if (item.stroke) entry.stroke = item.stroke;
    if (item.radius) entry.radius = item.radius;
    if (item.opacity !== undefined && item.opacity < 1) entry.opacity = item.opacity;
    if (item.locked) entry.locked = true;
    if (item.type === "text") {
      entry.text = item.text && item.text.length > 300 ? `${item.text.slice(0, 300)}…` : item.text;
      entry.fontSize = item.fontSize;
      if (item.fontWeight !== 400) entry.fontWeight = item.fontWeight;
      if (item.color) entry.color = item.color;
      if (item.fontFamily) entry.fontFamily = item.fontFamily;
      if (item.letterSpacing) entry.letterSpacing = item.letterSpacing;
      if (item.align) entry.align = item.align;
    }
    if (item.type === "image" && item.src) entry.src = item.src.length > 200 ? `${item.src.slice(0, 200)}…` : item.src;
    if (item.children) entry.children = item.children.map(slim);
    return entry;
  };
  return JSON.stringify(slim(node));
}
