// browser_save_image 的纯逻辑层（可单测、不依赖 Electron）：
// 图片来源分类、字节嗅探、文件名推导、落盘。
//
// 存在的意义：站点里的图片常常**没有下载按钮**，或者图片根本不是 http 资源
// （`data:` / `blob:` / canvas 绘制结果）——`browser_screenshot` 截的是「屏幕上
// 看到的样子」（可能被缩放、被遮挡、带页面装饰），`browser_eval` 只能拿回文本。
// 本模块把「页面里的图片原图 → 工作区文件」这条路径补全。
//
// 真机实测口径（2026-09-17，Electron 43）：
// - `session.fetch(url, { credentials: "include" })` 带得住 partition 的 Cookie（主通道）；
// - 但 `session.fetch` 对 **Referer 头有强校验**：Referer 与目标**不同源**时直接
//   `net::ERR_BLOCKED_BY_CLIENT`（同源 Referer 则正常）——所以跨域图片要么不带
//   Referer，要么退到下载通道（`webContents.downloadURL` 能把 Referer 正确送达）；
// - `data:` URL 不能走 `session.fetch`（ERR_INVALID_ARGUMENT），必须主进程解 base64；
// - 跨域绘制的 canvas `toDataURL` 抛 SecurityError（`Tainted canvases may not be exported.`）；
// - `nativeImage.createFromBuffer` 只认位图：SVG / 破损 / 仅文件头的输入一律 {0,0}。

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DOWNLOAD_DIR_SEGMENTS, sanitizeDownloadName } from "./browser-downloads.js";

/** 单张内联保存的字节上限（与 browser_upload 的 20MB 对齐）。 */
export const MAX_SAVE_IMAGE_BYTES = 20 * 1024 * 1024;

/** 图片来源分类（决定主进程走哪条取字节的路）。 */
export type ImageSourceKind = "data" | "blob" | "canvas" | "http";

/**
 * 按 URL 形状分类来源。`canvas` 不在此列——它是**元素类型**而不是 URL 形状，
 * 由页面脚本单独标注（canvas.toDataURL 的结果本身是 data: URL）。
 */
export function classifyImageSource(url: string): "data" | "blob" | "http" | undefined {
  const value = url.trim();
  if (!value) return undefined;
  if (value.startsWith("data:")) return "data";
  if (value.startsWith("blob:")) return "blob";
  if (/^https?:/iu.test(value)) return "http";
  return undefined;
}

/**
 * 两个 URL 是否同源。用于决定要不要给 `session.fetch` 带 Referer：
 * 实测「Referer 与目标不同源 → net::ERR_BLOCKED_BY_CLIENT」，同源则正常。
 * 解析失败按「不同源」处理（宁可不带 Referer，也不触发拦截）。
 */
export function isSameOrigin(pageUrl: string, targetUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const target = new URL(targetUrl);
    return page.protocol === target.protocol && page.host === target.host;
  } catch {
    return false;
  }
}

/**
 * 字节嗅探图片真实 MIME（magic bytes 优先于 URL 后缀：站点给的
 * `photo.webp` 可能实际是 PNG，甚至 Content-Type 都不可信）。
 * 返回 undefined = 不是已知图片格式。
 */
export function sniffImageMime(bytes: Buffer): string | undefined {
  const at = (offset: number, signature: readonly number[]): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // JPEG: FF D8 FF
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF: "GIF8"
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // WEBP: "RIFF"…. "WEBP"
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  // BMP: "BM"
  if (at(0, [0x42, 0x4d])) return "image/bmp";
  // AVIF/HEIF: …. "ftyp" + brand
  if (at(4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis" || brand === "heic" || brand === "heif" || brand === "mif1") return "image/avif";
  }
  // SVG: 文本格式，容忍 BOM 与前置空白；只看头部一段避免把大文件整段解码。
  const head = bytes.subarray(0, 256).toString("utf8").replace(/^\uFEFF/u, "").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return undefined;
}

/** MIME → 文件扩展名（落盘用）。未收录的格式回落 `.bin`（仍会写字节，不猜）。 */
export function extensionForMime(mime: string | undefined): string {
  switch (mime) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/bmp": return "bmp";
    case "image/avif": return "avif";
    case "image/svg+xml": return "svg";
    default: return "bin";
  }
}

/** 去掉文件名末尾的扩展名（扩展名一律由字节嗅探决定，不信任 URL 后缀）。 */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 推导落盘文件名：
 * - URL basename（经 sanitizeDownloadName 清洗：去目录分量/控制字符/保留名/超长截断）
 * - 无可用 basename → `image-<时间戳>`
 * - 扩展名以**嗅探结果**为准（`photo.webp` 实际是 PNG → `photo.png`）
 * - 无法嗅探 → 保留 URL 原有扩展名，仍无则 `.bin`（不冒充图片）
 */
