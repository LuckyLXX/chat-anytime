import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIGN_TOKENS,
  DEFAULT_FONT_SIZE_SCALE,
  DEFAULT_RADIUS_SCALE,
  DEFAULT_SPACING_SCALE,
  formatScale,
  nearestRadius,
  nearestScaleValue,
  normalizeScale,
  radiusOnScale,
  snapToScale,
  tokensFromScales
} from "./design-tokens.js";

describe("snapToScale", () => {
  it("标尺上的值原样返回；容差内的邻值吸附过去", () => {
    expect(snapToScale(16, DEFAULT_SPACING_SCALE)).toBe(16);
    expect(snapToScale(16.2, DEFAULT_SPACING_SCALE)).toBe(16);
    expect(snapToScale(11.9, DEFAULT_SPACING_SCALE)).toBe(12);
  });

  it("超出容差返回 undefined（= 不在标尺上）——13.5/12.5 这类半档凑数要被抓住", () => {
    expect(snapToScale(37, DEFAULT_SPACING_SCALE)).toBeUndefined();
    expect(snapToScale(13.5, DEFAULT_FONT_SIZE_SCALE)).toBeUndefined();
    expect(snapToScale(12.5, DEFAULT_FONT_SIZE_SCALE)).toBeUndefined();
    expect(snapToScale(19, DEFAULT_FONT_SIZE_SCALE)).toBeUndefined();
    expect(snapToScale(-5, DEFAULT_SPACING_SCALE)).toBeUndefined();
  });

  it("自定义容差生效", () => {
    expect(snapToScale(18, DEFAULT_SPACING_SCALE, 6)).toBe(16);
    expect(snapToScale(18, DEFAULT_SPACING_SCALE, 1)).toBeUndefined();
  });

  it("空标尺 / 非有限值返回 undefined", () => {
    expect(snapToScale(8, [])).toBeUndefined();
    expect(snapToScale(Number.NaN, DEFAULT_SPACING_SCALE)).toBeUndefined();
    expect(snapToScale(Number.POSITIVE_INFINITY, DEFAULT_SPACING_SCALE)).toBeUndefined();
  });
});

describe("nearestScaleValue / nearestRadius", () => {
  it("取最近档位（用于产出吸附修复）", () => {
    expect(nearestScaleValue(15, DEFAULT_SPACING_SCALE)).toBe(16);
    expect(nearestScaleValue(19, DEFAULT_FONT_SIZE_SCALE)).toBe(18);
    expect(nearestScaleValue(Number.NaN, DEFAULT_SPACING_SCALE)).toBeUndefined();
  });

  it("半径：胶囊量级保留胶囊，其余取最近档位", () => {
    expect(nearestRadius(220, DEFAULT_RADIUS_SCALE)).toBe(9999);
    expect(nearestRadius(9999, DEFAULT_RADIUS_SCALE)).toBe(9999);
    expect(nearestRadius(14, DEFAULT_RADIUS_SCALE)).toBe(12);
    expect(nearestRadius(29, DEFAULT_RADIUS_SCALE)).toBe(24);
  });

  it("radiusOnScale：≥100 视为胶囊（标尺含 9999 时算命中）", () => {
    expect(radiusOnScale(12, DEFAULT_RADIUS_SCALE)).toBe(true);
    expect(radiusOnScale(14, DEFAULT_RADIUS_SCALE)).toBe(false);
    expect(radiusOnScale(9999, DEFAULT_RADIUS_SCALE)).toBe(true);
    expect(radiusOnScale(210, DEFAULT_RADIUS_SCALE)).toBe(true);
    // 没有胶囊档位的自定义标尺：大半径不命中。
    expect(radiusOnScale(210, [0, 8, 12])).toBe(false);
  });
});

describe("normalizeScale / tokensFromScales", () => {
  it("归一化：过滤非法值、升序去重、上限 64 档", () => {
    const scale = normalizeScale([12, 4, 4, -1, "8", Number.NaN, 200], DEFAULT_SPACING_SCALE);
    expect(scale).toEqual([4, 8, 12, 200]);
    const long = normalizeScale(Array.from({ length: 100 }, (_, index) => index), DEFAULT_SPACING_SCALE);
    expect(long).toHaveLength(64);
  });

  it("非法/空标尺回落默认（标尺至少要两档才可信）", () => {
    expect(normalizeScale(undefined, DEFAULT_RADIUS_SCALE)).toEqual([...DEFAULT_RADIUS_SCALE]);
    expect(normalizeScale([1], DEFAULT_RADIUS_SCALE)).toEqual([...DEFAULT_RADIUS_SCALE]);
    expect(normalizeScale("nope", DEFAULT_RADIUS_SCALE)).toEqual([...DEFAULT_RADIUS_SCALE]);
  });

  it("tokensFromScales：部分提供时其余走默认；风格专属标尺能覆盖默认", () => {
    const tokens = tokensFromScales({ radius: [0, 8, 16] });
    expect(tokens.radius).toEqual([0, 8, 16]);
    expect(tokens.spacing).toEqual([...DEFAULT_SPACING_SCALE]);
    expect(tokens.fontSize).toEqual([...DEFAULT_FONT_SIZE_SCALE]);
    expect(tokensFromScales(undefined)).toEqual(DEFAULT_DESIGN_TOKENS);
  });

  it("formatScale 人类可读", () => {
    expect(formatScale([0, 8, 9999])).toBe("0/8/9999");
  });
});
