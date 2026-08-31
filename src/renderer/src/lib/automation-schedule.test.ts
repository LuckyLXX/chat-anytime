import { describe, expect, it } from "vitest";
import { buildCron, describeCron, DEFAULT_SCHEDULE_PARTS, pad2 } from "./automation-schedule";

describe("describeCron", () => {
  it("recognizes each preset from single-value/asterisk cron fields", () => {
    expect(describeCron("30 * * * *")).toMatchObject({ preset: "hourly", minute: 30 });
    expect(describeCron("0 9 * * *")).toMatchObject({ preset: "daily", minute: 0, hour: 9 });
    expect(describeCron("15 8 * * 1-5")).toMatchObject({ preset: "weekdays", minute: 15, hour: 8 });
    expect(describeCron("5 20 * * 3")).toMatchObject({ preset: "weekly", minute: 5, hour: 20, weekday: 3 });
    expect(describeCron("0 7 1 * *")).toMatchObject({ preset: "monthly", minute: 0, hour: 7, monthDay: 1 });
  });

  it("maps dow 7 to sunday 0 for weekly preset", () => {
    expect(describeCron("0 9 * * 7")).toMatchObject({ preset: "weekly", weekday: 0 });
  });

  it("falls back to custom for step/range/multi-value expressions", () => {
    expect(describeCron("*/15 * * * *").preset).toBe("custom");
    expect(describeCron("0 9,18 * * *").preset).toBe("custom");
    expect(describeCron("0 9-18 * * *").preset).toBe("custom");
    expect(describeCron("0 9 * * 1,3,5").preset).toBe("custom");
  });

  it("falls back to custom for malformed or out-of-range fields", () => {
    expect(describeCron("not a cron").preset).toBe("custom");
    expect(describeCron("").preset).toBe("custom");
    expect(describeCron("99 9 * * *").preset).toBe("custom");
    expect(describeCron("0 25 * * *").preset).toBe("custom");
    expect(describeCron("0 9 32 * *").preset).toBe("custom");
  });

  it("keeps default params alongside a custom preset", () => {
    const parts = describeCron("*/15 * * * *");
    expect(parts.preset).toBe("custom");
    expect(parts.minute).toBe(DEFAULT_SCHEDULE_PARTS.minute);
    expect(parts.hour).toBe(DEFAULT_SCHEDULE_PARTS.hour);
  });
});

describe("buildCron", () => {
  it("builds expressions for every preset", () => {
    expect(buildCron({ preset: "hourly", minute: 30, hour: 9, weekday: 1, monthDay: 1 })).toBe("30 * * * *");
    expect(buildCron({ preset: "daily", minute: 0, hour: 9, weekday: 1, monthDay: 1 })).toBe("0 9 * * *");
    expect(buildCron({ preset: "weekdays", minute: 15, hour: 8, weekday: 1, monthDay: 1 })).toBe("15 8 * * 1-5");
    expect(buildCron({ preset: "weekly", minute: 5, hour: 20, weekday: 0, monthDay: 1 })).toBe("5 20 * * 0");
    expect(buildCron({ preset: "monthly", minute: 0, hour: 7, weekday: 1, monthDay: 28 })).toBe("0 7 28 * *");
    expect(buildCron({ preset: "custom", minute: 0, hour: 9, weekday: 1, monthDay: 1 })).toBe("");
  });
});

describe("describeCron ↔ buildCron round-trip", () => {
  it("describing a built preset expression reproduces the parameters", () => {
    const cases = [
      { preset: "hourly" as const, minute: 42, hour: 9, weekday: 1, monthDay: 1 },
      { preset: "daily" as const, minute: 5, hour: 21, weekday: 1, monthDay: 1 },
      { preset: "weekdays" as const, minute: 59, hour: 6, weekday: 1, monthDay: 1 },
      { preset: "weekly" as const, minute: 0, hour: 12, weekday: 6, monthDay: 1 },
      { preset: "monthly" as const, minute: 30, hour: 18, weekday: 1, monthDay: 15 }
    ];
    for (const parts of cases) {
      expect(describeCron(buildCron(parts))).toEqual(parts);
    }
  });
});

describe("pad2", () => {
  it("pads single digits", () => {
    expect(pad2(0)).toBe("00");
    expect(pad2(9)).toBe("09");
    expect(pad2(23)).toBe("23");
  });
});
