// MCP capability cluster extracted from pi-runtime.ts: config path
// resolution, draft→entry validation, and the sync core that connects to all
// configured servers and rebuilds the Pi customTool definitions. The
// session-scoped tool-set orchestration (hot reload vs rebuild) stays in
// pi-runtime.

import { join, resolve } from "node:path";
import type { McpServerSummary, McpServerConfigDraft } from "../shared/protocol.js";
import { McpClientManager } from "./mcp-client.js";
import { readConfiguredMcpServers, type McpServerConfigEntry } from "./mcp-config.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function mcpConfigPathsFor(workspace: string | undefined, agentDir: string): { project: string; global: string } {
  return {
    project: workspace ? resolve(workspace, ".mcp.json") : join(agentDir, ".mcp.json"),
    global: join(agentDir, "mcp.json")
  };
}

/** Validate an MCP server draft from the UI and convert it to a config entry. */
export function mcpConfigEntry(server: McpServerConfigDraft): McpServerConfigEntry {
  if (server.transport === "stdio") {
    const command = server.command?.trim();
    if (!command) throw new Error("stdio MCP Server 需要填写启动命令");
    return {
      command,
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {})
    };
  }
  const url = server.url?.trim();
  if (!url || !/^https?:\/\//iu.test(url)) throw new Error("HTTP MCP Server 需要填写 http:// 或 https:// 地址");
  if (server.auth === "bearer-env" && !server.bearerTokenEnv?.trim()) throw new Error("Bearer 认证需要填写环境变量名");
  return {
    url,
    ...(server.auth === "oauth" ? { auth: "oauth" as const } : {}),
    ...(server.auth === "bearer-env" ? { bearerTokenEnv: server.bearerTokenEnv!.trim() } : {})
  };
}

/** Connect to all configured MCP servers and rebuild tool definitions. */
export async function syncMcpServers(client: McpClientManager, paths: { project: string; global: string }, refresh: boolean): Promise<{ summaries: McpServerSummary[]; tools: ToolDefinition[] }> {
  const servers = readConfiguredMcpServers(paths.project, paths.global);
  const { summaries, bindings } = await client.sync(servers, { refresh });
  return { summaries, tools: client.buildToolDefinitions(bindings) };
}
