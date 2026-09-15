// MCP OAuth capability cluster: credential store + OAuthClientProvider + local
// callback server. Runs in the utility process, so it only uses Node APIs —
// opening the authorization page is injected (`openExternal`) and forwarded to
// the main process (`shell.openExternal`).
//
// Flow: an HTTP MCP server without `bearerTokenEnv` gets an authProvider; the
// SDK's `auth()` runs RFC 9728 discovery + dynamic client registration + PKCE,
// then calls `redirectToAuthorization` (we open the system browser) and throws
// `UnauthorizedError`, which `mcp-client` reports as status "needs-auth". The
// browser redirects back to our loopback callback, we call `finishAuth(code)`
// on the pending transport and reconnect. Credentials live in
// `<agentDir>/pidesktop-mcp-auth.json` (same plaintext-JSON level as
// `mcp-cache.json`), so refresh tokens survive restarts.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpAuthState } from "../shared/protocol.js";
import type { ConfiguredMcpServer, McpServerConfigEntry } from "./mcp-config.js";

/** 回调服务器首选端口（被占用时退避到系统随机端口，并把最终端口持久化）。 */
export const DEFAULT_MCP_CALLBACK_PORT = 1456;

/** 待授权窗口的默认有效期；超时后回到「认证」按钮状态。 */
export const DEFAULT_PENDING_TIMEOUT_MS = 10 * 60 * 1000;

export interface McpAuthRecord {
  /** 动态客户端注册（DCR）得到的注册信息。 */
  clientInformation?: OAuthClientInformationMixed;
  /** 注册/授权时使用的回调地址；端口变化后注册信息视为失效，需重新注册。 */
  redirectUrl?: string;
  tokens?: OAuthTokens;
  /**
   * 凭据被判定不可用（刷新被授权服务器拒绝）时的说明。刻意**不删除 tokens**：
   * 轮换型服务器上一次瞬时/竞态失败就把 refresh_token 永久销毁，代价是用户
   * 每次都要重新走浏览器授权；保留下来还能在下次显式「认证」时重试一次。
   * 标记期间 tokens() 返回 undefined（SDK 直接走交互式授权，不拿死 token 反复刷新），
   * 拿到新 token 后由 saveTokens 清除。
   */
  refreshFailed?: { reason: string; at: number };
  codeVerifier?: string;
  /** 本次授权流程的 state，回调时用于比对。 */
  state?: string;
  discoveryState?: OAuthDiscoveryState;
  updatedAt?: number;
}

