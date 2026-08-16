// Skill capability cluster extracted from pi-runtime.ts: path resolution,
// discovery, per-agent filtering, and the executable skill prompt. All
// functions are pure over their inputs — pi-runtime keeps the discovered
// catalog as module state and calls these with explicit arguments.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentProfile, SkillSummary } from "../shared/protocol.js";
import { buildSkillPrompt } from "./skill-prompt.js";
import { discoverSkills, isSkillDisabled, skillIdFromPath, toSkillSummaries, type DiscoveredSkill } from "./skill-catalog.js";

export interface SkillPaths {
  globalDir: string;
  agentsDir: string;
  projectDir: string;
  statePath: string;
}

export function skillPathsFor(workspace: string | undefined, agentDir: string): SkillPaths {
  return {
    globalDir: join(agentDir, "pidesktop-skills"),
    agentsDir: join(homedir(), ".agents", "skills"),
    projectDir: workspace ? resolve(workspace, ".pidesktop-skills") : join(agentDir, "pidesktop-skills"),
    statePath: join(agentDir, "pidesktop-skill-state.json")
  };
}

/** Scan skill sources and apply the persisted enable/disable state. */
export function scanSkills(paths: SkillPaths): { discovered: DiscoveredSkill[]; summaries: SkillSummary[] } {
  const discovered = discoverSkills(paths.globalDir, paths.projectDir, paths.agentsDir);
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

/** Prompt that steers the model to read the SKILL.md and follow it. */
export function buildRuntimeSkillPrompt(discovered: readonly DiscoveredSkill[], name: string, instructions: string | undefined, hasReadTool: boolean): string {
  const skill = discovered.find((item) => item.name === name || item.slug === name);
  if (!skill) throw new Error(`未找到 Skill：${name}`);
  if (!hasReadTool) throw new Error("当前 Agent 未启用 read 工具，无法读取 Skill");
  const userInstructions = instructions?.trim() ?? "";
  const executionPrompt = [
    `使用 Skill「${skill.name}」完成任务。`,
    `首先调用 read 工具读取 Skill 文件：${skill.filePath}`,
    "完整阅读后遵循其中的说明；其中的相对路径均以该 Skill 文件所在目录为基准。",
    userInstructions ? `用户要求：\n${userInstructions}` : undefined
  ].filter(Boolean).join("\n\n");
  return buildSkillPrompt(skill.name, userInstructions, executionPrompt);
}
