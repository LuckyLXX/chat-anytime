import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
