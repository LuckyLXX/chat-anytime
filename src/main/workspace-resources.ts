/**
 * 按会话工作区加载资源（skills / commands / subagents / hooks）的缓存层。
 *
 * 为什么单独一层：pi-runtime 里的 `discoveredSkills` 等模块级数组是「当前激活
 * 工作区」的快照，跨工作区会话创建时会拿到错误项目资源。这里把「共享 + 内置 +
 * 全局 + 项目」的合并结果按 workspace 缓存，调用方每次按 record.workspace 取，
 * 既保证隔离，又避免每次建会话都重扫目录。
 *
 * 缓存**不包含 agent 维**：skillOverrides、内置子智能体的模型/思考等级覆盖、
 * hook trust 都与助手绑定，而同一工作区可能被多个助手使用；把它们放进这里会让
 * 两个助手互相污染。这些覆盖由调用方按 record.agent 在取用处叠加。
 */

import { join, resolve } from "node:path";
import type { CommandSummary, SkillSummary, SubagentDefinition } from "../shared/protocol.js";
import { discoverCommands, toCommandSummaries, type DiscoveredCommand } from "./command-catalog.js";
import { readConfiguredHooks, type ConfiguredHook } from "./hooks-config.js";
import { scanSkills, skillPathsFor } from "./runtime-skills.js";
import type { DiscoveredSkill } from "./skill-catalog.js";
import { readSubagents } from "./subagents-store.js";

export interface WorkspaceResources {
  /** 与 scanSkills().summaries 同源（未按 agent 过滤）。 */
  skills: SkillSummary[];
  /** 同上（兼容命名）。 */
  skillSummaries: SkillSummary[];
  discoveredSkills: DiscoveredSkill[];
  commands: CommandSummary[];
  discoveredCommands: DiscoveredCommand[];
  subagents: SubagentDefinition[];
  hooks: ConfiguredHook[];
}

export interface WorkspaceResourceDeps {
  agentDir: string | (() => string);
  bundledSkillsDir?: string | (() => string | undefined);
  bundledSubagentsDir?: string | (() => string | undefined);
  /** 缓存有效期，默认 5000ms。 */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 5_000;

/**
 * 无 workspace 的专用键。不能退回 `resolve("")`（= cwd）：那会把进程当前目录当成
 * 项目来源扫描，而「没有工作区」的语义是只有共享/内置/全局来源。
 * 前置控制字符确保它不可能与真实绝对路径相撞。
 */
const NO_WORKSPACE_KEY = "\u0000workspace:none";

/** 缓存键：路径大小写不敏感（Windows 同一目录可能以不同大小写传入）。 */
function cacheKeyFor(workspace: string | undefined): string {
  return workspace ? resolve(workspace).toLowerCase() : NO_WORKSPACE_KEY;
}

function resolveOptionalPath(value: string | (() => string | undefined) | undefined): string | undefined {
  return typeof value === "function" ? value() : value;
}

/**
 * 单个来源的意外异常只降级为空列表：缺资源最多是功能变少，不能让整个会话创建失败。
 * 现有 read* 大多已经逐作用域容错，这里是最后一道兜底（例如目录突然变成文件时
 * 的 ENOTDIR 之外的意外错误）。
 */
function attempt<T>(label: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    console.warn(`读取工作区资源失败（${label}）：${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

export function createWorkspaceResources(deps: WorkspaceResourceDeps): {
  load(workspace?: string): WorkspaceResources;
  invalidate(workspace?: string): void;
  clear(): void;
} {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  const entries = new Map<string, { loadedAt: number; resources: WorkspaceResources }>();

  const loadResources = (workspace: string | undefined): WorkspaceResources => {
    const agentDir = typeof deps.agentDir === "function" ? deps.agentDir() : deps.agentDir;
    const bundledSkillsDir = resolveOptionalPath(deps.bundledSkillsDir);
    const bundledSubagentsDir = resolveOptionalPath(deps.bundledSubagentsDir);

    // skills 走既有四档路径函数，保证「共享 → 内置 → 全局 → 项目」的覆盖关系
    // 与 pi-runtime 当前目录完全一致（项目 slug 覆盖全局/内置）。
    const scanned = attempt(
      "skills",
      () => scanSkills(skillPathsFor(workspace, agentDir, bundledSkillsDir)),
      { discovered: [] as DiscoveredSkill[], summaries: [] as SkillSummary[] }
    );

    // commands 双作用域：没有 workspace 时项目目录退回全局目录（与 pi-runtime 的
    // commandPaths() 同口径），由 discoverCommands 的按名合并自然去重。
    const globalCommandsDir = join(agentDir, "pidesktop-commands");
    const projectCommandsDir = workspace ? resolve(workspace, ".pidesktop-commands") : globalCommandsDir;
    const discoveredCommandList = attempt(
      "commands",
      () => discoverCommands(globalCommandsDir, projectCommandsDir),
      [] as DiscoveredCommand[]
    );
    const commandSummaries = attempt(
      "command summaries",
      () => toCommandSummaries(discoveredCommandList),
      [] as CommandSummary[]
    );

    const subagents = attempt(
      "subagents",
      () => readSubagents(workspace, agentDir, bundledSubagentsDir),
      [] as SubagentDefinition[]
    );

    const hooks = attempt(
      "hooks",
      () =>
        readConfiguredHooks(
          workspace ? join(workspace, ".pidesktop-hooks.json") : undefined,
          join(agentDir, "pidesktop-hooks.json")
        ),
      [] as ConfiguredHook[]
    );

    return {
      skills: scanned.summaries,
      // 同一份数组：两个字段是兼容命名，调用方不应假设它们可以独立修改。
      skillSummaries: scanned.summaries,
      discoveredSkills: scanned.discovered,
      commands: commandSummaries,
      discoveredCommands: discoveredCommandList,
      subagents,
      hooks
    };
  };

  return {
    load(workspace?: string): WorkspaceResources {
      const key = cacheKeyFor(workspace);
      const current = now();
      const cached = entries.get(key);
      // TTL 内命中返回同一对象引用：调用方可能把返回值当身份比较（缓存/渲染去重）。
      if (cached && current - cached.loadedAt < ttlMs) return cached.resources;
      const resources = loadResources(workspace);
      entries.set(key, { loadedAt: current, resources });
      return resources;
    },
    invalidate(workspace?: string): void {
      // 不传 workspace 清全部：资源重载命令不知道当前有哪些工作区，只能全清。
      if (workspace === undefined) {
        entries.clear();
        return;
      }
      entries.delete(cacheKeyFor(workspace));
    },
    clear(): void {
      entries.clear();
    }
  };
}
