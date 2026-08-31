// 自定义子智能体定义读写：双作用域 JSON（项目 <workspace>/.pidesktop-subagents.json
// 覆盖全局 <agentDir>/pidesktop-subagents.json，按 id 合并），模式与 hooks-config.ts
// / mcp-config.ts 一致（tmp/rename 原子写、坏文件只影响所在作用域）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUILTIN_TOOLS, defaultToolEnabled } from "./settings.js";
import type { BuiltinToolName, SubagentDefinition, SubagentScope } from "../shared/protocol.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验 + 归一化一条子智能体定义；不合格抛中文错误（面板直接展示）。 */
export function normalizeSubagent(value: unknown): SubagentDefinition {
  if (!isRecord(value)) throw new Error("子智能体定义必须是对象");
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) throw new Error("子智能体 id 不能为空");
  if (id.length > 64) throw new Error("子智能体 id 过长（最多 64 字符）");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) throw new Error("子智能体名称不能为空");
  if (name.length > 64) throw new Error("子智能体名称过长（最多 64 字符）");
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt.trim() : "";
  if (!systemPrompt) throw new Error("子智能体系统提示词不能为空");
  if (systemPrompt.length > 20_000) throw new Error("子智能体系统提示词过长（最多 20000 字符）");
  const scope: SubagentScope = value.scope === "project" ? "project" : "global";
  const model = isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.id === "string" && value.model.provider.trim() && value.model.id.trim()
    ? { provider: value.model.provider.trim(), id: value.model.id.trim() }
    : undefined;
  const color = typeof value.color === "string" && value.color.trim() ? value.color.trim() : undefined;
  const injectAgentsMd = value.injectAgentsMd === true;
  // tools: "inherit" 原样保留；否则归一化到完整的 BuiltinToolName 启停表。
  let tools: SubagentDefinition["tools"];
  if (value.tools === "inherit") {
    tools = "inherit";
  } else if (isRecord(value.tools)) {
    const sourceTools = value.tools as Record<string, unknown>;
    tools = Object.fromEntries(
      BUILTIN_TOOLS.map((tool) => [tool, typeof sourceTools[tool] === "boolean" ? sourceTools[tool] : defaultToolEnabled(tool)])
    ) as Record<BuiltinToolName, boolean>;
  } else {
    tools = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool, defaultToolEnabled(tool)])) as Record<BuiltinToolName, boolean>;
  }
  const result: SubagentDefinition = {
    id,
    name,
    description,
    systemPrompt,
    tools,
    scope,
    ...(color ? { color } : {}),
    ...(model ? { model } : {}),
    ...(injectAgentsMd ? { injectAgentsMd: true } : {})
  };
  return result;
}

function readConfig(filePath: string): JsonRecord {
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`子智能体配置无法解析：${filePath}，请先修复 JSON 格式。${error instanceof Error ? ` ${error.message}` : ""}`);
  }
  if (!isRecord(parsed)) throw new Error(`子智能体配置根节点必须是对象：${filePath}`);
  return parsed;
}

function writeConfig(filePath: string, config: JsonRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function readSubagentList(config: JsonRecord): SubagentDefinition[] {
  const value = config.subagents;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("子智能体配置中的 subagents 必须是数组");
  return value.map((raw) => normalizeSubagent(raw));
}

function writeSubagentList(filePath: string, list: SubagentDefinition[]): void {
  const config = readConfig(filePath);
  config.subagents = list;
  writeConfig(filePath, config);
}

function listFromFile(filePath: string): SubagentDefinition[] {
  return readSubagentList(readConfig(filePath));
}

/** 双作用域路径：global 永远返回；project 仅在提供 workspace 时返回。 */
export function subagentPathsFor(workspace: string | undefined, agentDir: string): { global: string; project?: string } {
  return {
    global: joinUnix(agentDir, "pidesktop-subagents.json"),
    ...(workspace ? { project: joinUnix(workspace, ".pidesktop-subagents.json") } : {})
  };
}

function joinUnix(...parts: string[]): string {
  return parts.join("/").replaceAll("\\", "/");
}

/**
 * 合并全局 + 项目子智能体；项目按 id 覆盖全局。坏文件只影响所在作用域。
 * 返回的每个定义带最终生效 scope。用于渲染端列表与 delegate_agent 解析。
 */
export function readSubagents(workspace: string | undefined, agentDir: string): SubagentDefinition[] {
  const { global, project } = subagentPathsFor(workspace, agentDir);
  const merged = new Map<string, SubagentDefinition>();
  for (const [scope, path] of [["global", global], ["project", project]] as const) {
    if (!path) continue;
    try {
      for (const entry of listFromFile(path)) {
        merged.set(entry.id, { ...entry, scope });
      }
    } catch (error) {
      console.warn(`读取子智能体配置失败（${scope}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** 按作用域 upsert；不清除目标文件中无关条目。 */
export function saveSubagent(workspace: string | undefined, agentDir: string, subagent: SubagentDefinition): void {
  const normalized = normalizeSubagent(subagent);
  const path = normalized.scope === "project"
    ? (subagentPathsFor(workspace, agentDir).project ?? (() => { throw new Error("保存项目级子智能体需要当前工作区"); })())
    : subagentPathsFor(workspace, agentDir).global;
  const existing = listFromFile(path);
  const rest = existing.filter((item) => item.id !== normalized.id);
  writeSubagentList(path, [...rest, normalized]);
}

export function deleteSubagent(workspace: string | undefined, agentDir: string, id: string, scope: SubagentScope): boolean {
  const path = scope === "project"
    ? (subagentPathsFor(workspace, agentDir).project ?? (() => { throw new Error("删除项目级子智能体需要当前工作区"); })())
    : subagentPathsFor(workspace, agentDir).global;
  const existing = listFromFile(path);
  if (!existing.some((item) => item.id === id)) return false;
  writeSubagentList(path, existing.filter((item) => item.id !== id));
  return true;
}
