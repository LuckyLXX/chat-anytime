import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { McpServerSummary } from "../shared/protocol.js";
import type { ConfiguredMcpServer, McpServerConfigEntry } from "./mcp-config.js";
import { mcpServerConfigFields } from "./mcp-config.js";
import type { McpOAuthController } from "./mcp-oauth.js";

/**
 * Native MCP client (runs in the utility process alongside the Pi runtime).
 *
 * The previous design loaded the external `pi-mcp-adapter` Pi extension to gain
 * MCP support. That extension is gone, so this module owns the full lifecycle:
 * it connects to each configured server (stdio / streamable-HTTP), lists its
 * tools, and re-exports every tool as a Pi `customTool` named
 * `mcp__<server>__<tool>`. Server status flows back to the capability catalog.
 */

const TOOL_NAME_PREFIX = "mcp__";

/** Upper bound for a single MCP connect / tools-list operation. */
const MCP_OP_TIMEOUT_MS = 15_000;

/** Upper bound for a single MCP tool call; most servers answer well within this. */
export const MCP_CALL_TIMEOUT_MS = 120_000;

/**
 * Merge the caller's cancellation signal with a timeout signal. Node 22
 * (Electron 43) provides both AbortSignal.any and AbortSignal.timeout.
 */
export function combinedCallSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Bounded wait so a slow or unreachable server can never block session switching forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP 操作超时（${ms}ms）`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

interface McpConnection {
  client: Client;
  configHash: string;
  close: () => Promise<void>;
}

/** Cached tool bindings per server, so steady-state syncs need no network roundtrip. */
interface McpToolCacheEntry {
  hash: string;
  bindings: McpToolBinding[];
  toolCount: number;
}

export interface McpToolBinding {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
}

export interface McpSyncResult {
  summaries: McpServerSummary[];
  bindings: McpToolBinding[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function configHash(entry: McpServerConfigEntry): string {
  return JSON.stringify({
    command: entry.command,
    args: entry.args,
    url: entry.url,
    auth: entry.auth,
    bearerTokenEnv: entry.bearerTokenEnv,
    env: entry.env ? Object.keys(entry.env).sort() : undefined
  });
}

/** Pi tool name for an MCP server/tool pair. Sanitized so the model can call it. */
export function mcpToolName(serverName: string, toolName: string): string {
  const server = serverName.replace(/[^A-Za-z0-9_-]+/gu, "_");
  const tool = toolName.replace(/[^A-Za-z0-9_-]+/gu, "_");
  return `${TOOL_NAME_PREFIX}${server}__${tool}`;
}

function isObjectSchema(schema: unknown): boolean {
  return Boolean(schema) && typeof schema === "object"
    && (schema as { type?: unknown }).type === "object";
}

/**
 * Pass the MCP tool's JSON Schema through to Pi as a TypeBox schema. `Type.Unsafe`
 * keeps validation permissive (the MCP server validates on its side) while
 * preserving the raw `properties`/`required` so the model sees the real shape.
 */
export function toTypeBoxSchema(schema: unknown): TSchema {
  return isObjectSchema(schema) ? Type.Unsafe(schema as TSchema) : Type.Object({});
}

function createTransport(entry: McpServerConfigEntry, authProvider?: OAuthClientProvider): StdioClientTransport | StreamableHTTPClientTransport {
  if (entry.command) {
    // process.env values are `string | undefined`; StdioClientTransport
    // requires a flat Record<string, string>, so drop undefined entries.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    Object.assign(env, entry.env ?? {});
    return new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env
    });
  }
  if (entry.url) {
    const headers: Record<string, string> = {};
    if (entry.bearerTokenEnv) {
      const token = process.env[entry.bearerTokenEnv];
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    // Bearer 环境变量优先；否则（auth: oauth 或未知）挂 OAuth provider：
    // 公开 server 不会触发认证，401 时才走授权流程。
    return new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers },
      ...(authProvider && !entry.bearerTokenEnv ? { authProvider } : {})
    });
  }
  throw new Error("MCP 配置缺少 command（stdio）或 url（HTTP）");
}

/** 连接需要 OAuth 且尚未授权时，SDK 抛 UnauthorizedError（授权页已打开）。 */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof UnauthorizedError || (typeof error === "object" && error !== null && (error as { name?: string }).name === "UnauthorizedError");
}

export function convertMcpResult(result: unknown): AgentToolResult<unknown> {
  const content: Array<TextContent | ImageContent> = [];
  const raw = (result ?? {}) as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  if (Array.isArray(raw.content)) {
    for (const block of raw.content) {
      if (!block || typeof block !== "object") continue;
      const item = block as { type?: string; text?: string; data?: string; mimeType?: string };
      if (item.type === "text" && typeof item.text === "string") {
        content.push({ type: "text", text: item.text });
      } else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
        content.push({ type: "image", data: item.data, mimeType: item.mimeType });
      } else {
        content.push({ type: "text", text: JSON.stringify(block) });
      }
    }
  }
  if (raw.structuredContent !== undefined) {
    content.push({ type: "text", text: `structuredContent:\n${JSON.stringify(raw.structuredContent, null, 2)}` });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
  }
  if (raw.isError) {
    content.unshift({ type: "text", text: "MCP 工具返回 isError=true。" });
  }
  return { content, details: result };
}

export class McpClientManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly toolIndex = new Map<string, { serverName: string; toolName: string }>();
  private readonly toolCache = new Map<string, McpToolCacheEntry>();
  /** per-server 串行队列：同一 server 的并发 sync/connect 依次执行（见 sync 注释）。 */
  private readonly serialized = new Map<string, Promise<unknown>>();
  /** 最近一次同步看到的 server 配置（callTool 的到期刷新要回查 url / OAuth 归属）。 */
  private readonly configuredServers = new Map<string, ConfiguredMcpServer>();

  /** oauth 提供 HTTP server 的凭据/回调（utility 进程，见 mcp-oauth.ts）。 */
  constructor(private readonly options: { oauth?: McpOAuthController } = {}) {}

  /**
   * Reconcile live connections with the given servers; returns status + tool
   * bindings. Steady state (connection alive, hash unchanged, tools cached)
   * is served from cache with zero network, so session switches never block
   * on remote MCP servers. Pass `{ refresh: true }` to force a fresh
   * connect/listTools roundtrip (config changes, explicit reloads).
   */
  async sync(servers: ConfiguredMcpServer[], options?: { refresh?: boolean }): Promise<McpSyncResult> {
    const refresh = options?.refresh === true;
    for (const server of servers) this.configuredServers.set(server.name, server);
    for (const name of [...this.configuredServers.keys()]) {
      if (!servers.some((server) => server.name === name)) this.configuredServers.delete(name);
    }
    // 已移除/停用的 server 不再维持连接。断开也走 per-server 队列：否则「一条 sync 正在
    // 队列里建连、另一条 sync 因停用而直接断开」会交错，把停用的连接又装回去。
    const wanted = new Set(servers.filter((server) => !server.entry.disabled).map((server) => server.name));
    for (const name of [...this.connections.keys()]) {
      if (!wanted.has(name)) await this.runExclusive(`server:${name}`, () => this.disconnect(name));
    }

    // OAuth 回调服务器就绪后才能建 provider（redirectUrl 依赖实际端口）。
    const hasOAuthServers = Boolean(this.options.oauth) && servers.some((server) => !server.entry.disabled && this.options.oauth!.supports(server));
    if (this.options.oauth && hasOAuthServers) {
      await this.options.oauth.ensureReady();
      // 同步期间不自动弹授权页（启动时每次开机弹一个浏览器窗口太打扰）。
      this.options.oauth.beginSync();
    }

    // 串行化：同一个 server 的并发 sync 依次跑。启动会有两条都带 refresh 的 sync
    // 并发（会话创建 + 工作区切换），两条都撞 401 时会各自拿同一个 refresh_token
    // 去刷——轮换型服务器判为重放并撤销令牌族，凭据就没了。串行后后者看到的是
    // 前者刚接好的活连接（fast path 无网络），不会再刷第二次。
    // 注意：断连（syncOne 内的 refresh 分支）先于建连验证，这样排在后面的 sync
    // 一定会重新连接，不会误用上一条可能已死的连接。
    const results = new Map<string, { ok: true; bindings: McpToolBinding[] } | { ok: false; error: unknown }>();
    try {
      await Promise.all(servers.filter((server) => !server.entry.disabled).map((server) => this.runExclusive(`server:${server.name}`, async () => {
        try {
          results.set(server.name, { ok: true, bindings: await this.syncOne(server, refresh) });
        } catch (error) {
          results.set(server.name, { ok: false, error });
        }
      })));
    } finally {
      if (this.options.oauth && hasOAuthServers) this.options.oauth.endSync();
    }

    const summaries: McpServerSummary[] = [];
    const bindings: McpToolBinding[] = [];
    for (const server of servers) {
      const config = mcpServerConfigFields(server);
      const authState = this.options.oauth?.authStateOf(server.name);
      const authFields = authState ? { authState } : {};
      const outcome = results.get(server.name);
      if (server.entry.disabled) {
        summaries.push({ name: server.name, ...config, ...authFields, status: "disabled", toolCount: 0, disabled: true });
        continue;
      }
      if (!outcome) {
        summaries.push({ name: server.name, ...config, ...authFields, status: "not-connected", toolCount: 0, disabled: false });
        continue;
      }
      if (outcome.ok) {
        bindings.push(...outcome.bindings);
        summaries.push({ name: server.name, ...config, ...authFields, status: "connected", toolCount: outcome.bindings.length, disabled: false });
        continue;
      }
      const error = outcome.error;
      // Keep serving cached bindings so a slow/unreachable server does not
      // strip previously working tools; the status still reports the failure.
      const cache = this.toolCache.get(server.name);
      const hash = configHash(server.entry);
      if (cache && cache.hash === hash) bindings.push(...cache.bindings);
      const needsAuth = isUnauthorizedError(error);
      summaries.push({
        name: server.name,
        ...config,
        ...(needsAuth ? { authState: this.options.oauth?.authStateOf(server.name) ?? "idle" } : authFields),
        status: needsAuth ? "needs-auth" : "failed",
        toolCount: cache?.toolCount ?? 0,
        disabled: false,
        // 优先给 OAuth 侧记录的真实原因（invalid_grant / 令牌被撤销），
        // 否则只剩一句笼统的 Unauthorized。
        error: (needsAuth ? this.options.oauth?.authErrorOf(server.name) : undefined) ?? errorText(error)
      });
    }

    this.toolIndex.clear();
    for (const binding of bindings) {
      this.toolIndex.set(mcpToolName(binding.serverName, binding.toolName), { serverName: binding.serverName, toolName: binding.toolName });
    }
    return { summaries, bindings };
  }

  /** 同一 key 上的操作依次执行（后者等前者结束），用于避免并发重复授权。 */
  private runExclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.serialized.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.serialized.set(key, next);
    void next.catch(() => undefined).finally(() => {
      if (this.serialized.get(key) === next) this.serialized.delete(key);
    });
    return next;
  }

  /** 单个 server 的同步主体（在 per-server 串行队列里跑）。 */
  private async syncOne(server: ConfiguredMcpServer, refresh: boolean): Promise<McpToolBinding[]> {
    // 停用的 server 不做任何网络动作（重启前的旧语义）：否则「停用」开关等于失效，
    // stdio server 每次 sync 都会被拉起并保活，OAuth server 每次都被打 401。
    if (server.entry.disabled) return [];
    const hash = configHash(server.entry);
    const cache = this.toolCache.get(server.name);
    const connectionMatches = this.connections.get(server.name)?.configHash === hash;
    // Fast path: nothing changed and tools are cached — no network at all.
    if (!refresh && connectionMatches && cache && cache.hash === hash) return cache.bindings;
    // 配置变了才重连。显式 refresh 只强制重新列一次工具（沿用原语义：不无条件重连，
    // 否则每个 stdio server 都要冷启动，resources.reload 会明显变慢甚至超时）；
    // 凭据失效依然会被 401 驱动，SDK 自己走刷新/授权。
    const network = async (): Promise<McpToolBinding[]> => {
      if (!connectionMatches) await this.disconnect(server.name);
      return await this.ensureTools(server, hash);
    };
    // OAuth server 的连接/列工具段要进 auth 闸门：这一步的 401 由 SDK 内部直接调
    // auth() 刷新（不经过我们的任何入口），只有与 callTool 的刷新共用同一把锁，
    // 才能保证「同一个 refresh_token 不会在两条路径上被并发使用」。
    // 锁序恒为 server:/send: → auth:，auth: 永远最内层，不存在环。
    const oauth = this.options.oauth;
    if (oauth?.supports(server) && oauth.providerFor(server)) {
      return await oauth.runExclusiveAuth(server.name, network);
    }
    return await network();
  }

  /** Connect if needed, list tools, and refresh the per-server tool cache. */
  private async ensureTools(server: ConfiguredMcpServer, hash: string): Promise<McpToolBinding[]> {
    const list = async (): Promise<McpToolBinding[]> => {
      const connection = this.connections.get(server.name);
      if (!connection) throw new Error("MCP 连接未建立");
      const { tools } = await withTimeout(connection.client.listTools(), MCP_OP_TIMEOUT_MS);
      const bindings = tools.map((tool) => ({ serverName: server.name, toolName: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
      this.toolCache.set(server.name, { hash, bindings, toolCount: tools.length });
      return bindings;
    };
    const existing = this.connections.get(server.name);
    if (!existing || existing.configHash !== hash) {
      if (existing) await this.disconnect(server.name);
      await withTimeout(this.connect(server, hash), MCP_OP_TIMEOUT_MS);
    }
    try {
      return await list();
    } catch (error) {
      // The connection may have gone stale (server-side idle timeout).
      // Reconnect once and retry before giving up.
      await this.disconnect(server.name);
      await withTimeout(this.connect(server, hash), MCP_OP_TIMEOUT_MS);
      try {
        return await list();
      } catch {
        throw error;
      }
    }
  }

  private async connect(server: ConfiguredMcpServer, hash: string): Promise<McpConnection> {
    const authProvider = this.options.oauth?.providerFor(server);
    const transport = createTransport(server.entry, authProvider);
    // 回调时用同一个 transport finishAuth（PKCE code verifier 就在它的 provider 里）。
    if (transport instanceof StreamableHTTPClientTransport && this.options.oauth?.supports(server)) {
      this.options.oauth.registerTransport(server.name, transport);
    }
    const client = new Client({ name: "chatanytime-desktop", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    const connection: McpConnection = {
      client,
      configHash: hash,
      close: async () => {
        try { await transport.close(); } catch { /* closing twice is harmless */ }
        try { await client.close(); } catch { /* ignore */ }
      }
    };
    this.connections.set(server.name, connection);
    return connection;
  }

  private async disconnect(name: string): Promise<void> {
    // 注意：不要在这里等待该 server 的串行队列——syncOne 本身就跑在队列里，
    // 等待自己会死锁。队列保证同一 server 上不会同时出现连接与断开。
    const connection = this.connections.get(name);
    if (!connection) return;
    this.connections.delete(name);
    await connection.close();
  }

  /** Invoke the MCP tool backing a Pi customTool name. */
  async callTool(piToolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    const binding = this.toolIndex.get(piToolName);
    if (!binding) throw new Error(`未找到 MCP 工具：${piToolName}`);
    const connection = this.connections.get(binding.serverName);
    if (!connection) throw new Error(`MCP 服务器未连接：${binding.serverName}`);
    return await this.sendWithOAuthGate(binding.serverName, async (callSignal) => {
      const result = await connection.client.callTool({ name: binding.toolName, arguments: args }, undefined, { signal: callSignal });
      return convertMcpResult(result);
    }, signal, piToolName);
  }

  /**
   * OAuth server 的工具调用收进 per-server 闸门；非 OAuth server 直接放行（保持并行度）。
   *
   * 为什么连「发送」也要串行：SDK 的 StreamableHTTPClientTransport 在 401 时自己调
   * `auth()`，我们无法拦截；而当 access token 不是可解析 exp 的 JWT（opaque token、
   * 或服务器提前吊销）时，发送前的到期判断看不见它——两个并行调用会同时撞 401、
   * 各拿同一个 refresh_token 去换。把发送本身串行，第二个调用必然在第一个完成
   * 刷新与重试之后才发出，不会再出现同 token 并发的窗口。代价只落在 OAuth server 上。
   */
  private async sendWithOAuthGate(
    serverName: string,
    send: (callSignal: AbortSignal) => Promise<AgentToolResult<unknown>>,
    signal: AbortSignal | undefined,
    piToolName: string
  ): Promise<AgentToolResult<unknown>> {
    const oauth = this.options.oauth;
    const server = this.configuredServers.get(serverName);
    const gated = Boolean(oauth) && Boolean(server) && oauth!.supports(server!);
    const queuedAt = Date.now();
    let callSignal: AbortSignal | undefined;
    const attempt = async (): Promise<AgentToolResult<unknown>> => {
      // 排队等待也算在总时限里：否则同 server 上一串长调用会让后来者无限期等待。
      const waited = Date.now() - queuedAt;
      if (waited >= MCP_CALL_TIMEOUT_MS) {
        throw new Error(`MCP 工具调用排队超时（${MCP_CALL_TIMEOUT_MS}ms）：${piToolName}（同一服务器上还有未完成的调用或同步）`);
      }
      if (oauth && server) {
        const provider = oauth.providerFor(server);
        // 已在 auth 锁内，用不取锁的版本（再取一次会自锁）。
        if (provider) await oauth.refreshIfExpiredLocked(serverName, server.entry.url, provider);
      }
      // 真正的发送计时从开始发送算起：排队等待不该占用这次调用的预算。
      callSignal = combinedCallSignal(signal, MCP_CALL_TIMEOUT_MS);
      return await send(callSignal);
    };
    try {
      // 与 syncOne 的网络段共用 controller 的 auth 锁：SDK 在 401 时自己调 auth()
      // 刷新，两条路径不共锁就会拿同一个 refresh_token 并发去换。
      return gated ? await oauth!.runExclusiveAuth(serverName, attempt) : await attempt();
    } catch (error) {
      // Our timeout fired while the caller did not abort → report a hang, not a cancel.
      if (!signal?.aborted && callSignal?.aborted) {
        throw new Error(`MCP 工具调用超时（${MCP_CALL_TIMEOUT_MS}ms）：${piToolName}`);
      }
      throw error;
    }
  }

  /** Wrap discovered MCP tools as Pi customTools. */
  buildToolDefinitions(bindings: McpToolBinding[]): ToolDefinition[] {
    const seen = new Set<string>();
    const tools: ToolDefinition[] = [];
    for (const binding of bindings) {
      const name = mcpToolName(binding.serverName, binding.toolName);
      if (seen.has(name)) continue;
      seen.add(name);
      const description = binding.description || `调用 ${binding.serverName} 的 MCP 工具 ${binding.toolName}`;
      tools.push(defineTool({
        name,
        label: name,
        description,
        promptSnippet: `${name}: ${description}`,
        parameters: toTypeBoxSchema(binding.inputSchema),
        execute: async (_toolCallId, params, signal) => this.callTool(name, (params ?? {}) as Record<string, unknown>, signal)
      }));
    }
    return tools;
  }

  async dispose(): Promise<void> {
    const closing = [...this.connections.values()].map((connection) => connection.close());
    this.connections.clear();
    this.toolIndex.clear();
    this.toolCache.clear();
    await Promise.allSettled(closing);
  }
}
