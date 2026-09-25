import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import type { AppearanceSettings } from "../shared/protocol.js";
import {
  THEME_ASSET_CURRENT_SCOPE,
  activeThemeScope,
  themeAssetReferences,
  themeAssetRelativePath,
  themeAssetScopeName
} from "../shared/theme-assets.js";
import type { ThemeImportOutcome } from "../shared/theme-assets.js";
import { safeRelativePath } from "./workspace-preview.js";

/**
 * 主题资产的磁盘侧（2026-09-26 主题资产落磁盘）。
 *
 * 布局：`<agentDir>/pidesktop-themes/<scope>/`，每套主题一个目录、保留导入时的相对
 * 路径结构：
 *
 * ```
 * <agentDir>/pidesktop-themes/
 *   <themeId>/assets/bg-day.webp      # 已保存的主题
 *   current/assets/wallpaper.png      # 未保存为主题的活动资产
 * ```
 *
 * 选 `<agentDir>`（= `~/.pi/agent`）而非 `%APPDATA%/chat-anytime`：与
 * `pidesktop-gallery` / `pidesktop-memory` / `pidesktop-commands` 同款——**用户资源
 * 进 agentDir，应用配置/状态进 userData**；主题资产是用户导入的资源，且 gallery
 * 已是「全局跨工作区」的同类先例。
 *
 * 协议侧只认 `pidesktop-file://theme/<scope>/<relative>`（`src/shared/theme-assets.ts`
 * 是唯一解析口径），本模块负责目录定位与 MIME。
 */

export const THEME_ASSETS_DIR_NAME = "pidesktop-themes";

/** 单文件 / 单主题合计 / CSS 的体积上限：超限**报错中止**（不写半套）。 */
export const THEME_ASSET_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const THEME_ASSET_MAX_SCOPE_BYTES = 32 * 1024 * 1024;
export const THEME_ASSET_MAX_CSS_BYTES = 512 * 1024;

/** 允许落盘的扩展名白名单（图片 + 字体）。 */
export const THEME_ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg",
  ".woff2", ".woff", ".ttf", ".otf"
]);

/**
 * 协议服务用的 MIME 表。刻意与 `previewFileMimeTypes`（工作区预览）分开：那边
 * 多一个 pdf、且「有 MIME = 可预览」，把字体并进去会让工作区预览面板把 woff
 * 当文本渲染。
 */
export const themeAssetMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf"
};

/** 协议可服务的主题资产类型；未知扩展名返回 undefined（handler 回 415）。 */
export function themeAssetMimeType(filePath: string): string | undefined {
  return themeAssetMimeTypes[extname(filePath).toLowerCase()];
}

export function themeAssetsDirFor(agentDir: string): string {
  return join(agentDir, THEME_ASSETS_DIR_NAME);
}

/**
 * 主进程侧的 agentDir 解析。口径与 `resolveGalleryAgentDir` 一致（`homedir()/.pi/agent`，
 * `<APP>_CODING_AGENT_DIR` 环境变量优先）——utility 进程用 SDK 的 getAgentDir()，而 main
 * 不能引 SDK；两处必须指向同一目录，否则「主体程序写的主题资产协议读不到」。
 */
export function resolveThemeAgentDir(home = homedir()): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  return join(home, ".pi", "agent");
}

/** 作用域目录绝对路径；作用域名非法（含分隔符等）返回 undefined。 */
export function themeScopeDir(themesDir: string, scope: string): string | undefined {
  const safeScope = themeAssetScopeName(scope);
  return safeScope ? join(themesDir, safeScope) : undefined;
}

/**
 * 主题资产的协议服务体（`pidesktop-file://theme/<scope>/<relative>`）。
 *
 * 放在本模块而不是 `index.ts`：`protocol.handle` 需要 Electron，但"读盘 + 状态码"
 * 这段逻辑必须能单测（真文件 200 / 穿越 403 / 目录 404 / 未知类型 415）。
 * 根目录固定为 `<themesDir>/<scope>`，`safeRelativePath` 再兜一次包含关系（纵深防御：
 * URL 解析器已经拒过 `..` 与绝对路径）。
 */
