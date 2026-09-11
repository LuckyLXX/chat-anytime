/**
 * 设计 token 标尺（设计模式的审美地基）：间距 / 圆角 / 字号各自的合法档位。
 *
 * 为什么需要：对三份真实稿子的结构化统计发现 22 种圆角、37 种间距、16 种字号
 * （含 12.5 / 13.5 / 19 这类标尺外凑数）——不是缺能力，而是每一步都随手取了一个
 * 「看起来差不多」的数，整篇就没有节奏，于是「没有设计感」。标尺把取值自由度
 * 收敛到 6–15 档，质量门据此把散沙检出并给出可直接套用的吸附修复。
 *
 * 与 dsh-openpencil 的差别：它的 guide digest 只保留调色板/字体/字号，丢掉了间距
 * 与圆角标尺——而那恰是我们最需要的（22 种圆角的病根）。本模块把三类标尺都建模。
 *
 * 纯数据 + 纯函数，零 node 依赖（utility 与 renderer 共用）；风格指南可以带自己的
 * 标尺，因此所有校验函数一律接受 tokens 参数，不硬编码全局常量。
 */

/** 默认间距标尺（4 的倍数为主，两端留 2/6 与 80+ 的大档）。 */
export const DEFAULT_SPACING_SCALE: readonly number[] = [2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 120];
/** 默认圆角标尺（0 = 方角，9999 = 胶囊/圆）。 */
export const DEFAULT_RADIUS_SCALE: readonly number[] = [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 9999];
/** 默认字号标尺（11–64 共 14 档）。 */
export const DEFAULT_FONT_SIZE_SCALE: readonly number[] = [11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64];

export interface DesignTokens {
  spacing: readonly number[];
  radius: readonly number[];
  fontSize: readonly number[];
}

export const DEFAULT_DESIGN_TOKENS: DesignTokens = {
  spacing: DEFAULT_SPACING_SCALE,
  radius: DEFAULT_RADIUS_SCALE,
  fontSize: DEFAULT_FONT_SIZE_SCALE
};

/**
 * 吸附容差：0.25px。刻意取得很小——真实稿子里的 13.5 / 12.5 / 19 这类「凑数」
 * 值（半档台阶、奇数值）正是要被抓出来的对象；容差太宽松（0.5）会把 13.5 当成 13
 * 的舍入误差放行，标尺就形同虚设。同时 16.2 这类输入仍不会报。
 */
export const DEFAULT_SCALE_TOLERANCE = 0.25;
/** 胶囊圆角哨兵值（=「全圆」，几何上等同于高度的一半以上）。 */
export const PILL_RADIUS = 9999;
/** 半径 ≥ 该值一律按胶囊处理：再大的数值在视觉上与全圆无差别，不该被拉回 24。 */
export const PILL_RADIUS_MIN = 100;

/**
 * 吸附：`value` 在标尺容差内 → 返回对应标尺值（可能被吸附到更规范的那个），
 * 否则返回 undefined（= 「不在标尺上」）。空标尺一律 undefined。
 */
export function snapToScale(value: number, scale: readonly number[], tolerance = DEFAULT_SCALE_TOLERANCE): number | undefined {
  if (!Number.isFinite(value) || scale.length === 0) return undefined;
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of scale) {
    if (!Number.isFinite(candidate)) continue;
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== undefined && bestDistance <= tolerance ? best : undefined;
}

/** 最近的标尺值（不带容差判定；不在标尺上时用它产出吸附修复）。 */
export function nearestScaleValue(value: number, scale: readonly number[]): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of scale) {
    if (!Number.isFinite(candidate)) continue;
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** 半径是否在标尺上（≥ {@link PILL_RADIUS_MIN} 视为胶囊：标尺含 9999 时算命中）。 */
export function radiusOnScale(value: number, scale: readonly number[], tolerance = DEFAULT_SCALE_TOLERANCE): boolean {
  if (value >= PILL_RADIUS_MIN) return scale.some((candidate) => candidate >= PILL_RADIUS);
  return snapToScale(value, scale, tolerance) !== undefined;
}

/** 半径的吸附修复值：胶囊量级保留胶囊，其余取最近档位。 */
export function nearestRadius(value: number, scale: readonly number[]): number {
  if (value >= PILL_RADIUS_MIN && scale.some((candidate) => candidate >= PILL_RADIUS)) return PILL_RADIUS;
  return nearestScaleValue(value, scale) ?? value;
}

/** 归一化任意标尺输入：只保留有限非负数，升序去重，上限 64 档；空结果回落 fallback。 */
export function normalizeScale(values: unknown, fallback: readonly number[]): number[] {
  if (!Array.isArray(values)) return [...fallback];
  const cleaned = values
    .map((value) => (typeof value === "number" ? value : Number(value)))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const unique: number[] = [];
  for (const value of cleaned) {
    if (unique.length >= 64) break;
    if (unique.length === 0 || unique[unique.length - 1] !== value) unique.push(value);
  }
  return unique.length >= 2 ? unique : [...fallback];
}

/** 用（可能来自风格指南的）部分标尺拼一份完整 tokens，缺失/非法项回落默认标尺。 */
export function tokensFromScales(partial?: Partial<DesignTokens> | undefined): DesignTokens {
  return {
    spacing: normalizeScale(partial?.spacing, DEFAULT_SPACING_SCALE),
    radius: normalizeScale(partial?.radius, DEFAULT_RADIUS_SCALE),
    fontSize: normalizeScale(partial?.fontSize, DEFAULT_FONT_SIZE_SCALE)
  };
}

/** 标尺的人类可读形式（诊断信息里展示合法档位）。 */
export function formatScale(scale: readonly number[]): string {
  return scale.map((value) => String(Math.round(value * 100) / 100)).join("/");
}
