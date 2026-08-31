/**
 * 轻量 cron 匹配器（纯函数，零依赖），服务于自动化定时任务。
 *
 * 支持标准 5 字段：分 时 日 月 周
 *  - 分钟 0-59 / 小时 0-23 / 日 1-31 / 月 1-12 / 周 0-7（0 与 7 均为周日）
 *  - 语法：星号、`a,b,c`（列表）、`a-b`（区间）、步长（`星号/n`、`a-b/n`、`d/n`——从 d 出发按 n 步进到字段上限）
 *  - 匹配语义：5 字段各自命中即「与」；不实现 Vixie cron 的 dom/dow 或关系（大多数用户按纯与理解，简单可预期）。
 *  - 时区：缺省使用 date 的本地字段；传 IANA 时区名时换算到该时区后比对。
 */

export interface CronField {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

export interface ZonedDateParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  dayOfWeek: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function parseField(field: string, min: number, max: number, normalizeDow: boolean): Set<number> {
  const result = new Set<number>();
  if (field.trim() === "") throw new Error(`cron 字段为空：${JSON.stringify(field)}`);
  // 通配/步长的自然上限：dow 只有 0-6 共 7 天（7 是 0 的别名，仅显式书写时接受）。
  const wildMax = normalizeDow ? 6 : max;
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) throw new Error(`cron 字段存在空项：${JSON.stringify(field)}`);
    const stepMatch = /^(.*?)\/(\d+)$/u.exec(part);
    let base = part;
    let step = 1;
    const hasStep = Boolean(stepMatch);
    if (stepMatch) {
      base = stepMatch[1] ?? part;
      step = Number.parseInt(stepMatch[2] ?? "", 10);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`cron 步长非法：${JSON.stringify(part)}`);
    }
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = wildMax;
    } else if (base.includes("-")) {
      const dash = base.indexOf("-");
      const a = Number.parseInt(base.slice(0, dash), 10);
      const b = Number.parseInt(base.slice(dash + 1), 10);
      if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`cron 区间非法：${JSON.stringify(part)}`);
      start = a;
      end = b;
    } else {
      const value = Number.parseInt(base, 10);
      if (Number.isNaN(value)) throw new Error(`cron 值非法：${JSON.stringify(part)}`);
      // 无步长 = 字面单值；`d/n` = 从 d 出发按 n 步进到自然上限（如分钟 `5/15` = 5,20,35,50）。
      start = value;
      end = hasStep ? wildMax : value;
    }
    if (start < min || start > max || end < min || end > max || start > end) {
      throw new Error(`cron 字段越界：${JSON.stringify(part)}（允许 ${min}-${max}）`);
    }
    for (let value = start; value <= end; value += step) {
      if (normalizeDow && value === 7) result.add(0);
      else result.add(value);
    }
  }
  if (normalizeDow && result.has(7)) result.add(0);
  return result;
}

/** 解析 cron 表达式为 5 个数值集合；非法抛错。 */
export function parseCron(expr: string): CronField {
  const normalized = expr.trim().replace(/\s+/gu, " ");
  if (normalized === "") throw new Error("cron 表达式为空");
  const fields = normalized.split(" ");
  if (fields.length !== 5) throw new Error(`cron 需要 5 个字段，收到 ${fields.length} 个：${JSON.stringify(expr)}`);
  return {
    minute: parseField(fields[0]!, 0, 59, false),
    hour: parseField(fields[1]!, 0, 23, false),
    day: parseField(fields[2]!, 1, 31, false),
    month: parseField(fields[3]!, 1, 12, false),
    dayOfWeek: parseField(fields[4]!, 0, 7, true)
  };
}

/** 校验 cron 表达式是否合法（parseCron 不抛即合法）。 */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/** 把 date（或其时区换算）拆成 cron 比对所需的墙钟字段。 */
export function zonedDateParts(date: Date, timeZone?: string): ZonedDateParts {
  if (!timeZone) {
    return { minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(), month: date.getMonth() + 1, dayOfWeek: date.getDay() };
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short"
  });
  const parts = formatter.formatToParts(date);
  const valueOf = (type: string): string | undefined => parts.find((part) => part.type === type)?.value;
  let hour = Number(valueOf("hour") ?? 0);
  if (hour === 24) hour = 0; // Intl 在 hour12:false 下午夜可能输出 24。
  const dayOfWeekName = valueOf("weekday") ?? "";
  const dayOfWeekIndex = WEEKDAY_INDEX[dayOfWeekName];
  return {
    minute: Number(valueOf("minute") ?? 0),
    hour,
    day: Number(valueOf("day") ?? 0),
    month: Number(valueOf("month") ?? 0),
    dayOfWeek: dayOfWeekIndex === undefined ? -1 : dayOfWeekIndex
  };
}

/** date 在（可选的）时区下是否命中 cron 表达式。 */
export function cronMatches(expr: string, date: Date, timeZone?: string): boolean {
  const parsed = parseCron(expr);
  const parts = zonedDateParts(date, timeZone);
  return (
    parsed.minute.has(parts.minute) &&
    parsed.hour.has(parts.hour) &&
    parsed.day.has(parts.day) &&
    parsed.month.has(parts.month) &&
    parsed.dayOfWeek.has(parts.dayOfWeek)
  );
}