interface McpAuthFile {
  version: 1;
  redirectPort?: number;
  servers: Record<string, McpAuthRecord>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** access token 生命周期余量：快到期也当作过期，避免「刚发出去就过期」的边界。 */
const ACCESS_TOKEN_SKEW_MS = 60_000;

/** 主动刷新的上限；超时即放弃（交给 401 路径兜底），不拖住工具调用。 */
const REFRESH_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP 授权刷新超时（${ms}ms）`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * 判断 access token 是否已过期（仅 JWT 可判断：读 payload 的 exp）。非 JWT 或解析
 * 失败时返回 false —— 无法预判就不预判，交给 401 路径兜底。
 */
export function isAccessTokenExpired(accessToken: string, now = Date.now()): boolean {
  const payload = accessToken.split(".")[1];
  if (!payload) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof decoded.exp !== "number") return false;
    return decoded.exp * 1000 - ACCESS_TOKEN_SKEW_MS <= now;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Credential store: one JSON file for the whole app, per-server records. */
export class McpAuthStore {
  private file: McpAuthFile;

  constructor(private readonly filePath: () => string) {
    this.file = this.load();
  }

  private load(): McpAuthFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(), "utf8")) as Partial<McpAuthFile>;
      if (!parsed || typeof parsed !== "object" || typeof parsed.servers !== "object" || !parsed.servers) return { version: 1, servers: {} };
      return {
        version: 1,
        ...(typeof parsed.redirectPort === "number" ? { redirectPort: parsed.redirectPort } : {}),
        servers: parsed.servers as Record<string, McpAuthRecord>
      };
    } catch {
      // 缺失/损坏的凭据文件按空处理（下次写入会重建），绝不让它阻断连接。
      return { version: 1, servers: {} };
    }
  }

  private save(): void {
    const target = this.filePath();
    mkdirSync(dirname(target), { recursive: true });
    const tempPath = `${target}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
    renameSync(tempPath, target);
  }

  get redirectPort(): number | undefined {
    return this.file.redirectPort;
  }

  setRedirectPort(port: number): void {
    if (this.file.redirectPort === port) return;
    this.file.redirectPort = port;
    this.save();
  }

  get(serverName: string): McpAuthRecord | undefined {
    const record = this.file.servers[serverName];
    return record ? { ...record } : undefined;
  }

  /** 合并写入；显式 undefined 表示删除该字段。 */
  update(serverName: string, patch: Partial<McpAuthRecord>): void {
    const next: McpAuthRecord = { ...(this.file.servers[serverName] ?? {}), ...patch, updatedAt: Date.now() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key as keyof McpAuthRecord];
    }
    this.file.servers[serverName] = next;
    this.save();
  }

  clear(serverName: string): void {
    if (!(serverName in this.file.servers)) return;
    delete this.file.servers[serverName];
    this.save();
  }

  hasTokens(serverName: string): boolean {
    const tokens = this.file.servers[serverName]?.tokens;
    return Boolean(tokens?.access_token || tokens?.refresh_token);
  }

  /**
   * 当前存档凭据的指纹。失效请求只允许销毁「它自己读到的那一份」：并发刷新时
   * 另一个流程可能已经写入新凭据（轮换型服务器），此时销毁等于把刚拿到的有效
   * refresh_token 一起删掉——这正是「重启后必须重新授权」的根因。
   */
  tokenFingerprint(serverName: string): string | undefined {
    const tokens = this.file.servers[serverName]?.tokens;
    if (!tokens) return undefined;
    return `${tokens.access_token ?? ""}|${tokens.refresh_token ?? ""}`;
  }

  refreshFailure(serverName: string): { reason: string; at: number } | undefined {
    const failure = this.file.servers[serverName]?.refreshFailed;
    return failure ? { ...failure } : undefined;
  }

  markRefreshFailed(serverName: string, reason: string): void {
    this.update(serverName, { refreshFailed: { reason, at: Date.now() } });
  }

  clearRefreshFailure(serverName: string): void {
    if (!this.file.servers[serverName]?.refreshFailed) return;
    this.update(serverName, { refreshFailed: undefined });
  }
}

export interface McpOAuthProviderOptions {
  serverName: string;
  redirectUrl: string;
  store: McpAuthStore;
  /** 打开系统浏览器（main 进程 shell.openExternal）；失败只记日志。 */
  openExternal: (url: string) => void | Promise<void>;
  /** 记录/清空待授权 URL（面板「重新打开授权页」与状态展示用）。 */
  onAuthorizationUrl?: (url: string) => void;
  /**
   * 这次调用是不是用户主动发起（面板「认证」）：只有它才允许弹授权页，也只有它
   * 会把「已被标记失效」的 refresh_token 再拿出来重试一次。
   */
  isUserInitiated?: () => boolean;
  /** 失败原因（授权服务器/transport 侧记录的原文），写进标记与面板提示。 */
  failureReason?: () => string | undefined;
  /** 凭据失效处理的可观测回调（ignored=true 表示这次失效请求被指纹守卫挡下）。 */
  onTokensInvalidated?: (info: { reason?: string; ignored: boolean }) => void;
  /**
   * 凭据已被判定失效、且不是用户主动发起时，不自动弹登录页（否则每次启动都会
   * 自己开一个授权页）——把 URL 交给宿主，由面板提示 + 用户点「认证」决定。
   */
  onAuthorizationSuppressed?: (reason: string) => void;
  /** 启动期的初始同步是否还在进行（进行中不自弹授权页）。 */
  isSyncing?: () => boolean;
}

