import type { AutomationTask } from "../shared/protocol.js";
import { SCHEDULED_REMINDER_PREFIX } from "../shared/automation.js";

/**
 * 会话绑定任务到期时投递进原会话的提醒文本。
 *
 * 语义：这是「用户之前创建的一条定时任务」触发的普通消息，不是系统指令。
 * 因此保留 `[定时任务提醒]` 头 + 任务 id/计划时间，正文原样放用户提示词，
 * 让模型能直接利用原会话上下文继续处理。
 */
export function buildAutomationReminderText(task: AutomationTask, now = Date.now()): string {
  const schedule = task.schedule;
  const plannedAt = schedule.kind === "cron"
    ? new Date(now).toLocaleString("zh-CN")
    : new Date(schedule.scheduledAt).toLocaleString("zh-CN");
  const taskId = task.id;
  return [
    `${SCHEDULED_REMINDER_PREFIX} ${task.name}`,
    `任务 ID：${taskId}`,
    `计划时间：${plannedAt}`,
    "说明：这是你在本会话中创建的定时任务触发消息，请直接结合上文继续处理。",
    "",
    task.prompt
  ].join("\n");
}
