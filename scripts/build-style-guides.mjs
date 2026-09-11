/**
 * 提取 OpenPencil 风格指南语料为 PiDesktop 的设计知识 digest。
 *
 * 来源：https://github.com/ZSeven-W/openpencil — `crates/op-ai-skills/skills/style-guides/*.md`
 * 许可证：MIT，Copyright (c) 2026 ZSeven—W（见仓库根目录 THIRD_PARTY_NOTICES.md）。
 *
 * 用法：
 *   node scripts/build-style-guides.mjs                       # 用缺省语料目录
 *   node scripts/build-style-guides.mjs --source <dir>        # 自备语料目录
 *   node scripts/build-style-guides.mjs --output <file>       # 自定输出（缺省 src/shared/design-guides.json）
 *
 * 生成物 `src/shared/design-guides.json` **入库**（39 KB 量级，diff 可 review）；
 * `npm run build` 不依赖语料仓库，本脚本只在语料更新时手动重跑。
 *
 * 与 dsh-openpencil 的 build-style-guides.mjs 的关键差别：dsh 的 digest 只保留
 * 调色板/字体/字号，丢掉了**间距标尺与圆角标尺**——而那恰是 PiDesktop 最需要的
 * （实测稿子里 22 种圆角 / 37 种间距的病根）。本脚本额外抽 spacing / radius /
 * letterSpacing / lineHeight。
 */

import { readdir, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 缺省语料目录（OpenPencil 子模块；不存在时给出可读提示，不静默产出空目录）。 */
export const DEFAULT_SOURCE_DIR = "D:/开源仓库/dsh-openpencil/vendor/openpencil/crates/op-ai-skills/skills/style-guides";
export const DEFAULT_OUTPUT_PATH = resolve(root, "src/shared/design-guides.json");

/** 单套 digest 的序列化字节上限（控制注入体积；超出按确定性顺序裁剪）。 */
const MAX_GUIDE_BYTES = 1400;
/** 语料完整性下限：语料是一份真目录，而不是几套幸存者。 */
const MIN_GUIDES = 40;
/** 每套最少调色板 token 数与字体条目数（对齐 dsh 的 createStyleGuideCatalog 校验）。 */
const MIN_PALETTE_TOKENS = 4;
const HEX = /#[0-9A-Fa-f]{6}/;

export class BuildStyleGuidesError extends Error {}

function fail(message) {
  throw new BuildStyleGuidesError(`build-style-guides: ${message}`);
}

/** YAML frontmatter：name / tags / platform + 正文。 */
function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) return undefined;
  const name = /name:\s*'?([A-Za-z0-9_-]+)'?/.exec(match[1])?.[1];
  const platform = /platform:\s*([A-Za-z]+)/.exec(match[1])?.[1];
  const tagsRaw = /tags:\s*\[([^\]]*)\]/.exec(match[1])?.[1] ?? "";
  const tags = tagsRaw.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (!name) return undefined;
  return { name, platform: platform ?? "webapp", tags, body: markdown.slice(match[0].length) };
}

/**
 * `## Style Summary` 下的首段，压成一行并截断到预算内。
 *
 * 截断必须在**词边界 + 完整 token** 上收尾：直接 `slice(0, 220)` 会把半个 hex
 * 切出来（实测 "#21140F" → "#21"），而摘要是要发给模型的——残值会被当成合法
 * 颜色照抄（画布上真的出现 #21 这种值）。优先在句尾断，否则退到最后一个空格，
 * 再剥掉末尾不完整的 `#hex` / 半词。
 */
