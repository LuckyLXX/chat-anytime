import { describe, expect, it } from "vitest";
import { assistantText, buildEmptyDelegationOutputError, buildSubagentPromptBlock, buildSubagentReferenceError, createSubagentTools, DelegationTracker, delegationModelEnabled, parseModelId, resolveDelegationModelTarget, resolveSubagentDefinition, type SubagentContext } from "./subagent.js";
import type { SubagentDefinition } from "../shared/protocol.js";

const catalog: SubagentDefinition[] = [
  { id: "subagent-a", name: "code-reviewer", description: "审查代码", systemPrompt: "x", tools: "inherit", scope: "global" }
];

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
    getSubagentCatalog: () => catalog,
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

  it("falls back to the parent model when an explicit target was unchecked", () => {
    const enabled = (providerId: string, modelId: string): boolean => !(providerId === "p" && modelId === "gone");
    // 未被取消勾选：保留显式指定。
    expect(resolveDelegationModelTarget({ provider: "p", id: "keep" }, { provider: "q", id: "m" }, enabled)).toEqual({ provider: "p", id: "keep" });
    // 已被取消勾选：回退主会话模型。
    expect(resolveDelegationModelTarget({ provider: "p", id: "gone" }, { provider: "q", id: "m" }, enabled)).toEqual({ provider: "q", id: "m" });
    // 无校验器（主进程未挂目录）时显式指定照用，兼容旧行为。
    expect(resolveDelegationModelTarget({ provider: "p", id: "gone" }, { provider: "q", id: "m" }, undefined)).toEqual({ provider: "p", id: "gone" });
    expect(delegationModelEnabled({ provider: "p", id: "x" }, undefined)).toBe(true);
    expect(delegationModelEnabled({ provider: "p", id: "gone" }, enabled)).toBe(false);
  });

  it("extracts concatenated text from an assistant message", () => {
    expect(assistantText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", text: "skip" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(assistantText({ role: "assistant", content: "plain" })).toBe("");
    expect(assistantText(undefined)).toBe("");
  });

  it("resolves a subagent definition by id or name and falls back otherwise", () => {
    expect(resolveSubagentDefinition(catalog, "subagent-a")?.name).toBe("code-reviewer");
    expect(resolveSubagentDefinition(catalog, "code-reviewer")?.id).toBe("subagent-a");
    expect(resolveSubagentDefinition(catalog, "missing")).toBeUndefined();
    expect(resolveSubagentDefinition(undefined, "anything")).toBeUndefined();
  });

  it("builds a prompt block listing available subagents as the only delegation target", () => {
    const block = buildSubagentPromptBlock(catalog);
    expect(block).toBeDefined();
    expect(block).toContain("code-reviewer");
    // 硬约束口径：唯一委派对象 + subagent 必填，挡住模型自由发明子代理。
    expect(block).toContain("唯一委派对象");
    expect(block).toContain("subagent 参数必填");
    expect(buildSubagentPromptBlock([])).toBeUndefined();
    expect(buildSubagentPromptBlock(undefined)).toBeUndefined();
  });

  it("names the available subagents when a delegation misses", () => {
    const missing = buildSubagentReferenceError("invented-agent", catalog);
    expect(missing).toContain("invented-agent");
    expect(missing).toContain("code-reviewer（subagent-a）");
    const omitted = buildSubagentReferenceError("", catalog);
    expect(omitted).toContain("必须指定 subagent");
    // 目录为空时给出「先定义或不要委派」而不是一个空清单。
    expect(buildSubagentReferenceError("x", [])).toContain("没有可用的子智能体");
    expect(buildSubagentReferenceError("x", undefined)).toContain("没有可用的子智能体");
  });

  it("turns an empty delegation output into an explicit error", () => {
    expect(buildEmptyDelegationOutputError("code-reviewer", 0, "/agent/delegations/c.jsonl")).toContain("空响应");
    expect(buildEmptyDelegationOutputError("code-reviewer", 12, "/agent/delegations/c.jsonl")).toContain("12 个步骤");
    expect(buildEmptyDelegationOutputError("code-reviewer", 0, "/agent/delegations/c.jsonl")).toContain("/agent/delegations/c.jsonl");
  });

  it("rejects a delegation without a matching subagent before touching the model runtime", async () => {
    const tool = createSubagentTools(makeCtx())[0]!;
    const execute = (tool as unknown as { execute: (id: string, params: unknown) => Promise<unknown> }).execute;
    await expect(execute("call", { goal: "做点事" })).rejects.toThrow(/必须指定 subagent/u);
    await expect(execute("call", { goal: "做点事", role: "review" })).rejects.toThrow(/必须指定 subagent/u);
    await expect(execute("call", { goal: "做点事", subagent: "not-defined" })).rejects.toThrow(/没有名为「not-defined」的子智能体/u);
    // 报错要带上可用名单，否则模型只会反复换名字重试。
    await expect(execute("call", { goal: "做点事", subagent: "not-defined" })).rejects.toThrow(/code-reviewer/u);
  });
});