export async function serveThemeAsset(
  parsed: { scope: string; relativePath: string },
  themesDir = themeAssetsDirFor(resolveThemeAgentDir())
): Promise<Response> {
  const scopeDir = themeScopeDir(themesDir, parsed.scope);
  if (!scopeDir) return new Response("主题资产地址无效", { status: 400 });
  try {
    const rootReal = await realpath(scopeDir);
    if (!safeRelativePath(rootReal, parsed.relativePath)) {
      return new Response("主题资产必须位于该主题目录内", { status: 403 });
    }
    const candidate = resolve(rootReal, ...parsed.relativePath.split("/"));
    const info = await stat(candidate);
    if (!info.isFile()) return new Response("只能读取主题资产文件", { status: 404 });
    const mimeType = themeAssetMimeType(candidate);
    if (!mimeType) return new Response("该主题资产类型不支持", { status: 415 });
    return new Response(Readable.toWeb(createReadStream(candidate)) as ReadableStream, {
      headers: { "Content-Type": mimeType, "Content-Length": String(info.size), "Cache-Control": "no-cache" }
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return new Response("主题资产不存在或已被删除", { status: 404 });
    throw error;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

// —— 目录操作（全部同步：导入与迁移都在主进程的一次调用里做完，量级是一套主题几十个文件） ——

/** 目录下全部普通文件（相对路径、正斜杠）；有深度与数量上限，防止扫到病态目录。 */
function listFilesRecursive(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || found.length >= MAX_SCAN_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_SCAN_FILES) return;
      if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
      else if (entry.isFile()) found.push(relative(root, join(dir, entry.name)).replaceAll("\\", "/"));
    }
  };
  walk(root, 0);
  return found;
}

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_FILES = 5000;

/** 主题目录下一个层级的子目录名（用于孤儿清理）。 */
function listThemeScopes(themesDir: string): string[] {
  try {
    return readdirSync(themesDir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? [entry.name] : []);
  } catch {
    return [];
  }
}

/** 删掉某个作用域目录（不存在即无事发生）。 */
export function clearThemeScope(themesDir: string, scope: string): void {
  const scopeDir = themeScopeDir(themesDir, scope);
  if (!scopeDir) return;
  rmSync(scopeDir, { recursive: true, force: true });
}

/** 递归复制（覆盖同名），用于跨盘/目标已存在时替代 rename。 */
function copyDirectoryInto(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyDirectoryInto(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

/**
 * 把草稿槽（`current/`）的资产归到某个主题目录下——「保存主题」时调用。
 * 目标目录已存在时改为合并复制（不丢新导入的文件），完成后清掉草稿槽。
 * 返回是否有目录被处理（没有草稿槽时 false，属正常路径）。
 */
export function promoteThemeScope(themesDir: string, themeId: string): boolean {
  const target = themeScopeDir(themesDir, themeId);
  const currentDir = themeScopeDir(themesDir, THEME_ASSET_CURRENT_SCOPE);
  if (!target || !currentDir || !existsSync(currentDir)) return false;
  if (!existsSync(target)) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(currentDir, target);
      return true;
    } catch {
      // 跨盘或目录被占用：落回复制路径
    }
  }
  copyDirectoryInto(currentDir, target);
  rmSync(currentDir, { recursive: true, force: true });
  return true;
}

/**
 * 主题资产目录与设置的**对账**（每次 settings.save / appearance.save 后跑一次）：
 *
 * 1. 新增主题（渲染端刚点「保存主题」）且 CSS 就是当前生效的 → 把 `current/` 归到 `<id>/`；
 * 2. 当前生效的不是草稿（CSS 为空或命中某条主题）→ 草稿槽已无用，删掉；
 * 3. 孤儿目录（不属于任何现存主题、也不是 `current`，含「保存主题后取消」留下的目录）→ 删掉。
 *
 * 渲染端不做任何文件操作，主进程以**内存里的权威 appearance** 为准做对账——
 * 渲染端看到的主题列表是它的副本，不能用来决定删谁。
 */
export function reconcileThemeAssetDirs(themesDir: string, previous: AppearanceSettings, next: AppearanceSettings): void {
  const previousIds = new Set(previous.customThemes.map((theme) => theme.id));
  for (const theme of next.customThemes) {
    if (previousIds.has(theme.id) || theme.css !== next.customCss) continue;
    promoteThemeScope(themesDir, theme.id);
    break;
  }
  if (!next.customCss.trim() || activeThemeScope(next) !== THEME_ASSET_CURRENT_SCOPE) {
    clearThemeScope(themesDir, THEME_ASSET_CURRENT_SCOPE);
  }
  const keep = new Set(next.customThemes.flatMap((theme) => {
    const scope = themeAssetScopeName(theme.id);
    return scope ? [scope] : [];
  }));
  for (const name of listThemeScopes(themesDir)) {
    if (name !== THEME_ASSET_CURRENT_SCOPE && !keep.has(name)) clearThemeScope(themesDir, name);
  }
}

// —— 导入：主进程读盘、按 CSS 引用收集资产、写进草稿槽 ——

/** 从 CSS 里取主题名（`Theme Name:` / `主题:`），取不到用目录名。 */
function themeNameFromCss(css: string, fallback: string): string {
  const match = /(?:Theme Name|\u4e3b\u9898)\s*[:\uff1a]\s*([^\r\n*]+)/iu.exec(css);
  return match?.[1]?.trim() || fallback;
}

/**
 * 主题 CSS 的选择规则（与旧渲染端逐字一致）：`theme.css` → `<目录名>.css` → 第一个 CSS。
 */
function selectThemeCss(rootName: string, cssFiles: string[]): string | undefined {
  const byBaseName = (name: string): string | undefined => cssFiles.find((file) => basename(file).toLowerCase() === name);
  return byBaseName("theme.css") ?? byBaseName(`${rootName.toLowerCase()}.css`) ?? cssFiles[0];
}

/** CSS 引用 → 源目录里的实际文件（先按相对 CSS 的目录、再按根、最后按唯一同名文件）。 */
function resolveAssetSource(byLowerPath: Map<string, string>, cssDir: string, reference: string): string | undefined {
  const candidates = [cssDir ? `${cssDir}/${reference}` : reference, reference];
  for (const candidate of candidates) {
    const hit = byLowerPath.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  const baseName = reference.split("/").at(-1)!;
  const hits = [...byLowerPath.values()].filter((file) => file.toLowerCase().endsWith(`/${reference}`) || basename(file).toLowerCase() === baseName);
  return hits.length === 1 ? hits[0] : undefined;
}

function importThemeCss(themesDir: string, root: string, cssRelativePath: string, fallbackName: string, files: string[]): ThemeImportOutcome {
  const cssPath = join(root, ...cssRelativePath.split("/"));
  const cssInfo = statSync(cssPath);
  if (cssInfo.size > THEME_ASSET_MAX_CSS_BYTES) {
    return { ok: false, message: `主题 CSS 超过 ${Math.round(THEME_ASSET_MAX_CSS_BYTES / 1024)} KB 上限（${Math.round(cssInfo.size / 1024)} KB）` };
  }
  const css = readFileSync(cssPath, "utf8");
  const cssDir = cssRelativePath.includes("/") ? cssRelativePath.slice(0, cssRelativePath.lastIndexOf("/")) : "";
  const byLowerPath = new Map(files.map((file) => [file.toLowerCase(), file]));
  const missing: string[] = [];
  const skipped: string[] = [];
  const plan: { reference: string; source: string; size: number }[] = [];
  let total = 0;
  for (const reference of themeAssetReferences(css)) {
    const source = resolveAssetSource(byLowerPath, cssDir, reference);
    if (!source) {
      missing.push(reference);
      continue;
    }
    if (!THEME_ASSET_EXTENSIONS.has(extname(reference).toLowerCase())) {
      skipped.push(reference);
      continue;
    }
    const info = statSync(join(root, ...source.split("/")));
    if (!info.isFile()) {
      missing.push(reference);
      continue;
    }
    if (info.size > THEME_ASSET_MAX_FILE_BYTES) {
      return { ok: false, message: `资产 ${reference} 超过单文件 ${Math.round(THEME_ASSET_MAX_FILE_BYTES / 1024 / 1024)} MB 上限` };
    }
    total += info.size;
    if (total > THEME_ASSET_MAX_SCOPE_BYTES) {
      return { ok: false, message: `主题资产合计超过 ${Math.round(THEME_ASSET_MAX_SCOPE_BYTES / 1024 / 1024)} MB 上限，未写入任何文件` };
    }
    plan.push({ reference, source, size: info.size });
  }

  // 校验全过才动磁盘：草稿槽是「本次导入」的完整快照，先清空再写。
  clearThemeScope(themesDir, THEME_ASSET_CURRENT_SCOPE);
  const scopeDir = themeScopeDir(themesDir, THEME_ASSET_CURRENT_SCOPE)!;
  let assetCount = 0;
  let bytes = 0;
  for (const item of plan) {
    const target = join(scopeDir, ...item.reference.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, ...item.source.split("/")), target);
    const info = statSync(target);
    if (!info.isFile() || info.size !== item.size) return { ok: false, message: `资产 ${item.reference} 落盘校验失败` };
    assetCount += 1;
    bytes += info.size;
  }
  return { ok: true, name: themeNameFromCss(css, fallbackName), css, assetCount, bytes, missing, skipped };
}

/** 导入一个主题目录（`theme.css` 等规则见 `selectThemeCss`）。 */
export function importThemeDirectory(themesDir: string, sourceDir: string): ThemeImportOutcome {
  try {
    const root = resolve(sourceDir);
    if (!statSync(root).isDirectory()) return { ok: false, message: "选择的路径不是目录" };
    const files = listFilesRecursive(root);
    const cssFiles = files.filter((file) => file.toLowerCase().endsWith(".css"));
    const cssRelativePath = selectThemeCss(basename(root), cssFiles);
    if (!cssRelativePath) return { ok: false, message: "主题目录中没有找到 CSS 文件" };
    return importThemeCss(themesDir, root, cssRelativePath, basename(root), files);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "主题目录导入失败" };
  }
}

