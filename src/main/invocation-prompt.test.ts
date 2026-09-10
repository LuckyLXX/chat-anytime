import { describe, expect, it } from "vitest";
import { buildCommandPrompt } from "./command-catalog.js";
import { buildMultiInvocationPrompt, composeInvocationBody, parseInvocationPrompt, sameInvocations } from "./invocation-prompt.js";
import { buildSkillPrompt } from "./skill-prompt.js";

describe("斜杠调用展示 marker", () => {
  it("多调用 build 与 parse 往返：调用清单（含中文名）与共享文本无损", () => {
    const invocations = [{ kind: "skill" as const, name: "design-taste" }, { kind: "command" as const, name: "提交" }];
    const text = "修复登录页：\n1. 保持风格一致";
    const prompt = buildMultiInvocationPrompt(invocations, text, "合并正文");

    expect(prompt.startsWith("<!-- pidesktop-invoke-display:")).toBe(true);
    expect(prompt.endsWith("合并正文")).toBe(true);
    expect(parseInvocationPrompt(prompt)).toEqual({ invocations, text });
  });

  it("旧 marker 归一成单项调用（读旧会话与读新消息同一口径）", () => {
    expect(parseInvocationPrompt(buildSkillPrompt("demo", "要求", "正文"))).toEqual({ invocations: [{ kind: "skill", name: "demo" }], text: "要求" });
    expect(parseInvocationPrompt(buildCommandPrompt("commit", "feat: x", "正文"))).toEqual({ invocations: [{ kind: "command", name: "commit" }], text: "feat: x" });
  });

  it("坏 marker 与普通文本都不误判", () => {
    const broken = buildMultiInvocationPrompt([], "", "正文");
    expect(parseInvocationPrompt(broken)).toBeUndefined();
    expect(parseInvocationPrompt("请检查这个项目并修复测试。")).toBeUndefined();
    expect(parseInvocationPrompt("<!-- pidesktop-invoke-display:!!! -->\n正文")).toBeUndefined();
  });
});

describe("多调用正文合并", () => {
  it("各调用一段小标题，共享文本只在末尾出现一次", () => {
    const body = composeInvocationBody([
      { kind: "skill", name: "a", body: "读取 SKILL.md" },
      { kind: "command", name: "commit", body: "按规范生成提交信息：" }
    ], "修复登录");

    expect(body).toBe([
      "使用以下 Skill / 命令完成任务（共 2 项，按顺序执行）。",
      "【Skill：a】\n读取 SKILL.md",
      "【命令：/commit】\n按规范生成提交信息：",
      "用户要求：\n修复登录"
    ].join("\n\n"));
    expect(body.match(/修复登录/g)).toHaveLength(1);
  });

  it("无共享文本时不输出空的「用户要求」段", () => {
    const body = composeInvocationBody([{ kind: "skill", name: "a", body: "读取 SKILL.md" }], "   ");
    expect(body).not.toContain("用户要求");
    expect(body.endsWith("读取 SKILL.md")).toBe(true);
  });
});

describe("调用清单比较（regenerate 定位）", () => {
  it("顺序与种类都参与比较", () => {
    const base = [{ kind: "skill" as const, name: "a" }, { kind: "command" as const, name: "b" }];
    expect(sameInvocations(base, [{ kind: "skill", name: "a" }, { kind: "command", name: "b" }])).toBe(true);
    expect(sameInvocations(base, [{ kind: "command", name: "b" }, { kind: "skill", name: "a" }])).toBe(false);
    expect(sameInvocations(base, [{ kind: "skill", name: "a" }])).toBe(false);
    expect(sameInvocations(undefined, undefined)).toBe(true);
    expect(sameInvocations(undefined, base)).toBe(false);
  });
});
