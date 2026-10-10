// 本地静态服务的共用件：MIME 表与路径包含判定。
//
// 两个消费者：loopback 静态服务（内置浏览器预览 / file 型作品，browser-static-server.ts）
// 与自定义协议的面板路由（panel-protocol.ts）。放这里而不是复制两份，是为了
// 「同一个文件在两种承载方式下 Content-Type 必须一致」——不一致会以两种表象出现：
// 图片不显示、`<script type="module">` 被 MIME 检查拒掉（浏览器只接受 JS MIME）。

import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

export function extnameLower(file: string): string {
  const index = file.lastIndexOf(".");
  if (index <= 0) return "";
  return file.slice(index).toLowerCase();
}

/** 文件扩展名 → Content-Type；未知扩展名返回 undefined（调用方回 415）。 */
export function staticMimeType(filePath: string): string | undefined {
  return STATIC_MIME_TYPES[extnameLower(filePath)];
}

/**
 * `target` 是否落在 `root` 内。
 *
 * `relative` 跨盘符（Windows）会返回绝对路径，所以 `isAbsolute` 那道判断是必需的——
 * 只查 `..` 前缀会让另一个盘上的路径被判成「在内」。
 */
export function pathIsWithin(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation) && !relation.startsWith(`..${sep}`));
}
