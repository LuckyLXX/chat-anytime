// 自定义子智能体定义读写：三档作用域（内置目录 / 全局 <agentDir>/pidesktop-subagents.json
// / 项目 <workspace>/.pidesktop-subagents.json，后者覆盖前者，按 id 合并），模式与
// hooks-config.ts / mcp-config.ts 一致（tmp/rename 原子写、坏文件只影响所在作用域）。
//
// 内置档（2026-09-15）：随安装包分发在 <安装目录>/subagents（dev 为 resources/subagents），
// 一文件一定义，**只读**——用户能改的只有「执行模型」，落在 <agentDir>/pidesktop-subagent-models.json
// 覆盖表里（单独一个文件，与定义本体解耦；同名用户定义仍然整体覆盖内置）。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  // scope：bundled 不来自用户配置（由 readBundledSubagents 强制标定），这里仅区分项目/全局。
  const scope: SubagentScope = value.scope === "project" ? "project" : "global";
  const model = normalizeModel(value.model);
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

function joinUnix(...parts: string[]): string {
  return parts.join("/").replaceAll("\\", "/");
}

/** 双作用域路径：global 永远返回；project 仅在提供 workspace 时返回；bundled 仅在提供了目录时返回。 */
export function subagentPathsFor(workspace: string | undefined, agentDir: string, bundledDir?: string): { global: string; project?: string; bundled?: string } {
  return {
    global: joinUnix(agentDir, "pidesktop-subagents.json"),
    ...(workspace ? { project: joinUnix(workspace, ".pidesktop-subagents.json") } : {}),
    ...(bundledDir ? { bundled: joinUnix(bundledDir) } : {})
  };
}

/** 内置子智能体「执行模型」覆盖表路径（用户对内置定义的唯一可写项）。 */
export function subagentModelOverridesPath(agentDir: string): string {
  return joinUnix(agentDir, "pidesktop-subagent-models.json");
}

/**
 * 读取内置子智能体目录：一文件一定义（`*.json`），全部标为 scope="bundled" 且
 * builtin=true。单个文件坏掉只跳过那一个（内置资产不应因为一份写错就整体消失）。
 */
export function readBundledSubagents(dir: string): SubagentDefinition[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const result: SubagentDefinition[] = [];
  for (const name of entries.sort()) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const filePath = joinUnix(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      const raw = isRecord(parsed) && Array.isArray(parsed.subagents) ? parsed.subagents : [parsed];
      for (const item of raw) {
        result.push({ ...normalizeSubagent(item), scope: "bundled", builtin: true });
      }
    } catch (error) {
      console.warn(`读取内置子智能体失败（${name}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** 读取内置定义的模型覆盖表（id → 模型）；缺省为空。 */
export function readSubagentModelOverrides(agentDir: string): Record<string, { provider: string; id: string }> {
  const filePath = subagentModelOverridesPath(agentDir);
  if (!existsSync(filePath)) return {};
  try {
    const config = readConfig(filePath);
    const models = config.models;
    if (!isRecord(models)) return {};
    const result: Record<string, { provider: string; id: string }> = {};
    for (const [id, value] of Object.entries(models)) {
      const model = normalizeModel(value);
      if (model) result[id] = model;
    }
    return result;
  } catch (error) {
    console.warn(`读取内置子智能体模型覆盖失败：${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * 写入内置子智能体（按 id）的执行模型选择；model 为空则删掉该条（回到继承默认模型）。
 * 只影响内置定义——用户自建的模型存在自己的定义文件里，不走这张表。
 */
export function saveSubagentModelOverride(agentDir: string, id: string, model: { provider: string; id: string } | undefined): void {
  const filePath = subagentModelOverridesPath(agentDir);
  const config = existsSync(filePath) ? readConfig(filePath) : {};
  const models = isRecord(config.models) ? { ...config.models } : {};
  if (model) models[id] = { provider: model.provider, id: model.id };
  else delete models[id];
  config.models = models;
  writeConfig(filePath, config);
}

/** 模型引用的归一化：provider/id 均为非空字符串才有效。 */
function normalizeModel(value: unknown): { provider: string; id: string } | undefined {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string" && value.provider.trim() && value.id.trim()
    ? { provider: value.provider.trim(), id: value.id.trim() }
    : undefined;
}

/**
 * 合并内置 + 全局 + 项目子智能体；后者的同 id **或同名**条目会逐掉前者：
 * 项目 > 全局 > 内置。同名也算覆盖是因为「按名称引用」是委派的入口——若内置叫
 * code-reviewer、用户的定义叫 code-reviewer 但 id 不同，清单里就会出现两个同名条目，
 * 按名字解析命中哪个变成不确定（真实场景：用户的存量定义 id 是随机生成、名称却是这
 * 三个名字）。同名覆盖让用户能直接用自己那份替掉内置那份，零额外配置。
 * 内置定义的「执行模型」用用户覆盖表回填（用户在设置页能改的只有模型）。
 * 坏文件只影响所在作用域。返回的每个定义带最终生效 scope。
 */
export function readSubagents(workspace: string | undefined, agentDir: string, bundledDir?: string): SubagentDefinition[] {
  const { global, project, bundled } = subagentPathsFor(workspace, agentDir, bundledDir);
  const merged = new Map<string, SubagentDefinition>();
  /** 插入一条定义：先逐掉同 id 与同名的低位条目，再按 id 落位。 */
  const upsert = (entry: SubagentDefinition): void => {
    merged.delete(entry.id);
    for (const [key, existing] of merged) {
      if (existing.name === entry.name) merged.delete(key);
    }
    merged.set(entry.id, entry);
  };
  if (bundled) {
    const overrides = readSubagentModelOverrides(agentDir);
    for (const entry of readBundledSubagents(bundled)) {
      upsert({ ...entry, model: overrides[entry.id] ?? entry.model });
    }
  }
  for (const [scope, path] of [["global", global], ["project", project]] as const) {
    if (!path) continue;
    try {
      for (const entry of listFromFile(path)) {
        upsert({ ...entry, scope });
      }
    } catch (error) {
      console.warn(`读取子智能体配置失败（${scope}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** 内置定义只读：任何试图改写内置档的保存/删除都直接拒绝。 */
function rejectBundledWrite(scope: SubagentScope): void {
  if (scope === "bundled") throw new Error("内置子智能体不可修改（只能在列表里选择执行模型）");
}

/** 按作用域 upsert；不清除目标文件中无关条目。 */
export function saveSubagent(workspace: string | undefined, agentDir: string, subagent: SubagentDefinition): void {
  rejectBundledWrite(subagent.scope);
  const normalized = normalizeSubagent(subagent);
  const path = normalized.scope === "project"
    ? (subagentPathsFor(workspace, agentDir).project ?? (() => { throw new Error("保存项目级子智能体需要当前工作区"); })())
    : subagentPathsFor(workspace, agentDir).global;
  const existing = listFromFile(path);
  const rest = existing.filter((item) => item.id !== normalized.id);
  writeSubagentList(path, [...rest, normalized]);
}

export function deleteSubagent(workspace: string | undefined, agentDir: string, id: string, scope: SubagentScope): boolean {
  rejectBundledWrite(scope);
  const path = scope === "project"
    ? (subagentPathsFor(workspace, agentDir).project ?? (() => { throw new Error("删除项目级子智能体需要当前工作区"); })())
    : subagentPathsFor(workspace, agentDir).global;
  const existing = listFromFile(path);
  if (!existing.some((item) => item.id === id)) return false;
  writeSubagentList(path, existing.filter((item) => item.id !== id));
  return true;
}
