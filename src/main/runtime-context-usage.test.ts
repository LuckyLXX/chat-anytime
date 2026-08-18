import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { addMessageToCacheUsage, cacheHitRateFrom, scanCacheUsage, zeroCacheUsage } from "./runtime-context-usage";

function assistantUsage(partial: Partial<Usage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    stopReason: "stop",
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

describe("runtime context usage accumulation", () => {
  it("accumulates cacheRead and billed prompt tokens from assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi", timestamp: 0 },
      assistantUsage({ input: 200, cacheRead: 800, cacheWrite: 100 }),
      { role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false, timestamp: 2 },
      assistantUsage({ input: 50, cacheRead: 950, cacheWrite: 20, output: 300 })
    ];
    const totals = scanCacheUsage(messages);
    expect(totals).toEqual({ cacheRead: 1750, promptTokens: 2120 });
    expect(cacheHitRateFrom(totals)).toBeCloseTo((1750 / 2120) * 100);
  });

  it("skips aborted, error, and all-zero usage messages", () => {
    const aborted = assistantUsage({ input: 10, cacheRead: 90 });
    (aborted as { stopReason: string }).stopReason = "aborted";
    const errored = assistantUsage({ input: 10, cacheRead: 90 });
    (errored as { stopReason: string }).stopReason = "error";
    const zero = assistantUsage({});
    const valid = assistantUsage({ input: 100, cacheRead: 400, output: 50 });
    const totals = scanCacheUsage([aborted, errored, zero, valid]);
    expect(totals).toEqual({ cacheRead: 400, promptTokens: 500 });
  });

  it("returns null hit rate without billed input", () => {
    expect(cacheHitRateFrom(zeroCacheUsage())).toBeNull();
    expect(cacheHitRateFrom({ cacheRead: 500, promptTokens: 0 })).toBeNull();
  });

  it("adds one message without mutating the original totals", () => {
    const base = zeroCacheUsage();
    const next = addMessageToCacheUsage(base, assistantUsage({ input: 40, cacheRead: 360 }));
    expect(base).toEqual({ cacheRead: 0, promptTokens: 0 });
    expect(next).toEqual({ cacheRead: 360, promptTokens: 400 });
  });

  it("ignores non-assistant messages during incremental add", () => {
    const user: AgentMessage = { role: "user", content: "hi", timestamp: 0 };
    const next = addMessageToCacheUsage(zeroCacheUsage(), user);
    expect(next).toEqual(zeroCacheUsage());
  });
});
