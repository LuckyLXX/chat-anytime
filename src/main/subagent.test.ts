import { describe, expect, it } from "vitest";
import { assistantText, createSubagentTools, parseModelId, type SubagentContext } from "./subagent.js";

function makeCtx(overrides: Partial<SubagentContext> = {}): SubagentContext {
  return {
    // modelRuntime is only touched when a delegation actually runs, so cast a
    // minimal stub — these tests never execute a real child session.
    modelRuntime: {} as SubagentContext["modelRuntime"],
    workspace: "/ws",
    agentDir: "/agent",
    agent: { id: "default", name: "默认", description: "", systemPrompt: "", divMode: "off", defaultThinkingLevel: "medium", tools: { read: true, bash: true, edit: true, write: true, grep: true, find: true, ls: true } },
    thinkingLevel: "medium",
    accessMode: "ask",
    model: { provider: "p", id: "m" },
    requestPermission: async () => "allow-once",
    isDelegationChild: false,
    ...overrides
  } as SubagentContext;
}

describe("subagent tools", () => {
  it("exposes a single delegate_agent tool for root sessions", () => {
    const tools = createSubagentTools(makeCtx());
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("delegate_agent");
  });

  it("blocks nesting by returning no delegate tool for child sessions", () => {
    expect(createSubagentTools(makeCtx({ isDelegationChild: true }))).toEqual([]);
  });

  it("parses provider/id model identifiers and falls back otherwise", () => {
    expect(parseModelId("anthropic/claude-4", { provider: "x", id: "y" })).toEqual({ provider: "anthropic", id: "claude-4" });
    expect(parseModelId("no-slash", { provider: "x", id: "y" })).toEqual({ provider: "x", id: "y" });
  });

  it("extracts concatenated text from an assistant message", () => {
    expect(assistantText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", text: "skip" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(assistantText({ role: "assistant", content: "plain" })).toBe("");
    expect(assistantText(undefined)).toBe("");
  });
});
