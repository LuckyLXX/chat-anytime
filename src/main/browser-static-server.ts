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
import { PANEL_ACTION_MAX_BYTES, isPanelStatePath, parsePanelAction, type PanelAction } from "../shared/panel.js";

/**
 * 虚拟端点（面板作品读状态的地方）。
 *
 * 它不是一个真文件，而是被拦在 `stat` 之前的一段处理：请求路径的**最后一段**等于
 * `__pidesktop_state.json` 就命中。这样面板页面用相对路径 `fetch("./__pidesktop_state.json")`
 * 即可访问，无论页面位于挂载目录的哪一层——作者不需要知道端口与 token。
 * 它同样受 `/w/<token>/<挂载号>/` 前缀保护：不经 token 的请求连分支都进不来。
 */
export interface StaticServerEndpoint {
  /** GET 返回的状态（任意可 JSON 序列化的值）。 */
  state: () => unknown;
  /**
   * POST 动作处理：返回 true = 已执行并回 { ok: true }。
   *
   * `context.referer` 是发请求页面的 URL（面板页 fetch 相对路径时浏览器会带上）：
   * close / toggle 这类「作用于发出窗口本身」的动作靠它定位是哪个窗口的页面在说话。
   */
  action: (action: PanelAction, context: { referer?: string }) => boolean;
}

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
  /** 面板作品的虚拟端点；未注册时该路径回 404（不是抛错）。 */
  private endpoint: StaticServerEndpoint | undefined;

  /** 注册/摘除虚拟端点（面板窗口与内置浏览器预览共用同一实现）。 */
  setEndpoint(endpoint: StaticServerEndpoint | undefined): void {
    this.endpoint = endpoint;
  }

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

  /** 虚拟端点：GET 读状态、POST 跑白名单动作，其余方法 405。 */
  private async handleEndpoint(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const endpoint = this.endpoint;
    // 没注册端点时按「文件不存在」处理，不泄露这个地址意味着什么。
    if (!endpoint) {
      respond(response, 404, "本地预览地址无效");
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const body = JSON.stringify(endpoint.state() ?? null);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (request.method !== "POST") {
      respond(response, 405, "该地址只接受 GET/POST");
      return;
    }
    const raw = await readBody(request, PANEL_ACTION_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    const action = parsePanelAction(parsed);
    if (!action) {
      respond(response, 403, "不认识的动作");
      return;
    }
    const referer = request.headers.referer;
    if (!endpoint.action(action, { referer: typeof referer === "string" ? referer : undefined })) {
      respond(response, 403, "动作未被接受");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify({ ok: true, action }));
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
      if (isPanelStatePath(rel)) {
        await this.handleEndpoint(request, response);
        return;
      }
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

/** 读请求体，超过 limit 即放弃（返回空串，调用方会当成「没有动作」拒掉）。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) return "";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
