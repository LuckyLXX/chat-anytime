import { describe, expect, it } from "vitest";
import {
  PLAN_APPROVE_OPTION,
  PLAN_MODE_GUIDANCE_FULL,
  PLAN_MODE_GUIDANCE_REMINDER,
  PLAN_REVISE_OPTION,
  buildPlanTools,
  createPlanModeExtension,
  injectPlanNarration,
  parsePlanReview,
  planNarrationText,
  planReviewQuestion,
  type PlanModeState,
  type PlanToolDeps
} from "./runtime-plan-tools.js";
import type { QuestionBroker, QuestionOutcome } from "./runtime-question-tool.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const idleState: PlanModeState = { enabled: false, narrate: undefined };

describe("planNarrationText", () => {
  it("returns full guidance once on entry and reminder on later turns", () => {
    expect(planNarrationText({ enabled: true, narrate: "full" })).toBe(PLAN_MODE_GUIDANCE_FULL);
    expect(planNarrationText({ enabled: true, narrate: "reminder" })).toBe(PLAN_MODE_GUIDANCE_REMINDER);
    expect(planNarrationText({ enabled: true, narrate: undefined })).toBeUndefined();
    expect(planNarrationText({ enabled: false, narrate: "full" })).toBeUndefined();
    expect(planNarrationText(idleState)).toBeUndefined();
  });

  it("guidance forbids implementation before approval", () => {
    expect(PLAN_MODE_GUIDANCE_FULL).toContain("exit_plan_mode");
    expect(PLAN_MODE_GUIDANCE_FULL).toContain("批准之前绝对不要开始实施");
  });
});

describe("injectPlanNarration", () => {
  const narration = "【计划模式已开启】";

  it("appends to the last user message's trailing text part without mutating input", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "需求" }] },
      { role: "assistant", content: [{ type: "text", text: "好的" }] },
      { role: "toolResult", content: [{ type: "text", text: "工具结果" }] },
      { role: "user", content: [{ type: "text", text: "请继续" }] }
    ];
    const result = injectPlanNarration(messages, narration);
    const lastUser = [...result!].reverse().find((message) => message.role === "user");
    expect(lastUser?.content).toEqual([{ type: "text", text: `请继续\n\n${narration}` }]);
    // 输入数组与消息对象未被原地修改。
    expect(messages[3]!.content).toEqual([{ type: "text", text: "请继续" }]);
  });

  it("appends a new text part when the last user message has non-text parts", () => {
    const messages = [
      { role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }] },
      { role: "toolResult", content: [{ type: "text", text: "r" }] }
    ];
    const result = injectPlanNarration(messages, narration);
    expect(result![0]!.content).toEqual([
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "text", text: narration }
    ]);
  });

  it("concatenates string-form content", () => {
    const result = injectPlanNarration([{ role: "user", content: "旧文本" }], narration);
    expect(result![0]!.content).toBe(`旧文本\n\n${narration}`);
  });

  it("walks backwards past tool results to the current turn's user message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "首条" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "toolResult", content: [{ type: "text", text: "r" }] }
    ];
    const result = injectPlanNarration(messages, narration);
    expect(result![0]!.content).toEqual([{ type: "text", text: `首条\n\n${narration}` }]);
  });

  it("returns undefined when there is no user message", () => {
    expect(injectPlanNarration([{ role: "assistant", content: [{ type: "text", text: "x" }] }], narration)).toBeUndefined();
    expect(injectPlanNarration([], narration)).toBeUndefined();
  });
});

describe("plan review question", () => {
  it("carries the plan as detail and keeps approve as the first option", () => {
    const plan = "# 计划\n\n## 步骤";
    const question = planReviewQuestion(plan);
    expect(question.type).toBe("single");
    expect(question.options[0]).toBe(PLAN_APPROVE_OPTION);
    expect(question.options[1]).toBe(PLAN_REVISE_OPTION);
    expect(question.detail).toBe(plan);
  });

  it("parses answers: only the exact approve option consents", () => {
    expect(parsePlanReview([PLAN_APPROVE_OPTION])).toEqual({ status: "approved" });
    expect(parsePlanReview([PLAN_REVISE_OPTION])).toEqual({ status: "rejected", feedback: "" });
    expect(parsePlanReview(["把步骤拆细一点"])).toEqual({ status: "rejected", feedback: "把步骤拆细一点" });
    expect(parsePlanReview(undefined)).toEqual({ status: "cancelled" });
    expect(parsePlanReview([])).toEqual({ status: "cancelled" });
    expect(parsePlanReview([`  ${PLAN_APPROVE_OPTION}  `])).toEqual({ status: "approved" });
  });
});

