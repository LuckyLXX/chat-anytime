/**
 * 面板窗口的跨域放宽（CORS relaxation）。
 *
 * 背景（2026-09-26 实测）：很多自建/中转的模型 API 压根没有实现 CORS —— 预检
 * `OPTIONS` 返回 405 Method Not Allowed、正式响应里也没有 `Access-Control-Allow-Origin`，
 * 于是面板页里 `fetch("http://…/v1/chat/completions")` 只能拿到一句
 * `TypeError: Failed to fetch`。这不是面板作者能修的（服务端不在他手里），也不该逼
 * 每个面板自己套一层本地代理（用户为此手写过一整个 python 代理作品）。平台在**主进程**
 * 把两件事补上：给响应补 CORS 头、把被服务端拒掉的预检改写成 200。
 *
 * 三条纪律：
 * 1. **只对面板窗口生效**：判据是请求的 `webContentsId` 属于某个面板窗口。内置浏览器
 *    预览是「正常浏览器」——在那里放宽 CORS 等于让任意网站的脚本读跨域数据，不做。
 * 2. **服务端自己就对时不插手**：响应已有正确的 `Access-Control-Allow-Origin`（等于请求
 *    来源，或 `*`）时原样放行。patch 面积越小越好。
 * 3. **永远回调**：webRequest 监听漏一次回调，那个请求就永久挂起。所有分支都走同一个
 *    `respond()`，异常一律降级成「不改」。
 *
 * 为什么不用 `webSecurity: false`：那会连同一个窗口的**同源策略**一起关掉（面板里嵌入的
 * 任何远程页面都能互相读内容），代价与收益不成比例。
 *
 * 已知边界（如实记录）：服务端对 OPTIONS 直接重置连接/不回包时拿不到任何响应头，这里
 * 无从改写（那类只能走「平台代理端点」这条路，本轮未做）；面板页里 service worker 发起的
 * 请求没有 webContentsId，也不覆盖。
 */

import { session, type HeadersReceivedResponse, type OnBeforeSendHeadersListenerDetails } from "electron";

/** 只关心 http(s)：别的 scheme（file/data/blob，以及我们自己的 pidesktop-file://）没有跨域概念。 */
export const PANEL_CORS_URL_FILTER: string[] = ["http://*/*", "https://*/*"];

/** 记住的请求上限：正常在途请求远小于它，超了丢最老的（宁可漏放宽，不可无界增长）。 */
export const MAX_PENDING_REQUESTS = 512;

type HeaderMap = Record<string, string | string[]>;

/** 一次请求里与 CORS 有关的那些请求头（onHeadersReceived 拿不到请求头，所以要提前记）。 */
export interface PanelRequestHeaders {
  origin?: string;
  /** 预检要求的方法（`Access-Control-Request-Method`）。 */
  requestedMethod?: string;
  /** 预检要求的头（`Access-Control-Request-Headers`），原样回显最安全。 */
  requestedHeaders?: string;
}

export interface PanelCorsPatchInput {
  method: string;
  /** 原始状态行（如 `HTTP/1.1 405 Method Not Allowed`）。 */
  statusLine: string;
  responseHeaders: HeaderMap;
  request: PanelRequestHeaders;
}

/**
 * 计算要写回的响应（纯函数）。
 *
 * 返回 `undefined` = 什么都不做：不是浏览器发起的跨域请求（没有 Origin），或服务端本来
 * 就给了可用的 CORS 头。
 */
export function buildPanelCorsPatch(input: PanelCorsPatchInput): HeadersReceivedResponse | undefined {
  const origin = input.request.origin?.trim();
  // 没有 Origin：同源请求、或 main 进程自己发起的请求——没有跨域可言，也不该被改。
  if (!origin) return undefined;

  const isPreflight = input.method.toUpperCase() === "OPTIONS" && Boolean(input.request.requestedMethod);
  const existingAllowOrigin = headerValue(input.responseHeaders, "access-control-allow-origin");
  // 服务端自己给的 CORS 是对的（反映来源或通配）：尊重它，不动。
  if (!isPreflight && (existingAllowOrigin === origin || existingAllowOrigin === "*")) return undefined;

  // 其余 access-control-* 一律先清掉：服务端给错的值（比如 Allow-Origin 指向别的站点、
  // 或 Allow-Methods 少了我们实际用的方法）留着只会让浏览器判失败。
  const responseHeaders = withoutAccessControl(input.responseHeaders);
  responseHeaders["Access-Control-Allow-Origin"] = [origin];
  responseHeaders["Access-Control-Allow-Credentials"] = ["true"];
  responseHeaders["Access-Control-Expose-Headers"] = ["*"];
  withOriginVary(input.responseHeaders, responseHeaders);

  const patch: HeadersReceivedResponse = { responseHeaders };
  if (isPreflight) {
    responseHeaders["Access-Control-Allow-Methods"] = [input.request.requestedMethod!];
    responseHeaders["Access-Control-Allow-Headers"] = [input.request.requestedHeaders || "*"];
    responseHeaders["Access-Control-Max-Age"] = ["600"];
    // 关键一步：服务端把预检拒了（405 等）也要让浏览器认为它通过了，否则请求根本发不出去。
    if (!isSuccessStatusLine(input.statusLine)) patch.statusLine = upgradeStatusLine(input.statusLine);
  }
  return patch;
}

