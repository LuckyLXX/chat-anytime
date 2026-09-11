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
 *
 * 判定以**选项在不在**为准，而不是以 type 写没写为准：`type` 是可选字段，
 * 模型经常只给 `options` 不给 `type`（2026-09-11 实测 tool-audit：连续 15 组
 * 提问的每个问题都带 2-4 个 options、type 全缺省）。旧实现按「type 不是
 * single/multiple 就当文本题」处理，会把这些选项**静默丢弃**——用户看到面板
 * 里只有输入框、没有单选项（原始调用报文里明明有 options）。因此：
 * options ≥ 2 即视为选择题，显式 multiple 保留多选，其余（缺省/text/非法值）
 * 一律按单选；只有 options 不足 2 个才降级为文本题（无可选，保留输入框即可）。
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
  const options = normalizeOptions(raw.options);
  if (options.length < 2) return { text, type: "text", options: [] };
  return { text, type: raw.type === "multiple" ? "multiple" : "single", options };
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
      description: `向用户提出 ${QUESTION_MAX_COUNT} 个以内的问题以澄清需求、确认方案或收集信息；工具阻塞等待用户在提问面板作答，回答原样返回（问题形态与选项见参数 schema）。需要用户选择时用对象形式并提供 options：给出 ≥2 个 options 就是选择题（type 缺省即单选，可显式写 multiple 多选），不要只给 text 不给 options；选择题把最推荐的选项放在第一位，界面会自动在其后标注（推荐）。缺少关键信息时优先用它提问，而不是自行假设。`,
      promptSnippet: "ask_question: 向用户提问（文本/单选/多选）并等待回答",
      parameters: Type.Object({
        questions: Type.Array(
          Type.Union([
            Type.String({ description: "纯文本问题" }),
            Type.Object({
              text: Type.String({ description: "问题文本，简洁明确" }),
              type: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("multiple"), Type.Literal("text")], { description: "题型：multiple 多选；single 或省略（给 options 时缺省即单选）单选" })),
              options: Type.Optional(Type.Array(Type.String(), { description: "选项列表，2-8 个；给出 ≥2 个即成为选择题（type 缺省为单选）。把最推荐的选项放在第一位，界面会标注「推荐」" }))
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
