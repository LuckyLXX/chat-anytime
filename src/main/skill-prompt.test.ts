import { describe, expect, it } from "vitest";
import { buildSkillPrompt, parseSkillPrompt } from "./skill-prompt.js";

describe("Skill prompt display metadata", () => {
  it("round trips display metadata without changing the execution prompt", () => {
    const executionPrompt = "使用 Skill「imagegen」完成任务。\n\n读取内部 Skill 文件。";
    const prompt = buildSkillPrompt("imagegen", "生成一张桌面壁纸", executionPrompt);

    expect(prompt).toContain(executionPrompt);
    expect(parseSkillPrompt(prompt)).toEqual({ name: "imagegen", instructions: "生成一张桌面壁纸" });
  });

  it("preserves Unicode and multiline user instructions", () => {
    const instructions = "生成秦时明月角色合集\n比例 16:9\n不要添加文字";
    const prompt = buildSkillPrompt("rolldek-image", instructions, "internal execution prompt");

    expect(parseSkillPrompt(prompt)).toEqual({ name: "rolldek-image", instructions });
  });

  it("parses persisted legacy expanded Skill prompts", () => {
    const prompt = [
      "使用 Skill「rolldek-image」完成任务。",
      "首先调用 read 工具读取 Skill 文件：C:\\Users\\demo\\SKILL.md",
      "完整阅读后遵循其中的说明；其中的相对路径均以该 Skill 文件所在目录为基准。",
      "用户要求：\n生成桌面壁纸"
    ].join("\n\n");

    expect(parseSkillPrompt(prompt)).toEqual({ name: "rolldek-image", instructions: "生成桌面壁纸" });
  });

  it("does not classify ordinary user text as a Skill prompt", () => {
    expect(parseSkillPrompt("请检查这个项目并修复测试。")).toBeUndefined();
  });
});
