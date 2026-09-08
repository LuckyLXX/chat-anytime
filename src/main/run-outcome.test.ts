import { describe, expect, it } from "vitest";
import { isAbortedMessage, resolveRunOutcomeStatus } from "./run-outcome.js";

describe("isAbortedMessage", () => {
  it("按 stopReason 判定，不看英文文案（各家 SDK 中止原文不同）", () => {
    expect(isAbortedMessage({ role: "assistant", stopReason: "aborted", errorMessage: "This operation was aborted" })).toBe(true);
    expect(isAbortedMessage({ role: "assistant", stopReason: "aborted", errorMessage: "Request aborted by user" })).toBe(true);
    expect(isAbortedMessage({ role: "assistant", stopReason: "aborted" })).toBe(true);
  });

  it("非 assistant / 非 aborted / 缺字段都不是中止", () => {
    expect(isAbortedMessage(undefined)).toBe(false);
    expect(isAbortedMessage({ role: "user", stopReason: "aborted" })).toBe(false);
    expect(isAbortedMessage({ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" })).toBe(false);
    expect(isAbortedMessage({ role: "assistant" })).toBe(false);
  });
});

describe("resolveRunOutcomeStatus", () => {
  it("中止 → aborted（即使没有 aborted 消息，命令侧标记也算）", () => {
    expect(resolveRunOutcomeStatus(false, [{ role: "assistant", stopReason: "aborted", errorMessage: "This operation was aborted" }])).toBe("aborted");
    expect(resolveRunOutcomeStatus(true, [{ role: "user" }])).toBe("aborted");
  });

  it("真实错误 → failed", () => {
    expect(resolveRunOutcomeStatus(false, [{ role: "assistant", stopReason: "error", errorMessage: "503 Service Unavailable" }])).toBe("failed");
  });

  it("正常结束 → completed；只看末条 assistant", () => {
    expect(resolveRunOutcomeStatus(false, [{ role: "user" }, { role: "assistant", stopReason: "stop" }])).toBe("completed");
    // 早期回合的失败不影响本次结算（末条 assistant 才是本次结果）。
    expect(resolveRunOutcomeStatus(false, [
      { role: "assistant", stopReason: "error", errorMessage: "旧回合失败" },
      { role: "assistant", stopReason: "stop" }
    ])).toBe("completed");
    // 空消息列表（极端：进程被杀）不算失败。
    expect(resolveRunOutcomeStatus(false, [])).toBe("completed");
  });
});