/** 导入单个 CSS 文件：以它所在目录为根收集资产。 */
export function importThemeCssFile(themesDir: string, cssFilePath: string): ThemeImportOutcome {
  try {
    const cssPath = resolve(cssFilePath);
    const info = statSync(cssPath);
    if (!info.isFile() || extname(cssPath).toLowerCase() !== ".css") return { ok: false, message: "选择的文件不是 CSS" };
    const root = dirname(cssPath);
    return importThemeCss(themesDir, root, basename(cssPath), basename(cssPath).replace(/\.[^.]*$/u, ""), listFilesRecursive(root));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "主题 CSS 导入失败" };
  }
}

// —— 一次性迁移：内联 base64 → 磁盘文件 ——

const THEME_ASSET_DATA_URL_PATTERN = /^data:([^;,]+)((?:;[^,]*)?),([\s\S]*)$/u;
const THEME_ASSET_DATA_MIME_PATTERN = /^(?:image\/|font\/|application\/(?:font-woff|x-font-woff|vnd\.ms-fontobject))/u;

/** data URL → 字节；不是 base64 图片/字体（旧数据从没产生过别的形态）返回 undefined。 */
function decodeThemeDataUrl(value: string): Buffer | undefined {
  const match = THEME_ASSET_DATA_URL_PATTERN.exec(value.trim());
  if (!match) return undefined;
  if (!THEME_ASSET_DATA_MIME_PATTERN.test(match[1]!.toLowerCase())) return undefined;
  if (!(match[2] ?? "").includes("base64")) return undefined;
  try {
    const bytes = Buffer.from((match[3] ?? "").trim(), "base64");
    return bytes.length > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** 写内联资产到某个作用域目录；返回是否**全部**写入并逐个校验成功。 */
function writeInlineAssets(
  themesDir: string,
  scope: string,
  assets: Record<string, unknown>,
  report: (label: string) => void
): boolean {
  const scopeDir = themeScopeDir(themesDir, scope);
  if (!scopeDir) {
    for (const key of Object.keys(assets)) report(key);
    return false;
  }
  let allWritten = true;
  let scopeBytes = 0;
  for (const [key, value] of Object.entries(assets)) {
    const relativePath = themeAssetRelativePath(key);
    const bytes = typeof value === "string" ? decodeThemeDataUrl(value) : undefined;
    if (!relativePath || !bytes || !THEME_ASSET_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
      report(key);
      allWritten = false;
      continue;
    }
    if (bytes.length > THEME_ASSET_MAX_FILE_BYTES || scopeBytes + bytes.length > THEME_ASSET_MAX_SCOPE_BYTES) {
      report(key);
      allWritten = false;
      continue;
    }
    try {
      const target = join(scopeDir, ...relativePath.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      const info = statSync(target);
      if (!info.isFile() || info.size !== bytes.length) throw new Error("落盘校验失败");
      scopeBytes += bytes.length;
    } catch {
      report(key);
      allWritten = false;
    }
  }
  return allWritten;
}

export interface ThemeAssetMigrationResult {
  /** 迁移后的 raw（成功剥离的资产字段已去掉；失败/超限的保持内联原样）。 */
  raw: unknown;
  migrated: boolean;
  migratedAssets: number;
  /** 没能迁成、仍以 base64 留在配置里的资产键（如实上报，不静默丢）。 */
  keptInline: string[];
}

/**
 * 一次性迁移：把 `raw.appearance` 里的内联 base64 资产写进
 * `<themesDir>/<scope>/<relativePath>`，**先写文件、逐个校验（尺寸逐个断言）、
 * 全部成功才从 raw 里剥离**。任何一步失败就完全保留原样（数据不丢，下次启动重试），
 * 不需要备份文件。
 *
 * 作用域归属：主题自带 `assets` → 该主题 id；`customCssAssets`（活动资产）→
 * CSS 等值命中的主题 id，否则 `current`。
 */
export function migrateInlineThemeAssets(raw: unknown, themesDir: string): ThemeAssetMigrationResult {
  const source = isPlainRecord(raw) ? raw : undefined;
  const appearance = source && isPlainRecord(source.appearance) ? source.appearance : undefined;
  if (!appearance) return { raw, migrated: false, migratedAssets: 0, keptInline: [] };
  const rawThemes = Array.isArray(appearance.customThemes) ? appearance.customThemes : [];
  const cssAssets = isPlainRecord(appearance.customCssAssets) ? appearance.customCssAssets : undefined;
  const keptInline: string[] = [];
  let migratedAssets = 0;
  let migrated = false;

  const nextThemes = rawThemes.map((item, index) => {
    if (!isPlainRecord(item) || !isPlainRecord(item.assets)) return item;
    const scope = themeAssetScopeName(typeof item.id === "string" ? item.id : "") ?? `theme-${index + 1}`;
    const label = typeof item.name === "string" && item.name ? item.name : scope;
    const allWritten = writeInlineAssets(themesDir, scope, item.assets, (key) => keptInline.push(`${label}/${key}`));
    if (!allWritten) return item;
    migratedAssets += Object.keys(item.assets).length;
    migrated = true;
    const { assets: _assets, ...rest } = item;
    return rest;
  });

  let nextAppearance: Record<string, unknown> = { ...appearance, customThemes: nextThemes };
  if (cssAssets) {
    const activeId = rawThemes
      .filter(isPlainRecord)
      .find((theme) => theme.css === appearance.customCss)?.id;
    const scope = typeof activeId === "string" ? themeAssetScopeName(activeId) ?? THEME_ASSET_CURRENT_SCOPE : THEME_ASSET_CURRENT_SCOPE;
    const allWritten = writeInlineAssets(themesDir, scope, cssAssets, (key) => keptInline.push(`活动资产/${key}`));
    if (allWritten) {
      migratedAssets += Object.keys(cssAssets).length;
      migrated = true;
      const { customCssAssets: _cssAssets, ...rest } = nextAppearance;
      nextAppearance = rest;
    }
  }

  if (!migrated) return { raw, migrated: false, migratedAssets: 0, keptInline };
  return { raw: { ...source, appearance: nextAppearance }, migrated: true, migratedAssets, keptInline };
}
