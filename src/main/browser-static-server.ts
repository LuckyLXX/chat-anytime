// Workspace static server (main process): lets the built-in browser preview
// local files. The preview only loads http/https (a file:// page would get a
// local-file origin inside Electron), so browser_navigate maps file:// paths
// onto a loopback-only static server rooted at the workspace. The URL carries
// a per-run random token segment so other local processes cannot probe
// workspace files by guessing the address.

import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES: Record<string, string> = {
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
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

/** Detect a local file target: file:// URLs and bare Windows absolute paths. */
export function detectLocalFilePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  if (/^[a-zA-Z]:[\\/]/u.test(trimmed)) return trimmed;
  return undefined;
}

export class BrowserStaticServer {
  private server: Server | undefined;
  private port = 0;
  private token = "";
  /** mount index → absolute root directory. */
  private readonly roots = new Map<number, string>();
  /** lowercased root → mount index (stable within the app run). */
  private readonly rootIndex = new Map<string, number>();
  private startError: string | undefined;
  private starting: Promise<void> | undefined;

  /**
   * HTTP URL serving `filePath`, mounting `preferredRoot` when the file lives
   * inside it (workspace), the file's own directory otherwise.
   */
  async urlForFile(filePath: string, preferredRoot?: string): Promise<string> {
    const file = resolve(filePath);
    const root =
      preferredRoot && pathIsWithin(preferredRoot, file) ? resolve(preferredRoot) : dirname(file);
    const index = this.mount(root);
    await this.ensureRunning();
    if (!this.server || !this.port) throw new Error(`本地静态预览服务不可用：${this.startError ?? "启动失败"}`);
    const rel = relative(root, file).split(sep).join("/");
    const encoded = rel.split("/").map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${this.port}/w/${this.token}/${index}${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
  }

  dispose(): void {
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    this.startError = undefined;
    this.starting = undefined;
    this.roots.clear();
    this.rootIndex.clear();
    if (server) server.close();
  }

  private mount(root: string): number {
    const key = root.toLowerCase();
    const existing = this.rootIndex.get(key);
    if (existing !== undefined) return existing;
    const index = this.roots.size + 1;
    this.roots.set(index, root);
    this.rootIndex.set(key, index);
    return index;
  }

  private ensureRunning(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (this.starting) return this.starting;
    this.startError = undefined;
    this.token = randomUUID().replace(/-/gu, "").slice(0, 16);
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.starting = new Promise<void>((resolveStart, rejectStart) => {
      server.once("error", (error) => {
        // Keep the instance replaceable: the next ensureRunning() starts fresh.
        if (this.server === server) this.server = undefined;
        this.startError = error.message;
        this.starting = undefined;
        server.close();
        rejectStart(error);
      });
      // Ephemeral port on the loopback interface only — never reachable from
      // other machines, and the URL path carries a per-run token anyway.
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") this.port = address.port;
        this.server = server;
        this.starting = undefined;
        resolveStart();
      });
    });
    return this.starting;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/w\/([0-9a-f]{16})\/(\d+)(\/.*)?$/u.exec(url.pathname);
      if (!match || match[1] !== this.token) {
        respond(response, 404, "本地预览地址无效");
        return;
      }
      const root = this.roots.get(Number(match[2]));
      if (!root) {
        respond(response, 404, "本地预览目录未挂载");
        return;
      }
      const rel = decodeURIComponent(match[3] ?? "/");
      const target = resolve(join(root, rel));
      if (!pathIsWithin(root, target)) {
        respond(response, 403, "路径越出预览目录");
        return;
      }
      const info = await stat(target).catch(() => undefined);
      if (!info) {
        respond(response, 404, `文件不存在：${rel}`);
        return;
      }
      const actual = info.isDirectory() ? join(target, "index.html") : target;
      // Symlinks must not escape the mount root.
      const real = await realpath(actual).catch(() => undefined);
      const realRoot = await realpath(root).catch(() => undefined);
      if (!real || !realRoot || !pathIsWithin(realRoot, real)) {
        respond(response, 403, "路径越出预览目录");
        return;
      }
      const body = await readFile(real).catch(() => undefined);
      if (!body) {
        respond(response, 404, `文件不存在：${rel}`);
        return;
      }
      const type = MIME_TYPES[extnameLower(real)] ?? "application/octet-stream";
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(body);
    } catch (error) {
      respond(response, 500, `本地预览失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function extnameLower(file: string): string {
  const index = file.lastIndexOf(".");
  if (index <= 0) return "";
  return file.slice(index).toLowerCase();
}

function pathIsWithin(root: string, target: string): boolean {
  // `relative` returns an absolute path for targets on another drive (Windows),
  // so the isAbsolute guard is what keeps cross-drive escapes out.
  const relation = relative(resolve(root), resolve(target));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation) && !relation.startsWith(`..${sep}`));
}

function respond(response: ServerResponse, status: number, message: string): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  response.end(message);
}
