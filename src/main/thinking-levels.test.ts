import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "../shared/protocol.js";
import {
  THINKING_LEVELS,
  clampThinkingLevel as clampApp,
  defaultThinkingLevelMapFor,
  narrowThinkingLevelsByAllowList,
  normalizeThinkingLevelAllowList,
  normalizeThinkingLevelMap,
  supportedThinkingLevels,
  thinkingLevelDraftFrom,
  thinkingLevelMapFromDraft,
  thinkingLevelMenu,
  thinkingLevelMenuFor,
  upstreamThinkingValue
} from "../shared/thinking-levels.js";

/** 与 Pi 的 Model 形状对齐（只取思考相关字段）。 */
function piModel(reasoning: boolean, thinkingLevelMap?: Record<string, string | null>) {
  return { reasoning, thinkingLevelMap } as Parameters<typeof getSupportedThinkingLevels>[0];
}

describe("thinking level capability", () => {
  it("mirrors Pi for an undeclared reasoning model", () => {
    expect(supportedThinkingLevels(undefined, true)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(supportedThinkingLevels(undefined, true)).toEqual(getSupportedThinkingLevels(piModel(true)) as ThinkingLevel[]);
  });

  it("mirrors Pi for a declared model (xhigh/max need an explicit key)", () => {
    const map = { off: null, minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null };
    expect(supportedThinkingLevels(map, true)).toEqual(["low", "medium", "xhigh"]);
    expect(supportedThinkingLevels(map, true)).toEqual(getSupportedThinkingLevels(piModel(true, map)) as ThinkingLevel[]);
    // 只声明 xhigh 不等于「只支持 xhigh」：缺键的低档位仍按缺省可用（Pi 的同一口径）。
    expect(supportedThinkingLevels({ xhigh: "xhigh" }, true)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("only offers off for a non-reasoning model", () => {
    expect(supportedThinkingLevels(undefined, false)).toEqual(["off"]);
    expect(supportedThinkingLevels(undefined, false)).toEqual(getSupportedThinkingLevels(piModel(false)) as ThinkingLevel[]);
  });

  it("matches Pi's clamp in both directions", () => {
    const available: ThinkingLevel[] = ["low", "medium", "xhigh"];
    for (const requested of THINKING_LEVELS) {
      expect(clampApp(available, requested)).toBe(clampThinkingLevel(piModel(true, { low: "low", medium: "medium", xhigh: "xhigh", off: null, minimal: null, high: null, max: null }), requested));
    }
    // 向上优先：high 在 xhigh 存在时升到 xhigh；off 在无低档时降到最低可用档。
    expect(clampApp(available, "high")).toBe("xhigh");
    expect(clampApp(["medium", "high"], "off")).toBe("medium");
    expect(clampApp([], "high")).toBe("off");
  });

  it("maps levels to the value actually sent upstream", () => {
    expect(upstreamThinkingValue(undefined, "high")).toBe("high");
    expect(upstreamThinkingValue({ high: "xhigh" }, "high")).toBe("xhigh");
    expect(upstreamThinkingValue({ high: null }, "high")).toBeUndefined();
  });

  it("builds a menu that explains why a level is unavailable", () => {
    const menu = thinkingLevelMenu({ off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" }, true);
    expect(menu.map((option) => option.level)).toEqual([...THINKING_LEVELS]);
    expect(menu.find((option) => option.level === "max")).toMatchObject({ supported: true });
    expect(menu.find((option) => option.level === "high")).toMatchObject({ supported: false, fallback: "max" });
    expect(menu.find((option) => option.level === "off")).toMatchObject({ supported: false, fallback: "max" });
  });

  it("collapses a menu with no model selected to the runtime default", () => {
    expect(thinkingLevelMenuFor(undefined).map((option) => option.supported)).toEqual([true, true, true, true, true, false, false]);
  });
});

describe("thinking level normalization", () => {
  it("keeps only legal levels and string/null values", () => {
    expect(normalizeThinkingLevelMap({ high: "xhigh", off: null, xhigh: "  xhigh  ", bogus: "x", minimal: 2, low: "" }))
      .toEqual({ high: "xhigh", off: null, xhigh: "xhigh" });
    expect(normalizeThinkingLevelMap({})).toBeUndefined();
    expect(normalizeThinkingLevelMap(null)).toBeUndefined();
    expect(normalizeThinkingLevelMap([{ high: "xhigh" }])).toBeUndefined();
  });

  it("normalizes the allow list (full selection = follow runtime default)", () => {
    expect(normalizeThinkingLevelAllowList(["high", "xhigh", "bogus", "high"])).toEqual(["high", "xhigh"]);
    expect(normalizeThinkingLevelAllowList([...THINKING_LEVELS])).toBeUndefined();
    expect(normalizeThinkingLevelAllowList([])).toBeUndefined();
    expect(normalizeThinkingLevelAllowList("high")).toBeUndefined();
    // 交集为空时保留原集合（宁可放宽白名单也不给空菜单）。
    expect(narrowThinkingLevelsByAllowList(["high", "xhigh"], ["low"])).toEqual(["high", "xhigh"]);
    expect(narrowThinkingLevelsByAllowList(["high", "xhigh"], ["xhigh"])).toEqual(["xhigh"]);
    expect(narrowThinkingLevelsByAllowList(["high", "xhigh"], undefined)).toEqual(["high", "xhigh"]);
  });

  it("round-trips the settings editor draft through its declared map", () => {
    const draft = thinkingLevelDraftFrom(undefined, true);
    expect(draft.enabled).toEqual({ off: true, minimal: true, low: true, medium: true, high: true, xhigh: false, max: false });
    // 未改动草稿 = 不声明（缺省口径），而不是写死一份「关闭…高」。
    expect(thinkingLevelMapFromDraft(draft)).toBeUndefined();

    // 打开「很高」+ 把「高」映射到 xhigh（用户截图里的场景）。
    const custom = { ...draft, enabled: { ...draft.enabled, xhigh: true }, values: { ...draft.values, high: "xhigh" } };
    const map = thinkingLevelMapFromDraft(custom);
    expect(map).toEqual({ high: "xhigh", xhigh: "xhigh" });
    expect(supportedThinkingLevels(map, true)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(upstreamThinkingValue(map, "xhigh")).toBe("xhigh");

    // 关掉「最少」要显式写 null，缺键会被 Pi 当成默认可用。
    const narrowed = { ...draft, enabled: { ...draft.enabled, minimal: false } };
    expect(thinkingLevelMapFromDraft(narrowed)).toEqual({ minimal: null });
    expect(supportedThinkingLevels(thinkingLevelMapFromDraft(narrowed), true)).toEqual(["off", "low", "medium", "high"]);

    // 回显：草稿能还原已声明的映射。
    const roundTrip = thinkingLevelDraftFrom(thinkingLevelMapFromDraft(custom)!, true);
    expect(thinkingLevelMapFromDraft(roundTrip)).toEqual(thinkingLevelMapFromDraft(custom));
    expect(thinkingLevelDraftFrom(defaultThinkingLevelMapFor(true), true).enabled).toMatchObject({ high: true, xhigh: false });
    expect(supportedThinkingLevels(defaultThinkingLevelMapFor(false), false)).toEqual(["off"]);
  });
});
