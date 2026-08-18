import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillsSystemPromptBlock, discoverSkills, isSkillDisabled, parseSkillFrontmatter, setSkillEnabled, skillIdFromPath, toSkillSummaries } from "./skill-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeSkillDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("skill frontmatter", () => {
  it("parses name and description from a YAML frontmatter block", () => {
    const parsed = parseSkillFrontmatter("---\nname: code-review\ndescription: 审查代码变更\n---\n\nBody.");
    expect(parsed).toEqual({ name: "code-review", description: "审查代码变更" });
  });

  it("returns empty when there is no frontmatter", () => {
    expect(parseSkillFrontmatter("just body")).toEqual({});
  });

  it("ignores comments and quotes", () => {
    const parsed = parseSkillFrontmatter("---\n# comment\nname: \"doc-gen\"\ndescription: 'gen docs'\n---\n");
    expect(parsed).toEqual({ name: "doc-gen", description: "gen docs" });
  });
});

describe("skill discovery", () => {
  it("discovers skills from global and project dirs with project precedence", async () => {
    const globalDir = await makeSkillDir();
    const projectDir = await makeSkillDir();
    await mkdir(join(globalDir, "alpha"), { recursive: true });
    await writeFile(join(globalDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 全局 alpha\n---\n", "utf8");
    await mkdir(join(globalDir, "beta"), { recursive: true });
    await writeFile(join(globalDir, "beta", "SKILL.md"), "---\nname: beta\ndescription: 全局 beta\n---\n", "utf8");
    await mkdir(join(projectDir, "beta"), { recursive: true });
    await writeFile(join(projectDir, "beta", "SKILL.md"), "---\nname: beta\ndescription: 项目 beta 覆盖\n---\n", "utf8");

    const skills = discoverSkills(globalDir, projectDir);
    expect(skills.map((skill) => skill.slug)).toEqual(["alpha", "beta"]);
    const beta = skills.find((skill) => skill.slug === "beta");
    expect(beta?.scope).toBe("project");
    expect(beta?.description).toBe("项目 beta 覆盖");
  });

  it("discovers skills from the shared ~/.agents/skills dir with lowest precedence", async () => {
    const globalDir = await makeSkillDir();
    const agentsDir = await makeSkillDir();
    const projectDir = await makeSkillDir();
    // 仅存在于共享目录
    await mkdir(join(agentsDir, "gamma"), { recursive: true });
    await writeFile(join(agentsDir, "gamma", "SKILL.md"), "---\nname: gamma\ndescription: 共享 gamma\n---\n", "utf8");
    // 共享目录 vs 全局目录 → 全局目录胜出
    await mkdir(join(agentsDir, "delta"), { recursive: true });
    await writeFile(join(agentsDir, "delta", "SKILL.md"), "---\nname: delta\ndescription: 共享 delta\n---\n", "utf8");
    await mkdir(join(globalDir, "delta"), { recursive: true });
    await writeFile(join(globalDir, "delta", "SKILL.md"), "---\nname: delta\ndescription: 全局 delta\n---\n", "utf8");
    // 共享目录 vs 项目目录 → 项目目录胜出
    await mkdir(join(agentsDir, "epsilon"), { recursive: true });
    await writeFile(join(agentsDir, "epsilon", "SKILL.md"), "---\nname: epsilon\ndescription: 共享 epsilon\n---\n", "utf8");
    await mkdir(join(projectDir, "epsilon"), { recursive: true });
    await writeFile(join(projectDir, "epsilon", "SKILL.md"), "---\nname: epsilon\ndescription: 项目 epsilon\n---\n", "utf8");

    const skills = discoverSkills(globalDir, projectDir, agentsDir);
    const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
    expect(bySlug.get("gamma")?.description).toBe("共享 gamma");
    expect(bySlug.get("gamma")?.scope).toBe("global");
    expect(bySlug.get("delta")?.description).toBe("全局 delta");
    expect(bySlug.get("delta")?.scope).toBe("global");
    expect(bySlug.get("epsilon")?.description).toBe("项目 epsilon");
    expect(bySlug.get("epsilon")?.scope).toBe("project");
  });

  it("ignores a missing or unreadable shared dir", async () => {
    const globalDir = await makeSkillDir();
    const projectDir = await makeSkillDir();
    await mkdir(join(globalDir, "alpha"), { recursive: true });
    await writeFile(join(globalDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n", "utf8");

    const skills = discoverSkills(globalDir, projectDir, join(globalDir, "does-not-exist"));
    expect(skills.map((skill) => skill.slug)).toEqual(["alpha"]);
  });

  it("follows linked skill dirs (junction/symlink) and skips dead or file links", async (context) => {
    const globalDir = await makeSkillDir();
    const sourceRepo = await mkdtemp(join(tmpdir(), "pi-desktop-skill-repo-"));
    temporaryDirectories.push(sourceRepo);
    const linkedSkill = join(sourceRepo, "ppt-master");
    await mkdir(linkedSkill, { recursive: true });
    await writeFile(join(linkedSkill, "SKILL.md"), "---\nname: ppt-master\ndescription: 外部仓库链接\n---\n", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(linkedSkill, join(globalDir, "ppt-master"), linkType);
    } catch {
      context.skip(); // 环境不允许创建目录链接
      return;
    }
    await writeFile(join(sourceRepo, "plain.md"), "not a skill dir", "utf8");
    // 辅助链接（文件链接 / 断链）用于验证过滤，个别平台创建失败不影响断言
    try {
      symlinkSync(join(sourceRepo, "plain.md"), join(globalDir, "file-link"), linkType);
    } catch { /* junction 无法指向文件等场景 */
    }
    try {
      symlinkSync(join(sourceRepo, "missing"), join(globalDir, "dead-link"), linkType);
    } catch { /* 平台不允许悬挂链接 */
    }

    const skills = discoverSkills(globalDir, globalDir);
    expect(skills.map((skill) => skill.slug)).toEqual(["ppt-master"]);
    expect(skills[0]!.filePath).toBe(join(globalDir, "ppt-master", "SKILL.md"));
    expect(skills[0]!.description).toBe("外部仓库链接");
  });

  it("derives a stable id and maps to summaries with disabled state", async () => {
    const globalDir = await makeSkillDir();
    const projectDir = await makeSkillDir();
    const statePath = join(globalDir, "state.json");
    await mkdir(join(globalDir, "alpha"), { recursive: true });
    await writeFile(join(globalDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n", "utf8");

    const discovered = discoverSkills(globalDir, projectDir);
    const id = skillIdFromPath(discovered[0]!.filePath);
    setSkillEnabled(statePath, id, false);
    expect(isSkillDisabled(statePath, id)).toBe(true);

    const summaries = toSkillSummaries(discovered, new Set([id]));
    expect(summaries[0]).toMatchObject({ name: "alpha", enabled: false, defaultEnabled: true, toggleable: true, scope: "global" });
    expect(summaries[0]?.filePath).toBe(discovered[0]!.filePath);

    setSkillEnabled(statePath, id, true);
    expect(toSkillSummaries(discovered, new Set())[0]?.enabled).toBe(true);
  });

  it("builds a system prompt block only for active skills", () => {
    expect(buildSkillsSystemPromptBlock([])).toBeUndefined();
    const block = buildSkillsSystemPromptBlock([
      { id: "skill:x", name: "alpha", description: "do alpha", source: "s", scope: "global", filePath: "/a/SKILL.md", defaultEnabled: true, enabled: true, toggleable: true, disableModelInvocation: false }
    ]);
    expect(block).toContain("/skill:alpha");
    expect(block).toContain("do alpha");
  });
});
