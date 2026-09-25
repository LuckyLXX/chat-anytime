import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { themeAssetScopeName } from "../shared/theme-assets.js";
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
