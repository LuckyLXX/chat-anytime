import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { cachedToolTokens, estimateContextBreakdown, estimateToolTokens, toolDeclarationsFingerprint } from "./context-breakdown";

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

describe("工具声明的指纹与估算缓存", () => {
  it("同名工具的 parameters 变化会改变指纹（不能只看名字）", () => {
    const base = { name: "mcp__x__search", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } } } };
    const wider = { ...base, parameters: { type: "object", properties: { q: { type: "string" }, limit: { type: "number" } } } };
    expect(toolDeclarationsFingerprint([base])).not.toBe(toolDeclarationsFingerprint([wider]));
    expect(estimateToolTokens([wider])).toBeGreaterThan(estimateToolTokens([base]));
  });

  it("等长描述变化同样失效（不能比较描述长度）", () => {
    const a = { name: "mcp__x__search", description: "Search docs", parameters: { type: "object" } };
    const b = { name: "mcp__x__search", description: "Search code", parameters: { type: "object" } };
    expect(a.description.length).toBe(b.description.length);
    expect(toolDeclarationsFingerprint([a])).not.toBe(toolDeclarationsFingerprint([b]));
  });

  it("声明内容不变时复用缓存对象；变化后重新估算", () => {
    const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }];
    const first = cachedToolTokens(undefined, tools);
    expect(first.tokens).toBe(estimateToolTokens(tools));
    // 同一个记录（同一对象引用）不重复估算
    expect(cachedToolTokens(first, [{ ...tools[0]! }])).toBe(first);
    const changed = cachedToolTokens(first, [{ ...tools[0]!, description: "Read a file" }]);
    expect(changed).not.toBe(first);
    expect(changed.tokens).toBe(estimateToolTokens([{ ...tools[0]!, description: "Read a file" }]));
  });
});
