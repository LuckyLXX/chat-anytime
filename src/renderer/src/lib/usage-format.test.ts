import { describe, expect, it } from "vitest";
import type { UsageDayEntry } from "../../../shared/protocol";
import { formatCost, formatDayLabel, formatHitRate, formatLastUsed, formatTokenCount, shiftLocalDate, todayLocalDate, windowTotalsFromDays } from "./usage-format";

describe("usage-format", () => {
  it("缩写 token 数", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(12_300)).toBe("12.3k");
    expect(formatTokenCount(120_000)).toBe("120k");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });

  it("成本与命中率列的空值形态", () => {
    expect(formatCost(0)).toBe("—");
    expect(formatCost(1.005)).toBe("$1.00");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatHitRate(null)).toBe("—");
    expect(formatHitRate(66.66)).toBe("66.7%");
  });

  it("本地日期与平移", () => {
    expect(todayLocalDate(new Date(2026, 7, 30, 23, 59))).toBe("2026-08-30");
    expect(shiftLocalDate("2026-08-01", -1)).toBe("2026-07-31");
    expect(shiftLocalDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftLocalDate("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("日期列：今天/今年内/跨年", () => {
    expect(formatDayLabel("2026-08-30", "2026-08-30")).toBe("今天");
    expect(formatDayLabel("2026-08-01", "2026-08-30")).toBe("08-01");
    expect(formatDayLabel("2025-12-31", "2026-08-30")).toBe("2025-12-31");
  });

  it("最近使用列：同日时刻/今年/跨年", () => {
    const now = new Date(2026, 7, 30, 20, 0);
    expect(formatLastUsed(new Date(2026, 7, 30, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatLastUsed(new Date(2026, 0, 15).getTime(), now)).toBe("01-15");
    expect(formatLastUsed(new Date(2025, 11, 31).getTime(), now)).toBe("2025-12-31");
    expect(formatLastUsed(0, now)).toBe("—");
  });

  it("时间窗合计：只并入窗口内日期，命中率按窗口内口径重算", () => {
    const byDay: UsageDayEntry[] = [
      { date: "2026-08-20", requests: 10, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 1 },
      { date: "2026-08-28", requests: 2, input: 300, output: 100, cacheRead: 100, cacheWrite: 100, cost: 0.5 },
      { date: "2026-08-30", requests: 1, input: 100, output: 50, cacheRead: 300, cacheWrite: 0, cost: 0.2 }
    ];
    const week = windowTotalsFromDays(byDay, "2026-08-30", 7);
    expect(week.requests).toBe(3);
    expect(week.input).toBe(400);
    expect(week.output).toBe(150);
    expect(week.cacheRead).toBe(400);
    expect(week.cost).toBeCloseTo(0.7);
    expect(week.cacheHitRate).toBeCloseTo((400 / 900) * 100);
    const today = windowTotalsFromDays(byDay, "2026-08-30", 1);
    expect(today.requests).toBe(1);
    expect(today.cacheHitRate).toBeCloseTo(75);
  });
});
