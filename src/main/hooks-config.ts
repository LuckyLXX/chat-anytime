// 钩子配置文件读写：双作用域 JSONC（项目 <workspace>/.pidesktop-hooks.json 覆盖
// 全局 <agentDir>/pidesktop-hooks.json，按 name 合并），模式与 mcp-config.ts 一致
// （strip-json-comments + tmp/rename 原子写、坏文件只影响所在作用域）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import stripJsonComments from "strip-json-comments";
import type { HookAction, HookEventName, HookRule } from "../shared/protocol.js";

export interface ConfiguredHook {
  name: string;
  rule: HookRule;
  scope: "project" | "global";
}

export const HOOK_EVENTS: readonly HookEventName[] = ["session_start", "tool_call", "tool_execution_end", "agent_end", "turn_end"];
export const HOOK_TIMEOUT_MIN_MS = 1_000;
export const HOOK_TIMEOUT_MAX_MS = 120_000;
export const HOOK_TIMEOUT_DEFAULT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compileRegex(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch (error) {
    throw new Error(`${label}不是合法的正则表达式：${pattern}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function validateAction(action: HookAction, event: HookEventName): void {
  switch (action.kind) {
    case "notify":
      if (action.title !== undefined && typeof action.title !== "string") throw new Error("钩子通知标题必须是字符串");
      if (action.body !== undefined && typeof action.body !== "string") throw new Error("钩子通知正文必须是字符串");
      break;
    case "http": {
      let url: URL;
      try {
        url = new URL(action.url);
      } catch {
        throw new Error("钩子推送地址无效，必须是完整的 http(s) URL");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("钩子推送地址只支持 http/https");
      break;
    }
    case "block": {
      if (event !== "tool_call") throw new Error("拦截规则（block）只能挂在 tool_call 事件上");
      if (!Array.isArray(action.deny) || action.deny.length === 0) throw new Error("拦截规则至少需要一条 deny 正则");
      action.deny.forEach((pattern, index) => {
        if (typeof pattern !== "string" || !pattern.trim()) throw new Error(`拦截规则第 ${index + 1} 条 deny 不能为空`);
        compileRegex(pattern, `拦截规则第 ${index + 1} 条 deny `);
      });
      break;
    }
    case "command":
      if (typeof action.command !== "string" || !action.command.trim()) throw new Error("钩子命令不能为空");
      if (action.blocking === true && event !== "tool_call") throw new Error("只有 tool_call 事件上的命令钩子可以设为阻断型");
      break;
  }
}

/** 校验一条钩子规则；不合格时抛出带中文说明的错误（面板直接展示）。 */
export function validateHookRule(rule: HookRule): void {
  const name = typeof rule.name === "string" ? rule.name.trim() : "";
  if (!name) throw new Error("钩子名称不能为空");
  if (name.length > 64) throw new Error("钩子名称过长（最多 64 字符）");
  if (!HOOK_EVENTS.includes(rule.event)) throw new Error(`钩子事件无效：${String(rule.event)}`);
  if (rule.matcher !== undefined) {
    if (typeof rule.matcher !== "string" || !rule.matcher.trim()) throw new Error("工具匹配正则不能为空（留空表示匹配全部工具）");
    if (rule.event !== "tool_call" && rule.event !== "tool_execution_end") throw new Error("只有工具事件（tool_call / tool_execution_end）可以使用工具匹配正则");
    compileRegex(rule.matcher, "工具匹配正则");
  }
  if (rule.timeoutMs !== undefined) {
    if (typeof rule.timeoutMs !== "number" || !Number.isFinite(rule.timeoutMs) || rule.timeoutMs < HOOK_TIMEOUT_MIN_MS || rule.timeoutMs > HOOK_TIMEOUT_MAX_MS) {
      throw new Error(`命令超时必须在 ${HOOK_TIMEOUT_MIN_MS / 1000}–${HOOK_TIMEOUT_MAX_MS / 1000} 秒之间`);
    }
  }
  if (!isRecord(rule.action)) throw new Error("钩子动作无效");
  validateAction(rule.action as HookAction, rule.event);
}

function readConfig(filePath: string): JsonRecord {
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(filePath, "utf8"), { trailingCommas: true }));
  } catch (error) {
    throw new Error(`钩子配置无法解析：${filePath}，请先修复 JSON 格式。${error instanceof Error ? ` ${error.message}` : ""}`);
  }
  if (!isRecord(parsed)) throw new Error(`钩子配置根节点必须是对象：${filePath}`);
  return parsed;
}

function writeConfig(filePath: string, config: JsonRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function readRules(config: JsonRecord): HookRule[] {
  const value = config.hooks;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("钩子配置中的 hooks 必须是数组");
  return value.map((raw) => {
    if (!isRecord(raw)) throw new Error("钩子配置中的每条规则必须是对象");
    const rule = raw as unknown as HookRule;
    validateHookRule(rule);
    // name 在单个文件内唯一，重复以后者覆盖前者（与按 name 的 upsert 语义一致）。
    return rule;
  });
}

function writeRules(filePath: string, rules: HookRule[]): void {
  const config = readConfig(filePath);
  config.hooks = rules;
  writeConfig(filePath, config);
}

function rulesFromFile(filePath: string): HookRule[] {
  return readRules(readConfig(filePath));
}

/** 合并项目 + 全局钩子；项目按 name 覆盖全局。坏文件只影响所在作用域。 */
export function readConfiguredHooks(projectConfigPath: string | undefined, globalConfigPath: string): ConfiguredHook[] {
  const merged = new Map<string, ConfiguredHook>();
  for (const [scope, path] of [["global", globalConfigPath], ["project", projectConfigPath]] as const) {
    if (!path) continue;
    try {
      for (const rule of rulesFromFile(path)) {
        merged.set(rule.name, { name: rule.name, rule, scope });
      }
    } catch (error) {
      // 缺失/损坏的作用域文件不应阻断另一作用域；诊断信息由调用方日志兜底。
      console.warn(`读取钩子配置失败（${scope}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** 按 name upsert；保留目标文件中既有条目的 disabled 标记，其余字段以传入规则为准。 */
export function upsertHookConfig(filePath: string, rule: HookRule): void {
  const existing = rulesFromFile(filePath);
  const previous = existing.find((item) => item.name === rule.name);
  const next: HookRule = { ...rule, ...(previous?.disabled ? { disabled: true } : {}) };
  const rest = existing.filter((item) => item.name !== rule.name);
  writeRules(filePath, [...rest, next]);
}

export function removeHookConfig(filePath: string, name: string): boolean {
  const existing = rulesFromFile(filePath);
  if (!existing.some((item) => item.name === name)) return false;
  writeRules(filePath, existing.filter((item) => item.name !== name));
  return true;
}

export function setHookDisabled(filePath: string, name: string, disabled: boolean): boolean {
  const existing = rulesFromFile(filePath);
  const target = existing.find((item) => item.name === name);
  if (!target) return false;
  const next: HookRule = { ...target };
  if (disabled) next.disabled = true;
  else delete next.disabled;
  writeRules(filePath, existing.map((item) => item.name === name ? next : item));
  return true;
}

/** 面板列表的一行动作摘要。 */
export function hookActionPreview(action: HookAction): string {
  switch (action.kind) {
    case "notify":
      return action.title?.trim() || action.body?.trim() || "桌面通知";
    case "http":
      return action.url;
    case "block":
      return `拦截 ${action.deny.length} 条规则`;
    case "command":
      return action.command;
  }
}
