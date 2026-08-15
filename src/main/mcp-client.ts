import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { McpServerSummary } from "../shared/protocol.js";
import type { ConfiguredMcpServer, McpServerConfigEntry } from "./mcp-config.js";

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

function createTransport(entry: McpServerConfigEntry): StdioClientTransport | StreamableHTTPClientTransport {
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
    return new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } });
  }
  throw new Error("MCP 配置缺少 command（stdio）或 url（HTTP）");
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

  /**
   * Reconcile live connections with the given servers; returns status + tool
   * bindings. Steady state (connection alive, hash unchanged, tools cached)
   * is served from cache with zero network, so session switches never block
   * on remote MCP servers. Pass `{ refresh: true }` to force a fresh
   * connect/listTools roundtrip (config changes, explicit reloads).
   */
  async sync(servers: ConfiguredMcpServer[], options?: { refresh?: boolean }): Promise<McpSyncResult> {
    const refresh = options?.refresh === true;
    const enabled = servers.filter((server) => !server.entry.disabled);
    const wanted = new Set(enabled.map((server) => server.name));

    for (const name of [...this.connections.keys()]) {
      if (!wanted.has(name)) await this.disconnect(name);
    }

    const summaries: McpServerSummary[] = [];
    const bindings: McpToolBinding[] = [];

    await Promise.all(servers.map(async (server) => {
      if (server.entry.disabled) {
        summaries.push({ name: server.name, status: "disabled", toolCount: 0, disabled: true });
        return;
      }
      const hash = configHash(server.entry);
      const cache = this.toolCache.get(server.name);
      const connectionMatches = this.connections.get(server.name)?.configHash === hash;
      // Fast path: nothing changed and tools are cached — no network at all.
      if (!refresh && connectionMatches && cache && cache.hash === hash) {
        bindings.push(...cache.bindings);
        summaries.push({ name: server.name, status: "connected", toolCount: cache.toolCount, disabled: false });
        return;
      }
      try {
        const fresh = await this.ensureTools(server, hash);
        bindings.push(...fresh);
        summaries.push({ name: server.name, status: "connected", toolCount: fresh.length, disabled: false });
      } catch (error) {
        // Keep serving cached bindings so a slow/unreachable server does not
        // strip previously working tools; the status still reports the failure.
        if (cache && cache.hash === hash) bindings.push(...cache.bindings);
        summaries.push({ name: server.name, status: "failed", toolCount: cache?.toolCount ?? 0, disabled: false, error: errorText(error) });
      }
    }));

    this.toolIndex.clear();
    for (const binding of bindings) {
      this.toolIndex.set(mcpToolName(binding.serverName, binding.toolName), { serverName: binding.serverName, toolName: binding.toolName });
    }
    return { summaries, bindings };
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
    const transport = createTransport(server.entry);
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
    const result = await connection.client.callTool({ name: binding.toolName, arguments: args }, undefined, { signal });
    return convertMcpResult(result);
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
