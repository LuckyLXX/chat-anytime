import { describe, expect, it, vi } from "vitest";
import { autoCompactionFailureNotice, runManualCompaction } from "./compaction-lifecycle.js";

describe("manual compaction lifecycle", () => {
  it("settles successful compaction instead of leaving the caller busy", async () => {
    const compact = vi.fn().mockResolvedValue({ summary: "done" });

    await expect(runManualCompaction(compact)).resolves.toEqual({
      type: "completed",
      status: "就绪",
      message: "已压缩上下文。"
    });
    expect(compact).toHaveBeenCalledOnce();
  });

  it("distinguishes cancellation from a failed compaction", async () => {
    await expect(runManualCompaction(() => Promise.reject(new Error("Compaction cancelled")))).resolves.toEqual({
      type: "cancelled",
      status: "已停止",
      message: "已停止压缩上下文。"
    });

    const failure = new Error("provider unavailable");
    await expect(runManualCompaction(() => Promise.reject(failure))).resolves.toEqual({
      type: "failed",
      status: "压缩失败",
      message: "压缩上下文失败：provider unavailable",
      error: failure
    });
  });
});

describe("auto compaction failure notice", () => {
  it("surfaces threshold and overflow failures", () => {
    expect(autoCompactionFailureNotice({ reason: "threshold", errorMessage: "Compaction failed: 503" }))
      .toBe("自动压缩上下文失败：Compaction failed: 503");
    expect(autoCompactionFailureNotice({ reason: "overflow", errorMessage: "Compaction failed: 503" }))
      .toBe("自动压缩上下文失败：Compaction failed: 503");
  });

  it("stays silent for manual compaction (control message path), aborts, and successes", () => {
    expect(autoCompactionFailureNotice({ reason: "manual", errorMessage: "Compaction failed: 503" })).toBeUndefined();
    // 中止路径 Pi 不带 errorMessage；成功同理。
    expect(autoCompactionFailureNotice({ reason: "threshold" })).toBeUndefined();
    expect(autoCompactionFailureNotice({ reason: "overflow" })).toBeUndefined();
  });
});
