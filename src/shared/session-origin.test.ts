import { describe, expect, it } from "vitest";
import { isAutomationSessionSummary, normalizeSessionOrigin } from "./session-origin.js";

describe("normalizeSessionOrigin", () => {
  it("keeps a valid automation marker and trims its fields", () => {
    expect(normalizeSessionOrigin({ kind: "automation", taskId: " task-1 ", taskName: " 日报 ", runId: " run-1 " }))
      .toEqual({ kind: "automation", taskId: "task-1", taskName: "日报", runId: "run-1" });
  });

  it("rejects malformed markers instead of poisoning the session summary", () => {
    expect(normalizeSessionOrigin(undefined)).toBeUndefined();
    expect(normalizeSessionOrigin({ kind: "automation" })).toBeUndefined();
    expect(normalizeSessionOrigin({ kind: "automation", taskId: "  " })).toBeUndefined();
    expect(normalizeSessionOrigin({ kind: "other", taskId: "task-1" })).toBeUndefined();
  });
});

describe("isAutomationSessionSummary", () => {
  it("recognizes the persistent origin marker and the legacy title prefix", () => {
    expect(isAutomationSessionSummary({ title: "任意标题", origin: { kind: "automation", taskId: "task-1" } })).toBe(true);
    expect(isAutomationSessionSummary({ title: "自动化 · 旧日报" })).toBe(true);
    expect(isAutomationSessionSummary({ title: "普通话题" })).toBe(false);
  });
});
