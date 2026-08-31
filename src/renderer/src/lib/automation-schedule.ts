// 自动化任务调度方式：cron 表达式 ↔ 用户友好的预设（每小时/每天/…）互转纯函数。
// 预设覆盖最常见的单值/星号组合；其余表达式（区间、步长、多值等）一律归为「自定义」。

export type SchedulePreset = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface SchedulePresetOption {
  value: SchedulePreset;
  label: string;
}

export const SCHEDULE_PRESETS: SchedulePresetOption[] = [
  { value: "hourly", label: "每小时" },
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "每工作日" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "custom", label: "自定义表达式" }
];

export const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" }
];

export interface ScheduleParts {
  preset: SchedulePreset;
  minute: number;
  hour: number;
  weekday: number;
  monthDay: number;
}

/** 新建任务时的默认调度：每天 09:00。 */
export const DEFAULT_SCHEDULE_PARTS: ScheduleParts = { preset: "daily", minute: 0, hour: 9, weekday: 1, monthDay: 1 };

function plainNumber(field: string): number | null {
  return /^\d{1,2}$/u.test(field) ? Number(field) : null;
}

/**
 * 把 cron 表达式反推为预设 + 参数；不匹配任何预设（区间/步长/多值/超范围）时归为 custom。
 * 与 automation-cron 的纯 AND 语义对应：只识别每个字段为「单值」或「*」的组合。
 */
export function describeCron(cron: string): ScheduleParts {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) return { ...DEFAULT_SCHEDULE_PARTS, preset: "custom", minute: 0, hour: 0 };
  const [m, h, dom, mon, dow] = fields;
  if (m === undefined || h === undefined || dom === undefined || mon === undefined || dow === undefined) return { ...DEFAULT_SCHEDULE_PARTS, preset: "custom" };
  const minute = plainNumber(m);
  const hour = plainNumber(h);
  if (mon !== "*") return { ...DEFAULT_SCHEDULE_PARTS, preset: "custom" };
  // 每小时：第 M 分（小时及之后字段全星号）。
  if (h === "*" && dom === "*" && dow === "*" && minute !== null && minute <= 59) {
    return { ...DEFAULT_SCHEDULE_PARTS, preset: "hourly", minute };
  }
  if (minute === null || minute > 59 || hour === null || hour > 23) return { ...DEFAULT_SCHEDULE_PARTS, preset: "custom" };
  if (dom === "*" && dow === "*") return { ...DEFAULT_SCHEDULE_PARTS, preset: "daily", minute, hour };
  if (dom === "*" && dow === "1-5") return { ...DEFAULT_SCHEDULE_PARTS, preset: "weekdays", minute, hour };
  if (dom === "*") {
    const weekday = plainNumber(dow);
    if (weekday !== null && weekday <= 7) return { ...DEFAULT_SCHEDULE_PARTS, preset: "weekly", minute, hour, weekday: weekday === 7 ? 0 : weekday };
    return { ...DEFAULT_SCHEDULE_PARTS, preset: "custom" };
  }
  if (dow === "*") {
    const monthDay = plainNumber(dom);
    if (monthDay !== null && monthDay >= 1 && monthDay <= 31) return { ...DEFAULT_SCHEDULE_PARTS, preset: "monthly", minute, hour, monthDay };
  }
  return { ...DEFAULT_SCHEDULE_PARTS, preset: "custom" };
}

/** 由预设参数生成 cron 表达式（custom 返回空串，由调用方取用户输入）。 */
export function buildCron(parts: Pick<ScheduleParts, "preset" | "minute" | "hour" | "weekday" | "monthDay">): string {
  const { preset, minute, hour, weekday, monthDay } = parts;
  switch (preset) {
    case "hourly": return `${minute} * * * *`;
    case "daily": return `${minute} ${hour} * * *`;
    case "weekdays": return `${minute} ${hour} * * 1-5`;
    case "weekly": return `${minute} ${hour} * * ${weekday}`;
    case "monthly": return `${minute} ${hour} ${monthDay} * *`;
    default: return "";
  }
}

/** 两位数字补零（时间下拉显示 09:05 风格）。 */
export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
