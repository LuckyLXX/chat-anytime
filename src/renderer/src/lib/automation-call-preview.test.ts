import { describe, expect, it } from "vitest";
import { automationTaskIdFromOutput, parseAutomationCreateArgs } from "./automation-call-preview";

describe("parseAutomationCreateArgs", () => {
  it("parses cron, after, and at calls", () => {
    expect(parseAutomationCreateArgs({ name: "巡检", cron: "0 9 * * *" })?.schedule.kind).toBe("cron");
    const after = parseAutomationCreateArgs({ name: "检查", after_seconds: 300, prompt: "检查后台任务" });
    expect(after?.schedule.kind).toBe("after");
    if (after?.schedule.kind === "after") expect(after.schedule.afterSeconds).toBe(300);
    expect(parseAutomationCreateArgs({ name: "一次", at: new Date(Date.now() + 60_000).toISOString() })?.schedule.kind).toBe("at");
  });

  it("accepts JSON strings and falls back to the prompt first line", () => {
    const preview = parseAutomationCreateArgs(JSON.stringify({ prompt: "检查后台任务\n然后汇报", after_seconds: 60 }));
    expect(preview?.name).toBe("检查后台任务");
  });

  it("returns undefined for malformed input", () => {
    expect(parseAutomationCreateArgs(undefined)).toBeUndefined();
    expect(parseAutomationCreateArgs("{ bad json")).toBeUndefined();
    expect(parseAutomationCreateArgs({ name: "x" })).toBeUndefined();
  });
});

describe("automationTaskIdFromOutput", () => {
  it("extracts the id from the create result", () => {
    expect(automationTaskIdFromOutput("已创建定时任务：#0f8fad5b-d9cb-469f-a165-70867728950e 检查（仅一次…）")).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
  });

  it("returns undefined for empty or unrelated output", () => {
    expect(automationTaskIdFromOutput(undefined)).toBeUndefined();
    expect(automationTaskIdFromOutput("创建失败")).toBeUndefined();
  });
});
