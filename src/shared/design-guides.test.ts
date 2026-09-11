import { describe, expect, it } from "vitest";
import {
  allStyleGuides,
  buildGuideInjection,
  CJK_FONT_STACK_HINT,
  cjkGuideFor,
  DEFAULT_GUIDE_PALETTE,
  filterGuideIndex,
  formatGuideIndexLine,
  getStyleGuide,
  listGuideIndex,
  mapGuidePalette,
  mapGuidePaletteWithFallback,
  matchGuideName,
  MAX_GUIDE_INJECTION_BYTES,
  platformCompatible,
  platformForWidth,
  selectStyleGuide,
  utf8Bytes,
  type StyleGuideDigest
} from "./design-guides.js";
import { DEFAULT_RADIUS_SCALE, DEFAULT_SPACING_SCALE } from "./design-tokens.js";

/** 构造一套最小指南（测匹配/映射逻辑时不依赖真实语料的具体配色）。 */
function guide(partial: Partial<StyleGuideDigest> & { name: string }): StyleGuideDigest {
  return {
    platform: "webapp",
    tags: [],
    summary: "摘要",
    aesthetics: [],
    palette: {},
    fonts: {},
    type: [],
    spacing: [],
    radius: [],
    letterSpacing: [],
    lineHeight: [],
    ...partial
  };
}