/** Build the SDK-facing OAuth client provider for one MCP server. */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): OAuthClientProvider {
  const { serverName, redirectUrl, store } = options;
  // 最近一次交给 SDK 的凭据指纹：失效请求只对它读到的那一份生效（见 tokenFingerprint）。
  let readFingerprint: string | undefined;
  return {
    get redirectUrl(): string {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "ChatAnyTime",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      };
    },
    clientInformation(): OAuthClientInformationMixed | undefined {
      const record = store.get(serverName);
      if (!record?.clientInformation) return undefined;
      // 回调端口变了 → 旧注册的 redirect_uri 不再匹配，返回 undefined 让 SDK 重新注册。
      return record.redirectUrl === redirectUrl ? record.clientInformation : undefined;
    },
    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
      store.update(serverName, { clientInformation, redirectUrl });
    },
    tokens(): OAuthTokens | undefined {
      readFingerprint = store.tokenFingerprint(serverName);
      const record = store.get(serverName);
      if (!record?.tokens) return undefined;
      // 标记为刷新失败时不交出去：交给 SDK 只会再拿同一份死 refresh_token 刷一遍，
      // 又被 invalid_grant 顶回来（而 invalid_grant 分支会再调一次 authInternal，
      // 始终返回同一份就会无限重试）。用户主动「认证」时由控制器先清掉标记
      // 放开一次重试，失败则重新标记并改走浏览器授权。
      if (record.refreshFailed) return undefined;
      return record.tokens;
    },
    saveTokens(tokens: OAuthTokens): void {
      // 拿到新凭据即恢复可用（清掉失败标记与面板文案）。
      store.update(serverName, { tokens, refreshFailed: undefined });
    },
    saveCodeVerifier(codeVerifier: string): void {
      store.update(serverName, { codeVerifier });
    },
    codeVerifier(): string {
      const verifier = store.get(serverName)?.codeVerifier;
      if (!verifier) throw new Error("缺少 PKCE code verifier，请重新发起认证");
      return verifier;
    },
    saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
      store.update(serverName, { discoveryState });
    },
    discoveryState(): OAuthDiscoveryState | undefined {
      return store.get(serverName)?.discoveryState;
    },
    state(): string {
      const value = randomBytes(16).toString("hex");
      store.update(serverName, { state: value });
      return value;
    },
    invalidateCredentials(scope): void {
      if (scope === "all") {
        store.clear(serverName);
        return;
      }
      if (scope === "client") store.update(serverName, { clientInformation: undefined, redirectUrl: undefined });
      else if (scope === "tokens") {
        // 指纹守卫：存档已不是这次失败流程读到的那一份（并发刷新的赢家刚写入新
        // 凭据）→ 拒绝销毁，否则会把有效的 refresh_token 一起删掉。
        const current = store.tokenFingerprint(serverName);
        if (readFingerprint !== undefined && current !== undefined && current !== readFingerprint) {
          options.onTokensInvalidated?.({ ignored: true });
          return;
        }
        // 真失败：保留凭据只做标记（用户下次点「认证」还能拿它重试一次）。
        const reason = options.failureReason?.() ?? "刷新令牌被授权服务器拒绝（invalid_grant）";
        store.markRefreshFailed(serverName, reason);
        options.onTokensInvalidated?.({ reason, ignored: false });
      } else if (scope === "verifier") store.update(serverName, { codeVerifier: undefined });
      else store.update(serverName, { discoveryState: undefined });
    },
    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      // 两种情况下不自动弹授权页：凭据已被判失效（避免「刷新失败 → 又开一个授权页」
      // 的反复打扰），或正处于连接同步中（避免每次开机弹一个浏览器窗口）。都交给面板
      // 提示，由用户点「认证」拿回授权。用户主动「认证」与首次连接（本就该走授权）
      // 照常弹页面。
      const failure = store.refreshFailure(serverName);
      if (!options.isUserInitiated?.() && (failure || options.isSyncing?.())) {
        options.onAuthorizationSuppressed?.(failure?.reason ?? "需要重新登录授权");
        return;
      }
      options.onAuthorizationUrl?.(authorizationUrl.toString());
      await options.openExternal(authorizationUrl.toString());
    }
  };
}

export interface McpOAuthCallbackRequest {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

function callbackPage(ok: boolean, message: string): string {
  const accent = ok ? "#2bd48f" : "#e5484d";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ChatAnyTime MCP 授权</title>`
    + `<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.6 system-ui,"Segoe UI",sans-serif;background:#f6f7f9;color:#1f2328}`
    + `@media (prefers-color-scheme:dark){body{background:#16181d;color:#e6e8eb}}`
    + `main{max-width:420px;padding:28px 32px;border-radius:12px;background:light-dark(#fff,#22252b);box-shadow:0 8px 28px rgb(0 0 0 / 12%)}`
    + `h1{margin:0 0 8px;font-size:16px;color:${accent}}p{margin:0;color:inherit;opacity:.78}</style></head>`
    + `<body><main><h1>${ok ? "授权成功" : "授权失败"}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

/** Loopback OAuth callback server (single instance for the whole app). */
export class McpOAuthCallbackServer {
  private server?: Server;
  private port?: number;
  private handler?: (request: McpOAuthCallbackRequest) => Promise<{ ok: boolean; message: string }>;

  get redirectUrl(): string | undefined {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}/callback`;
  }

