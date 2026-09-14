import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./bundled-skills.js";

describe("resolveBundledSkillsDir", () => {
  it("maps the packaged asar path to <resources>/skills", () => {
    const appPath = join("C:", "Program Files", "ChatAnyTime", "resources", "app.asar");
    const resolved = resolveBundledSkillsDir(appPath, true, () => true);
    expect(resolved).toBe(resolve(join("C:", "Program Files", "ChatAnyTime", "resources", "skills")));
  });

  it("reads the repo resources/skills in dev", () => {
    const appPath = join("D:", "code", "PiDesktop");
    const resolved = resolveBundledSkillsDir(appPath, false, () => true);
    expect(resolved).toBe(resolve(appPath, "resources", "skills"));
  });

  it("returns undefined when the bundled dir is absent", () => {
    expect(resolveBundledSkillsDir(join("D:", "code", "PiDesktop"), false, () => false)).toBeUndefined();
    // 校验的必须是候选路径本身（而不是仓库根之类的父目录）
    const probed: string[] = [];
    resolveBundledSkillsDir(join("C:", "App", "resources", "app.asar"), true, (path) => {
      probed.push(path);
      return false;
    });
    expect(probed).toHaveLength(1);
    expect(probed[0]!.endsWith(`resources${sep}skills`)).toBe(true);
  });
});