describe("语料完整性（src/shared/design-guides.json）", () => {
  it("63 套指南，字段齐全", () => {
    const guides = allStyleGuides();
    expect(guides.length).toBe(63);
    for (const entry of guides) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(["webapp", "mobile", "slides", "card"]).toContain(entry.platform);
      expect(entry.tags.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it("每套至少 4 个调色板 token 与 1 个字体族（构建脚本的校验门）", () => {
    for (const entry of allStyleGuides()) {
      expect(Object.keys(entry.palette).length).toBeGreaterThanOrEqual(4);
      expect(entry.fonts.heading ?? entry.fonts.body).toBeDefined();
      expect(Object.values(entry.palette).every((value) => /^#[0-9A-F]{6}$/u.test(value))).toBe(true);
    }
  });

  it("标尺解析健壮：绝大多数指南带间距/字号标尺（散文式指南允许为空回落默认）", () => {
    const guides = allStyleGuides();
    expect(guides.filter((entry) => entry.spacing.length >= 4).length).toBeGreaterThanOrEqual(50);
    expect(guides.filter((entry) => entry.type.length >= 4).length).toBeGreaterThanOrEqual(50);
    expect(guides.filter((entry) => entry.radius.length >= 3).length).toBeGreaterThanOrEqual(50);
  });

  it("单套 digest 体积可接受（≤ 1.5KB，注入预算的前提）", () => {
    for (const entry of allStyleGuides()) {
      expect(utf8Bytes(JSON.stringify(entry))).toBeLessThanOrEqual(1500);
    }
  });

  it("getStyleGuide 大小写不敏感；不存在返回 undefined", () => {
    expect(getStyleGuide("AI-PRODUCT-DARK")?.name).toBe("ai-product-dark");
    expect(getStyleGuide("no-such-guide")).toBeUndefined();
  });
});

describe("platformForWidth", () => {
  it("≤600 视为移动端，其余 web；缺省 web", () => {
    expect(platformForWidth(390)).toBe("mobile");
    expect(platformForWidth(600)).toBe("mobile");
    expect(platformForWidth(601)).toBe("web");
    expect(platformForWidth(1440)).toBe("web");
    expect(platformForWidth(undefined)).toBe("web");
  });
});

describe("GUIDE_RULES 关键词匹配", () => {
  it("垂直场景 web 命中", () => {
    expect(matchGuideName("咖啡外卖官网", "web")).toBe("retro-warm-light");
    expect(matchGuideName("金融理财产品落地页", "web")).toBe("fintech-dark-blue-light");
    expect(matchGuideName("数据看板 dashboard", "web")).toBe("dashboard-analytics-dark");
    expect(matchGuideName("AI 智能体产品官网", "web")).toBe("ai-product-dark");
    expect(matchGuideName("电商商城首页", "web")).toBe("ecommerce-modern-light");
    expect(matchGuideName("健身房预约官网", "web")).toBe("wellness-organic-light");
  });

  it("移动端取 mobile 变体", () => {
    expect(matchGuideName("咖啡外卖 App", "mobile")).toBe("warm-food-mobile-light");
    expect(matchGuideName("金融理财 App", "mobile")).toBe("finance-clean-mobile-light");
    expect(matchGuideName("旅游行程 App", "mobile")).toBe("travel-warm-mobile-light");
  });

  it("cjkGuideFor 按平台兼容性过滤：当前语料无 webapp/mobile 级中文特调风格", () => {
    // 语料里带 cjk-type 的 10 套全是 slides/card（演示文稿与社交卡片），
    // 它们的页面几何不能当网页/移动页面设计用，因此这里刻意不命中。
    expect(cjkGuideFor("web")).toBeUndefined();
    expect(cjkGuideFor("mobile")).toBeUndefined();
    expect(allStyleGuides().filter((entry) => entry.tags.includes("cjk-type")).every((entry) => !platformCompatible(entry, "web"))).toBe(true);
  });

  it("平台兼容性：slides/card 不参与 web/mobile 自动匹配", () => {
    for (const entry of allStyleGuides()) {
      if (entry.platform === "slides" || entry.platform === "card") {
        expect(platformCompatible(entry, "web")).toBe(false);
        expect(platformCompatible(entry, "mobile")).toBe(false);
      }
    }
    // 规则表里引用的名字全部存在，且都能被 web 或 mobile 自动命中。
    for (const brief of ["咖啡", "教育", "金融", "企业", "杂志", "和风", "瑞士", "马卡龙", "医疗"]) {
      const name = matchGuideName(brief, "web")!;
      expect(platformCompatible(getStyleGuide(name)!, "web")).toBe(true);
    }
  });

  it("中文 brief 不再切到 slides 类 cjk 专用项（平台不兼容），但中文排版提示仍然生效", () => {
    expect(matchGuideName("中小学在线课程页面", "web")).toBe("education-friendly-light");
    expect(matchGuideName("企业财务系统", "web")).toBe("corporate-blue-light");
    // 中文排版的真正落点在注入文本的字体栈提示上。
    const selected = selectStyleGuide("中小学在线课程页面", "web")!;
    expect(selected.cjk).toBe(true);
    expect(buildGuideInjection(selected)).toContain("中文字体");
  });

  it("无命中返回 undefined（不硬套一套不相关的风格）", () => {
    expect(matchGuideName("这是一个没有任何场景词的需求", "web")).toBeUndefined();
    expect(matchGuideName("qwertyuiop zxcv", "web")).toBeUndefined();
  });
});

describe("selectStyleGuide", () => {
  it("暗色 brief 命中非暗色指南时切换到同平台暗色基准", () => {
    // 电商 web 规则指向 ecommerce-modern-light（浅色）→ 暗色 brief 换 midnight-minimal-dark。
    const light = selectStyleGuide("电商商城首页", "web");
    expect(light?.name).toBe("ecommerce-modern-light");
    const dark = selectStyleGuide("电商商城首页 暗色主题", "web");
    expect(dark?.name).toBe("midnight-minimal-dark");
    expect(dark?.tags).toContain("dark-mode");
    // 移动端同名场景换 dark-bold-mobile。
    expect(selectStyleGuide("电商 App 暗黑模式", "mobile")?.name).toBe("dark-bold-mobile");
  });

  it("同 brief 同平台 → 同结果（确定性）", () => {
    const first = selectStyleGuide("咖啡外卖 App 首页", "mobile");
    const second = selectStyleGuide("咖啡外卖 App 首页", "mobile");
    expect(first).toEqual(second);
    expect(first?.name).toBe("warm-food-mobile-light");
  });

  it("显式指南名优先于关键词匹配，并跳过暗色替换", () => {
    const explicit = selectStyleGuide("咖啡外卖 App", "mobile", "ai-product-dark");
    expect(explicit?.name).toBe("ai-product-dark");
    expect(explicit?.platform).toBe("webapp");
    // 不存在/空名的显式项等同未提供（回落到规则）。
    expect(selectStyleGuide("咖啡外卖 App", "mobile", "no-such-guide")?.name).toBe("warm-food-mobile-light");
  });

  it("无命中返回 undefined", () => {
    expect(selectStyleGuide("qwertyuiop", "web")).toBeUndefined();
  });

  it("产出的规格四要素齐全：调色板 / 字体 / 字号档 / 三套标尺", () => {
    const selected = selectStyleGuide("AI 智能体产品官网", "web")!;
    expect(selected.palette.page).toMatch(/^#[0-9A-F]{6}$/u);
    expect(selected.palette.onAccent).toMatch(/^#[0-9A-F]{6}$/u);
    expect(selected.fonts.heading ?? selected.fonts.body).toBeTruthy();
    expect(selected.typeScale.display ?? selected.typeScale.heading).toBeTruthy();
    expect(selected.tokens.spacing.length).toBeGreaterThan(0);
    expect(selected.tokens.radius.length).toBeGreaterThan(0);
    expect(selected.tokens.fontSize.length).toBeGreaterThan(0);
  });

  it("标尺回落：指南未带间距段时用默认标尺（不是空标尺）", () => {
    // 真实语料里散文式 slides/card 指南的 spacing 为空，tokensOf 必须回落默认。
    const selected = selectStyleGuide("", "web", "banxin-rule")!;
    expect(selected.tokens.spacing.length).toBeGreaterThan(0);
    const guideEntry = getStyleGuide("banxin-rule")!;
    if (guideEntry.spacing.length < 4) expect(selected.tokens.spacing).toEqual([...DEFAULT_SPACING_SCALE]);
    if (guideEntry.radius.length < 3) expect(selected.tokens.radius).toEqual([...DEFAULT_RADIUS_SCALE]);
  });
});

describe("WCAG AA 守卫（mapGuidePalette）", () => {
  it("合格的调色板原样映射，不回退", () => {
    const mapped = mapGuidePaletteWithFallback(guide({
      name: "ok",
      palette: {
        "Page Background": "#FFFFFF",
        "Card Surface": "#FFFFFF",
        "Primary Text": "#111827",
        "Secondary Text": "#6B7280",
        "Primary Accent": "#2563EB",
        "Default Border": "#E5E7EB"
      }
    }));
    expect(mapped.fallback).toBe(false);
    expect(mapped.palette.page).toBe("#FFFFFF");
    expect(mapped.palette.ink).toBe("#111827");
    // 蓝底上的文字色取对比度最高的（白）。
    expect(mapped.palette.onAccent).toBe("#FFFFFF");
  });

  it("ink/page 对比度不达标 → 整块回落默认调色板", () => {
    const broken = guide({
      name: "broken-ink",
      palette: {
        "Page Background": "#F0F0F0",
        "Card Surface": "#F0F0F0",
        "Primary Text": "#E8E8E8",
        "Primary Accent": "#2563EB"
      }
    });
    const mapped = mapGuidePaletteWithFallback(broken);
    expect(mapped.fallback).toBe(true);
    expect(mapped.palette).toEqual(DEFAULT_GUIDE_PALETTE);
  });

  it("onSurface/surface 对比度不达标同样回落", () => {
    const broken = guide({
      name: "broken-surface",
      platform: "mobile",
      tags: ["dark-mode"],
      palette: {
        "Page Background": "#0B1220",
        "Card Surface": "#101828",
        "Elevated Surface": "#101828",
        "Primary Text": "#0E1420",
        "Primary Accent": "#2563EB"
      }
    });
    // surface 与 ink 撞色 → onSurface 读不了 → 回落。
    expect(mapGuidePaletteWithFallback(broken).fallback).toBe(true);
  });

  it("mapGuidePalette 便捷入口返回调色板本身", () => {
    const palette = mapGuidePalette(guide({ name: "fallback-only" }));
    expect(palette).toEqual(DEFAULT_GUIDE_PALETTE);
  });
});

describe("索引导航（listGuideIndex / filterGuideIndex）", () => {
  it("列全部 63 套；platform 过滤 web 取 webapp", () => {
    expect(listGuideIndex()).toHaveLength(63);
    expect(listGuideIndex("mobile")).toHaveLength(15);
    expect(listGuideIndex("web")).toHaveLength(38);
    expect(listGuideIndex("mobile").every((entry) => entry.platform === "mobile")).toBe(true);
  });

  it("索引体积受控（每条 tags ≤6、摘要截断）", () => {
    const entries = listGuideIndex();
    for (const entry of entries) expect(entry.tags.length).toBeLessThanOrEqual(6);
    const bytes = utf8Bytes(entries.map((entry) => formatGuideIndexLine(entry)).join("\n"));
    // 63 套全量索引约 10–14KB（≈3K tokens），是「1 次调用换完整目录」的成本上限。
    expect(bytes).toBeLessThan(16_000);
  });

  it("tags 过滤取交集（含没进索引前 6 个的长尾标签）", () => {
    const dark = filterGuideIndex(listGuideIndex(), ["dark-mode"]);
    expect(dark.length).toBeGreaterThan(20);
    expect(dark.every((entry) => getStyleGuide(entry.name)!.tags.includes("dark-mode"))).toBe(true);
    const darkMobile = filterGuideIndex(listGuideIndex(), ["dark-mode", "mobile"]);
    expect(darkMobile.length).toBeGreaterThan(0);
    expect(darkMobile.every((entry) => entry.platform === "mobile")).toBe(true);
    // 空 tags = 不过滤。
    expect(filterGuideIndex(listGuideIndex(), [])).toHaveLength(63);
  });

  it("formatGuideIndexLine 标出推荐项", () => {
    const entry = listGuideIndex()[0]!;
    expect(formatGuideIndexLine(entry)).toMatch(/^- /u);
    expect(formatGuideIndexLine(entry, true)).toMatch(/^★ /u);
  });
});

describe("buildGuideInjection", () => {
  it("含调色板/字体/字号/三套标尺/美学方向，且有体积上限", () => {
    const selected = selectStyleGuide("AI 智能体产品官网", "web")!;
    const text = buildGuideInjection(selected);
    expect(text).toContain("设计规格");
    expect(text).toContain(selected.palette.page);
    expect(text).toContain("间距标尺");
    expect(text).toContain("圆角标尺");
    expect(text).toContain("字号白名单");
    expect(text).toContain("美学方向");
    expect(utf8Bytes(text)).toBeLessThanOrEqual(MAX_GUIDE_INJECTION_BYTES);
  });

  it("显式指定与 brief 命中用不同的开头（让模型知道来源）", () => {
    const selected = selectStyleGuide("", "web", "ai-product-dark")!;
    expect(buildGuideInjection(selected, "explicit")).toContain("已按 guide 参数载入");
    expect(buildGuideInjection(selected, "brief")).toContain("已按需求匹配");
  });

  it("中文 brief 附中文字体栈提示", () => {
    const selected = selectStyleGuide("咖啡外卖 App 首页", "mobile")!;
    expect(selected.cjk).toBe(true);
    expect(buildGuideInjection(selected)).toContain(CJK_FONT_STACK_HINT.slice(0, 20));
  });

  it("超长指南也裁到预算内（从尾部裁，标题与标尺永远保留）", () => {
    const huge: StyleGuideDigest = guide({
      name: "huge",
      palette: Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`Token${index}`, "#123456"])),
      aesthetics: ["a".repeat(200), "b".repeat(200), "c".repeat(200), "d".repeat(200), "e".repeat(200)],
      letterSpacing: ["x".repeat(100), "y".repeat(100), "z".repeat(100), "w".repeat(100)],
      lineHeight: ["x".repeat(100), "y".repeat(100), "z".repeat(100), "w".repeat(100)]
    });
    const text = buildGuideInjection({
      name: "huge",
      platform: "webapp",
      tags: ["tech"],
      palette: DEFAULT_GUIDE_PALETTE,
      paletteFallback: false,
      fonts: { heading: "Inter" },
      typeScale: { display: [64, 700], body: [16, 400] },
      tokens: { spacing: [...DEFAULT_SPACING_SCALE], radius: [...DEFAULT_RADIUS_SCALE], fontSize: [12, 16, 24] },
      direction: huge.aesthetics.join(" "),
      details: huge.aesthetics.join(" "),
      letterSpacing: huge.letterSpacing,
      lineHeight: huge.lineHeight,
      cjk: false
    });
    expect(utf8Bytes(text)).toBeLessThanOrEqual(MAX_GUIDE_INJECTION_BYTES);
    // 裁的是尾部参考内容，标尺与标题仍在。
    expect(text).toContain("设计规格");
    expect(text).toContain("间距标尺");
  });
});

describe("utf8Bytes", () => {
  it("按 UTF-8 字节数计（中文 3 字节、emoji 4 字节）", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("中文")).toBe(6);
    expect(utf8Bytes("🍳")).toBe(4);
    expect(utf8Bytes("")).toBe(0);
  });
});