describe("plan mode extension (context injection + retry backstop)", () => {
  interface CapturedHandlers {
    context: ((event: { messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined)[];
    afterProviderResponse: ((event: { status: number }) => void)[];
  }

  function capture(state: PlanModeState): { state: PlanModeState; handlers: CapturedHandlers } {
    const handlers: CapturedHandlers = { context: [], afterProviderResponse: [] };
    const pi = {
      on(event: string, handler: unknown): void {
        if (event === "context") handlers.context.push(handler as CapturedHandlers["context"][number]);
        if (event === "after_provider_response") handlers.afterProviderResponse.push(handler as CapturedHandlers["afterProviderResponse"][number]);
      }
    };
    const extension = createPlanModeExtension({ state: () => state }) as { factory: (pi: ExtensionAPI) => void | Promise<void> };
    extension.factory(pi as ExtensionAPI);
    return { state, handlers };
  }

  const messages = (): AgentMessage[] => [{ role: "user", content: [{ type: "text", text: "任务" }] } as AgentMessage];

  it("injects full guidance on entry and clears the pending narration", () => {
    const state: PlanModeState = { enabled: true, narrate: "full" };
    const { handlers } = capture(state);
    const result = handlers.context[0]!({ messages: messages() });
    const serialized = JSON.stringify(result?.messages);
    expect(serialized).toContain("计划模式已开启");
    expect(serialized).toContain("批准之前绝对不要开始实施");
    expect(state.narrate).toBeUndefined();
  });

  it("leaves requests untouched when there is no pending narration", () => {
    const state: PlanModeState = { enabled: true, narrate: undefined };
    const { handlers } = capture(state);
    const result = handlers.context[0]!({ messages: messages() });
    expect(result).toBeUndefined();
  });

  it("re-arms a reminder after a failed provider response so retries see the guidance", () => {
    const state: PlanModeState = { enabled: true, narrate: undefined };
    const { handlers } = capture(state);
    handlers.afterProviderResponse[0]!({ status: 500 });
    expect(state.narrate).toBe("reminder");
    const result = handlers.context[0]!({ messages: messages() });
    expect(JSON.stringify(result?.messages)).toContain("提醒：本会话仍处于计划模式");
  });

  it("ignores successful responses and disabled mode", () => {
    const enabled: PlanModeState = { enabled: true, narrate: undefined };
    const { handlers: okHandlers } = capture(enabled);
    okHandlers.afterProviderResponse[0]!({ status: 200 });
    expect(enabled.narrate).toBeUndefined();

    const disabled: PlanModeState = { enabled: false, narrate: undefined };
    const { handlers: offHandlers } = capture(disabled);
    offHandlers.afterProviderResponse[0]!({ status: 429 });
    expect(disabled.narrate).toBeUndefined();
  });

  it("keeps a pending full narration through a failure (no downgrade)", () => {
    const state: PlanModeState = { enabled: true, narrate: "full" };
    const { handlers } = capture(state);
    handlers.afterProviderResponse[0]!({ status: 503 });
    expect(state.narrate).toBe("full");
  });
});

describe("plan mode tools", () => {
  interface FakeDeps {
    deps: PlanToolDeps;
    enabled: boolean;
    calls: string[];
    saved: string[];
    setOutcome: (outcome: QuestionOutcome) => void;
  }

  function makeDeps(): FakeDeps {
    let enabled = false;
    let outcome: QuestionOutcome = { status: "cancelled" };
    const calls: string[] = [];
    const saved: string[] = [];
    const broker = {
      request: async (): Promise<QuestionOutcome> => outcome
    } as unknown as QuestionBroker;
    const deps: PlanToolDeps = {
      getSessionId: () => "session-1",
      getEnabled: () => enabled,
      setEnabled: (value) => { enabled = value; calls.push(`set:${value}`); },
      broker,
      workspace: () => "/workspace",
      savePlan: (plan) => { saved.push(plan); return { path: "docs/plans/计划.md" }; }
    };
    return {
      deps,
      get enabled() { return enabled; },
      get calls() { return calls; },
      get saved() { return saved; },
      setOutcome(next) { outcome = next; }
    };
  }

  const [enterTool, exitTool] = buildPlanTools(makeDeps().deps);

  interface ToolRunResult {
    content: { type: string; text?: string }[];
    isError?: boolean;
    details?: { status?: string };
  }

  async function runTool(tool: { execute?: unknown } | undefined, id: string, params: unknown): Promise<ToolRunResult> {
    if (typeof tool?.execute !== "function") throw new Error("tool has no execute");
    const execute = tool.execute as (toolCallId: string, params: unknown) => Promise<ToolRunResult>;
    return execute(id, params);
  }

  function resultText(result: ToolRunResult): string {
    return result.content.map((part) => part.text ?? "").join("\n");
  }

  it("enter_plan_mode enables the mode and reports it", async () => {
    const fake = makeDeps();
    const tools = buildPlanTools(fake.deps);
    const result = await runTool(tools[0], "1", {});
    expect(result.details?.status).toBe("enabled");
    expect(fake.enabled).toBe(true);
    expect(fake.calls).toEqual(["set:true"]);
  });

  it("enter_plan_mode is a no-op when already enabled", async () => {
    const fake = makeDeps();
    fake.deps.setEnabled(true);
    const tools = buildPlanTools(fake.deps);
    const result = await runTool(tools[0], "2", {});
    expect(result.details?.status).toBe("already-enabled");
  });

  it("exit_plan_mode rejects calls outside plan mode", async () => {
    const tools = buildPlanTools(makeDeps().deps);
    const result = await runTool(tools[1], "1", { plan: "# 计划" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("不在计划模式");
  });

  it("exit_plan_mode rejects an empty plan", async () => {
    const fake = makeDeps();
    fake.deps.setEnabled(true);
    const tools = buildPlanTools(fake.deps);
    const result = await runTool(tools[1], "1", { plan: "   " });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("plan 参数无效");
  });

  it("approval exits the mode, archives the plan and instructs implementation", async () => {
    const fake = makeDeps();
    fake.deps.setEnabled(true);
    fake.setOutcome({ status: "answered", answers: [PLAN_APPROVE_OPTION] });
    const tools = buildPlanTools(fake.deps);
    const result = await runTool(tools[1], "1", { plan: "# 实施计划\n\n步骤" });
    expect(result.isError).toBeUndefined();
    expect(fake.enabled).toBe(false);
    expect(fake.calls).toEqual(["set:true", "set:false"]);
    expect(fake.saved).toEqual(["# 实施计划\n\n步骤"]);
    expect(resultText(result)).toContain("已退出计划模式");
    expect(resultText(result)).toContain("docs/plans/计划.md");
  });

  it("rejection keeps the mode and carries the user's feedback verbatim", async () => {
    const fake = makeDeps();
    fake.deps.setEnabled(true);
    fake.setOutcome({ status: "answered", answers: ["步骤太少，补充分步验收"] });
    const tools = buildPlanTools(fake.deps);
    const result = await runTool(tools[1], "1", { plan: "# 计划" });
    expect(result.isError).toBe(true);
    expect(fake.enabled).toBe(true);
    expect(fake.saved).toEqual([]);
    expect(resultText(result)).toContain("步骤太少，补充分步验收");
  });

  it("ignored review keeps the mode and does not archive", async () => {
    const fake = makeDeps();
    fake.deps.setEnabled(true);
    const tools = buildPlanTools(fake.deps);
    const result = await runTool(tools[1], "1", { plan: "# 计划" });
    expect(result.isError).toBeUndefined();
    expect(fake.enabled).toBe(true);
    expect(fake.saved).toEqual([]);
    expect(resultText(result)).toContain("尚未审查");
  });
});