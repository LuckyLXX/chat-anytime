import type { AutomationSchedule } from "./protocol.js";

/**
 * 自动化任务调度/提醒的纯展示与解析工具。
 *
 * main 侧（工具摘要、提醒文案）与 renderer 侧（设置页、聊天卡片、消息徽标）
 * 共用同一套文案，避免「5 分钟后」在三个地方各写一种口径。
 */

/** 是否一次性调度（after / at）。 */
export function isOneShotSchedule(schedule: AutomationSchedule): schedule is Extract<AutomationSchedule, { kind: "after" | "at" }> {
  return schedule.kind === "after" || schedule.kind === "at";
}

/** 把秒数写成人类可读时长（5 分钟 / 2 小时 30 分 / 45 秒）。 */
export function formatAutomationDelay(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地时区的 MM-DD HH:mm（一次性任务展示）。 */
function formatLocalInstant(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 一条调度规则的一行摘要。
 *
 * cron 保留表达式与时区；一次性任务显示本地目标时间与相对距离
 * （`仅一次 · 10-21 15:30（5 分钟后）`），已过期显示「已到期」。
 */
export function formatAutomationSchedule(schedule: AutomationSchedule, now = Date.now()): string {
  if (schedule.kind === "cron") {
    return `${schedule.cron}${schedule.timezone ? ` · ${schedule.timezone}` : " · 本地"}`;
  }
  const when = formatLocalInstant(schedule.scheduledAt);
  const diff = schedule.scheduledAt - now;
  if (diff <= 0) return `仅一次 · ${when}（已到期）`;
  return `仅一次 · ${when}（${formatAutomationDelay(Math.ceil(diff / 1000))}后）`;
}

/** 会话绑定任务到期时投递进原会话的提醒消息头。 */
export const SCHEDULED_REMINDER_PREFIX = "[定时任务提醒]";

/** 聊天里从投递消息中解析出的展示信息。 */
export interface ParsedScheduledReminder {
  /** 任务名（提醒头 `[定时任务提醒] 任务名` 的后半段）。 */
  title?: string;
  /** 去掉提醒头与元信息后的提示词正文。 */
  body: string;
}

/**
 * 解析会话绑定任务的投递消息，供聊天 UI 收起元信息、只展示任务名与提示词。
 *
 * 格式（由 main/automation-delivery.ts 生成）：
 * ```
 * [定时任务提醒] 任务名
 * 任务 ID：...
 * 计划时间：...
 * 说明：...
 *
 * <prompt>
 * ```
 * 非提醒消息返回 undefined，渲染端照常显示原文。
 */
export function parseScheduledReminderText(text: string): ParsedScheduledReminder | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(SCHEDULED_REMINDER_PREFIX)) return undefined;
  const lines = trimmed.split(/\r?\n/u);
  const header = (lines[0] ?? "").slice(SCHEDULED_REMINDER_PREFIX.length).trim();
  let index = 1;
  while (index < lines.length && (lines[index] ?? "").trim() !== "") index += 1;
  const body = lines.slice(index).join("\n").trim();
  return { ...(header ? { title: header } : {}), body };
}
