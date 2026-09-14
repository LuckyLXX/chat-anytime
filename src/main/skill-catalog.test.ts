import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_SKILL_SOURCE, GLOBAL_SKILL_SOURCE, PROJECT_SKILL_SOURCE, SHARED_SKILL_SOURCE, buildSkillsSystemPromptBlock, discoverSkills, isSkillDisabled, parseSkillFrontmatter, setSkillEnabled, skillIdFromPath, toSkillSummaries, type SkillSourceDir } from "./skill-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeSkillDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(root: string, slug: string, description: string): Promise<void> {
  await mkdir(join(root, slug), { recursive: true });
  await writeFile(join(root, slug, "SKILL.md"), `---\nname: ${slug}\ndescription: ${description}\n---\n`, "utf8");
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
    await writeSkill(globalDir, "alpha", "全局 alpha");
    await writeSkill(globalDir, "beta", "全局 beta");
    await writeSkill(projectDir, "beta", "项目 beta 覆盖");

    const skills = discoverSkills([
      { dir: globalDir, ...GLOBAL_SKILL_SOURCE },
      { dir: projectDir, ...PROJECT_SKILL_SOURCE }
    ]);
    expect(skills.map((skill) => skill.slug)).toEqual(["alpha", "beta"]);
    const beta = skills.find((skill) => skill.slug === "beta");
    expect(beta?.scope).toBe("project");
    expect(beta?.source).toBe("当前项目");
    expect(beta?.description).toBe("项目 beta 覆盖");
    expect(skills.find((skill) => skill.slug === "alpha")?.source).toBe("用户资源");
  });

  it("applies the four-source precedence: shared < bundled < user global < project", async () => {
    const sharedDir = await makeSkillDir();
    const bundledDir = await makeSkillDir();
    const globalDir = await makeSkillDir();
    const projectDir = await makeSkillDir();
    // 只在共享目录存在的
    await writeSkill(sharedDir, "gamma", "共享 gamma");
    // 共享 vs 内置 → 内置胜出
    await writeSkill(sharedDir, "delta", "共享 delta");
    await writeSkill(bundledDir, "delta", "内置 delta");
    // 内置 vs 用户全局 → 用户全局胜出
    await writeSkill(bundledDir, "epsilon", "内置 epsilon");
    await writeSkill(globalDir, "epsilon", "全局 epsilon");
    // 用户全局 vs 项目 → 项目胜出
    await writeSkill(globalDir, "zeta", "全局 zeta");
    await writeSkill(projectDir, "zeta", "项目 zeta");

    const skills = discoverSkills([
      { dir: sharedDir, ...SHARED_SKILL_SOURCE },
      { dir: bundledDir, ...BUNDLED_SKILL_SOURCE },
      { dir: globalDir, ...GLOBAL_SKILL_SOURCE },
      { dir: projectDir, ...PROJECT_SKILL_SOURCE }
    ]);
    const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
    expect(bySlug.get("gamma")?.description).toBe("共享 gamma");
    expect(bySlug.get("gamma")?.scope).toBe("global");
    expect(bySlug.get("gamma")?.source).toBe("共享目录");
    // 内置来源：scope 是 bundled（渲染端显示「内置」），来源名是「随应用分发」
    expect(bySlug.get("delta")?.description).toBe("内置 delta");
    expect(bySlug.get("delta")?.scope).toBe("bundled");
    expect(bySlug.get("delta")?.source).toBe("随应用分发");
    expect(bySlug.get("epsilon")?.description).toBe("全局 epsilon");
    expect(bySlug.get("epsilon")?.scope).toBe("global");
    expect(bySlug.get("zeta")?.description).toBe("项目 zeta");
    expect(bySlug.get("zeta")?.scope).toBe("project");
  });

  it("ignores a missing or unreadable source dir", async () => {
    const globalDir = await makeSkillDir();
    await writeSkill(globalDir, "alpha", "a");

    const skills = discoverSkills([
      { dir: join(globalDir, "does-not-exist"), ...SHARED_SKILL_SOURCE },
      { dir: globalDir, ...GLOBAL_SKILL_SOURCE }
    ]);
    expect(skills.map((skill) => skill.slug)).toEqual(["alpha"]);
  });

  it("skips sources without a dir (optional bundled/global/project slots)", async () => {
    const globalDir = await makeSkillDir();
    await writeSkill(globalDir, "alpha", "a");
    const sources: SkillSourceDir[] = [
      { dir: "", ...SHARED_SKILL_SOURCE },
      { dir: globalDir, ...GLOBAL_SKILL_SOURCE }
    ];
    expect(discoverSkills(sources).map((skill) => skill.slug)).toEqual(["alpha"]);
  });

  it("follows linked skill dirs (junction/symlink) and skips dead or file links", async (context) => {
    const globalDir = await makeSkillDir();
    const sourceRepo = await mkdtemp(join(tmpdir(), "pi-desktop-skill-repo-"));
    temporaryDirectories.push(sourceRepo);
    const linkedSkill = join(sourceRepo, "ppt-master");
    await writeSkill(sourceRepo, "ppt-master", "外部仓库链接");
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

    const skills = discoverSkills([{ dir: globalDir, ...GLOBAL_SKILL_SOURCE }]);
    expect(skills.map((skill) => skill.slug)).toEqual(["ppt-master"]);
    expect(skills[0]!.filePath).toBe(join(globalDir, "ppt-master", "SKILL.md"));
    expect(skills[0]!.description).toBe("外部仓库链接");
  });

  it("derives a stable id and maps to summaries with disabled state", async () => {
    const globalDir = await makeSkillDir();
    const statePath = join(globalDir, "state.json");
    await writeSkill(globalDir, "alpha", "a");

    const discovered = discoverSkills([{ dir: globalDir, ...GLOBAL_SKILL_SOURCE }]);
    const id = skillIdFromPath(discovered[0]!.filePath);
    setSkillEnabled(statePath, id, false);
    expect(isSkillDisabled(statePath, id)).toBe(true);

    const summaries = toSkillSummaries(discovered, new Set([id]));
    expect(summaries[0]).toMatchObject({ name: "alpha", enabled: false, defaultEnabled: true, toggleable: true, scope: "global", source: "用户资源" });
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