  get listeningPort(): number | undefined {
    return this.port;
  }

  /** 启动并返回实际端口；首选端口被占用时退避到系统随机端口。 */
  async start(preferredPort: number, handler: (request: McpOAuthCallbackRequest) => Promise<{ ok: boolean; message: string }>): Promise<number> {
    if (this.server) return this.port!;
    this.handler = handler;
    for (const candidate of [preferredPort, 0]) {
      try {
        this.port = await this.listen(candidate);
        return this.port;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || candidate === 0) throw error;
      }
    }
    throw new Error("无法启动 MCP OAuth 回调服务器");
  }

  private listen(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => { void this.onRequest(request, response); });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        server.on("error", () => { /* 回调期间的连接错误不影响主流程 */ });
        // 不让回调监听阻止进程退出（应用退出时由 dispose 关闭）。
        server.unref();
        this.server = server;
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  private async onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const result = this.handler
      ? await this.handler({
        ...(url.searchParams.get("code") ? { code: url.searchParams.get("code")! } : {}),
        ...(url.searchParams.get("state") ? { state: url.searchParams.get("state")! } : {}),
        ...(url.searchParams.get("error") ? { error: url.searchParams.get("error")! } : {}),
        ...(url.searchParams.get("error_description") ? { errorDescription: url.searchParams.get("error_description")! } : {})
      })
      : { ok: false, message: "授权会话已失效" };
    response.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(callbackPage(result.ok, result.message));
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 需要 finishAuth 的 transport 最小接口（测试可注入假实现）。 */
export interface McpOAuthTransport {
  finishAuth(authorizationCode: string): Promise<void>;
}

interface PendingAuthorization {
  authorizationUrl?: string;
  /**
   * 本次授权流的 state 与 PKCE code verifier 快照。SDK 的 authInternal 在
   * `redirectToAuthorization` **之前**就把 state/codeVerifier 写进凭据库，所以一次
   * 并发的 auth()（同步期的刷新重连、另一台 server 的授权）会把库里的值改成它自己的；
   * 回调必须按「发起这次授权的那个流程」来校验与兑换，否则用户浏览器里那个
   * 授权页会在完成瞬间变成「state 不匹配」的废页。
   */
  state?: string;
  codeVerifier?: string;
  timer?: NodeJS.Timeout;
}

export interface McpOAuthControllerDeps {
  /** 凭据文件路径（惰性求值，agentDir 在 initialize 后才确定）。 */
  storePath: () => string;
  /** 可注入的凭据库（缺省按 storePath 新建）；测试用它预置「已存在凭据」的起始状态。 */
  store?: McpAuthStore;
  openExternal: (url: string) => void | Promise<void>;
  /** finishAuth 成功后重连并刷新资源目录。 */
  onAuthorized: (serverName: string) => Promise<void>;
  /**
   * 授权状态在命令流之外变化（等待超时、回调 finishAuth 失败）时通知——
   * utility 借此重推资源目录，设置面板不会停留在「等待浏览器授权…」。
   */
  onAuthStateChanged?: () => void;
  log?: (message: string) => void;
  pendingTimeoutMs?: number;
}

/**
 * OAuth 生命周期控制器：为 HTTP server 提供 provider、维护「待授权」窗口、
 * 处理浏览器回调并触发重连。所有外部依赖注入，便于单测。
 */
