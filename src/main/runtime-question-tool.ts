// ask_question capability cluster: the customTool that lets the agent ask the
// user questions, plus the broker that bridges the blocking tool execution to
// the renderer's question panel (mirrors permission-broker's round trip).
// Pure over injected dependencies so it is testable without Pi or Electron.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QuestionItem, QuestionRequest } from "../shared/protocol.js";
import { Type } from "typebox";

export type QuestionOutcome =
  | { status: "answered"; answers: string[]; /** 移交出口（计划审查）随答案携带的实施模型；ask_question 流程恒缺省。 */ model?: { provider: string; id: string } }
  | { status: "cancelled" };

export const QUESTION_MAX_COUNT = 5;
export const QUESTION_MAX_OPTIONS = 8;

export class QuestionBroker {
  private sequence = 0;
  private readonly pending = new Map<string, { request: QuestionRequest; resolve: (outcome: QuestionOutcome) => void }>();

  constructor(
    private readonly emit: (request: QuestionRequest) => void,
    private readonly dismiss: (id: string) => void = () => undefined
  ) {}

  request(input: { sessionId: string; toolCallId: string; questions: QuestionItem[] }): Promise<QuestionOutcome> {
    const id = `question-${++this.sequence}`;
    const request: QuestionRequest = {
      id,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      questions: input.questions
    };
    this.emit(request);
    return new Promise((resolve) => {
      this.pending.set(id, { request, resolve });
    });
  }

  /**
   * answers 缺省（或与问题数不符）视为用户取消。model 为移交出口（计划审查）
   * 随答案携带的实施模型：provider/id 必须是非空字符串，非法形状一律按缺省
   * 忽略（ask_question 流程无感知）。
   */
  resolve(id: string, answers?: string[], model?: { provider: string; id: string }): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    this.dismiss(id);
    const valid = Array.isArray(answers)
      && answers.length === pending.request.questions.length
      && answers.every((answer) => typeof answer === "string");
    const validModel = model && typeof model.provider === "string" && typeof model.id === "string"
      && model.provider.trim().length > 0 && model.id.trim().length > 0
      ? { provider: model.provider.trim(), id: model.id.trim() }
      : undefined;
    pending.resolve(valid
      ? { status: "answered", answers: answers!.map((answer) => answer.trim()), ...(validModel ? { model: validModel } : {}) }
      : { status: "cancelled" });
    return true;
  }

  /** 会话销毁/重建时取消挂起的提问，避免工具执行永久阻塞。 */
  reset(sessionId?: string): void {
    for (const [id, pending] of this.pending) {
      if (sessionId && pending.request.sessionId !== sessionId) continue;
      this.pending.delete(id);
      this.dismiss(id);
      pending.resolve({ status: "cancelled" });
    }
  }
}

export interface QuestionToolContext {
  /** 会话 id 在 createAgentSession 之后才确定，因此以 getter 注入。 */
  getSessionId(): string | undefined;
  broker: QuestionBroker;
}

type RawQuestionObject = { text?: unknown; type?: unknown; options?: unknown };

function normalizeOptions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, QUESTION_MAX_OPTIONS);
}

/**
 * 模型可用字符串简写（纯文本题），或对象形式指定 single/multiple 选择题。
 * 选择题选项不足 2 个时降级为文本题，保证渲染端拿到的永远是合法结构。
 */
export function normalizeQuestionItem(input: unknown): QuestionItem | undefined {
  if (typeof input === "string") {
    const text = input.trim();
    return text ? { text, type: "text", options: [] } : undefined;
  }
  if (!input || typeof input !== "object") return undefined;
  const raw = input as RawQuestionObject;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) return undefined;
  const type = raw.type === "single" || raw.type === "multiple" || raw.type === "text" ? raw.type : "text";
  const options = normalizeOptions(raw.options);
  const choiceType = (type === "single" || type === "multiple") && options.length >= 2 ? type : "text";
  return { text, type: choiceType, options: choiceType === "text" ? [] : options };
}

function normalizeQuestions(input: unknown): QuestionItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => normalizeQuestionItem(item))
    .filter((item): item is QuestionItem => item !== undefined)
    .slice(0, QUESTION_MAX_COUNT);
}

function formatAnswers(questions: QuestionItem[], answers: string[]): string {
  return questions.map((question, index) => `${index + 1}. ${question.text}\n   → ${answers[index] ?? "（未回答）"}`).join("\n");
}

/** Build the ask_question customTool (one per session record). */
export function buildQuestionTools({ getSessionId, broker }: QuestionToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "ask_question",
      label: "向用户提问",
      description: `向用户提出 ${QUESTION_MAX_COUNT} 个以内的问题以澄清需求、确认方案或收集信息。工具会阻塞等待用户在输入栏上方的提问面板中作答，回答会原样返回。问题可以是纯文本（直接传字符串），或对象形式的选择题：{ text, type: "single"|"multiple", options: [...] }（2-${QUESTION_MAX_OPTIONS} 个选项）；选择题同时提供自定义输入，用户可勾选也可自行填写。选择题请把最推荐的选项放在 options 的第一位，界面会自动在其后标注（推荐），提示用户这是你的建议项。缺少关键信息时优先用它提问，而不是自行假设。`,
      promptSnippet: "ask_question: 向用户提问（文本/单选/多选）并等待回答",
      parameters: Type.Object({
        questions: Type.Array(
          Type.Union([
            Type.String({ description: "纯文本问题" }),
            Type.Object({
              text: Type.String({ description: "问题文本，简洁明确" }),
              type: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("multiple"), Type.Literal("text")], { description: "题型：single 单选 / multiple 多选，缺省为文本题" })),
              options: Type.Optional(Type.Array(Type.String(), { description: "选项列表，选择题必填（2-8 个）；把最推荐的选项放在第一位，界面会标注「推荐」" }))
            })
          ]),
          {
            minItems: 1,
            maxItems: QUESTION_MAX_COUNT,
            description: "1-5 个问题；只有一个问题时也传数组。需要用户选择时用对象形式并提供 options"
          }
        )
      }),
      execute: async (id, params) => {
        const questions = normalizeQuestions(params?.questions);
        if (questions.length === 0) {
          return {
            content: [{ type: "text", text: `questions 参数无效：需要至少一个非空问题字符串。请修正后重试。` }],
            details: { status: "invalid", count: 0 }
          };
        }
        const outcome = await broker.request({ sessionId: getSessionId() ?? "unknown", toolCallId: String(id ?? ""), questions });
        if (outcome.status === "cancelled") {
          return {
            content: [{ type: "text", text: "用户取消了本次提问（未作答）。请基于已有信息继续，或改用其它方式推进。" }],
            details: { status: "cancelled", count: questions.length }
          };
        }
        return {
          content: [{ type: "text", text: `用户已回答：\n${formatAnswers(questions, outcome.answers)}` }],
          details: { status: "answered", count: questions.length }
        };
      }
    })
  ];
}
