import { describe, expect, it } from "vitest";
import type { AutomationTask } from "../../../shared/protocol.js";
import { AUTOMATION_TOAST_ERROR_MAX, automationRunToastMessage, automationTaskState, automationTaskStateRank, formatElapsed, formatShortTime, workspaceDisplayName } from "./automation-task-view.js";

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: "task-1",
    name: "日报",
    schedule: { kind: "cron", cron: "0 9 * * *" },
    prompt: "汇总",
    agentId: "default",
    accessMode: "full",
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides
  };
}

describe("automation task view", () => {
  it("derives the state with running > completed > paused > scheduled", () => {
    expect(automationTaskState(task(), "task-1")).toBe("running");
    expect(automationTaskState(task(), undefined)).toBe("scheduled");
    expect(automationTaskState(task({ enabled: false }), undefined)).toBe("paused");
    expect(automationTaskState(task({ completedAt: 1 }), undefined)).toBe("completed");
    expect(automationTaskState(task({ workspaceIssue: "目录不存在", enabled: false }), undefined)).toBe("issue");
    expect(automationTaskStateRank("running")).toBeLessThan(automationTaskStateRank("scheduled"));
  });

  it("formats short times and durations for both management surfaces", () => {
    const now = new Date(2026, 10, 3, 12, 0).getTime();
    expect(formatShortTime(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe("今天 09:05");
    expect(formatShortTime(new Date(2026, 10, 2, 9, 5).getTime(), now)).toBe("昨天 09:05");
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(92_000)).toBe("1m32s");
    expect(workspaceDisplayName("D:/Projects/PiDesktop")).toBe("PiDesktop");
    expect(workspaceDisplayName(undefined)).toBeUndefined();
  });

  // 2026-11-03 用户要求「自动化结果不弹窗」：成功与投递静默，结果只在运行记录里看。
  it("only surfaces failures and aborts as a toast", () => {
    expect(automationRunToastMessage({ status: "ok", taskName: "日报" })).toBeUndefined();
    expect(automationRunToastMessage({ status: "delivered", taskName: "日报" })).toBeUndefined();
    expect(automationRunToastMessage({ status: "running", taskName: "日报" })).toBeUndefined();
    expect(automationRunToastMessage({ status: "aborted", taskName: "日报" })).toBe("「日报」运行已中止");
    expect(automationRunToastMessage({ status: "aborted" })).toBe("定时任务运行已中止");
    expect(automationRunToastMessage({ status: "error", taskName: "日报", message: "工作区不存在" })).toBe("「日报」运行失败：工作区不存在");
    expect(automationRunToastMessage({ status: "error" })).toBe("运行失败");
    const long = "失".repeat(AUTOMATION_TOAST_ERROR_MAX + 10);
    expect(automationRunToastMessage({ status: "error", taskName: "日报", message: long })).toBe(`「日报」运行失败：${"失".repeat(AUTOMATION_TOAST_ERROR_MAX)}…`);
  });
});