describe("DelegationTracker", () => {
  const base = {
    childSessionId: "child-1",
    childSessionFile: "/agent/sessions/default/delegations/child-1.jsonl",
    subagentName: "Explorer",
    subagentColor: "amber",
    role: "explore" as const,
    model: { provider: "p", id: "m" }
  };

  it("accumulates steps with running/completed transitions and logs", () => {
    const tracker = new DelegationTracker(base);
    tracker.onToolStart("t1", "read", "读取文件：src/a.ts", 100);
    expect(tracker.logText()).toBe("● 读取文件：src/a.ts");
    tracker.onToolEnd("t1", false);
    expect(tracker.snapshot().steps[0]).toMatchObject({ toolCallId: "t1", status: "completed" });
    expect(tracker.snapshot().steps[0]?.completedAt).toBeGreaterThanOrEqual(100);
    expect(tracker.logText()).toMatch(/^✓ 读取文件：src\/a\.ts · /u);
    expect(tracker.snapshot()).toMatchObject({ childSessionId: "child-1", subagentName: "Explorer", role: "explore" });
  });

  it("marks errors and seals still-running steps on settle", () => {
    const tracker = new DelegationTracker(base);
    tracker.onToolStart("t1", "bash", "执行命令 npm test", 100);
    tracker.onToolStart("t2", "edit", "编辑文件：src/b.ts", 120);
    tracker.onToolEnd("t1", true);
    expect(tracker.snapshot().steps.find((step) => step.toolCallId === "t1")?.status).toBe("error");
    tracker.seal();
    const steps = tracker.snapshot().steps;
    expect(steps.find((step) => step.toolCallId === "t2")?.status).toBe("error");
    expect(steps.find((step) => step.toolCallId === "t2")?.completedAt).toBeDefined();
  });

  it("caps steps at 200 (placeholder included) and drops the oldest with a header", () => {
    const tracker = new DelegationTracker(base);
    for (let i = 0; i < 205; i++) tracker.onToolStart(`t${i}`, "read", `步骤 ${i}`, 1000 + i);
    const steps = tracker.snapshot().steps;
    expect(steps).toHaveLength(200);
    expect(steps[0]?.toolCallId).toBe("__dropped__");
    expect(steps[0]?.label).toContain("已省略 6 个早期步骤");
    expect(steps[1]?.toolCallId).toBe("t6");
  });

  it("keeps the placeholder label in sync as more steps are dropped", () => {
    const tracker = new DelegationTracker(base);
    for (let i = 0; i < 210; i++) tracker.onToolStart(`t${i}`, "read", `步骤 ${i}`, 1000 + i);
    const steps = tracker.snapshot().steps;
    expect(steps).toHaveLength(200);
    expect(steps[0]?.label).toContain("已省略 11 个早期步骤");
    expect(steps[1]?.toolCallId).toBe("t11");
  });

  it("truncates long labels to 120 characters", () => {
    const tracker = new DelegationTracker(base);
    tracker.onToolStart("t1", "bash", "x".repeat(300), 0);
    expect(tracker.snapshot().steps[0]?.label.length).toBeLessThanOrEqual(120);
    expect(tracker.snapshot().steps[0]?.label.endsWith("…")).toBe(true);
  });

  it("returns an empty log placeholder before any step", () => {
    const tracker = new DelegationTracker(base);
    expect(tracker.logText()).toBe("● 子代理正在启动…");
    expect(tracker.snapshot().steps).toEqual([]);
  });

  it("ignores end events for steps dropped by the cap", () => {
    const tracker = new DelegationTracker(base);
    for (let i = 0; i < 205; i++) tracker.onToolStart(`t${i}`, "read", `步骤 ${i}`, 1000 + i);
    tracker.onToolEnd("t0", false); // 已被截断丢弃，不抛错也不改动
    expect(tracker.snapshot().steps).toHaveLength(200);
  });
});
