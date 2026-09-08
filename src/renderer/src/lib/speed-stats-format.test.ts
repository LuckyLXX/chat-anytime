import { describe, expect, it } from "vitest";
import { formatSpeedDuration, formatSpeedTokens, formatTokensPerSecond, speedStatsGroups } from "./speed-stats-format";

describe("speed stats formatting (dsh StatsLine 口径)", () => {
  it("formats durations compactly", () => {
    expect(formatSpeedDuration(0)).toBe("0s");
    expect(formatSpeedDuration(1_600)).toBe("1.6s");
    expect(formatSpeedDuration(45_230)).toBe("45.2s");
    expect(formatSpeedDuration(162_000)).toBe("2m42s");
    expect(formatSpeedDuration(702_000)).toBe("11m42s");
  });

  it("abbreviates token counts like dsh", () => {
    expect(formatSpeedTokens(517)).toBe("517");
    expect(formatSpeedTokens(12_240)).toBe("12.2K");
    expect(formatSpeedTokens(517_000)).toBe("517K");
    expect(formatSpeedTokens(1_230_000)).toBe("1.2M");
    expect(formatSpeedTokens(7_300_000)).toBe("7.3M");
  });

  it("formats tok/s with one decimal below ten", () => {
    expect(formatTokensPerSecond(118)).toBe("118");
    expect(formatTokensPerSecond(8.34)).toBe("8.3");
  });

  it("renders the full dsh-shaped line with all groups", () => {
    const groups = speedStatsGroups({
      turns: 1,
      steps: 65,
      llmMs: 702_000,
      toolMs: 503_000,
      ttftMs: 104_000,
      ttftSteps: 65,
      decodeTokens: 70_600,
      decodeMs: 598_000,
      promptTokens: 7_300_000,
      outputTokens: 70_600
    }, 99);
    expect(groups).toEqual([
      "1轮·65步",
      "LLM 11m42s · 工具调用 8m23s",
      "首 token 平均 1.6s · 118 tok/s",
      "缓存命中 99%",
      "输入 7.3M tok · 输出 70.6K tok"
    ]);
  });

  it("omits empty groups and hides the line entirely without data", () => {
    expect(speedStatsGroups(undefined, 50)).toEqual([]);
    expect(speedStatsGroups({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeTokens: 0, decodeMs: 0, promptTokens: 0, outputTokens: 0 }, null)).toEqual([]);
    // 计数存在但没有任何时间读数（恢复会话的冷启动形态）。
    const seeded = speedStatsGroups({ turns: 2, steps: 3, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeTokens: 0, decodeMs: 0, promptTokens: 1_200, outputTokens: 340 }, undefined);
    expect(seeded).toEqual(["2轮·3步", "输入 1.2K tok · 输出 340 tok"]);
    // 中转站不报 usage：steps/token 恒 0，计时读数独立展示。
    const timingOnly = speedStatsGroups({ turns: 1, steps: 0, llmMs: 9_000, toolMs: 2_000, ttftMs: 3_200, ttftSteps: 2, decodeTokens: 0, decodeMs: 0, promptTokens: 0, outputTokens: 0 }, null);
    expect(timingOnly).toEqual(["LLM 9s · 工具调用 2s", "首 token 平均 1.6s"]);
  });

  it("prepends a live waiting timer before the first token", () => {
    const now = 5_000;
    // 等待不足门槛不显示，行整体隐藏（其余组全空）。
    expect(speedStatsGroups({ turns: 1, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeTokens: 0, decodeMs: 0, promptTokens: 0, outputTokens: 0, live: { startedAt: 4_900, tokens: 0 } }, null, now)).toEqual([]);
    // 超过 0.3s 显示等待计时；2.3s 取一位小数。
    const waiting = speedStatsGroups({ turns: 1, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeTokens: 0, decodeMs: 0, promptTokens: 0, outputTokens: 0, live: { startedAt: 2_700, tokens: 0 } }, null, now);
    expect(waiting[0]).toBe("首 token 2.3s…");
  });

  it("prepends a live tok/s estimate while streaming", () => {
    const now = 10_000;
    // 首帧后窗口 ≥0.8s 且估算 ≥8 token：400 token / 2s = ~200 tok/s。
    const streaming = speedStatsGroups({ turns: 1, steps: 1, llmMs: 1_200, toolMs: 0, ttftMs: 400, ttftSteps: 1, decodeTokens: 0, decodeMs: 0, promptTokens: 3_000, outputTokens: 0, live: { startedAt: 7_800, firstTokenAt: 8_000, tokens: 400 } }, 95, now);
    expect(streaming[0]).toBe("~200 tok/s");
    // 行首 live 组在累计组之前。
    expect(streaming[1]).toBe("1轮·1步");
    // 窗口太短（0.5s）不显示速度，只显示等待前的状态。
    expect(speedStatsGroups({ turns: 1, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeTokens: 0, decodeMs: 0, promptTokens: 0, outputTokens: 0, live: { startedAt: 9_000, firstTokenAt: 9_500, tokens: 400 } }, null, now)).toEqual([]);
  });
});
