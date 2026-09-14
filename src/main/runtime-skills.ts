// Skill capability cluster extracted from pi-runtime.ts: path resolution,
// discovery, per-agent filtering, and the executable skill prompt. All
// functions are pure over their inputs — pi-runtime keeps the discovered
// catalog as module state and calls these with explicit arguments.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentProfile, SkillSummary } from "../shared/protocol.js";
import { buildSkillPrompt } from "./skill-prompt.js";
import { BUNDLED_SKILL_SOURCE, GLOBAL_SKILL_SOURCE, PROJECT_SKILL_SOURCE, SHARED_SKILL_SOURCE, discoverSkills, isSkillDisabled, skillIdFromPath, toSkillSummaries, type DiscoveredSkill, type SkillSourceDir } from "./skill-catalog.js";

export interface SkillPaths {
  /** 按优先级**由低到高**的扫描源（同名 slug 后者覆盖前者）。 */
  dirs: SkillSourceDir[];
  statePath: string;
}

/**
 * Four skill sources, lowest precedence first:
 * shared `~/.agents/skills` → bundled app skills (only when the app bundle
 * actually has one) → user global `<agentDir>/pidesktop-skills` → project
 * `<workspace>/.pidesktop-skills`. No workspace means NO project source (a
 * previous version fell back to the global dir here, which mislabelled global
 * skills as 「当前项目」).
 */
export function skillPathsFor(workspace: string | undefined, agentDir: string, bundledDir?: string): SkillPaths {
  const dirs: SkillSourceDir[] = [
    { dir: join(homedir(), ".agents", "skills"), ...SHARED_SKILL_SOURCE },
    ...(bundledDir ? [{ dir: bundledDir, ...BUNDLED_SKILL_SOURCE }] : []),
    { dir: join(agentDir, "pidesktop-skills"), ...GLOBAL_SKILL_SOURCE },
    ...(workspace ? [{ dir: resolve(workspace, ".pidesktop-skills"), ...PROJECT_SKILL_SOURCE }] : [])
  ];
  return { dirs, statePath: join(agentDir, "pidesktop-skill-state.json") };
}

/** Scan skill sources and apply the persisted enable/disable state. */
export function scanSkills(paths: SkillPaths): { discovered: DiscoveredSkill[]; summaries: SkillSummary[] } {
  const discovered = discoverSkills(paths.dirs);
  const disabled = new Set<string>();
  for (const skill of discovered) {
    const id = skillIdFromPath(skill.filePath);
    if (isSkillDisabled(paths.statePath, id)) disabled.add(id);
  }
  return { discovered, summaries: toSkillSummaries(discovered, disabled) };
}

/** Skills active for the current agent (global state + per-agent overrides). */
export function activeSkillsFor(summaries: readonly SkillSummary[], agent: AgentProfile | undefined): SkillSummary[] {
  return summaries.filter((skill) => {
    if (!skill.enabled) return false;
    const override = agent?.skillOverrides?.[skill.id];
    return override !== false;
  });
}

/**
 * Prompt that steers the model to read the SKILL.md and follow it.
 * 返回片段（不含展示 marker）供多调用合并复用；单调用经 buildRuntimeSkillPrompt
 * 包上 marker，字节与历史版本一致。
 */
export function buildRuntimeSkillBody(discovered: readonly DiscoveredSkill[], name: string, instructions: string | undefined, hasReadTool: boolean): { name: string; instructions: string; body: string } {
  const skill = discovered.find((item) => item.name === name || item.slug === name);
  if (!skill) throw new Error(`未找到 Skill：${name}`);
  if (!hasReadTool) throw new Error("当前 Agent 未启用 read 工具，无法读取 Skill");
  const userInstructions = instructions?.trim() ?? "";
  const body = [
    `使用 Skill「${skill.name}」完成任务。`,
    `首先调用 read 工具读取 Skill 文件：${skill.filePath}`,
    "完整阅读后遵循其中的说明；其中的相对路径均以该 Skill 文件所在目录为基准。",
    userInstructions ? `用户要求：\n${userInstructions}` : undefined
  ].filter(Boolean).join("\n\n");
  return { name: skill.name, instructions: userInstructions, body };
}

export function buildRuntimeSkillPrompt(discovered: readonly DiscoveredSkill[], name: string, instructions: string | undefined, hasReadTool: boolean): string {
  const resolved = buildRuntimeSkillBody(discovered, name, instructions, hasReadTool);
  return buildSkillPrompt(resolved.name, resolved.instructions, resolved.body);
}
