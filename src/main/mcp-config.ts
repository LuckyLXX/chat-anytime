import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import stripJsonComments from "strip-json-comments";

export interface McpServerConfigEntry {
  command?: string;
  args?: string[];
  url?: string;
  auth?: "oauth";
  bearerTokenEnv?: string;
  env?: Record<string, string>;
}

type JsonRecord = Record<string, unknown>;

function readConfig(filePath: string): JsonRecord {
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(filePath, "utf8"), { trailingCommas: true }));
  } catch (error) {
    throw new Error(`MCP 配置无法解析：${filePath}，请先修复 JSON 格式。${error instanceof Error ? ` ${error.message}` : ""}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP 配置根节点必须是对象：${filePath}`);
  }
  return parsed as JsonRecord;
}

function readServers(config: JsonRecord): { key: "mcpServers" | "mcp-servers"; servers: Record<string, unknown> } {
  const key = config.mcpServers !== undefined ? "mcpServers" : config["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers";
  const value = config[key];
  if (value === undefined) return { key, servers: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP 配置中的 ${key} 必须是对象`);
  }
  return { key, servers: { ...(value as Record<string, unknown>) } };
}

function writeConfig(filePath: string, config: JsonRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

export function upsertMcpServerConfig(filePath: string, name: string, entry: McpServerConfigEntry): void {
  const config = readConfig(filePath);
  const { key, servers } = readServers(config);
  servers[name] = entry;
  config[key] = servers;
  if (key === "mcpServers") delete config["mcp-servers"];
  writeConfig(filePath, config);
}

