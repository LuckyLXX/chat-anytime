import { describe, expect, it } from "vitest";
import { buildAutomationReminderText } from "./automation-delivery.js";
import { parseScheduledReminderText } from "../shared/automation.js";
import type { AutomationTask } from "../shared/protocol.js";

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: "task-1",
    name: "检查后台任务",
    schedule: { kind: "at", scheduledAt: new Date(2026, 9, 21, 15, 30).getTime() },
    prompt: "检查刚才启动的后台任务是否完成。",
    agentId: "default",
    accessMode: "full",
    enabled: true,
    createdAt: 0,
    ...overrides
  };
}

describe("buildAutomationReminderText", () => {
  it("renders the reminder header, task id, time, and original prompt", () => {
    const text = buildAutomationReminderText(task());
    expect(text).toContain("[定时任务提醒] 检查后台任务");
    expect(text).toContain("任务 ID：task-1");
    expect(text).toContain("计划时间：");
    expect(text.endsWith("检查刚才启动的后台任务是否完成。")).toBe(true);
    expect(parseScheduledReminderText(text)).toEqual({
      title: "检查后台任务",
      body: "检查刚才启动的后台任务是否完成。"
    });
  });

  it("keeps cron tasks readable too", () => {
    const text = buildAutomationReminderText(task({ schedule: { kind: "cron", cron: "0 9 * * *" } }));
    expect(text).toContain("[定时任务提醒] 检查后台任务");
    expect(text).toContain("计划时间：");
  });
});