/** 安装放宽（本进程只装一次；见 index.ts 的 ensurePanelCorsRelaxation）。 */
export interface PanelCorsRelaxationDeps {
  /** 这个 webContents 属于面板窗口吗？false 一律原样放行。 */
  isPanelWebContents: (webContentsId: number) => boolean;
}

export function installPanelCorsRelaxation(deps: PanelCorsRelaxationDeps): void {
  const webRequest = session.defaultSession.webRequest;
  const pending = new Map<number, PanelRequestHeaders>();

  const remember = (id: number, info: PanelRequestHeaders): void => {
    if (pending.size >= MAX_PENDING_REQUESTS) {
      const oldest = pending.keys().next();
      if (!oldest.done) pending.delete(oldest.value);
    }
    pending.set(id, info);
  };

  webRequest.onBeforeSendHeaders({ urls: PANEL_CORS_URL_FILTER }, (details: OnBeforeSendHeadersListenerDetails, callback) => {
    try {
      const info = requestedHeaders(details.requestHeaders);
      // 没有 Origin 就不必记（同源请求 / main 进程发起的请求），省掉无谓的写入。
      if (info.origin) remember(details.id, info);
      else pending.delete(details.id);
    } catch {
      /* 记录失败不影响请求本身 */
    }
    callback({});
  });

  webRequest.onHeadersReceived({ urls: PANEL_CORS_URL_FILTER }, (details, callback) => {
    // 唯一出口：无论发生什么都要回调，否则这个请求会永久挂起。
    const respond = (patch: HeadersReceivedResponse): void => {
      try {
        callback(patch);
      } catch {
        /* 到这一步已无能为力 */
      }
    };
    try {
      const info = pending.get(details.id);
      pending.delete(details.id);
      if (!info || details.webContentsId === undefined || !deps.isPanelWebContents(details.webContentsId)) {
        respond({});
        return;
      }
      respond(
        buildPanelCorsPatch({
          method: details.method,
          statusLine: details.statusLine,
          responseHeaders: details.responseHeaders ?? {},
          request: info
        }) ?? {}
      );
    } catch {
      respond({});
    }
  });

  // 请求在拿到响应头之前就失败了（DNS/连接重置）：清掉记录，别让它占着额度。
  webRequest.onErrorOccurred({ urls: PANEL_CORS_URL_FILTER }, (details) => {
    pending.delete(details.id);
  });
}

/** 从 Electron 给的原始请求头里挑出我们关心的三个（键大小写原样，故统一小写匹配）。 */
export function requestedHeaders(headers: Record<string, string>): PanelRequestHeaders {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) lower.set(key.toLowerCase(), value);
  const info: PanelRequestHeaders = {};
  const origin = lower.get("origin");
  if (origin) info.origin = origin;
  const method = lower.get("access-control-request-method");
  if (method) info.requestedMethod = method;
  const requested = lower.get("access-control-request-headers");
  if (requested) info.requestedHeaders = requested;
  return info;
}

function headerValue(headers: HeaderMap, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value.join(", ") : value;
  }
  return undefined;
}

function withoutAccessControl(headers: HeaderMap): HeaderMap {
  const next: HeaderMap = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^access-control-/iu.test(key)) continue;
    next[key] = value;
  }
  return next;
}

/**
 * 反映来源的响应必须带 `Vary: Origin`（否则中间缓存可能把 A 来源的响应给 B 来源）。
 * 已有 Vary 时**合并**而不是覆盖——丢掉 `Accept-Encoding` 会带来别的麻烦。
 */
function withOriginVary(existing: HeaderMap, next: HeaderMap): void {
  const current = headerValue(existing, "vary");
  const parts = current ? current.split(",").map((part) => part.trim()).filter(Boolean) : [];
  if (parts.some((part) => part.toLowerCase() === "origin")) return;
  next["Vary"] = [...parts, "Origin"].join(", ");
}

function isSuccessStatusLine(statusLine: string): boolean {
  return /^HTTP\/[\d.]+\s+2\d\d\b/u.test(statusLine);
}

/** 保留原协议版本（HTTP/2 的响应上写 HTTP/1.1 状态行不合适），只换状态码与原因短语。 */
function upgradeStatusLine(statusLine: string): string {
  const match = /^(HTTP\/[\d.]+)\s+\d{3}/u.exec(statusLine);
  return `${match?.[1] ?? "HTTP/1.1"} 200 OK`;
}
