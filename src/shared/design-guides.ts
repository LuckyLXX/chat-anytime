/**
 * 风格指南知识库（设计模式的「设计知识」层）：把 63 套 OpenPencil 风格指南 digest
 * 按 brief 关键词确定性匹配，产出可直接注入工具回执的**结构化设计规格**。
 *
 * 为什么需要这一层：质量门（design-quality）只能拦住难看的稿子出错，不能让平淡的
 * 稿子变好看。真正决定「设计感」的是调色板、字体配对、字号/间距/圆角标尺这些
 * 设计知识——它们在生成之前就该给到模型，而不是事后校验。
 *
 * 三层供给（见 AGENTS.md）：
 *  1. 自动命中（默认路径，零额外调用）：`design_create` 带 brief → 本模块选一套，
 *     完整规格塞进回执尾部。
 *  2. 索引导航（备选路径，1 次调用）：`design_guides` 工具列 63 套索引，模型自选。
 *  3. token 标尺（兜底约束，零调用）：没命中也要落在标尺上（design-tokens.ts）。
 *
 * 缓存纪律：本模块只在**工具结果尾部**生效，绝不进工具 description / 系统提示。
 * 纯函数 + 静态数据，零 node 依赖（utility 与 renderer 共用）。
 *
 * 语料来源：OpenPencil（MIT，Copyright (c) 2026 ZSeven—W），digest 生成脚本
 * `scripts/build-style-guides.mjs`，许可证见仓库根 THIRD_PARTY_NOTICES.md。
 */

import guidesJson from "./design-guides.json" with { type: "json" };
import { contrastRatio, parseColor } from "./design-quality.js";
import { DEFAULT_RADIUS_SCALE, DEFAULT_SPACING_SCALE, DEFAULT_FONT_SIZE_SCALE, type DesignTokens } from "./design-tokens.js";

/** 单套风格指南的 digest（构建脚本产出；字段缺失表示语料里没有该段）。 */
export interface StyleGuideDigest {
  name: string;
  /** webapp / mobile / slides / card。 */
  platform: string;
  tags: readonly string[];
  summary: string;
  aesthetics: readonly string[];
  /** 命名 token → HEX（大写）。 */
  palette: Readonly<Record<string, string>>;
  fonts: { heading?: string; body?: string; mono?: string };
  /** `[档位名, px, 字重]`。 */
  type: readonly (readonly [string, number, number])[];
  spacing: readonly number[];
  radius: readonly number[];
  letterSpacing: readonly string[];
  lineHeight: readonly string[];
}

/** 固定形状的调色板（映射后的结果；键名与设计稿里该用的角色一一对应）。 */
export interface GuidePalette {
  /** 页面底色。 */
  page: string;
  /** 卡片/面板底色。 */
  panel: string;
  /** 次级区块/悬浮面底色。 */
  surface: string;
  /** surface 上的正文色。 */
  onSurface: string;
  /** surface 上的次要文字色。 */
  mutedOnSurface: string;
  /** 强调色（按钮/活跃态）。 */
  accent: string;
  /** accent 上的文字色（自动取对比度最高者）。 */
  onAccent: string;
  /** 页面主文字色。 */
  ink: string;
  /** 次要文字色。 */
  muted: string;
  /** 分隔线/边框色。 */
  line: string;
  /** 更淡的一条分隔线。 */
  surfaceLine: string;
}

export interface SelectedStyleGuide {
  name: string;
  platform: string;
  tags: readonly string[];
  palette: GuidePalette;
  /** 映射后的调色板是否因对比度不达标回落了内置默认（诊断用）。 */
  paletteFallback: boolean;
  fonts: { heading?: string; body?: string; mono?: string };
  /** display/heading/body/label 四档（`[px, 字重]`）。 */
  typeScale: Partial<Record<"display" | "heading" | "body" | "label", readonly [number, number]>>;
  /** 该风格的标尺（缺段落落默认标尺）。 */
  tokens: DesignTokens;
  /** 美学方向（summary + 前 3 条 aesthetics）。 */
  direction: string;
  /** 剩余的美学条目（层次/细节提示）。 */
  details: string;
  letterSpacing: readonly string[];
  lineHeight: readonly string[];
  /** 是否按中文 brief 附加了 CJK 字体栈提示。 */
  cjk: boolean;
}

