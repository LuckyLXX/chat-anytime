// MCP capability cluster extracted from pi-runtime.ts: config path
// resolution, draft→entry validation, and the sync core that connects to all
// configured servers and rebuilds the Pi customTool definitions. The
// session-scoped tool-set orchestration (hot reload vs rebuild) stays in
// pi-runtime.

import { join, resolve } from "node:path";
import type { McpServerSummary, McpServerConfigDraft } from "../shared/protocol.js";
import { McpClientManager, mcpToolName, type McpToolBinding } from "./mcp-client.js";
import { readConfiguredMcpServers, readMcpServerEntry, type McpServerConfigEntry } from "./mcp-config.js";
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

/** 一次保存的落地计划：目标文件 + 合并停用态后的条目 + 需要先删的原条目。 */
export interface McpServerSavePlan {
  targetPath: string;
  entry: McpServerConfigEntry;
  remove?: { path: string; name: string };
}

/**
 * Plan an MCP server save from the settings form. `original` is the entry's
 * position before editing (name/scope): a scope switch moves the entry to the
 * other config file instead of leaving a duplicate behind (project wins on a
 * name clash, so a stale copy would silently shadow the edit), and the disabled
 * flag travels with the entry so editing never re-enables a paused server.
 */
export function planMcpServerSave(
  paths: { project: string; global: string },
  draft: McpServerConfigDraft,
  original?: { name: string; scope: "project" | "global" }
): McpServerSavePlan {
  const name = draft.name.trim();
  const targetPath = draft.scope === "project" ? paths.project : paths.global;
  const previousName = original?.name.trim();
  const previousPath = original ? (original.scope === "project" ? paths.project : paths.global) : undefined;
  const moving = Boolean(previousName && previousPath && (previousPath !== targetPath || previousName !== name));
  const previous = readMcpServerEntry(targetPath, name) ?? (moving ? readMcpServerEntry(previousPath!, previousName!) : undefined);
  const entry = mcpConfigEntry({ ...draft, name });
  return {
    targetPath,
    entry: previous?.disabled ? { ...entry, disabled: true } : entry,
    ...(moving ? { remove: { path: previousPath!, name: previousName! } } : {})
  };
}

/** Connect to all configured MCP servers and rebuild tool definitions. */
export async function syncMcpServers(client: McpClientManager, paths: { project: string; global: string }, refresh: boolean): Promise<{ summaries: McpServerSummary[]; tools: ToolDefinition[]; serverToolNames: Map<string, string[]> }> {
  const servers = readConfiguredMcpServers(paths.project, paths.global);
  const { summaries, bindings } = await client.sync(servers, { refresh });
  return { summaries, tools: client.buildToolDefinitions(bindings), serverToolNames: serverToolNamesFrom(bindings) };
}

/**
 * 服务器→Pi 工具名的映射（角色级 mcp:<server> overlay 的消费依据）：键为配置
 * 原始服务器名（与 toolOverrides 键一致，不做 sanitize），值为经 mcpToolName()
 * 生成的完整工具名。去重规则与 buildToolDefinitions 同源（同名跳过）。
 */
export function serverToolNamesFrom(bindings: readonly McpToolBinding[]): Map<string, string[]> {
  const seen = new Set<string>();
  const map = new Map<string, string[]>();
  for (const binding of bindings) {
    const name = mcpToolName(binding.serverName, binding.toolName);
    if (seen.has(name)) continue;
    seen.add(name);
    const names = map.get(binding.serverName);
    if (names) names.push(name);
    else map.set(binding.serverName, [name]);
  }
  return map;
}
