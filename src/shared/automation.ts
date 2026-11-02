import type { AutomationSchedule } from "./protocol.js";
import { parseCron } from "./automation-cron.js";

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

/** 星期短名（周日 … 周六），用于「下次触发」的相对日期。 */
const WEEKDAY_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/**
 * 计算下一次触发时间（epoch ms）。
 *
 * P0 只精确支持**本地时区**：带 IANA `timezone` 的 cron 返回 undefined，界面显示
 * 「按计划」，避免在渲染端做昂贵且易错的时区反算（P1 再补）。
 *
 * cron 按「日 → 时 → 分」推进而不是逐分钟扫描：每天先做一次 月/日/星期 的集合
 * 判断，命中后再取当天最近的 时/分，年度任务也只需 366 次日判断。
 */
export function nextAutomationRun(schedule: AutomationSchedule, now = Date.now()): number | undefined {
  if (schedule.kind !== "cron") {
    return schedule.scheduledAt > now ? schedule.scheduledAt : undefined;
  }
  if (schedule.timezone) return undefined;
  let cron;
  try {
    cron = parseCron(schedule.cron);
  } catch {
    return undefined;
  }
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const from = start.getTime();
  const hours = [...cron.hour].sort((a, b) => a - b);
  const minutes = [...cron.minute].sort((a, b) => a - b);
  for (let dayOffset = 0; dayOffset <= 366; dayOffset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    if (!cron.month.has(day.getMonth() + 1)) continue;
    // 与调度器同一口径：日与星期是纯 AND（不是 Vixie 的 OR）。
    if (!cron.day.has(day.getDate()) || !cron.dayOfWeek.has(day.getDay())) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
        if (candidate >= from) return candidate;
      }
    }
  }
  return undefined;
}

/**
 * 「下次触发」的一行展示：今天/明天/周几/日期 + 相对时间。
 * 传入非法值返回 undefined，调用方自行决定占位文案。
 */
export function formatAutomationNextRun(nextAt: number | undefined, now = Date.now()): string | undefined {
  if (nextAt === undefined || !Number.isFinite(nextAt)) return undefined;
  const date = new Date(nextAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThatDay = new Date(nextAt);
  startOfThatDay.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((startOfThatDay.getTime() - startOfToday.getTime()) / 86_400_000);
  const dayLabel = dayDiff === 0
    ? `今天 ${time}`
    : dayDiff === 1
      ? `明天 ${time}`
      : dayDiff > 1 && dayDiff < 7
        ? `${WEEKDAY_SHORT[date.getDay()]} ${time}`
        : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  const diff = nextAt - now;
  if (diff <= 0) return `${dayLabel} · 已到期`;
  const relative = diff < 3_600_000
    ? `${Math.max(1, Math.ceil(diff / 60_000))} 分钟后`
    : diff < 86_400_000
      ? `${Math.floor(diff / 3_600_000)} 小时后`
      : `${dayDiff} 天后`;
  return `${dayLabel} · ${relative}`;
}