export type DesignPlatform = "web" | "mobile";

/** UTF-8 字节长度（零 node 依赖：shared 层会在 renderer 里被执行，不能用 Buffer）。 */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** 无对比度合格的指南调色板时用的中性默认（宁可少亮点，不可出不可读稿）。 */
export const DEFAULT_GUIDE_PALETTE: GuidePalette = {
  page: "#FFFFFF",
  panel: "#FFFFFF",
  surface: "#F8FAFC",
  onSurface: "#0F172A",
  mutedOnSurface: "#64748B",
  accent: "#2563EB",
  onAccent: "#FFFFFF",
  ink: "#0F172A",
  muted: "#475569",
  line: "#E2E8F0",
  surfaceLine: "#F1F5F9"
};

/** 中文稿的字体栈提示：英文风格指南的字体族大多不含中文字形，必须显式补中文字体。 */
export const CJK_FONT_STACK_HINT = "中文稿字体栈务必带中文字体并保留英文首选族的回落链，例如 \"Inter\", \"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif；正文行高 1.6–1.75（中文比西文需要更大的行距），字距保持 0 或极小的正值。";

const DARK_BRIEF = /暗色|深色|夜间|暗黑|dark\s*(?:mode|theme)|dark\b/iu;
const CJK_BRIEF = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
/** 画布宽度 ≤ 该值视为移动端（对齐 dsh MAX_COMPACT_ROOT_WIDTH）。 */
export const MAX_COMPACT_ROOT_WIDTH = 600;

interface GuideRule {
  match: RegExp;
  web?: string;
  mobile?: string;
}

/**
 * brief 关键词 → 指南名的**有序**规则表（首个命中即用）。指南名必须真实存在于语料
 * （测试会逐条断言），改语料时同步改这里。
 */