export class McpOAuthController {
  private readonly store: McpAuthStore;
  private readonly callback = new McpOAuthCallbackServer();
  private readonly providers = new Map<string, { provider: OAuthClientProvider; redirectUrl: string }>();
  private readonly transports = new Map<string, McpOAuthTransport>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly failures = new Map<string, string>();
  /**
   * 每个 server 的刷新单飞：同一时刻只允许一次 refresh（或注册）在飞，并发的
   * 401 共享同一个 Promise。上游 SDK 1.30 的 auth() 没有并发去重，两次 401
   * 会各自拿磁盘上同一个 refresh_token 去刷——轮换型服务器（Exa 等）判定为重放，
   * 撤销整个令牌族，这就是「每次重启都要重新授权」的直接原因。
   */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** 正在进行的连接同步轮数（同步期间不自动弹授权页）。 */
  private activeSyncs = 0;
  /** 当前是否处于用户主动发起的授权调用内（中间件据此决定要不要弹授权页）。 */
  private readonly userInitiated = new Set<string>();
  private readonly lastRefreshError = new Map<string, string>();
  /** 本 server 上一轮授权页被抑制过（用于把「没开浏览器」与「没有元数据」区分开）。 */
  private readonly suppressed = new Set<string>();
  private ready?: Promise<string>;

  constructor(private readonly deps: McpOAuthControllerDeps) {
    this.store = deps.store ?? new McpAuthStore(deps.storePath);
  }

  /** 回调地址（未就绪时 undefined）：授权 URL/回调测试与「重新打开授权页」都要用。 */
  get callbackUrl(): string | undefined {
    return this.callback.redirectUrl;
  }

  /** 该 server 是否走 OAuth（HTTP 且未使用 Bearer 环境变量；bearer 优先）。 */
  supports(server: ConfiguredMcpServer | McpServerConfigEntry): boolean {
    const entry = "entry" in server ? server.entry : server;
    return Boolean(entry.url) && !entry.command && !entry.bearerTokenEnv;
  }

  /** 启动回调服务器并确定 redirectUrl（幂等；失败后下次调用会重试）。 */
  async ensureReady(): Promise<string> {
    if (this.ready) return this.ready;
    this.ready = this.callback.start(this.store.redirectPort ?? DEFAULT_MCP_CALLBACK_PORT, (request) => this.handleCallback(request))
      .then((port) => {
        this.store.setRedirectPort(port);
        this.deps.log?.(`MCP OAuth 回调服务器已就绪：http://127.0.0.1:${port}/callback`);
        return this.callback.redirectUrl!;
      })
      .catch((error) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }

  /** 同一时间只有一个 flow 能跑：后来的调用等前一个结束（共享结果）。 */
  private runExclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.inflight.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.inflight.set(key, next);
    void next.catch(() => undefined).finally(() => {
      if (this.inflight.get(key) === next) this.inflight.delete(key);
    });
    return next;
  }

  /**
   * 同一 server 上**所有会触网、可能触发 OAuth 刷新的活动**共用的一把锁：SDK 的
   * auth()、finishAuth、主动刷新，以及 MCP 连接/列工具/工具调用这些「发送本身」。
   *
   * 为什么必须共锁：SDK 的 StreamableHTTPClientTransport 在 401 时自己调 `auth()`
   * （不经过我们的任何入口），轮换型授权服务器上一次并发刷新就会被判为重放并撤销
   * 整个令牌族。只有把所有可能发出刷新请求的路径串到同一把锁上，才能保证
   * 「同一个 refresh_token 绝不被并发使用」。锁序恒为单锁，无环。
   */
  runExclusiveAuth<T>(serverName: string, run: () => Promise<T>): Promise<T> {
    return this.runExclusive(`auth:${serverName}`, run);
  }