function summaryOf(body) {
  const section = /## Style Summary\s*\n+([\s\S]*?)(?:\n##|\n### )/.exec(body)?.[1] ?? "";
  const paragraph = section.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  const flat = paragraph.replace(/\s+/gu, " ");
  if (flat.length <= SUMMARY_CHARS) return flat;
  const window = flat.slice(0, SUMMARY_CHARS + 1);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("。"));
  let cut = sentenceEnd > SUMMARY_CHARS * 0.6 ? sentenceEnd + 1 : window.lastIndexOf(" ");
  if (cut <= 0) cut = SUMMARY_CHARS;
  let text = flat.slice(0, cut).trim();
  // 末尾可能落在半个 hex 或半个词上：剥到最后一个完整 token 为止。
  text = text.replace(/\s*#[0-9A-Fa-f]{0,5}$/u, "").replace(/[\s,;:—-]+$/u, "");
  return text.length > 0 ? text : flat.slice(0, SUMMARY_CHARS);
}

/** 摘要字符预算（后续 buildGuideInjection 还会再裁一次字节）。 */
const SUMMARY_CHARS = 220;

/** Key aesthetics 里的 `- **Label**: text` 条目，取前 5 条。 */
function aestheticsOf(body) {
  const bullets = [];
  for (const match of body.matchAll(/^- \*\*([^*]+)\*\*:\s*([^\n]+)$/gmu)) {
    bullets.push(`${match[1].trim()}: ${match[2].trim()}`);
    if (bullets.length >= 5) break;
  }
  return bullets;
}