export function deriveImageFilename(rawUrl: string | undefined, mime: string | undefined, now = new Date()): string {
  let stem = "";
  if (rawUrl) {
    // data:/blob: 的「basename」没有意义：data 直接忽略，blob 用其 UUID 也无价值。
    if (!rawUrl.startsWith("data:") && !rawUrl.startsWith("blob:")) {
      const path = rawUrl.split(/[?#]/u)[0] ?? "";
      // 只取 pathname：直接按 `/` 拆会把 host 当成 basename（`https://example.com/` →
      // 「example.com」）。解析失败时退回整串切分（仍然比造名字安全）。
      let pathname = path;
      try {
        pathname = new URL(path).pathname;
      } catch {
        // keep the raw string
      }
      const last = pathname.split("/").filter(Boolean).at(-1) ?? "";
      // 百分号编码先解码（Chromium 的下载命名同样解码）：`a%20b.png` → `a b.png`。
      // 危险序列（%2e%2e%2f 之类）解码后是路径分量，紧接着的 sanitizeDownloadName
      // 会把它拆掉，所以“先解码再清洗”不会引入穿越面。
      let decoded = last;
      if (last.includes("%")) {
        try {
          decoded = decodeURIComponent(last);
        } catch {
          decoded = last;
        }
      }
      const cleaned = decoded ? sanitizeDownloadName(decoded, now) : "";
      // sanitizeDownloadName 会给出 `download-<时间戳>` 兜底；那是它的语义，
      // 这里要区分「本来就有名字」与「兜底」——兜底名字里没有 '.'，也无妨。
      if (cleaned && !cleaned.startsWith("download-")) stem = stripExtension(cleaned);
    }
  }
  if (!stem) {
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    stem = `image-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }
  // 清洗后可能只剩扩展名或空串（如 URL 为 `.png`）：再过一遍 sanitize 保证安全。
  const safeStem = sanitizeDownloadName(stem, now);
  const extension = extensionForMime(mime);
  return `${stripExtension(safeStem) || "image"}.${extension}`;
}

export interface SavedImage {
  /** 落盘绝对路径。 */
  filePath: string;
  filename: string;
  bytes: number;
}

/**
 * 把字节写到该工作区的下载目录（与浏览器下载同一落点，便于模型统一用
 * `ls .pidesktop/downloads/` 找产物）。同名冲突时递增序号，绝不覆盖已有文件。
 */
export async function saveImageBytes(workspace: string, filename: string, bytes: Buffer): Promise<SavedImage> {
  const rootReal = await realpath(resolve(workspace));
  const dir = join(rootReal, ...DOWNLOAD_DIR_SEGMENTS);
  await mkdir(dir, { recursive: true });
  let candidate = filename;
  for (let attempt = 1; ; attempt++) {
    const filePath = join(dir, candidate);
    if (!existsSync(filePath)) {
      try {
        await writeFile(filePath, bytes, { flag: "wx" });
        return { filePath, filename: candidate, bytes: bytes.length };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    // 冲突（或竞态）：`photo.png` → `photo-1.png` → `photo-2.png`…
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : "";
    candidate = `${base}-${attempt}${extension}`;
  }
}

/** 落盘路径 → 工作区相对路径（forward slashes，回执用）。 */
export function imageRelativePath(workspace: string, filePath: string): string {
  return [...DOWNLOAD_DIR_SEGMENTS, relative(resolve(workspace), filePath).split(sep).at(-1) ?? ""].join("/");
}

/**
 * 从 data: URL 解出字节。`data:image/png;base64,xxx` 与百分号编码的
 * `data:image/svg+xml,%3Csvg…` 都支持（后者在 SVG 内联场景常见）。
 * 非法/空载荷返回 undefined，由调用方给出可行动错误。
 */
export function decodeDataUrl(dataUrl: string): { bytes: Buffer; mime: string } | undefined {
  const match = /^data:([^,]*),(.*)$/su.exec(dataUrl.trim());
  if (!match) return undefined;
  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  const mime = meta.split(";")[0]?.trim() || "application/octet-stream";
  const isBase64 = /;base64$/iu.test(meta);
  try {
    if (isBase64) {
      if (!payload) return undefined;
      return { bytes: Buffer.from(payload, "base64"), mime };
    }
    return { bytes: Buffer.from(decodeURIComponent(payload), "utf8"), mime };
  } catch {
    return undefined;
  }
}