const GUIDE_RULES: readonly GuideRule[] = [
  { match: /咖啡|奶茶|外卖|餐饮|餐厅|美食|甜品|烘焙|生鲜|超市|coffee|cafe|food|restaurant|bakery|grocery/iu, mobile: "warm-food-mobile-light", web: "retro-warm-light" },
  { match: /旅行|旅游|酒店|机票|民宿|行程|travel|trip|hotel|booking/iu, mobile: "travel-warm-mobile-light", web: "retro-warm-light" },
  { match: /教育|课程|学习|培训|考试|school|education|course|learning/iu, mobile: "minimal-playful-light", web: "education-friendly-light" },
  { match: /健身|冥想|瑜伽|睡眠|健康|养生|wellness|fitness|meditation|yoga/iu, mobile: "wellness-green-mobile-light", web: "wellness-organic-light" },
  { match: /医疗|医院|诊所|问诊|healthcare|medical|clinic/iu, mobile: "health-minimal-mobile-dark", web: "healthcare-trust-light" },
  { match: /金融|理财|银行|支付|钱包|证券|保险|fintech|finance|banking|payment/iu, mobile: "finance-clean-mobile-light", web: "fintech-dark-blue-light" },
  { match: /加密|区块链|crypto|web3/iu, web: "crypto-dark-bold", mobile: "dark-bold-mobile" },
  { match: /仪表盘|仪表板|数据看板|管理后台|后台管理|控制台|dashboard|admin panel|analytics/iu, web: "dashboard-analytics-dark", mobile: "finance-clean-mobile-light" },
  { match: /开发者|开发工具|终端|命令行|代码|developer|terminal|devtool|\bcli\b|\bapi\b/iu, web: "developer-terminal-dark", mobile: "terminal-minimal-dark" },
  { match: /游戏|电竞|电玩|game|gaming|esports/iu, web: "gaming-electric-dark", mobile: "neon-purple-mobile-dark" },
  { match: /音乐|播放器|播客|电台|music|podcast|player/iu, mobile: "music-dark-mobile", web: "creative-bold-light" },
  { match: /奢侈|奢华|高端|珠宝|腕表|珠宝|luxury|jewelry|premium/iu, web: "luxury-brand-dark", mobile: "luxury-fashion-mobile-dark" },
  { match: /社交|社区|动态|朋友圈|评论|social|community|feed/iu, mobile: "social-vibrant-mobile-light", web: "creative-bold-light" },
  { match: /作品集|个人主页|简历|portfolio/iu, web: "portfolio-minimal-light" },
  { match: /公益|慈善|非营利|nonprofit|charity/iu, web: "nonprofit-warm-light" },
  { match: /人工智能|大模型|智能体|问答机器人|\bai\b|\bllm\b|agent/iu, web: "ai-product-dark", mobile: "dark-bold-mobile" },
  { match: /创业|孵化|startup/iu, web: "startup-gradient-dark", mobile: "dark-bold-mobile" },
  { match: /电商|商城|购物|商品|商店|下单|e-?commerce|shop|storefront|retail/iu, web: "ecommerce-modern-light", mobile: "clean-blue-mobile-light" },
  { match: /saas|软件服务|b2b|企业服务|产品官网|订阅/iu, web: "saas-modern-light", mobile: "clean-blue-mobile-light" },
  { match: /企业|公司|公务|corporate|enterprise/iu, web: "corporate-blue-light", mobile: "clean-blue-mobile-light" },
  { match: /杂志|文章|专栏|报纸|editorial|magazine|blog/iu, web: "editorial-serif-light" },
  { match: /赛博|霓虹|蒸汽波|cyber|cyberpunk|neon/iu, web: "cyber-gradient-dark", mobile: "neon-purple-mobile-dark" },
  { match: /野兽派|粗野|brutalist/iu, web: "brutalist-luxury-dark" },
  { match: /和风|日式|禅|宣纸|zen|japanese/iu, web: "zen-paper-light" },
  { match: /瑞士|国际主义|swiss/iu, web: "japanese-swiss-light" },
  { match: /马卡龙|柔彩|奶油|pastel/iu, mobile: "pastel-soft-mobile-light", web: "butter-serif-light" },
  { match: /工业|机械|硬朗|industrial/iu, mobile: "industrial-mobile-dark", web: "industrial-neon-dark" },
  { match: /复古|怀旧|retro|vintage/iu, web: "retro-warm-light", mobile: "warm-food-mobile-light" },
  { match: /极简|简约|minimal/iu, web: "nordic-frost-light", mobile: "minimal-playful-light" },
  { match: /杂志风|大字标题|粗体标题|bold typography/iu, web: "creative-bold-light" },
  { match: /落地页|官网|首页|宣传页|营销|landing|homepage|marketing/iu, web: "saas-clean-light", mobile: "clean-blue-mobile-light" }
];

// JSON 语料用 import attributes（`with { type: "json" }`）静态导入：实测 electron-vite 三种
// 构建目标（dev / build / asar 打包）都会把内容**内联进 bundle**，不产生运行时文件读取，
// 因此不需要 ?asset / import.meta.url 方案（见 AGENTS.md 的记约定）。
// 每套指南的 palette 键名各不相同，推导出的字面量联合类型没法直接当
// Record<string, string>，过一层 unknown 再落到自己的接口上。
const guideCatalog = guidesJson as unknown as { guides: readonly StyleGuideDigest[] };
const guides: readonly StyleGuideDigest[] = guideCatalog.guides;

/** 全量 digest（测试与工具索引用）。 */
export function allStyleGuides(): readonly StyleGuideDigest[] {
  return guides;
}

/** 按名取单套 digest；不存在返回 undefined。 */
export function getStyleGuide(name: string): StyleGuideDigest | undefined {
  const wanted = name.trim().toLowerCase();
  return guides.find((guide) => guide.name.toLowerCase() === wanted);
}

