import { describe, expect, it } from "vitest";
import type { ContextUsage } from "../../../shared/protocol";
import { contextUsageCacheLabel, contextUsagePercentLabel, contextUsageTone, contextUsageTooltip, formatTokenCount } from "./context-usage";

describe("formatTokenCount", () => {
  it("keeps small counts plain", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(800)).toBe("800");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("compacts thousands with one decimal", () => {
    expect(formatTokenCount(1000)).toBe("1K");
    expect(formatTokenCount(12_340)).toBe("12.3K");
    expect(formatTokenCount(999_940)).toBe("999.9K");
  });

  it("compacts millions with one decimal", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_254_000)).toBe("1.3M");
  });
});

describe("contextUsageTone", () => {
  it("stays normal below the warning threshold", () => {
    expect(contextUsageTone({ tokens: 0, contextWindow: 128_000, percent: 0, cacheHitRate: null })).toBe("normal");
    expect(contextUsageTone({ tokens: 89_600, contextWindow: 128_000, percent: 70, cacheHitRate: null })).toBe("normal");
  });

  it("warns above 70% and goes danger above 90%", () => {
    expect(contextUsageTone({ tokens: 96_000, contextWindow: 128_000, percent: 75, cacheHitRate: null })).toBe("warn");
    expect(contextUsageTone({ tokens: 90, contextWindow: 100, percent: 90.1, cacheHitRate: null })).toBe("danger");
  });

  it("treats unknown percent as normal", () => {
    expect(contextUsageTone({ tokens: null, contextWindow: 128_000, percent: null, cacheHitRate: null })).toBe("normal");
  });
});

describe("contextUsage labels", () => {
  it("formats percent with one decimal", () => {
    const usage: ContextUsage = { tokens: 80_100, contextWindow: 128_000, percent: 62.578, cacheHitRate: null };
    expect(contextUsagePercentLabel(usage)).toBe("62.6%");
    expect(contextUsageTooltip(usage)).toContain("80.1K / 128K");
  });

  it("uses the em dash placeholder after compaction", () => {
    const usage: ContextUsage = { tokens: null, contextWindow: 128_000, percent: null, cacheHitRate: null };
    expect(contextUsagePercentLabel(usage)).toBe("—");
    expect(contextUsageTooltip(usage)).toContain("压缩后");
    expect(contextUsageTooltip(usage)).toContain("128K");
  });

  it("renders the cache hit segment only when known", () => {
    const withHit: ContextUsage = { tokens: 80_100, contextWindow: 128_000, percent: 62.5, cacheHitRate: 91.28 };
    expect(contextUsageCacheLabel(withHit)).toBe("91%");
    expect(contextUsageTooltip(withHit)).toContain("缓存命中");
    const noHit: ContextUsage = { tokens: 80_100, contextWindow: 128_000, percent: 62.5, cacheHitRate: null };
    expect(contextUsageCacheLabel(noHit)).toBe("");
    expect(contextUsageTooltip(noHit)).not.toContain("缓存命中");
  });
});