  /**
   * 工具调用前的「到期即刷新」闸门：access token 已过期时，在 per-server 单飞段里
   * 刷一次再放行；未过期（或无法判断有效期）时直接放行。
   *
   * 为什么必须做在发送前：SDK 的 StreamableHTTPClientTransport 在 401 时自己调
   * `auth()`，而它没有并发去重——模型一条消息里并行调用同一 server 的两个工具，
   * 两个 401 会各拿磁盘上同一个 refresh_token 去刷，轮换型服务器判为重放并撤销
   * 整个令牌族（本地凭据虽然有指纹守卫兜住，但服务器侧已经失效，下次仍要重新授权）。
   * 串行地把刷新提前到发送前，第二个调用进来时拿到的是刚刷好的 token，不再触发刷新。
   */
  /**
   * 到期即刷新的实现体（**不取锁**）：调用方必须已经持有该 server 的 auth 锁
   * （见 runExclusiveAuth 注释）。刻意不提供「自己取锁」的包装——runExclusive
   * 不可重入，一个能在锁内误用的入口迟早会自锁。
   */
  async refreshIfExpiredLocked(serverName: string, url: string | undefined, provider: OAuthClientProvider): Promise<void> {
    if (!url) return;
    const accessToken = (await provider.tokens())?.access_token;
    if (!accessToken || !isAccessTokenExpired(accessToken)) return;
    try {
      // 进入锁之后再判断一次：持锁期间前一个调用可能已经刷好了。
      const current = (await provider.tokens())?.access_token;
      if (!current || !isAccessTokenExpired(current)) return;
      // 带超时：token 端点挂起时不能把工具调用拖到 undici 的默认超时（分钟级）。
      await this.callWithDiagnostics(serverName, () => withTimeout(auth(provider, { serverUrl: url }), REFRESH_TIMEOUT_MS));
    } catch {
      // 这是一次「提前刷新」的优化：失败不改变行为——照原样把请求发出去，
      // 由 SDK 的 401 路径（刷新或交互式授权）处理。
    }
  }

