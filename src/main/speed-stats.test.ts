import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { addSpeedToolMs, beginSpeedTurn, closeSpeedStep, seedSpeedStats, syncSpeedCounters, zeroSpeedStats } from "./speed-stats";

function assistantUsage(partial: Partial<Usage>, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    stopReason,
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...partial
    }
  };
}

describe("speed stats accumulation", () => {
  it("counts a turn and a step with ttft/decode split (dsh decode window excludes ttft)", () => {
    let stats = beginSpeedTurn(zeroSpeedStats());
    // 请求发出 → 首帧 1.6s → 完成 11.6s，输出 1000 tok。
    stats = closeSpeedStep(stats, { startedAt: 0, firstTokenAt: 1600 }, 11_600, { output: 1000 });
    expect(stats).toEqual({
      turns: 1,
      steps: 1,
      llmMs: 11_600,
      toolMs: 0,
      ttftMs: 1600,
      ttftSteps: 1,
      decodeMs: 10_000,
      decodeTokens: 1000,
      promptTokens: 0,
      outputTokens: 0
    });
    // 118 tok/s 口径：Σ输出 / Σ(完成−首帧)。
    expect(1000 / (stats.decodeMs / 1000)).toBe(100);
  });

  it("keeps timing but skips counters when the step has no valid usage (aborted)", () => {
    let stats = beginSpeedTurn(zeroSpeedStats());
    stats = closeSpeedStep(stats, { startedAt: 0, firstTokenAt: 500 }, 4000, undefined);
    expect(stats.steps).toBe(0);
    expect(stats.llmMs).toBe(4000);
    expect(stats.ttftMs).toBe(500);
    expect(stats.ttftSteps).toBe(1);
    expect(stats.decodeTokens).toBe(0);
  });

  it("steps without a first frame have no ttft/decode reading but still count llm time", () => {
    let stats = beginSpeedTurn(zeroSpeedStats());
    stats = closeSpeedStep(stats, { startedAt: 100 }, 2100, { output: 42 });
    expect(stats.llmMs).toBe(2000);
    expect(stats.ttftSteps).toBe(0);
    expect(stats.decodeMs).toBe(0);
    expect(stats.steps).toBe(1);
  });

  it("usage without output tokens adds no decode reading", () => {
    let stats = beginSpeedTurn(zeroSpeedStats());
    stats = closeSpeedStep(stats, { startedAt: 0, firstTokenAt: 100 }, 1000, { output: 0 });
    expect(stats.steps).toBe(1);
    expect(stats.decodeMs).toBe(0);
  });

  it("accumulates tool durations across calls and clamps negatives", () => {
    let stats = zeroSpeedStats();
    stats = addSpeedToolMs(stats, 1500);
    stats = addSpeedToolMs(stats, 2500);
    stats = addSpeedToolMs(stats, -10);
    expect(stats.toolMs).toBe(4000);
  });

  it("seeds counters from a restored transcript and leaves timings at zero", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "q1", timestamp: 0 },
      assistantUsage({ input: 100, cacheRead: 900, output: 40 }),
      { role: "user", content: "q2", timestamp: 2 },
      assistantUsage({ input: 20, cacheRead: 980, output: 60 }),
      assistantUsage({ input: 5, cacheRead: 5 }, "aborted")
    ];
    const stats = seedSpeedStats(messages);
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(2);
    expect(stats.llmMs).toBe(0);
    expect(stats.toolMs).toBe(0);
    expect(stats.ttftSteps).toBe(0);
  });

  it("syncSpeedCounters re-derives steps after truncation while keeping timings and turns", () => {
    let stats = beginSpeedTurn(zeroSpeedStats());
    stats = closeSpeedStep(stats, { startedAt: 0, firstTokenAt: 100 }, 1000, { output: 10 });
    stats = closeSpeedStep(stats, { startedAt: 2000, firstTokenAt: 2100 }, 3000, { output: 20 });
    // regenerate 截断后 transcript 只剩一步。
    const remaining: AgentMessage[] = [assistantUsage({ input: 10, output: 20 })];
    const synced = syncSpeedCounters(stats, remaining);
    expect(synced.steps).toBe(1);
    expect(synced.turns).toBe(1);
    expect(synced.llmMs).toBe(stats.llmMs);
    expect(synced.decodeTokens).toBe(stats.decodeTokens);
  });
});
