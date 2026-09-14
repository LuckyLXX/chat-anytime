import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILL_SOURCE, GLOBAL_SKILL_SOURCE, PROJECT_SKILL_SOURCE, SHARED_SKILL_SOURCE, discoverSkills, parseSkillFrontmatter } from "./skill-catalog.js";
import { skillPathsFor } from "./runtime-skills.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

const agentDir = join(tmpdir(), "pi-desktop-agent");
const workspace = join(tmpdir(), "pi-desktop-ws");
const bundledDir = join(tmpdir(), "pi-desktop-bundled");

describe("skillPathsFor", () => {
  it("orders sources lowest precedence first with bundled in the middle", () => {
    const paths = skillPathsFor(workspace, agentDir, bundledDir);
    expect(paths.dirs.map((source) => source.source)).toEqual(["共享目录", "随应用分发", "用户资源", "当前项目"]);
    expect(paths.dirs.map((source) => source.scope)).toEqual(["global", "bundled", "global", "project"]);
    expect(paths.dirs[0]!.dir).toBe(join(homedir(), ".agents", "skills"));
    expect(paths.dirs[1]!.dir).toBe(bundledDir);
    expect(paths.dirs[2]!.dir).toBe(join(agentDir, "pidesktop-skills"));
    expect(paths.dirs[3]!.dir).toBe(resolve(workspace, ".pidesktop-skills"));
    expect(paths.statePath).toBe(join(agentDir, "pidesktop-skill-state.json"));
  });

  it("skips the bundled slot when the app has no bundled skills dir", () => {
    const paths = skillPathsFor(workspace, agentDir);
    expect(paths.dirs).toHaveLength(3);
    expect(paths.dirs.some((source) => source.scope === "bundled")).toBe(false);
  });

  it("keeps the user global dir as the last global source without a workspace", () => {
    // 回归：旧实现无工作区时把 projectDir 顶成 globalDir，全局 skill 被标成「当前项目」。
    const paths = skillPathsFor(undefined, agentDir, bundledDir);
    expect(paths.dirs.map((source) => source.scope)).toEqual(["global", "bundled", "global"]);
    expect(paths.dirs.some((source) => source.scope === "project")).toBe(false);
  });
});

describe("bundled skill assets (repo contract)", () => {
  const repoRoot = resolve(__dirname, "../..");
  const skillsRoot = join(repoRoot, "resources", "skills");

  it("ships the bundled skill dirs with their runtime assets", () => {
    // 这些路径是发行契约：electron-builder 的 extraResources 把 resources/skills
    // 原样发成 <安装目录>/resources/skills，运行时（skill 扫描 + locateLjqCtrlDir）
    // 与文档都按它定位。改名/搬家必须同步改 main 侧与 SKILL.md。
    for (const slug of ["automation", "computer-use"]) {
      expect(existsSync(join(skillsRoot, slug, "SKILL.md")), `${slug}/SKILL.md 缺失`).toBe(true);
    }
    for (const asset of ["ljqCtrl.py", "uia.py", "ui_detect.py"]) {
      expect(existsSync(join(skillsRoot, "computer-use", asset)), `computer-use/${asset} 缺失`).toBe(true);
    }
  });

  it("parses frontmatter of every bundled skill", async () => {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    const slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(slugs.sort()).toEqual(["automation", "computer-use"]);
    for (const slug of slugs) {
      const parsed = parseSkillFrontmatter(readFileSync(join(skillsRoot, slug, "SKILL.md"), "utf8"));
      expect(parsed.name, `${slug} 缺 name`).toBeTruthy();
      expect(parsed.description, `${slug} 缺 description`).toBeTruthy();
    }
  });

  it("discovers the real bundled dir as bundled scope through the source pipeline", async () => {
    const skills = discoverSkills([{ dir: skillsRoot, ...BUNDLED_SKILL_SOURCE }]);
    const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
    expect([...bySlug.keys()].sort()).toEqual(["automation", "computer-use"]);
    expect(bySlug.get("computer-use")?.scope).toBe("bundled");
    expect(bySlug.get("computer-use")?.source).toBe("随应用分发");
    expect(bySlug.get("automation")?.name).toBe("自动化任务");
    expect(bySlug.get("computer-use")?.name).toBe("电脑控制");
  });

  it("merges empty bundled/global/project dirs without noise", async () => {
    const empty = await mkdtemp(join(tmpdir(), "pi-desktop-empty-"));
    try {
      await mkdir(join(empty, "global"), { recursive: true });
      await writeFile(join(empty, "probe.txt"), "not a skill", "utf8");
      const skills = discoverSkills([
        { dir: join(empty, "global"), ...GLOBAL_SKILL_SOURCE },
        { dir: join(empty, "missing"), ...PROJECT_SKILL_SOURCE },
        { dir: join(empty, "shared"), ...SHARED_SKILL_SOURCE }
      ]);
      expect(skills).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
