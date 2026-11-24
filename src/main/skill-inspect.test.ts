import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_CONTENT_MAX_CHARS, SKILL_FILES_MAX, inspectSkill, listSkillFiles } from "./skill-inspect.js";

/**
 * Skill 详情读取（设置页右栏）的回归网：
 * ① SKILL.md 正文原样返回，正文截断是显式的（contentTruncated）；
 * ② 附件清单跳过缓存/依赖/隐藏目录（内置 skill 目录里确实有 __pycache__ / .git），
 *    SKILL.md 自己不算附件，子目录路径统一 `/` 分隔；
 * ③ 失败路径不抛异常，统一回 error（渲染端只处理一种形态）。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-skill-inspect-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("inspectSkill", () => {
  it("读取 SKILL.md 正文并列出附件（跳过 SKILL.md / 缓存目录 / 隐藏项）", async () => {
    const root = await makeDir();
    const skillDir = join(root, "demo");
    const skillFile = join(skillDir, "SKILL.md");
    await write(skillFile, "---\nname: demo\ndescription: 演示\n---\n\n# Demo\n");
    await write(join(skillDir, "references", "variables.md"), "变量清单");
    await write(join(skillDir, "scripts", "check.py"), "print('ok')");
    await write(join(skillDir, "__pycache__", "check.cpython-313.pyc"), "binary");
    await write(join(skillDir, "node_modules", "dep", "index.js"), "module.exports = 1");
    await write(join(skillDir, ".git", "config"), "[core]");
    await write(join(skillDir, ".DS_Store"), "junk");

    const detail = inspectSkill({ id: "skill:demo", filePath: skillFile });

    expect(detail.error).toBeUndefined();
    expect(detail.content).toContain("# Demo");
    expect(detail.contentTruncated).toBeUndefined();
    expect(detail.files.map((file) => file.path)).toEqual(["references/variables.md", "scripts/check.py"]);
    expect(detail.files.every((file) => file.size > 0)).toBe(true);
    expect(detail.filePath).toBe(skillFile);
  });

  it("正文超限时截断并标记（不静默丢内容）", async () => {
    const root = await makeDir();
    const skillFile = join(root, "big", "SKILL.md");
    await write(skillFile, "x".repeat(SKILL_CONTENT_MAX_CHARS + 500));

    const detail = inspectSkill({ id: "skill:big", filePath: skillFile });

    expect(detail.content.length).toBe(SKILL_CONTENT_MAX_CHARS);
    expect(detail.contentTruncated).toBe(true);
  });

  it("附件数量超上限时截断并标记", async () => {
    const root = await makeDir();
    const skillDir = join(root, "many");
    const skillFile = join(skillDir, "SKILL.md");
    await write(skillFile, "body");
    for (let index = 0; index < SKILL_FILES_MAX + 5; index += 1) {
      await write(join(skillDir, "files", `f-${String(index).padStart(3, "0")}.txt`), "x");
    }

    const detail = inspectSkill({ id: "skill:many", filePath: skillFile });

    expect(detail.files.length).toBe(SKILL_FILES_MAX);
    expect(detail.filesTruncated).toBe(true);
  });

  it("SKILL.md 读不到时回 error，而不是抛异常", async () => {
    const root = await makeDir();
    const detail = inspectSkill({ id: "skill:gone", filePath: join(root, "missing", "SKILL.md") });
    expect(detail.content).toBe("");
    expect(detail.files).toEqual([]);
    expect(detail.error).toContain("读取 SKILL.md 失败");
  });

  it("没有 filePath 时直接给出明确原因", () => {
    const detail = inspectSkill({ id: "skill:none" });
    expect(detail.error).toBe("该 Skill 没有记录 SKILL.md 路径，无法读取内容");
    expect(detail.id).toBe("skill:none");
  });
});

describe("listSkillFiles", () => {
  it("目录不可读时返回空清单（不抛异常）", () => {
    expect(listSkillFiles(join(tmpdir(), "definitely-not-a-directory-xyz"))).toEqual({ files: [], truncated: false });
  });
});
