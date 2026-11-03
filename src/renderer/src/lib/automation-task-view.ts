import type { AutomationTask } from "../../../shared/protocol.js";

/**
 * 自动化任务在渲染端的展示口径（2026-11-02 P1 抽取）。
 *
 * 面板（AutomationPanel）与管理页（AutomationCenter）必须共用同一套状态/时间
 * 文案：两处各写一份最容易出现「面板说运行中、管理页说已暂停」的口径漂移。
 * 这里只放纯函数，方便单测。
 */

export type AutomationTaskState = "running" | "scheduled" | "paused" | "completed" | "issue";

export const AUTOMATION_STATE_LABEL: Record<AutomationTaskState, string> = {
  running: "运行中",
  scheduled: "已排定",
  paused: "已暂停",
  completed: "已完成",
  issue: "需修复"
};

export const AUTOMATION_LAST_RUN_LABEL: Record<NonNullable<AutomationTask["lastRun"]>["status"], string> = {
  ok: "成功",
  error: "失败",
  aborted: "已中止",
  delivered: "已投递"
};

/** 状态优先级：运行中 → 已排定 → 已暂停 → 已完成 → 需修复。 */
export function automationTaskState(task: AutomationTask, runningTaskId: string | undefined): AutomationTaskState {
  if (task.workspaceIssue) return "issue";
  if (runningTaskId === task.id) return "running";
  if (task.completedAt) return "completed";
  if (!task.enabled) return "paused";
  return "scheduled";
}

export function automationTaskStateRank(state: AutomationTaskState): number {
  return state === "running" ? 0 : state === "scheduled" ? 1 : state === "paused" ? 2 : state === "completed" ? 3 : 4;
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** HH:mm（本地时区）。 */
export function formatClock(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 任务/运行历史里的短时间：今天/昨天/MM-DD + HH:mm。 */
export function formatShortTime(ts: number, now: number): string {
  const date = new Date(ts);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThatDay = new Date(ts);
  startOfThatDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((startOfToday.getTime() - startOfThatDay.getTime()) / 86_400_000);
  if (diffDays === 0) return `今天 ${formatClock(ts)}`;
  if (diffDays === 1) return `昨天 ${formatClock(ts)}`;
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(ts)}`;
}

/** 运行时长：12s / 1m32s。 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${pad2(seconds % 60)}s`;
}

/**
 * 一次自动化运行终态该不该弹应用内提示条（2026-11-03 用户要求「自动化结果不弹窗」）。
 *
 * 成功（ok）与投递（delivered）静默：结果本来就在运行记录里，定时任务一天跑几次、
 * 每次弹一条「运行完成 + 查看结果」只是打扰；只有失败（error）与中止（aborted）
 * 这类异常才提示，免得问题被淹没。运行中（running）由运行记录面板顶部的条目承载。
 *
 * 返回 undefined = 不弹；返回字符串 = 提示文案（调用方决定是否可跳转运行记录）。
 */
export const AUTOMATION_TOAST_ERROR_MAX = 120;

export function automationRunToastMessage(run: {
  status: "ok" | "error" | "aborted" | "delivered" | "running";
  taskName?: string;
  message?: string;
}): string | undefined {
  if (run.status === "running" || run.status === "ok" || run.status === "delivered") return undefined;
  const name = run.taskName ? `「${run.taskName}」` : "";
  if (run.status === "aborted") return name ? `${name}运行已中止` : "定时任务运行已中止";
  // 中止不是失败：单独一句中性文案，不套「运行失败」。
  const detail = run.message
    ? `：${run.message.length > AUTOMATION_TOAST_ERROR_MAX ? `${run.message.slice(0, AUTOMATION_TOAST_ERROR_MAX)}…` : run.message}`
    : "";
  return `${name}运行失败${detail}`;
}

/** 工作区路径的末级目录（展示用）；元信息缺失时 undefined。 */
export function workspaceDisplayName(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/[\\/]/u).at(-1) || trimmed;
}
