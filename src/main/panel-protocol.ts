/**
 * 面板作品的协议路由（main 进程）：面板窗口的页面与数据端点**不走 loopback 静态服务**，
 * 而是由平台自定义协议 `pidesktop-file://` 承载，每个作品一个固定 host。
 *
 * 为什么（2026-10-10 根因修复）：面板原先跑在
 * `http://127.0.0.1:<listen(0) 随机端口>/w/<每次新 token>/…`，而 localStorage /
 * IndexedDB 按 **origin（scheme+host+端口）** 隔离 —— 端口每次启动都变 ⇒ 每次都是
 * 全新空存储，作品看起来「数据丢了」（真机探针：同 userData 换端口后两者都读回 null）。
 * 改用协议后 origin = `pidesktop-file://w-<作品>`，跨启动永久稳定、按作品互相隔离，
 * 作品代码一行不用改。
 *
 * 三个刻意的设计：
 * 1. **自描述 URL + 内存挂载表**：URL 里只有 host（= 作品身份）与工作区相对路径，
 *    工作区由主进程的挂载表提供（开面板时注册、关窗时摘除）。URL 短、页面路径干净，
 *    相对资源按目录语义解析（段间保留真实 `/`，见 `panelWorkUrl`）。
 * 2. **窗口级动作按 host 定位，不靠 Referer**：自定义协议的请求里 Referer / Origin
 *    头拿不到（真机实测），而 host 本身就唯一标识作品，比「路径匹配 + 唯一活窗退化」
 *    那套判据更确定——也不再有「多窗口分不清时只能拒绝」的退化。
 * 3. **端点与量测页都是虚拟路径**（最后一段匹配）：面板页用相对路径
 *    `fetch("./__pidesktop_state.json")` 就能取数，作者不需要知道任何地址细节；
 *    量测页则是平台自带页面，作品改坏了也能看到并清掉数据。
 *
 * 安全面：协议只有本进程能服务，**本机其他进程完全够不到**（原先那个「每次一换的
 * token」防探测机制随之不再必要）；路径一律做工作区包含校验 + realpath 复核。
 */

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { PANEL_ACTION_MAX_BYTES, PANEL_MEASURE_PAGE, isPanelMeasurePath, isPanelStatePath, parsePanelRequest, type PanelRequest } from "../shared/panel.js";
import { parsePanelWorkUrl, panelWorkHost } from "../shared/protocol.js";
import { pathIsWithin, staticMimeType } from "./static-assets.js";

/** 面板端点（状态读 / 白名单动作写）。与静态服务的 `StaticServerEndpoint` 同契约，此处只保留差异：定位信息是 appId。 */
export interface PanelProtocolEndpoint {
  state(): unknown;
  action(request: PanelRequest, context: { appId: string }): boolean;
}

export interface PanelMount {
  appId: string;
  /** 挂载根（= 工作区）：面板可访问工作区内的任意文件，与原先静态服务的口径一致。 */
  workspace: string;
}

/**
 * 数据量测脚本（平台自带，**单一来源**）。
 *
 * 两个使用处共用同一份代码：量测页把它内联进 HTML；面板窗口已开着时，主进程把它
 * 直接注入那个页面（那边才是数据的「活主」，量到的就是它当前真正用的存储）。
 *
 * 结果写到 `globalThis.__pidesktopData`，主进程用 `executeJavaScript` 读回并交给
 * `parsePanelDataProbe` 归一化。刻意不读作品代码：作品写坏了，用户仍要能看到并清空数据。
 * localStorage 不在 `navigator.storage.estimate()` 的统计里（它只覆盖 IDB / CacheStorage /
 * ServiceWorker 等配额管理的存储），所以逐键自己量——两者在 UI 上是两行，不合并。
 */
export const PANEL_MEASURE_SCRIPT = `(async () => {
  const out = { origin: location.origin, localStorageBytes: 0, keys: [], databaseNames: [] };
  try {
    const encoder = new TextEncoder();
    const entries = [];
    let total = 0;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      const value = localStorage.getItem(key) || "";
      const bytes = encoder.encode(key).length + encoder.encode(value).length;
      total += bytes;
      entries.push({ key: key, bytes: bytes });
    }
    entries.sort((left, right) => right.bytes - left.bytes);
    out.localStorageBytes = total;
    out.keys = entries.slice(0, 8);
  } catch (error) {
    out.localStorageError = String((error && error.message) || error);
  }
  try {
    const estimate = await navigator.storage.estimate();
    out.storageBytes = estimate.usage;
    out.quotaBytes = estimate.quota;
    out.persisted = await navigator.storage.persisted();
  } catch (error) {
    out.storageError = String((error && error.message) || error);
  }
  try {
    if (indexedDB.databases) {
      const databases = await indexedDB.databases();
      out.databaseNames = databases.map((database) => database.name).filter((name) => typeof name === "string");
    }
  } catch (error) {
    out.databaseError = String((error && error.message) || error);
  }
  globalThis.__pidesktopData = out;
})();`;

