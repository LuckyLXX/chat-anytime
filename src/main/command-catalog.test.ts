import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCommandPrompt,
  buildRuntimeCommandPrompt,
  discoverCommands,
  expandCommandTemplate,
  parseCommandPrompt,
  stripCommandFrontmatter,
  toCommandSummaries,
  type DiscoveredCommand
} from "./command-catalog.js";

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-commands-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverCommands 双作用域扫描", () => {
  it("扫描全局与项目目录的 md 文件，文件名即命令名，按名排序", () => {
    const globalDir = makeTempDir();
    const projectDir = makeTempDir();
    writeFileSync(join(globalDir, "commit.md"), "# 提交\n", "utf8");
    writeFileSync(join(projectDir, "review.md"), "# 审查\n", "utf8");
    writeFileSync(join(projectDir, "notes.txt"), "不是 md", "utf8");
    const commands = discoverCommands(globalDir, projectDir);
    expect(commands.map((command) => command.name)).toEqual(["commit", "review"]);
    expect(commands[0]?.scope).toBe("global");
    expect(commands[1]?.scope).toBe("project");
  });

  it("同名时项目覆盖全局", () => {
    const globalDir = makeTempDir();
    const projectDir = makeTempDir();
    writeFileSync(join(globalDir, "deploy.md"), "全局", "utf8");
    writeFileSync(join(projectDir, "deploy.md"), "项目", "utf8");
    const commands = discoverCommands(globalDir, projectDir);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.scope).toBe("project");
  });

  it("目录不存在返回空数组；非法文件名（含冒号/点等）跳过", () => {
    const globalDir = join(makeTempDir(), "missing");
    const projectDir = makeTempDir();
    writeFileSync(join(projectDir, "skill:evil.md"), "x", "utf8");
    writeFileSync(join(projectDir, "中文命令.md"), "x", "utf8");
    expect(discoverCommands(globalDir, projectDir).map((command) => command.name)).toEqual(["中文命令"]);
  });

  it("toCommandSummaries 读 frontmatter description", () => {
    const globalDir = makeTempDir();
    const projectDir = makeTempDir();
    writeFileSync(join(globalDir, "commit.md"), "---\ndescription: 生成提交信息\n---\n正文", "utf8");
    const summaries = toCommandSummaries(discoverCommands(globalDir, projectDir));
    expect(summaries[0]?.description).toBe("生成提交信息");
    expect(summaries[0]?.filePath).toBeTruthy();
  });
});

describe("expandCommandTemplate 模板展开", () => {
  it("$ARGUMENTS 与 ${ARGUMENTS} 占位符替换为参数", () => {
    expect(expandCommandTemplate("请审查 $ARGUMENTS 的改动", "src/app.ts")).toBe("请审查 src/app.ts 的改动");
    expect(expandCommandTemplate("请审查 ${ARGUMENTS} 的改动", "src/app.ts")).toBe("请审查 src/app.ts 的改动");
    expect(expandCommandTemplate("先 $ARGUMENTS 再 ${ARGUMENTS}", "A")).toBe("先 A 再 A");
  });

  it("空参数时占位符替换为空串（模板无占位符则原样）", () => {
    expect(expandCommandTemplate("总结当前分支改动：$ARGUMENTS", undefined)).toBe("总结当前分支改动：");
    expect(expandCommandTemplate("总结当前分支改动", undefined)).toBe("总结当前分支改动");
  });

  it("无占位符但有参数时追加在模板末尾（空行分隔）", () => {
    expect(expandCommandTemplate("生成一条提交信息", "fix: 登录崩溃")).toBe("生成一条提交信息\n\nfix: 登录崩溃");
  });

  it("模板首尾空白被裁剪，多行参数原样保留", () => {
    expect(expandCommandTemplate("  任务：$ARGUMENTS  ", "第一行\n第二行")).toBe("任务：第一行\n第二行");
  });

  it("只匹配全大写 ARGUMENTS，误写不替换", () => {
    expect(expandCommandTemplate("成本 $arguments 元", undefined)).toBe("成本 $arguments 元");
  });
});

describe("命令 prompt marker", () => {
  it("build 与 parse 往返：name 与参数（含中文/换行）无损", () => {
    const prompt = buildCommandPrompt("提交", "修复：\n1. 登录页", "展开后的正文");
    expect(prompt.startsWith("<!-- pidesktop-command-display:")).toBe(true);
    const parsed = parseCommandPrompt(prompt);
    expect(parsed).toEqual({ name: "提交", args: "修复：\n1. 登录页" });
    // marker 之后是展开正文
    expect(prompt.endsWith("展开后的正文")).toBe(true);
  });

  it("非命令消息（含 skill marker）不误判", () => {
    expect(parseCommandPrompt("普通消息")).toBeUndefined();
    expect(parseCommandPrompt("<!-- pidesktop-skill-display:abc -->\n正文")).toBeUndefined();
    expect(parseCommandPrompt("<!-- pidesktop-command-display:!!! -->\n正文")).toBeUndefined();
  });
});

describe("stripCommandFrontmatter / buildRuntimeCommandPrompt", () => {
  it("剥离 frontmatter 只留正文", () => {
    expect(stripCommandFrontmatter("---\ndescription: x\n---\n正文")).toBe("正文");
    expect(stripCommandFrontmatter("无 frontmatter")).toBe("无 frontmatter");
  });

  it("发送时重读模板：frontmatter 剥离 + 参数展开 + marker，一条龙", () => {
    const dir = makeTempDir();
    const file = join(dir, "commit.md");
    writeFileSync(file, "---\ndescription: 生成提交信息\n---\n按规范为以下改动生成提交：$ARGUMENTS", "utf8");
    const discovered: DiscoveredCommand[] = [{ name: "commit", description: "", filePath: file, scope: "global" }];
    const prompt = buildRuntimeCommandPrompt(discovered, "commit", "feat: xxx");
    const parsed = parseCommandPrompt(prompt);
    expect(parsed?.name).toBe("commit");
    expect(prompt.endsWith("按规范为以下改动生成提交：feat: xxx")).toBe(true);
  });

  it("命令不存在时抛出可读错误", () => {
    expect(() => buildRuntimeCommandPrompt([], "nope", undefined)).toThrow("未找到自定义命令");
  });
});
