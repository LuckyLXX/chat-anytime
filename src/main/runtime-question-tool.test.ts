import { describe, expect, it } from "vitest";
import type { QuestionRequest } from "../shared/protocol.js";
import { QuestionBroker, buildQuestionTools, normalizeQuestionItem, type QuestionOutcome } from "./runtime-question-tool.js";

function createBroker(): { broker: QuestionBroker; emitted: QuestionRequest[]; dismissed: string[] } {
  const emitted: QuestionRequest[] = [];
  const dismissed: string[] = [];
  const broker = new QuestionBroker(
    (request) => emitted.push(request),
    (id) => dismissed.push(id)
  );
  return { broker, emitted, dismissed };
}

async function settled(promise: Promise<QuestionOutcome>): Promise<QuestionOutcome | undefined> {
  let outcome: QuestionOutcome | undefined;
  promise.then((value) => { outcome = value; });
  await Promise.resolve();
  await Promise.resolve();
  return outcome;
}

describe("QuestionBroker", () => {
  it("emits the request and resolves answers in order", async () => {
    const { broker, emitted } = createBroker();
    const promise = broker.request({ sessionId: "s1", toolCallId: "t1", questions: [{ text: "名字？", type: "text", options: [] }, { text: "版本？", type: "text", options: [] }] });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.questions.map((item) => item.text)).toEqual(["名字？", "版本？"]);

    expect(broker.resolve(emitted[0]!.id, ["PiDesktop", "1.0 "])).toBe(true);
    await expect(promise).resolves.toEqual({ status: "answered", answers: ["PiDesktop", "1.0"] });
  });

  it("treats missing or mismatched answers as cancelled", async () => {
    const { broker, emitted } = createBroker();
    const cancelled = broker.request({ sessionId: "s1", toolCallId: "t1", questions: [{ text: "A？", type: "text", options: [] }] });
    broker.resolve(emitted[0]!.id);
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });

    const mismatched = broker.request({ sessionId: "s1", toolCallId: "t2", questions: [{ text: "A？", type: "text", options: [] }, { text: "B？", type: "text", options: [] }] });
    broker.resolve(emitted[1]!.id, ["只有一个"]);
    await expect(mismatched).resolves.toEqual({ status: "cancelled" });
  });

  it("ignores resolves for unknown ids", () => {
    const { broker } = createBroker();
    expect(broker.resolve("question-99", ["x"])).toBe(false);
  });

  it("cancels only the matching session on reset and notifies dismissal", async () => {
    const { broker, emitted, dismissed } = createBroker();
    const first = broker.request({ sessionId: "s1", toolCallId: "t1", questions: [{ text: "A？", type: "text", options: [] }] });
    const second = broker.request({ sessionId: "s2", toolCallId: "t2", questions: [{ text: "B？", type: "text", options: [] }] });

    broker.reset("s1");
    await expect(first).resolves.toEqual({ status: "cancelled" });
    expect(dismissed).toEqual([emitted[0]!.id]);
    expect(await settled(second)).toBeUndefined();

    broker.reset();
    await expect(second).resolves.toEqual({ status: "cancelled" });
    expect(dismissed).toEqual([emitted[0]!.id, emitted[1]!.id]);
  });
});

describe("normalizeQuestionItem", () => {
  it("accepts the string shorthand as a plain text question", () => {
    expect(normalizeQuestionItem(" 用哪个分支？ ")).toEqual({ text: "用哪个分支？", type: "text", options: [] });
    expect(normalizeQuestionItem("   ")).toBeUndefined();
  });

  it("keeps choice questions with two or more options", () => {
    expect(normalizeQuestionItem({ text: "框架？", type: "single", options: ["React", "Vue"] })).toEqual({ text: "框架？", type: "single", options: ["React", "Vue"] });
    expect(normalizeQuestionItem({ text: "功能？", type: "multiple", options: ["A", "B", " C ", ""] })).toEqual({ text: "功能？", type: "multiple", options: ["A", "B", "C"] });
  });

  it("downgrades choice questions with fewer than two valid options to text", () => {
    expect(normalizeQuestionItem({ text: "框架？", type: "single", options: ["只有一项"] })).toEqual({ text: "框架？", type: "text", options: [] });
    expect(normalizeQuestionItem({ text: "框架？", type: "single" })).toEqual({ text: "框架？", type: "text", options: [] });
  });

  it("caps options and rejects unknown types", () => {
    const capped = normalizeQuestionItem({ text: "功能？", type: "multiple", options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] });
    expect(capped).toEqual({ text: "功能？", type: "multiple", options: ["1", "2", "3", "4", "5", "6", "7", "8"] });
    expect(normalizeQuestionItem({ text: "X?", type: "radio", options: ["A", "B"] })?.type).toBe("text");
    expect(normalizeQuestionItem({ type: "text" })).toBeUndefined();
    expect(normalizeQuestionItem(42)).toBeUndefined();
  });
});

