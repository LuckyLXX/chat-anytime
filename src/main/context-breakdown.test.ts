import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateContextBreakdown, estimateToolTokens } from "./context-breakdown";

describe("context breakdown estimation", () => {
  it("estimates tools as JSON length / 4 plus a wrapper overhead per tool", () => {
    expect(estimateToolTokens([])).toBe(0);
    const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
    const expected = Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length / 4) + 4;
    expect(estimateToolTokens([tool])).toBe(expected);
    expect(estimateToolTokens([tool, tool])).toBe(expected * 2);
  });

  it("estimates the system segment from the prompt string (chars/4)", () => {
    const breakdown = estimateContextBreakdown({ systemPrompt: "x".repeat(400), toolTokens: 0, messages: [] });
    expect(breakdown.system).toBe(100);
  });

  it("treats an empty system prompt as zero and sums messages via Pi's estimator", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a".repeat(80), timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "b".repeat(40) }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-test",
        stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: 1
      }
    ];
    const breakdown = estimateContextBreakdown({ toolTokens: 12, messages });
    expect(breakdown.system).toBe(0);
    expect(breakdown.tools).toBe(12);
    expect(breakdown.messages).toBe(20 + 10);
  });
});
