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
}

export interface McpOAuthProviderOptions {
  serverName: string;
  redirectUrl: string;
  store: McpAuthStore;
  /** 打开系统浏览器（main 进程 shell.openExternal）；失败只记日志。 */
  openExternal: (url: string) => void | Promise<void>;
  /** 记录/清空待授权 URL（面板「重新打开授权页」与状态展示用）。 */
  onAuthorizationUrl?: (url: string) => void;
}

/** Build the SDK-facing OAuth client provider for one MCP server. */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): OAuthClientProvider {
  const { serverName, redirectUrl, store } = options;
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
      return store.get(serverName)?.tokens;
    },
    saveTokens(tokens: OAuthTokens): void {
      store.update(serverName, { tokens });
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
      else if (scope === "tokens") store.update(serverName, { tokens: undefined });
      else if (scope === "verifier") store.update(serverName, { codeVerifier: undefined });
      else store.update(serverName, { discoveryState: undefined });
    },
    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
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
  timer?: NodeJS.Timeout;
}

export interface McpOAuthControllerDeps {
  /** 凭据文件路径（惰性求值，agentDir 在 initialize 后才确定）。 */
  storePath: () => string;
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
  private ready?: Promise<string>;

  constructor(private readonly deps: McpOAuthControllerDeps) {
    this.store = new McpAuthStore(deps.storePath);
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
      onAuthorizationUrl: (url) => {
        const entry = this.pending.get(server.name) ?? {};
        entry.authorizationUrl = url;
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
    if (this.store.hasTokens(serverName)) return "authorized";
    return "idle";
  }

  /** 上一次授权失败的说明（展示在列表行下方）。 */
  authErrorOf(serverName: string): string | undefined {
    return this.failures.get(serverName);
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
   */
  async beginAuthorization(server: ConfiguredMcpServer): Promise<"pending" | "authorized"> {
    const provider = this.providerFor(server);
    const url = server.entry.url;
    if (!provider || !url) throw new Error("该 MCP Server 不支持 OAuth（仅 HTTP 且未使用 Bearer 环境变量）");
    const result = await auth(provider, { serverUrl: url });
    if (result === "AUTHORIZED") return "authorized";
    if (!this.pending.has(server.name)) throw new Error("服务器未提供 OAuth 元数据，无法发起授权");
    return "pending";
  }

  /** 清除凭据（token + 客户端注册信息），下次连接会重新走授权。 */
  async clear(serverName: string): Promise<void> {
    this.dropPending(serverName);
    this.failures.delete(serverName);
    this.transports.delete(serverName);
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
    const match = [...this.pending.keys()].find((name) => this.store.get(name)?.state === request.state);
    if (!match) return { ok: false, message: "回调 state 不匹配（授权页可能已过期），请重新点击「认证」" };
    const transport = this.transports.get(match);
    if (!transport) return { ok: false, message: "授权会话已失效，请重新点击「认证」" };
    try {
      await transport.finishAuth(request.code);
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
