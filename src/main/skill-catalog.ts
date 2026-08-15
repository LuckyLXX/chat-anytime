import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SkillSummary, SkillSummary as _SS } from "../shared/protocol.js";

/**
 * Self-built Skill discovery. Skills live as `SKILL.md` files (one per
 * directory) under a global dir (`<agentDir>/pidesktop-skills/`), the shared
 * cross-agent dir (`~/.agents/skills/`), and a project dir
 * (`<workspace>/.pidesktop-skills/`). Each SKILL.md has a YAML-ish
 * frontmatter (`name`, `description`). The agent never imports these through
 * Pi's skill loader — instead the runtime injects an "available skills" list
 * into the system prompt and the user invokes a skill by asking the agent to
 * `read` its file.
 */

export interface DiscoveredSkill {
  slug: string;
  name: string;
  description: string;
  filePath: string;
  scope: "global" | "project";
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

/** Parse the leading `---` frontmatter block; tolerate missing/closing fences. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match?.[1]) return {};
  const result: { name?: string; description?: string } = {};
  for (const rawLine of match[1].split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/gu, "");
    if (key === "name" && value) result.name = value;
    if (key === "description" && value) result.description = value;
  }
  return result;
}

export function skillIdFromPath(filePath: string): string {
  return `skill:${createHash("sha256").update(filePath.replaceAll("\\", "/").toLowerCase()).digest("hex").slice(0, 20)}`;
}

function readSkillFile(filePath: string): { name: string; description: string } | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const frontmatter = parseSkillFrontmatter(content);
  const slug = basename(dirname(filePath));
  return {
    name: frontmatter.name?.trim() || slug,
    description: frontmatter.description?.trim() || ""
  };
}

function scanSkillDir(rootDir: string, scope: "global" | "project"): DiscoveredSkill[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(rootDir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = readSkillFile(skillFile);
    if (!parsed) continue;
    skills.push({ slug: entry.name, name: parsed.name, description: parsed.description, filePath: skillFile, scope });
  }
  return skills;
}

/**
 * Discover skills from the app global dir, the shared `~/.agents/skills` dir,
 * and the project dir. On slug clash, project entries win, then the app
 * global dir, then the shared agents dir.
 */
export function discoverSkills(globalDir: string, projectDir: string, agentsDir?: string): DiscoveredSkill[] {
  const merged = new Map<string, DiscoveredSkill>();
  if (agentsDir) {
    for (const skill of scanSkillDir(agentsDir, "global")) merged.set(skill.slug, skill);
  }
  for (const skill of scanSkillDir(globalDir, "global")) merged.set(skill.slug, skill);
  for (const skill of scanSkillDir(projectDir, "project")) merged.set(skill.slug, skill);
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export interface SkillState {
  disabled: string[];
}

function readSkillState(statePath: string): SkillState {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { disabled?: unknown }).disabled)) {
      const disabled = (parsed as { disabled: unknown[] }).disabled.filter((item): item is string => typeof item === "string");
      return { disabled };
    }
  } catch {
    // missing/corrupt state file → treat as nothing disabled
  }
  return { disabled: [] };
}

function writeSkillState(statePath: string, state: SkillState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, statePath);
}

export function isSkillDisabled(statePath: string, skillId: string): boolean {
  return readSkillState(statePath).disabled.includes(skillId);
}

export function setSkillEnabled(statePath: string, skillId: string, enabled: boolean): void {
  const state = readSkillState(statePath);
  const set = new Set(state.disabled);
  if (enabled) set.delete(skillId);
  else set.add(skillId);
  writeSkillState(statePath, { disabled: [...set] });
}

/** Map discovered skills to protocol summaries, applying the global disabled state. */
export function toSkillSummaries(skills: DiscoveredSkill[], disabledIds: Set<string>): SkillSummary[] {
  return skills.map((skill) => {
    const id = skillIdFromPath(skill.filePath);
    return {
      id,
      name: skill.name,
      description: skill.description || "无描述",
      source: skill.scope === "project" ? "当前项目" : "用户资源",
      scope: skill.scope,
      filePath: skill.filePath,
      defaultEnabled: true,
      enabled: !disabledIds.has(id),
      toggleable: true,
      disableModelInvocation: false
    } satisfies _SS;
  });
}

/**
 * Build the system-prompt block listing active skills so the model can invoke
 * them. Pass only the skills that are enabled for the current agent (global
 * state + agent overrides already applied).
 */
export function buildSkillsSystemPromptBlock(skills: SkillSummary[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = skills.map((skill) => `- /skill:${skill.name} — ${skill.description}${skill.filePath ? ` (file: ${skill.filePath})` : ""}`);
  return ["以下 Skill 可用，需要时先用 read 工具读取对应 SKILL.md 再按其中说明执行：", ...lines].join("\n");
}
