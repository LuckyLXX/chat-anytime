import { describe, expect, it } from "vitest";
import { cronMatches, isValidCron, parseCron, zonedDateParts } from "./automation-cron.js";

describe("parseCron", () => {
  it("parses a wildcard expression into full ranges", () => {
    const parsed = parseCron("* * * * *");
    expect(parsed.minute.size).toBe(60);
    expect(parsed.hour.size).toBe(24);
    expect(parsed.day.size).toBe(31);
    expect(parsed.month.size).toBe(12);
    expect(parsed.dayOfWeek.size).toBe(7);
  });

  it("expands step values (`*/15`) and `d/n`", () => {
    const step = parseCron("*/15 * * * *");
    expect([...step.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    const fromFive = parseCron("5/15 * * * *");
    expect([...fromFive.minute].sort((a, b) => a - b)).toEqual([5, 20, 35, 50]);
  });

  it("expands lists and ranges", () => {
    const parsed = parseCron("0 9 * 1-3 1,3,5");
    expect([...parsed.hour]).toEqual([9]);
    expect([...parsed.month].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...parsed.dayOfWeek].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it("treats 0 and 7 as Sunday in day-of-week", () => {
    const parsed = parseCron("0 0 * * 7");
    expect(parsed.dayOfWeek.has(0)).toBe(true);
    expect(parsed.dayOfWeek.has(7)).toBe(false);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCron("")).toThrow();
    expect(() => parseCron("* * * *")).toThrow(); // 4 fields
    expect(() => parseCron("60 * * * *")).toThrow(); // minute out of range
    expect(() => parseCron("0 24 * * *")).toThrow(); // hour out of range
    expect(() => parseCron("0 0 0 * *")).toThrow(); // day of month 0
    expect(() => parseCron("0 0 * * 8")).toThrow(); // dow 8
    expect(() => parseCron("*/0 * * * *")).toThrow(); // step 0
    expect(() => parseCron("a * * * *")).toThrow(); // non numeric
    expect(() => parseCron("5-1 * * * *")).toThrow(); // inverted range
  });

  it("isValidCron mirrors parseCron without throwing", () => {
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("bad")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });
});

describe("cronMatches", () => {
  it("matches any minute for `* * * * *` (using a few chosen wall clocks)", () => {
    for (const date of [new Date(2026, 5, 1, 0, 0), new Date(2026, 5, 1, 23, 59)]) {
      expect(cronMatches("* * * * *", date)).toBe(true);
    }
  });

  it("matches weekdays at 09:00 and skips weekends", () => {
    const cron = "0 9 * * 1-5";
    // Find a weekday and a weekend in the same month.
    const base = new Date(2026, 5, 1, 9, 0); // 2026-06-01
    let weekday: Date | undefined;
    let weekend: Date | undefined;
    for (let day = 1; day <= 30; day += 1) {
      const candidate = new Date(2026, 5, day, 9, 0);
      const dow = candidate.getDay();
      if (dow >= 1 && dow <= 5 && !weekday) weekday = candidate;
      if ((dow === 0 || dow === 6) && !weekend) weekend = candidate;
    }
    expect(weekday).toBeDefined();
    expect(weekend).toBeDefined();
    expect(cronMatches(cron, weekday!)).toBe(true);
    expect(cronMatches(cron, weekend!)).toBe(false);
  });

  it("does not match when the hour differs even on a valid weekday", () => {
    const base = new Date(2026, 5, 1, 10, 0);
    const dow = base.getDay();
    if (dow >= 1 && dow <= 5) {
      expect(cronMatches("0 9 * * 1-5", base)).toBe(false);
    }
  });

  it("applies a timezone when provided", () => {
    // 2026-06-01T00:30Z is 08:30 in Asia/Shanghai (+8) and 00:30 UTC.
    const date = new Date(Date.UTC(2026, 5, 1, 0, 30));
    // UTC views: 00:30 → `30 0 * * *` matches; Shanghai views: 08:30 → `30 8 * * *` matches too.
    expect(cronMatches("30 0 * * *", date, "UTC")).toBe(true);
    expect(cronMatches("30 8 * * *", date, "Asia/Shanghai")).toBe(true);
    expect(cronMatches("30 9 * * *", date, "Asia/Shanghai")).toBe(false);
  });
});

describe("zonedDateParts", () => {
  it("returns local wall-clock parts when no timezone", () => {
    const date = new Date(2026, 5, 1, 9, 15);
    const parts = zonedDateParts(date);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(15);
    expect(parts.day).toBe(1);
    expect(parts.month).toBe(6);
  });

  it("converts across timezones (midnight rollover)", () => {
    // 2026-06-01T18:00Z is 2026-06-02 02:00 in Asia/Shanghai.
    const date = new Date(Date.UTC(2026, 5, 1, 18, 0));
    const shanghai = zonedDateParts(date, "Asia/Shanghai");
    expect(shanghai.day).toBe(2);
    expect(shanghai.hour).toBe(2);
    const utc = zonedDateParts(date, "UTC");
    expect(utc.day).toBe(1);
    expect(utc.hour).toBe(18);
  });
});