function findToken(palette: Readonly<Record<string, string>>, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    for (const [token, value] of Object.entries(palette)) {
      if (pattern.test(token)) return value;
    }
  }
  return undefined;
}

/** 对比度排序取最优（onAccent 用）：候选里挑与该底色对比度最高的那个。 */
function bestContrast(on: string, candidates: readonly string[]): string {
  const background = parseColor(on);
  if (!background) return candidates[0]!;
  let best = candidates[0]!;
  let bestRatio = -1;
  for (const candidate of candidates) {
    const rgb = parseColor(candidate);
    if (!rgb) continue;
    const ratio = contrastRatio(rgb, background);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return best;
}

/** 美学方向文本的字节预算：超出时整段丢弃（不切半句）。 */
const DIRECTION_BUDGET = 460;

/**
 * 拼接美学方向：summary + 前 3 条 aesthetics，超预算**整段丢弃**。
 * 不能直接 `slice(0, N)`——实测定向文本被切在半个 hex 中间（"#21140F" → "#21"），
 * 模型会把这个残值当成合法颜色照抄。
 */
function directionOf(guide: StyleGuideDigest): string {
  const parts = [guide.summary, ...guide.aesthetics.slice(0, 3)].filter((part) => part.length > 0);
  while (parts.length > 1 && utf8Bytes(parts.join(" ")) > DIRECTION_BUDGET) parts.pop();
  return parts.join(" ");
}

/**
 * 指南命名 token → 固定调色板形状；任何一项缺失都回落 fallback 的同名项，
 * 因此稀疏的指南永远不会产出不完整的调色板。返回值带上是否整块回落了默认。
 */
export function mapGuidePaletteWithFallback(guide: StyleGuideDigest, fallback: GuidePalette = DEFAULT_GUIDE_PALETTE): { palette: GuidePalette; fallback: boolean } {
  const tokens = guide.palette;
  const dark = guide.tags.includes("dark-mode");
  const page = findToken(tokens, [/^page background$/iu, /^app background$/iu, /background$/iu]) ?? fallback.page;
  const ink = findToken(tokens, [/^primary text$/iu, /^text primary$/iu, /heading/iu]) ?? fallback.ink;
  const accent = findToken(tokens, [/^primary accent$/iu, /^accent$/iu, /^primary$/iu, /accent/iu]) ?? fallback.accent;
  const panel = findToken(tokens, [/^card surface$/iu, /^panel$/iu, /^inset surface$/iu, /^section alt$/iu, /elevated/iu]) ?? fallback.panel;
  const surface = findToken(tokens, [/elevated surface/iu, /^section alt$/iu, /^inset surface$/iu, /^subtle surface$/iu])
    ?? (dark ? panel : fallback.surface);
  const mapped: GuidePalette = {
    page,
    panel,
    surface,
    onSurface: bestContrast(surface, [ink, "#FFFFFF", "#0F172A"]),
    mutedOnSurface: findToken(tokens, [/^tertiary text$/iu, /^muted text$/iu, /^secondary text$/iu]) ?? fallback.mutedOnSurface,
    accent,
    onAccent: bestContrast(accent, ["#FFFFFF", ink, "#1C1917"]),
    ink,
    muted: findToken(tokens, [/^secondary text$/iu, /^text secondary$/iu, /^tertiary text$/iu]) ?? fallback.muted,
    line: findToken(tokens, [/^default border$/iu, /^border$/iu, /divider/iu]) ?? fallback.line,
    surfaceLine: findToken(tokens, [/^subtle border$/iu, /^light border$/iu]) ?? fallback.surfaceLine
  };
  // WCAG AA 守卫：ink/page 与 onSurface/surface 都读不了时整块回落默认调色板。
  // 指南配色是为它自己的大块填充调的，直接拿来当正文色可能不可读——
  // 宁可少一个亮点，不可出一份读不了的稿。
  const inkOnPage = contrastValue(mapped.ink, mapped.page);
  const surfaceReadable = contrastValue(mapped.onSurface, mapped.surface);
  if (inkOnPage === undefined || surfaceReadable === undefined || inkOnPage < 4.5 || surfaceReadable < 4.5) {
    return { palette: { ...fallback }, fallback: true };
  }
  return { palette: mapped, fallback: false };
}

/** 映射后的调色板（不要回退原因时用这个）。 */
export function mapGuidePalette(guide: StyleGuideDigest, fallback: GuidePalette = DEFAULT_GUIDE_PALETTE): GuidePalette {
  return mapGuidePaletteWithFallback(guide, fallback).palette;
}

function contrastValue(foreground: string, background: string): number | undefined {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return undefined;
  return contrastRatio(fg, bg);
}

/** 字号档位映射：display/heading/body/label 四档（缺档就不给，不编造）。 */
function typeScaleOf(guide: StyleGuideDigest): SelectedStyleGuide["typeScale"] {
  const rows = new Map(guide.type.map(([level, size, weight]) => [level.toLowerCase(), [size, weight] as const]));
  const pick = (...levels: string[]): readonly [number, number] | undefined => {
    for (const level of levels) {
      const row = rows.get(level);
      if (row) return row;
    }
    return undefined;
  };
  const scale: SelectedStyleGuide["typeScale"] = {};
  const display = pick("display", "hero", "display 1");
  const heading = pick("title 1", "heading 1", "h1", "title", "heading", "section heading");
  const body = pick("body", "body large", "paragraph");
  const label = pick("label", "caption", "small", "micro");
  if (display) scale.display = display;
  if (heading) scale.heading = heading;
  if (body) scale.body = body;
  if (label) scale.label = label;
  return scale;
}

/** 标尺：指南自带段优先（不足 4 档视为解析失败，回落默认标尺）。 */
function tokensOf(guide: StyleGuideDigest): DesignTokens {
  const spacing = guide.spacing.length >= 4 ? [...guide.spacing] : [...DEFAULT_SPACING_SCALE];
  const radius = guide.radius.length >= 3 ? [...guide.radius] : [...DEFAULT_RADIUS_SCALE];
  const fontSize = guide.type.length >= 4
    ? [...new Set(guide.type.map(([, size]) => size))].sort((left, right) => left - right)
    : [...DEFAULT_FONT_SIZE_SCALE];
  return { spacing, radius, fontSize };
}

/** 按画布宽度推断平台（窄画布 = 移动端）。 */
export function platformForWidth(width: number | undefined): DesignPlatform {
  return typeof width === "number" && width <= MAX_COMPACT_ROOT_WIDTH ? "mobile" : "web";
}

/** 指南平台与请求平台是否兼容。web = webapp，mobile = mobile；slides/card 两种
 *  （幻灯片/社交卡片）的几何与排版契约与页面设计不同，只作为脚本自己声明时才用。 */
export function platformCompatible(guide: StyleGuideDigest, platform: DesignPlatform): boolean {
  return platform === "mobile" ? guide.platform === "mobile" : guide.platform === "webapp";
}

/**
 * 找一套「中文排印特调且平台兼容」的指南。
 *
 * 实测结论（2026-09-11）：当前 63 套语料里带 `cjk-type` 标签的 10 套**全是
 * slides / card**（演示文稿与社交卡片），它们的几何与排版契约（页面四边距、
 * 界行、竖排卡片）与网页/移动页面不是一回事——把「幻灯片几何」当页面级设计
 * 发给模型比不给还差。因此这里按平台兼容性过滤，今天只会返回 undefined；
 * 语料将来添了 cjk 的 webapp/mobile 条目，这个函数自动生效。
 *
 * 中文的真正落点在 {@link CJK_FONT_STACK_HINT}：字体栈补中文字体 + 行高加大，
 * 与选哪套风格无关，buildingGuideInjection 对中文 brief 一律附上。
 */
export function cjkGuideFor(platform: DesignPlatform): StyleGuideDigest | undefined {
  return guides.find((guide) => guide.tags.includes("cjk-type") && platformCompatible(guide, platform));
}

/** 规则命中的指南名（未命中 undefined）。
 *  `cjk` 为真时先试中文特调指南（见 {@link cjkGuideFor}，当前语料下不命中），
 *  再走普通规则。 */
export function matchGuideName(brief: string, platform: DesignPlatform, cjk = CJK_BRIEF.test(brief)): string | undefined {
  if (cjk) {
    const cjkGuide = cjkGuideFor(platform);
    if (cjkGuide) return cjkGuide.name;
  }
  for (const rule of GUIDE_RULES) {
    if (!rule.match.test(brief)) continue;
    const name = platform === "mobile" ? rule.mobile ?? rule.web : rule.web ?? rule.mobile;
    if (name) return name;
  }
  return undefined;
}

/**
 * 确定性选中一套风格指南：同 brief + 同平台 → 同结果。
 *
 * 匹配顺序：规则表首个命中 → 暗色 brief 且命中项非暗色则换同平台暗色基准 →
 * 找不到返回 undefined（调用方走索引导航兜底）。
 */
export function selectStyleGuide(brief: string, platform: DesignPlatform, explicitName?: string): SelectedStyleGuide | undefined {
  const text = brief ?? "";
  const cjk = CJK_BRIEF.test(text);
  const explicit = explicitName?.trim() ? getStyleGuide(explicitName) : undefined;
  let guide = explicit;
  if (!guide) {
    const name = matchGuideName(text, platform, cjk);
    if (!name) return undefined;
    guide = getStyleGuide(name);
  }
  if (!guide) return undefined;
  if (!explicit && DARK_BRIEF.test(text) && !guide.tags.includes("dark-mode")) {
    const darkName = platform === "mobile" ? "dark-bold-mobile" : "midnight-minimal-dark";
    guide = getStyleGuide(darkName) ?? guide;
  }
  const mapped = mapGuidePaletteWithFallback(guide);
  return {
    name: guide.name,
    platform: guide.platform,
    tags: guide.tags,
    palette: mapped.palette,
    paletteFallback: mapped.fallback,
    fonts: guide.fonts,
    typeScale: typeScaleOf(guide),
    tokens: tokensOf(guide),
    direction: directionOf(guide),
    details: guide.aesthetics.slice(3, 5).join(" ").slice(0, 220),
    letterSpacing: guide.letterSpacing,
    lineHeight: guide.lineHeight,
    cjk: cjk || guide.tags.includes("cjk-type")
  };
}

/** 索引条目（列表输出用；summary 截断以控体积）。 */
export interface StyleGuideIndexEntry {
  name: string;
  platform: string;
  tags: readonly string[];
  summary: string;
}

const INDEX_TAG_LIMIT = 6;
const INDEX_SUMMARY_CHARS = 110;

/** 63 套索引（name + tags + 一句话摘要）；`platform` 过滤可选。 */
export function listGuideIndex(platform?: DesignPlatform): StyleGuideIndexEntry[] {
  const wanted = platform === "mobile" ? ["mobile"] : platform === "web" ? ["webapp"] : undefined;
  return guides
    .filter((guide) => !wanted || wanted.includes(guide.platform))
    .map((guide) => ({
      name: guide.name,
      platform: guide.platform,
      tags: guide.tags.slice(0, INDEX_TAG_LIMIT),
      summary: guide.summary.slice(0, INDEX_SUMMARY_CHARS)
    }));
}

/** 按标签过滤（design_guides 的 tags 参数）。 */
export function filterGuideIndex(entries: readonly StyleGuideIndexEntry[], tags: readonly string[]): StyleGuideIndexEntry[] {
  const wanted = tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
  if (wanted.length === 0) return [...entries];
  return entries.filter((entry) => wanted.every((tag) => entry.tags.some((candidate) => candidate.toLowerCase() === tag)
    || (getStyleGuide(entry.name)?.tags ?? []).some((candidate) => candidate.toLowerCase() === tag)));
}

/** 索引导航的一行文本。 */
export function formatGuideIndexLine(entry: StyleGuideIndexEntry, recommended = false): string {
  return `${recommended ? "★ " : "- "}${entry.name}（${entry.platform}｜${entry.tags.join("/")}）：${entry.summary}`;
}

/** 注入回执的单套规格字节上限（超预算按确定性顺序裁剪，对齐 dsh MAX_DOMAIN_GUIDANCE_BYTES）。 */
export const MAX_GUIDE_INJECTION_BYTES = 2048;

function paletteLines(palette: GuidePalette): string[] {
  return [
    `页面底色 ${palette.page}、卡片/面板底色 ${palette.panel}、次级区块 ${palette.surface}（其上文字 ${palette.onSurface}、次要文字 ${palette.mutedOnSurface}）`,
    `主文字 ${palette.ink}、次要文字 ${palette.muted}、分隔线 ${palette.line}（更淡一条 ${palette.surfaceLine}）`,
    `强调色 ${palette.accent}（其上文字用 ${palette.onAccent}）`
  ];
}

function typeScaleLine(scale: SelectedStyleGuide["typeScale"]): string | undefined {
  const parts: string[] = [];
  for (const key of ["display", "heading", "body", "label"] as const) {
    const row = scale[key];
    if (row) parts.push(`${key} ${row[0]}px/${row[1]}`);
  }
  return parts.length > 0 ? parts.join("、") : undefined;
}

/**
 * 生成注入工具回执的结构化设计规格文本（总字节受 {@link MAX_GUIDE_INJECTION_BYTES} 约束）。
 * 纯函数：同 guide 同结果。
 */
export function buildGuideInjection(guide: SelectedStyleGuide, source: "brief" | "explicit" = "brief"): string {
  const headline = source === "explicit"
    ? `已按 guide 参数载入风格指南「${guide.name}」（平台 ${guide.platform}；${guide.tags.join("/")}）。`
    : `已按需求匹配风格指南「${guide.name}」（平台 ${guide.platform}；${guide.tags.join("/")}）。`;
  const fontParts: string[] = [];
  if (guide.fonts.heading) fontParts.push(`标题 ${guide.fonts.heading}`);
  if (guide.fonts.body) fontParts.push(`正文 ${guide.fonts.body}`);
  if (guide.fonts.mono) fontParts.push(`等宽 ${guide.fonts.mono}`);
  const typeLine = typeScaleLine(guide.typeScale);
  const lines = [
    headline,
    "设计规格（本稿必须照此执行；每个 text 节点的 fontFamily/字号都要显式写进节点）：",
    ...paletteLines(guide.palette),
    ...(fontParts.length > 0 ? [`字体：${fontParts.join("、")}`] : []),
    ...(typeLine ? [`字号档位：${typeLine}`] : []),
    `间距标尺（gap/padding 只能取这些值）：${guide.tokens.spacing.join("/")}`,
    `圆角标尺（radius 只能取这些值；9999 = 全圆胶囊，仅用于头像/圆点/胶囊标签）：${guide.tokens.radius.join("/")}`,
    `字号白名单：${guide.tokens.fontSize.join("/")}`,
    ...(guide.cjk ? [`中文排版：${CJK_FONT_STACK_HINT}`] : []),
    ...(guide.letterSpacing.length > 0 ? [`字距参考：${guide.letterSpacing.join("；")}`] : []),
    ...(guide.lineHeight.length > 0 ? [`行高参考：${guide.lineHeight.join("；")}`] : []),
    `美学方向：${guide.direction}`,
    ...(guide.details ? [`细节要求：${guide.details}`] : []),
    "写完第一屏后，design_update 的质量门会按这套标尺检查（off-scale-* 诊断给出可直接套用的吸附修复 ops）。"
  ];
  let text = lines.join("\n");
  // 超预算：从尾部（参考性内容）向前裁剪整行，标题与标尺永远保留。
  while (utf8Bytes(text) > MAX_GUIDE_INJECTION_BYTES && lines.length > 8) {
    lines.pop();
    text = lines.join("\n");
  }
  return text;
}