describe("ask_question tool", () => {
  interface ToolRunResult {
    content: { type: string; text: string }[];
    details: { status: string; count: number };
  }

  // defineTool 推断的 execute 需要全部 5 个参数；测试里其余参数恒为空。
  async function runTool(tool: { execute?: unknown } | undefined, id: string, params: unknown): Promise<ToolRunResult> {
    if (!tool) throw new Error("ask_question 工具未构建");
    const execute = tool.execute as (toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: undefined) => Promise<ToolRunResult>;
    return execute(id, params, undefined, undefined, undefined);
  }

  function toolWithBroker(): { tools: ReturnType<typeof buildQuestionTools>; broker: QuestionBroker; emitted: QuestionRequest[] } {
    const emitted: QuestionRequest[] = [];
    const broker = new QuestionBroker((request) => emitted.push(request));
    const tools = buildQuestionTools({ getSessionId: () => "session-x", broker });
    return { tools, broker, emitted };
  }

  it("asks via the broker and returns the answers as text", async () => {
    const { tools, broker, emitted } = toolWithBroker();
    const execution = runTool(tools[0], "call-1", { questions: [
      { text: "用哪个分支？", type: "single", options: ["main", "dev"] },
      { text: "要跑测试吗？", type: "text" }
    ] });
    await Promise.resolve();
    broker.resolve(emitted[0]!.id, ["main", "要"]);
    const result = await execution;

    expect(emitted[0]!.sessionId).toBe("session-x");
    expect(emitted[0]!.toolCallId).toBe("call-1");
    expect(emitted[0]!.questions[0]).toEqual({ text: "用哪个分支？", type: "single", options: ["main", "dev"] });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[0]!.text).toContain("用哪个分支？");
    expect(result.content[0]!.text).toContain("→ main");
    expect(result.content[0]!.text).toContain("→ 要");
    expect(result.details).toEqual({ status: "answered", count: 2 });
  });

  it("reports cancellation to the model", async () => {
    const { tools, broker, emitted } = toolWithBroker();
    const execution = runTool(tools[0], "call-1", { questions: ["继续吗？"] });
    await Promise.resolve();
    broker.resolve(emitted[0]!.id);
    const result = await execution;
    expect(result.content[0]!.text).toContain("取消");
    expect(result.details).toEqual({ status: "cancelled", count: 1 });
  });

  it("rejects invalid parameter shapes without touching the broker", async () => {
    const { tools, emitted } = toolWithBroker();
    const empty = await runTool(tools[0], "call-1", { questions: [] });
    expect(empty.content[0]!.text).toContain("questions 参数无效");
    const notArray = await runTool(tools[0], "call-1", { questions: "只有一个字符串" });
    expect(notArray.content[0]!.text).toContain("questions 参数无效");
    const allInvalid = await runTool(tools[0], "call-1", { questions: ["  ", { type: "text" }, 42] });
    expect(allInvalid.content[0]!.text).toContain("questions 参数无效");
    expect(emitted).toHaveLength(0);
  });

  it("trims and caps questions at the limit", async () => {
    const { tools, broker, emitted } = toolWithBroker();
    const execution = runTool(tools[0], "call-1", { questions: ["  ", "一？", "二？", "三？", "四？", "五？", "六？", "七？"] });
    await Promise.resolve();
    expect(emitted[0]!.questions.map((item) => item.text)).toEqual(["一？", "二？", "三？", "四？", "五？"]);
    broker.resolve(emitted[0]!.id, ["1", "2", "3", "4", "5"]);
    const result = await execution;
    expect(result.details).toEqual({ status: "answered", count: 5 });
  });

  it("declares one ask_question tool with the expected shape", () => {
    const { tools } = toolWithBroker();
    expect(tools.map((tool) => tool.name)).toEqual(["ask_question"]);
  });
});
