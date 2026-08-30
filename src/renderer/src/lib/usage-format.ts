// 用量统计的展示格式化与时间窗聚合（设置页「用量统计」tab）。
// 全部纯函数：token 数缩写、日期列、今日/近 7 天窗口合计。

import type { UsageDayEntry, UsageTotals } from "../../../shared/protocol";

/** token 数缩写：0.9k / 12.3k / 1.2M；千位以下原样。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = value / 1_000_000;
  return `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

/** 成本列：0 显示「—」，否则保留两位小数并加 $。 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `$${value.toFixed(2)}`;
}

/** 本地时区今天 YYYY-MM-DD（与主进程聚合口径一致）。 */
export function todayLocalDate(now: Date = new Date()): string {
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 本地日期字符串平移 N 天（YYYY-MM-DD，跨月/年安全）。 */
export function shiftLocalDate(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  const shifted = new Date(year, month - 1, day + days);
  const m = `${shifted.getMonth() + 1}`.padStart(2, "0");
  const d = `${shifted.getDate()}`.padStart(2, "0");
  return `${shifted.getFullYear()}-${m}-${d}`;
}

/** 表格日期列：今年内显示 MM-DD，跨年带年份。 */
export function formatDayLabel(date: string, today: string = todayLocalDate()): string {
  if (date === today) return "今天";
  if (date.slice(0, 4) === today.slice(0, 4)) return date.slice(5);
  return date;
}

/** 「最近使用」列：同日显示 HH:mm，否则 MM-DD（跨年带年份）。 */
export function formatLastUsed(ts: number, now: Date = new Date()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const date = new Date(ts);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}-${monthDay}`;
}

/**
 * 把按天条目合并成时间窗合计（今日=1 天、近 7 天=7 天）。
 * dateRange 只含今天之前有数据的日期；窗口按日期字符串比较。
 */
export function windowTotalsFromDays(byDay: readonly UsageDayEntry[], today: string, days: number): UsageTotals {
  const start = shiftLocalDate(today, -(days - 1));
  const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  for (const entry of byDay) {
    if (entry.date < start || entry.date > today) continue;
    totals.requests += entry.requests;
    totals.input += entry.input;
    totals.output += entry.output;
    totals.cacheRead += entry.cacheRead;
    totals.cacheWrite += entry.cacheWrite;
    totals.reasoning += entry.reasoning ?? 0;
    totals.cost += entry.cost;
  }
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    ...totals,
    cacheHitRate: promptTokens > 0 ? (totals.cacheRead / promptTokens) * 100 : null
  };
}

/** 命中率列：null 显示「—」。 */
export function formatHitRate(rate: number | null): string {
  return rate === null || !Number.isFinite(rate) ? "—" : `${rate.toFixed(1)}%`;
}
