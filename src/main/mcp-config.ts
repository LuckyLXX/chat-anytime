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
  /**
   * App-owned extension of the standard `.mcp.json` format. The native MCP
   * client skips disabled servers but still lists them (greyed out) in the
   * capability panel. Standard MCP clients ignore unknown fields, so this stays
   * interoperable with `.mcp.json` files authored by other tools.
   */
  disabled?: boolean;
}

export interface ConfiguredMcpServer {
  name: string;
  entry: McpServerConfigEntry;
  scope: "project" | "global";
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

function isEntry(value: unknown): value is McpServerConfigEntry {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Merge project + global MCP configs; project entries override global on name conflict. */
export function readConfiguredMcpServers(projectConfigPath: string, globalConfigPath: string): ConfiguredMcpServer[] {
  const merged = new Map<string, ConfiguredMcpServer>();
  try {
    const globalServers = readServers(readConfig(globalConfigPath)).servers;
    for (const [name, raw] of Object.entries(globalServers)) {
      if (isEntry(raw)) merged.set(name, { name, entry: raw, scope: "global" });
    }
  } catch {
    // A missing/corrupt global config should not block project servers.
  }
  try {
    const projectServers = readServers(readConfig(projectConfigPath)).servers;
    for (const [name, raw] of Object.entries(projectServers)) {
      if (isEntry(raw)) merged.set(name, { name, entry: raw, scope: "project" });
    }
  } catch {
    // Likewise, a missing project config is normal (no `.mcp.json` yet).
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function upsertMcpServerConfig(filePath: string, name: string, entry: McpServerConfigEntry): void {
  const config = readConfig(filePath);
  const { key, servers } = readServers(config);
  servers[name] = entry;
  config[key] = servers;
  if (key === "mcpServers") delete config["mcp-servers"];
  writeConfig(filePath, config);
}

export function removeMcpServerConfig(filePath: string, name: string): boolean {
  const config = readConfig(filePath);
  const { key, servers } = readServers(config);
  if (!(name in servers)) return false;
  delete servers[name];
  config[key] = servers;
  if (key === "mcpServers") delete config["mcp-servers"];
  writeConfig(filePath, config);
  return true;
}

export function setMcpServerDisabled(filePath: string, name: string, disabled: boolean): boolean {
  const config = readConfig(filePath);
  const { key, servers } = readServers(config);
  const entry = servers[name];
  if (!isEntry(entry)) return false;
  const next: McpServerConfigEntry = { ...entry };
  if (disabled) next.disabled = true;
  else delete next.disabled;
  servers[name] = next;
  config[key] = servers;
  if (key === "mcpServers") delete config["mcp-servers"];
  writeConfig(filePath, config);
  return true;
}
