import { describe, expect, it } from "vitest";
import { isAbortErrorMessage, isAbortedMessage, isAbortedOutcome, resolveRunOutcomeStatus } from "./run-outcome.js";

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

describe("isAbortErrorMessage", () => {
  it("认得各家 SDK 的中止原文", () => {
    expect(isAbortErrorMessage("This operation was aborted")).toBe(true);
    expect(isAbortErrorMessage("Request was aborted")).toBe(true);
    expect(isAbortErrorMessage("Request aborted by user")).toBe(true);
    expect(isAbortErrorMessage("AbortError: signal is aborted")).toBe(true);
  });

  it("真实错误不算中止（这是补救判定，不能反过来洗白失败）", () => {
    expect(isAbortErrorMessage("429: {\"message\":\"inference exceeds tpm/rpm limit\"}")).toBe(false);
    expect(isAbortErrorMessage("524 status code (no body)")).toBe(false);
    expect(isAbortErrorMessage("Connection error.")).toBe(false);
    expect(isAbortErrorMessage("Unexpected reasoning effort high")).toBe(false);
    expect(isAbortErrorMessage(undefined)).toBe(false);
    expect(isAbortErrorMessage("")).toBe(false);
  });

  it("HTTP 状态码开头的一律算真实错误（即使后面出现 abort 字样）", () => {
    expect(isAbortErrorMessage("429 status code (no body)")).toBe(false);
    expect(isAbortErrorMessage("400 abort")).toBe(false);
    expect(isAbortErrorMessage("  503 \n\nconnection aborted")).toBe(false);
  });

  it("限流/配额/鉴权类错误含 abort 字样也不算中止", () => {
    expect(isAbortErrorMessage("rate_limit_error: request aborted by server")).toBe(false);
    expect(isAbortErrorMessage("Unauthorized: token aborted")).toBe(false);
    expect(isAbortErrorMessage("context length exceeded, stream aborted")).toBe(false);
  });
});

describe("isAbortedOutcome", () => {
  it("stopReason=aborted 一律算中止（严格版同义）", () => {
    expect(isAbortedOutcome({ role: "assistant", stopReason: "aborted", errorMessage: "This operation was aborted" })).toBe(true);
    expect(isAbortedOutcome({ role: "assistant", stopReason: "aborted" })).toBe(true);
  });

  it("stopReason=error + 中止原文也算中止（Pi 偶尔把中止报成 error 态）", () => {
    expect(isAbortedOutcome({ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" })).toBe(true);
    expect(isAbortedOutcome({ role: "assistant", stopReason: "error", errorMessage: "Request aborted" })).toBe(true);
  });

  it("stopReason=error + 真实错误不算中止", () => {
    expect(isAbortedOutcome({ role: "assistant", stopReason: "error", errorMessage: "503 Service Unavailable" })).toBe(false);
    expect(isAbortedOutcome({ role: "assistant", stopReason: "error" })).toBe(false);
    expect(isAbortedOutcome({ role: "assistant", stopReason: "stop" })).toBe(false);
    expect(isAbortedOutcome({ role: "user", stopReason: "aborted" })).toBe(false);
    expect(isAbortedOutcome(undefined)).toBe(false);
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

  it("Pi 把中止报成 error 态时也结算为 aborted（不爆红）", () => {
    expect(resolveRunOutcomeStatus(false, [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }])).toBe("aborted");
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