/** 全文 `| Token | #HEX |` 形式的调色板行，取前 18 个命名 token。 */
function paletteOf(body) {
  const palette = {};
  for (const match of body.matchAll(/^\|\s*([^|#\n]{2,40}?)\s*\|\s*(#[0-9A-Fa-f]{6})[0-9A-Fa-f]{0,2}\s*\|/gmu)) {
    const token = match[1].trim();
    if (/^-+$/u.test(token) || token.toLowerCase() === "token") continue;
    if (palette[token] === undefined) palette[token] = match[2].toUpperCase();
    if (Object.keys(palette).length >= 18) break;
  }
  return palette;
}

/** `### Font Families` 表格（Role | Family | Usage）→ heading/body/mono。 */
function fontsOf(body) {
  const fonts = {};
  const section = /### Font Families\s*\n([\s\S]*?)(?:\n###|\n##)/.exec(body)?.[1] ?? "";
  for (const match of section.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|/gmu)) {
    const role = match[1].trim().toLowerCase();
    const family = match[2].trim();
    if (role.startsWith("-") || role === "role" || family.startsWith("-")) continue;
    if (role.includes("display") || role.includes("heading") || role.includes("title")) fonts.heading ??= family;
    else if (role.includes("body")) fonts.body ??= family;
    else if (role.includes("mono") || role.includes("data") || role.includes("code")) fonts.mono ??= family;
    else if (role.includes("everything") || role.includes("all") || role.includes("ui")) {
      fonts.heading ??= family;
      fonts.body ??= family;
    }
  }
  return fonts;
}

/** `### Type Scale` 表格（Level | Size | Font | Weight）→ `[level, px, weight]`，取前 10 档。 */
function typeScaleOf(body) {
  const rows = [];
  const section = /### Type Scale\s*\n([\s\S]*?)(?:\n###|\n##)/.exec(body)?.[1] ?? "";
  for (const match of section.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*(\d+(?:\.\d+)?)px\s*\|\s*[^|\n]+\|\s*(\d{2,4})\s*\|/gmu)) {
    const level = match[1].trim();
    if (level.startsWith("-")) continue;
    rows.push([level, Number(match[2]), Number(match[3])]);
    if (rows.length >= 10) break;
  }
  return rows;
}

/** 表格首列取数字档位（`8px` → 8；`Full`/`Pill` → 9999；`4-8px` → 4）。 */
function numericScaleFrom(section, limit = 12) {
  if (!section) return [];
  const values = [];
  const add = (value) => {
    if (!Number.isFinite(value) || value < 0 || values.includes(value)) return;
    values.push(value);
  };
  for (const match of section.matchAll(/^\|\s*([^|\n]+?)\s*\|/gmu)) {
    const cell = match[1].trim();
    if (!cell || /^-+$/u.test(cell) || /^value$/iu.test(cell)) continue;
    const range = /^(\d+(?:\.\d+)?)\s*[-–~]\s*\d+(?:\.\d+)?\s*px$/u.exec(cell);
    const single = /^(\d+(?:\.\d+)?)\s*(?:px)?$/u.exec(cell);
    const full = /^(?:full|pill|circle|capsule)/iu.test(cell);
    if (full) add(9999);
    else if (range) add(Number(range[1]));
    else if (single) add(Number(single[1]));
    if (values.length >= limit) break;
  }
  if (values.length > 0) return values.sort((left, right) => left - right);
  // 散文式指南（slides 类常见）：从 `- Base gap: **24**` 这类列表项里抽数字。
  for (const match of section.matchAll(/^[-*]\s*[^\n]*?(?:gap|spacing|rhythm|lattice|radius)[^\n]*$/gimu)) {
    const numbers = match[0].match(/\*\*(\d+(?:\.\d+)?)\*\*|(\d+(?:\.\d+)?)\s*px/gu) ?? [];
    for (const token of numbers) {
      const value = Number(token.replace(/[^\d.]/gu, ""));
      add(value);
      if (values.length >= limit) break;
    }
    if (values.length >= limit) break;
  }
  return values.sort((left, right) => left - right);
}

/** 间距标尺：优先 `### Gap Scale`，缺失时回落 `## Spacing System`，再回落 Padding Scale。
 *  散文式指南（slides/card 类）三者皆无，此时返回空数组，消费方回落默认标尺。 */
function spacingOf(body) {
  const gap = /### Gap Scale\s*\n([\s\S]*?)(?:\n###|\n## )/.exec(body)?.[1];
  const fromGap = numericScaleFrom(gap);
  if (fromGap.length >= 4) return fromGap;
  const system = /## Spacing System\s*\n([\s\S]*?)(?:\n## |\n### Padding)/.exec(body)?.[1];
  const fromSystem = numericScaleFrom(system);
  if (fromSystem.length >= 4) return fromSystem;
  const padding = /### Padding Scale\s*\n([\s\S]*?)(?:\n###|\n## )/.exec(body)?.[1];
  const fromPadding = numericScaleFrom(padding);
  return [fromGap, fromSystem, fromPadding].find((candidate) => candidate.length >= 4) ?? [];
}

/** 圆角标尺：`## Corner Radius` 表格（含 `9999px` / `Full` 胶囊档）。 */
function radiusOf(body) {
  const section = /## Corner Radius\s*\n([\s\S]*?)(?:\n## |\n### )/.exec(body)?.[1];
  return numericScaleFrom(section);
}

/** 样式细节行（`- Display (34px): -0.5px` 之类），取前 4 条压平文本。 */
function bulletDetails(section, limit = 4) {
  if (!section) return [];
  const rows = [];
  for (const match of section.matchAll(/^-\s*([^\n]+)$/gmu)) {
    rows.push(match[1].trim());
    if (rows.length >= limit) break;
  }
  return rows;
}

function letterSpacingOf(body) {
  return bulletDetails(/### Letter Spacing\s*\n([\s\S]*?)(?:\n###|\n## )/.exec(body)?.[1]);
}

function lineHeightOf(body) {
  return bulletDetails(/### Line Height\s*\n([\s\S]*?)(?:\n###|\n## )/.exec(body)?.[1]);
}

function digestGuide(markdown) {
  const front = parseFrontmatter(markdown);
  if (!front) return undefined;
  const digest = {
    name: front.name,
    platform: front.platform,
    tags: front.tags,
    summary: summaryOf(front.body),
    aesthetics: aestheticsOf(front.body),
    palette: paletteOf(front.body),
    fonts: fontsOf(front.body),
    type: typeScaleOf(front.body),
    spacing: spacingOf(front.body),
    radius: radiusOf(front.body),
    letterSpacing: letterSpacingOf(front.body),
    lineHeight: lineHeightOf(front.body)
  };
  // 超预算时按确定性顺序裁剪：先丢自由文本，再丢低优先级的结构性字段。
  while (Buffer.byteLength(JSON.stringify(digest)) > MAX_GUIDE_BYTES) {
    if (digest.aesthetics.length > 2) digest.aesthetics.pop();
    else if (digest.lineHeight.length > 0) digest.lineHeight.pop();
    else if (digest.letterSpacing.length > 0) digest.letterSpacing.pop();
    else if (digest.summary.length > 80) digest.summary = trimToToken(digest.summary, digest.summary.length - 40);
    else if (digest.type.length > 4) digest.type.pop();
    else if (digest.spacing.length > 6) digest.spacing.pop();
    else if (digest.radius.length > 5) digest.radius.pop();
    else {
      const keys = Object.keys(digest.palette);
      if (keys.length <= MIN_PALETTE_TOKENS) fail(`${digest.name} 装不进 ${MAX_GUIDE_BYTES} 字节`);
      delete digest.palette[keys[keys.length - 1]];
    }
  }
  return digest;
}

/** 截到 limit 并在词边界收尾，剥掉末尾不完整的 `#hex`（同 summaryOf 的纪律）。 */
function trimToToken(text, limit) {
  // 先退到最近的空格，避免切在半个词上。
  const window = text.slice(0, limit);
  const cut = window.lastIndexOf(" ");
  const base = cut > limit * 0.6 ? window.slice(0, cut) : window;
  return base.replace(/\s*#[0-9A-Fa-f]{0,5}$/u, "").replace(/[\s,;:—-]+$/u, "");
}

/** 纯函数入口（便于测试与复用）：sources = [文件名, markdown][]。 */
export function createStyleGuideCatalog(sources) {
  const guides = [];
  for (const [file, markdown] of sources) {
    const digest = digestGuide(markdown);
    if (!digest) fail(`${file} 没有可解析的 frontmatter`);
    if (Object.keys(digest.palette).length < MIN_PALETTE_TOKENS) fail(`${file} 的调色板少于 ${MIN_PALETTE_TOKENS} 个 token`);
    if (digest.fonts.heading === undefined && digest.fonts.body === undefined) fail(`${file} 没有解析出任何字体族`);
    if (!Object.values(digest.palette).every((value) => HEX.test(value))) fail(`${digest.name} 的调色板含非 HEX 值`);
    guides.push(digest);
  }
  guides.sort((left, right) => left.name.localeCompare(right.name));
  if (guides.length < MIN_GUIDES) fail(`只解析出 ${guides.length} 套指南，期望 >= ${MIN_GUIDES}`);
  return { guides };
}

export async function buildStyleGuides(options = {}) {
  const sourceDir = resolve(options.sourceDir ?? DEFAULT_SOURCE_DIR);
  const outputPath = resolve(options.outputPath ?? DEFAULT_OUTPUT_PATH);
  let files;
  try {
    files = (await readdir(sourceDir)).filter((file) => file.endsWith(".md")).sort();
  } catch (error) {
    fail(`读不到语料目录 ${sourceDir}（${error instanceof Error ? error.message : String(error)}）；用 --source <dir> 指定语料目录`);
  }
  const sources = [];
  for (const file of files) sources.push([file, await readFile(join(sourceDir, file), "utf8")]);
  const catalog = createStyleGuideCatalog(sources);
  const content = `${JSON.stringify(catalog)}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, outputPath);
  return { outputPath, bytes: Buffer.byteLength(content), guides: catalog.guides.length };
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const result = await buildStyleGuides({ sourceDir: argValue("--source"), outputPath: argValue("--output") });
  console.log(`已生成 ${result.outputPath}（${result.guides} 套指南，${result.bytes} 字节）`);
}