/** 量测页（虚拟路径 `__pidesktop_measure.html`）：只是一个让脚本跑在该作品 origin 上的壳。 */
export const PANEL_MEASURE_HTML = `<!doctype html>\n<html><head><meta charset="utf-8"><title>作品数据</title></head>\n<body>\n<script>\n${PANEL_MEASURE_SCRIPT}\n</script>\n</body></html>`;

export class PanelProtocolRoute {
  /** host → 挂载（host 由作品 id 唯一决定，见 shared/protocol.ts 的 panelWorkHost）。 */
  private readonly mounts = new Map<string, PanelMount>();

  constructor(private readonly endpoint: PanelProtocolEndpoint) {}

  /** 注册（或覆盖）一个作品的挂载，返回它的 host。开面板窗口前调用。 */
  mount(input: PanelMount): string {
    const host = panelWorkHost(input.appId);
    this.mounts.set(host, { appId: input.appId, workspace: input.workspace });
    return host;
  }

  /** 摘除挂载（窗口关闭 / 控制器 dispose）。重复摘除是 no-op。 */
  unmount(appId: string): void {
    this.mounts.delete(panelWorkHost(appId));
  }

  /** 这个 webContents 对应的作品还在挂载中吗（调试与测试用）。 */
  has(appId: string): boolean {
    return this.mounts.has(panelWorkHost(appId));
  }

  dispose(): void {
    this.mounts.clear();
  }

  /** 协议请求入口。任何情况下都返回 Response（绝不抛错，否则那个请求会挂死）。 */
  async handle(request: Request): Promise<Response> {
    try {
      const parsed = parsePanelWorkUrl(request.url);
      if (!parsed) return errorResponse(404, "面板地址无效");
      const mount = this.mounts.get(parsed.host);
      if (!mount) return errorResponse(404, "面板未挂载（窗口已关闭或地址已过期）");
      if (isPanelStatePath(parsed.relativePath)) return await this.handleEndpoint(request, mount);
      if (isPanelMeasurePath(parsed.relativePath)) {
        return new Response(PANEL_MEASURE_HTML, { headers: htmlHeaders() });
      }
      return await this.serveFile(mount, parsed.relativePath);
    } catch (error) {
      return errorResponse(500, `面板请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 虚拟端点：GET/HEAD 读状态，POST 跑白名单动作，其余方法 405。 */
  private async handleEndpoint(request: Request, mount: PanelMount): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      const body = JSON.stringify(this.endpoint.state() ?? null);
      return new Response(method === "HEAD" ? undefined : body, {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
      });
    }
    if (method !== "POST") return errorResponse(405, "该地址只接受 GET/POST");
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > PANEL_ACTION_MAX_BYTES) return errorResponse(413, "请求体过大");
    const raw = await request.text().catch(() => "");
    if (raw.length > PANEL_ACTION_MAX_BYTES) return errorResponse(413, "请求体过大");
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    const panelRequest = parsePanelRequest(parsed);
    if (!panelRequest) return errorResponse(403, "不认识的动作");
    if (!this.endpoint.action(panelRequest, { appId: mount.appId })) return errorResponse(403, "动作未被接受");
    return new Response(JSON.stringify({ ok: true, action: panelRequest.action }), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  }

  /** 工作区内文件：包含校验（含 realpath，挡符号链接逃逸）→ MIME → 流式返回。 */
  private async serveFile(mount: PanelMount, relativePath: string): Promise<Response> {
    const root = resolve(mount.workspace);
    const target = resolve(root, ...relativePath.split("/"));
    if (!pathIsWithin(root, target)) return errorResponse(403, "路径越出工作区");
    const info = await stat(target).catch(() => undefined);
    if (!info) return errorResponse(404, `文件不存在：${relativePath}`);
    // 目录按 index.html 处理（原静态服务同一口径）
    const actual = info.isDirectory() ? join(target, "index.html") : target;
    const real = await realpath(actual).catch(() => undefined);
    const realRoot = await realpath(root).catch(() => undefined);
    if (!real || !realRoot || !pathIsWithin(realRoot, real)) return errorResponse(403, "路径越出工作区");
    const fileInfo = await stat(real).catch(() => undefined);
    if (!fileInfo?.isFile()) return errorResponse(404, `文件不存在：${relativePath}`);
    const mimeType = staticMimeType(real);
    if (!mimeType) return errorResponse(415, "该文件类型不能由面板加载");
    return new Response(Readable.toWeb(createReadStream(real)) as ReadableStream, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(fileInfo.size),
        // 入口与资产可能被 AI 就地覆盖重写：禁止直接复用缓存，但保留条件请求语义。
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
}

function htmlHeaders(): Record<string, string> {
  return { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
