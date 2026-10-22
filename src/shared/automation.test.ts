import { describe, expect, it } from "vitest";
import { formatAutomationDelay, formatAutomationSchedule, isOneShotSchedule, parseScheduledReminderText } from "./automation.js";
import type { AutomationSchedule } from "./protocol.js";

const CRON: AutomationSchedule = { kind: "cron", cron: "0 9 * * 1-5" };
const AFTER: AutomationSchedule = { kind: "after", afterSeconds: 300, scheduledAt: new Date(2026, 9, 21, 15, 30).getTime() };
const AT: AutomationSchedule = { kind: "at", scheduledAt: new Date(2026, 9, 21, 15, 30).getTime() };

describe("formatAutomationDelay", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatAutomationDelay(45)).toBe("45 秒");
    expect(formatAutomationDelay(300)).toBe("5 分钟");
    expect(formatAutomationDelay(3_600)).toBe("1 小时");
    expect(formatAutomationDelay(9_000)).toBe("2 小时 30 分");
  });

  it("never renders zero", () => {
    expect(formatAutomationDelay(0)).toBe("1 秒");
  });
});

describe("formatAutomationSchedule", () => {
  it("keeps cron expression and zone", () => {
    expect(formatAutomationSchedule(CRON)).toBe("0 9 * * 1-5 · 本地");
    expect(formatAutomationSchedule({ kind: "cron", cron: "0 9 * * *", timezone: "Asia/Shanghai" })).toBe("0 9 * * * · Asia/Shanghai");
  });

  it("renders the one-shot local target and relative distance", () => {
    const now = new Date(2026, 9, 21, 15, 25).getTime();
    expect(formatAutomationSchedule(AFTER, now)).toBe("仅一次 · 10-21 15:30（5 分钟后）");
    expect(formatAutomationSchedule(AT, now)).toBe("仅一次 · 10-21 15:30（5 分钟后）");
  });

  it("marks an overdue one-shot as 已到期", () => {
    expect(formatAutomationSchedule(AFTER, AFTER.scheduledAt + 1)).toBe("仅一次 · 10-21 15:30（已到期）");
  });
});

describe("isOneShotSchedule", () => {
  it("distinguishes cron from after/at", () => {
    expect(isOneShotSchedule(CRON)).toBe(false);
    expect(isOneShotSchedule(AFTER)).toBe(true);
    expect(isOneShotSchedule(AT)).toBe(true);
  });
});

describe("parseScheduledReminderText", () => {
  it("extracts title and prompt body from the delivered reminder", () => {
    const text = [
      "[定时任务提醒] 检查后台任务",
      "任务 ID：task-1",
      "计划时间：2026-10-21 15:30",
      "说明：这是你在本会话中创建的定时任务触发消息，请直接结合上文继续处理。",
      "",
      "检查刚才启动的后台任务是否完成。"
    ].join("\n");
    expect(parseScheduledReminderText(text)).toEqual({
      title: "检查后台任务",
      body: "检查刚才启动的后台任务是否完成。"
    });
  });

  it("keeps a body-only reminder and ignores ordinary user text", () => {
    expect(parseScheduledReminderText("[定时任务提醒]\n\n继续执行")).toEqual({ body: "继续执行" });
    expect(parseScheduledReminderText("普通用户消息")).toBeUndefined();
  });
});
