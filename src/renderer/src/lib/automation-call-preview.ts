import type { AutomationSchedule } from "../../../shared/protocol";

/**
 * 聊天里 `automation_create` 工具调用的纯展示解析。
 * 调用参数可能来自流式 JSON（对象或损坏的字符串），因此全部防御式读取，
 * 解析失败返回 undefined，由通用工具卡片兜底。
 */

export interface AutomationCallPreview {
  name: string;
  schedule: AutomationSchedule;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/u)[0]?.trim() ?? "";
}

/** 从 automation_create 的调用参数解析卡片标题与触发方式。 */
export function parseAutomationCreateArgs(args: unknown): AutomationCallPreview | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  const prompt = typeof record.prompt === "string" ? record.prompt : "";
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : firstLine(prompt) || "定时任务";
  const timezone = typeof record.timezone === "string" && record.timezone.trim() ? record.timezone.trim() : undefined;
  const cron = typeof record.cron === "string" ? record.cron.trim() : "";
  if (cron) return { name, schedule: { kind: "cron", cron, ...(timezone ? { timezone } : {}) } };

  const afterSeconds = typeof record.after_seconds === "number" ? record.after_seconds : undefined;
  if (afterSeconds !== undefined && Number.isFinite(afterSeconds) && afterSeconds > 0) {
    return { name, schedule: { kind: "after", afterSeconds, scheduledAt: Date.now() + afterSeconds * 1_000 } };
  }

  const at = typeof record.at === "string" ? record.at.trim() : "";
  const scheduledAt = at ? Date.parse(at) : Number.NaN;
  if (Number.isFinite(scheduledAt)) return { name, schedule: { kind: "at", scheduledAt } };
  return undefined;
}

/** 从 automation_create 的文本输出 `已创建定时任务：#<id> ...` 解析任务 id。 */
export function automationTaskIdFromOutput(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match = /#([A-Za-z0-9_-]+)/u.exec(output);
  return match?.[1];
}