  /** 为 HTTP server 建 provider；回调服务器尚未就绪时返回 undefined（按无认证连接）。 */
  providerFor(server: ConfiguredMcpServer): OAuthClientProvider | undefined {
    if (!this.supports(server)) return undefined;
    const redirectUrl = this.callback.redirectUrl;
    if (!redirectUrl) return undefined;
    const cached = this.providers.get(server.name);
    if (cached && cached.redirectUrl === redirectUrl) return cached.provider;
    const provider = createMcpOAuthProvider({
      serverName: server.name,
      redirectUrl,
      store: this.store,
      openExternal: this.deps.openExternal,
      failureReason: () => this.lastRefreshError.get(server.name),
      isUserInitiated: () => this.userInitiated.has(server.name),
      isSyncing: () => this.activeSyncs > 0,
      onTokensInvalidated: ({ reason, ignored }) => {
        // 看不到失败原因就没法定位——这是「面板只显示 Unauthorized」的修根。
        // 指纹守卫挡下时静默返回：并发刷新的赢家已写入新凭据，没有任何事发生。
        if (ignored) return;
        this.deps.log?.(`MCP 刷新令牌失效（已保留凭据供重试）：${server.name} — ${reason ?? "原因未知"}`);
      },
      onAuthorizationSuppressed: (reason) => {
        this.suppressed.add(server.name);
        this.failures.set(server.name, `需重新授权：${reason}`);
        this.deps.log?.(`MCP 需重新授权：${server.name}（已保留凭据，请在设置页点击「认证」）`);
        this.deps.onAuthStateChanged?.();
      },
      onAuthorizationUrl: (url) => {
        const entry = this.pending.get(server.name) ?? {};
        entry.authorizationUrl = url;
        // 抓下本次流程的 state/verifier（此刻库里就是它的），回调时按快照校验与兑换。
        const snapshot = this.store.get(server.name);
        if (snapshot?.state) entry.state = snapshot.state;
        if (snapshot?.codeVerifier) entry.codeVerifier = snapshot.codeVerifier;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.expirePending(server.name), this.deps.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS);
        entry.timer.unref?.();
        this.pending.set(server.name, entry);
        this.failures.delete(server.name);
      }
    });
    this.providers.set(server.name, { provider, redirectUrl });
    return provider;
  }

  /** 登记 transport，回调时用它 finishAuth。 */
  registerTransport(serverName: string, transport: McpOAuthTransport): void {
    this.transports.set(serverName, transport);
  }

  authStateOf(serverName: string): McpAuthState {
    if (this.pending.has(serverName)) return "pending";
    // 凭据还在（保留未删）但已被标记刷新失败：面板应显示可重试的失败而不是
    // 「已授权」——否则用户看不到需要重新认证的原因。
    if (this.store.refreshFailure(serverName)) return "failed";
    if (this.store.hasTokens(serverName)) return "authorized";
    return "idle";
  }

  /**
   * 失败说明（展示在列表行下方）：授权流程自己的失败优先，否则回退到「保留的
   * 凭据曾被拒绝」的原文——以前这里只显示一句 Unauthorized，看不到 invalid_grant。
   */
  authErrorOf(serverName: string): string | undefined {
    const recorded = this.failures.get(serverName) ?? this.store.refreshFailure(serverName)?.reason;
    if (recorded) return recorded;
    // 连接最终报「需认证」但没人记录过原因：给一句可执行的兜底，而不是笼统的
    // Unauthorized。区分「本来就没授权过」与「凭据失效」，两者该做的事不同。
    return this.store.hasTokens(serverName)
      ? "凭据已失效，请在设置页点击「认证」重新授权"
      : "尚未授权，请在设置页点击「认证」完成登录";
  }

  /**
   * 同步开始/结束的登记：同步期间不自动弹授权页——启动时每次开机都弹一个
   * 浏览器窗口太打扰，改为面板提示 + 用户点「认证」。用计数而不是集合：并发的
   * sync 会交叠，集合的 delete 会把另一条还在跑的 sync 的标记一起去掉。
   */
  beginSync(): void {
    this.activeSyncs += 1;
    // 失败原因只在本轮同步内有意义：不清掉的话，401 驱动的失效可能拿到上一轮
    // 无关的旧错误文案当原因（会误导排查）。
    this.lastRefreshError.clear();
  }

  endSync(): void {
    this.activeSyncs = Math.max(0, this.activeSyncs - 1);
  }

  hasPending(serverName: string): boolean {
    return this.pending.has(serverName);
  }

  pendingAuthorizationUrl(serverName: string): string | undefined {
    return this.pending.get(serverName)?.authorizationUrl;
  }

  /** 已有待授权 URL 时重新打开浏览器；返回是否处理了。 */
  async reopenAuthorization(serverName: string): Promise<boolean> {
    const url = this.pendingAuthorizationUrl(serverName);
    if (!url) return false;
    await this.deps.openExternal(url);
    return true;
  }

  /**
   * 主动发起授权（不等 401）：用于显式 `auth: "oauth"` 的 server。走 SDK 的
   * `auth()`（RFC 9728 发现 + 动态注册 + PKCE）——无凭据时打开浏览器并返回
   * "pending"，已有可用（或刚刷新）的 token 时返回 "authorized"。
   *
   * 用户主动点「认证」是唯一允许复用「已被标记失效」的 refresh_token 的入口：
   * 试一次，不行就走完整的浏览器授权（旧行为是直接删掉凭据，永久失去重试机会）。
   */
  async beginAuthorization(server: ConfiguredMcpServer): Promise<"pending" | "authorized"> {
    const provider = this.providerFor(server);
    const url = server.entry.url;
    if (!provider || !url) throw new Error("该 MCP Server 不支持 OAuth（仅 HTTP 且未使用 Bearer 环境变量）");
    return await this.runExclusiveAuth(server.name, async () => {
      this.suppressed.delete(server.name);
      const result = await this.callWithDiagnostics(server.name, () => auth(provider, { serverUrl: url }));
      if (result === "AUTHORIZED") return "authorized";
      if (this.suppressed.has(server.name)) {
        // 授权页被策略抑制（自动路径、凭据已判失效）：不是元数据缺失，别报错误导。
        this.suppressed.delete(server.name);
        throw new Error("需要重新登录授权，请点击「认证」用浏览器完成授权");
      }
      if (!this.pending.has(server.name)) throw new Error("服务器未提供 OAuth 元数据，无法发起授权");
      return "pending";
    });
  }

  /**
   * 用户主动「认证」时的入口：先清掉失败标记，让保留的 refresh_token 能被拿出来
   * 真试一次（成功即直接恢复，无需再走浏览器）；失败会被重新标记，SDK 随后自动
   * 转成完整的浏览器授权——这正是「用户点了认证就应该拿到授权页」的语义。
   *
   * 公开给未显式声明 `auth: "oauth"` 的 server：它们的授权是 401 驱动的，重连流程
   * 在 runtime 里，需要借用同一道闸门才能重试保留的凭据。
   */
  runUserInitiated<T>(serverName: string, run: () => Promise<T>): Promise<T> {
    this.store.clearRefreshFailure(serverName);
    this.userInitiated.add(serverName);
    return run().finally(() => this.userInitiated.delete(serverName));
  }

  /**
   * 用户主动发起授权（面板「认证」）：与 beginAuthorization 同路，但额外开启
   * 「允许重试保留凭据」的闸门，并在结束时收起。
   */
  async authorizeInteractive(server: ConfiguredMcpServer): Promise<"pending" | "authorized"> {
    return await this.runUserInitiated(server.name, () => this.beginAuthorization(server));
  }

  /**
   * 跑一次 SDK 授权编排，把异常原文留下再抛出去：上游 `auth()` 的 invalid_grant
   * 分支只有一句 console.warn，不回传原因，utility 看不到就无从展示。
   */
  private async callWithDiagnostics<T>(serverName: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      this.lastRefreshError.delete(serverName);
      return result;
    } catch (error) {
      this.lastRefreshError.set(serverName, errorText(error));
      throw error;
    }
  }

  /** 清除凭据（token + 客户端注册信息），下次连接会重新走授权。 */
  async clear(serverName: string): Promise<void> {
    this.dropPending(serverName);
    this.failures.delete(serverName);
    this.lastRefreshError.delete(serverName);
    this.transports.delete(serverName);
    this.userInitiated.delete(serverName);
    this.store.clear(serverName);
  }

  private dropPending(serverName: string): void {
    const entry = this.pending.get(serverName);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(serverName);
  }

  private expirePending(serverName: string): void {
    if (!this.pending.has(serverName)) return;
    this.dropPending(serverName);
    this.deps.log?.(`MCP 授权等待超时：${serverName}，请重新点击「认证」`);
    this.deps.onAuthStateChanged?.();
  }

  private async handleCallback(request: McpOAuthCallbackRequest): Promise<{ ok: boolean; message: string }> {
    if (request.error) return { ok: false, message: `授权被拒绝：${request.error}${request.errorDescription ? `（${request.errorDescription}）` : ""}` };
    if (!request.code) return { ok: false, message: "回调缺少 code 参数" };
    if (!request.state) return { ok: false, message: "回调缺少 state 参数，无法确认授权来源" };
    // 按「发起时的快照」匹配，而不是库里的当前值：并发 auth() 会覆写库中的 state。
    const match = [...this.pending.keys()].find((name) => {
      const entry = this.pending.get(name);
      return entry?.state === request.state || this.store.get(name)?.state === request.state;
    });
    if (!match) return { ok: false, message: "回调 state 不匹配（授权页可能已过期），请重新点击「认证」" };
    // 回调发生在授权流之外，同样要进 per-server 单飞：避免与在飞的刷新/重连抢同一份凭据。
    // verifier 的还原必须在闸门内做（见 finishCallback 开头），否则还原与兑换之间会被
    // 并发 auth 流再次覆写。
    return await this.runExclusiveAuth(match, () => this.finishCallback(match, request));
  }

  private async finishCallback(match: string, request: McpOAuthCallbackRequest): Promise<{ ok: boolean; message: string }> {
    // 已在闸门内：此刻没有其他 auth 流在写，把 codeVerifier 换回本次流程自己的那份
    // （并发 auth() 会把它覆写成新流程的，导致 PKCE 校验失败、授权页变废页）。
    const pending = this.pending.get(match);
    if (pending?.codeVerifier && this.store.get(match)?.codeVerifier !== pending.codeVerifier) {
      this.store.update(match, { codeVerifier: pending.codeVerifier });
    }
    const transport = this.transports.get(match);
    if (!transport) return { ok: false, message: "授权会话已失效，请重新点击「认证」" };
    try {
      await transport.finishAuth(request.code!);
    } catch (error) {
      this.dropPending(match);
      this.failures.set(match, errorText(error));
      this.deps.log?.(`MCP 授权失败：${match} — ${errorText(error)}`);
      this.deps.onAuthStateChanged?.();
      return { ok: false, message: `授权失败：${errorText(error)}` };
    }
    this.dropPending(match);
    this.failures.delete(match);
    this.deps.log?.(`MCP 授权成功：${match}`);
    // 重连/注册工具是异步收尾，回调页面不等待（否则浏览器要多等一个 MCP 往返）。
    void this.deps.onAuthorized(match).catch((error) => this.deps.log?.(`MCP 授权后重连失败：${match} — ${errorText(error)}`));
    return { ok: true, message: "已获得访问令牌，可以关闭此窗口，回到 ChatAnyTime 继续使用。" };
  }

  async dispose(): Promise<void> {
    for (const name of [...this.pending.keys()]) this.dropPending(name);
    this.transports.clear();
    await this.callback.close();
  }
}
