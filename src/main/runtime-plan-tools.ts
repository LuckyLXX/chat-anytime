// Plan mode capability cluster: the enter/exit_plan_mode customTools and the
// per-request narration injection that tells the model it is planning.
//
// Design (aligned with deepseek-harness's plan mode): the mode is a
// collaboration stance with soft restraint only — guidance injection plus the
// exit review gate; it changes no permission/access axis and filters no tools.
// The plan itself lives in the session transcript as the exit_plan_mode
// tool-call argument (reconstructable from the log, one home per fact), and
// the approved version is archived to `<workspace>/docs/plans/` by the
// main-process side of the approval — the model never writes during planning.
//
// Cache discipline (same as todo/vision): narration never enters the system
// prompt or the transcript. It is appended to the last user message of a live
// LLM request via the per-session `context` extension event, once per entry
// (full guidance) and once per subsequent turn (a short reminder), so the
// request prefix stays byte-identical until a mode transition.

import { defineTool, type ToolDefinition, type InlineExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { QuestionBroker } from "./runtime-question-tool.js";
import type { QuestionItem } from "../shared/protocol.js";
import { Type } from "typebox";

/** Per-session plan mode state; narrate drives the one-shot context injection. */
export interface PlanModeState {
  enabled: boolean;
  /** 待注入的叙事：full=刚进入（完整指引）；reminder=新回合开始（短提醒）。 */
  narrate: "full" | "reminder" | undefined;
}

export const PLAN_MODE_GUIDANCE_FULL = [
  "【计划模式已开启】本会话已切换到计划模式，接下来请遵循：",
  "1. 先探索研究，再动手规划：阅读代码与文档理解现状，必要时向用户提问澄清需求与方案取舍；这一阶段只做只读操作，不要修改任何文件、不要执行有副作用的命令。",
  "2. 产出计划：把实施方案写成一份完整的 Markdown 计划文档，至少包含：背景与目标、实施步骤（每步说明涉及的文件与改动）、验证方式、风险与假设。计划要决策完备，用户将据此批准。",
  "3. 通过 exit_plan_mode 提交计划，等待用户在审查面板批准；批准之前绝对不要开始实施。",
  "4. 批准后计划模式自动退出，再严格按计划逐步实施；若审查被拒，工具会带回用户的修改意见，据此完善后重新提交。",
  "5. 简单任务不要进入计划模式；用户可随时手动关闭计划模式。"
].join("\n");

/** 每回合开始的短提醒：完整指引已在本会话出现过，无需重复全文。 */
export const PLAN_MODE_GUIDANCE_REMINDER =
  "【提醒：本会话仍处于计划模式】先产出完整计划并调用 exit_plan_mode 提交审查，批准后才开始实施；规划阶段保持只读。";

/** 审查单选选项；第一个会被审查面板标注「（推荐）」——模型提交计划即推荐批准。 */
export const PLAN_APPROVE_OPTION = "批准计划，开始实施";
export const PLAN_REVISE_OPTION = "不批准，继续完善计划";

/** 当前状态应注入的叙事文本；无待注入时返回 undefined。 */
export function planNarrationText(state: PlanModeState): string | undefined {
  if (!state.enabled || state.narrate === undefined) return undefined;
  return state.narrate === "full" ? PLAN_MODE_GUIDANCE_FULL : PLAN_MODE_GUIDANCE_REMINDER;
}

/**
 * Plan-mode inline extension（app-owned 第四个内联扩展）：在每次 LLM 调用前的
 * `context` 事件里把待注入的计划模式叙事附加到最后一条 user 消息尾部，随后
 * 清除 narrate 标记。注入只发生在有 pending narrate 的请求上——其余请求的
 * 消息原样返回，前缀缓存不受影响；叙事从不进入 transcript 或系统提示。
 */
export function createPlanModeExtension(deps: { state: () => PlanModeState | undefined }): InlineExtension {
  return {
    name: "pidesktop-plan-mode",
    hidden: true,
    factory(pi: ExtensionAPI) {
      pi.on("context", (event) => {
        const state = deps.state();
        if (!state) return undefined;
        const text = planNarrationText(state);
        if (!text) return undefined;
        // 注入只向用户消息追加文本部分，不改变消息结构——宽松类型在此收窄断言。
        const messages = injectPlanNarration(event.messages, text) as unknown as AgentMessage[] | undefined;
        if (!messages) return undefined;
        state.narrate = undefined;
        return { messages };
      });
    }
  };
}

// —— narration injection ——

/** 宽松的 transcript 消息结构（context 事件中的 AgentMessage 兼容子集）。 */
export interface NarrationMessage {
  role?: string;
  content?: unknown;
}

function isTextPart(part: unknown): part is { type?: string; text?: string } {
  return Boolean(part && typeof part === "object" && (part as { type?: string }).type !== "toolCall");
}

/**
 * 把叙事文本追加到消息列表中最后一条 user 消息的文本尾部（纯函数，不原地
 * 修改）。仅当存在可注入的 user 消息时返回新数组；否则返回 undefined，调用
 * 方保留 narrate 标记待下次请求再试。
 */
export function injectPlanNarration(messages: readonly NarrationMessage[], text: string): NarrationMessage[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") {
      return messages.map((item, i) => i === index ? { ...item, content: `${content}\n\n${text}` } : item);
    }
    if (Array.isArray(content)) {
      const parts = [...content];
      const last = parts[parts.length - 1];
      if (isTextPart(last) && typeof last.text === "string") {
        parts[parts.length - 1] = { ...last, text: `${last.text}\n\n${text}` };
      } else {
        parts.push({ type: "text", text });
      }
      return messages.map((item, i) => i === index ? { ...item, content: parts } : item);
    }
    // 该 user 消息无文本可挂（如纯图片）→ 继续向前找下一条 user。
  }
  return undefined;
}

// —— exit/enter tools ——

export interface PlanToolDeps {
  getSessionId(): string | undefined;
  getEnabled(): boolean;
  /** 切换模式：写盘 + 设置 narrate 标记 + 广播快照（主进程侧实现）。 */
  setEnabled(enabled: boolean): void;
  broker: QuestionBroker;
  /** 当前工作区（批准落盘目标目录的基座）。 */
  workspace: () => string | undefined;
  /** 批准后把计划写入 docs/plans/（主进程侧，失败不阻塞批准）。 */
  savePlan: (plan: string) => { path: string } | { error: string };
}

/** 审查问题：计划全文作为 detail 展示，单选批准/继续完善，自定义输入即反馈。 */
export function planReviewQuestion(plan: string): QuestionItem {
  return {
    text: "请审查这份计划：批准后我将退出计划模式并严格按计划开始实施。",
    type: "single",
    options: [PLAN_APPROVE_OPTION, PLAN_REVISE_OPTION],
    detail: plan
  };
}

export type PlanReviewOutcome =
  | { status: "approved" }
  | { status: "rejected"; feedback: string }
  | { status: "cancelled" };

/**
 * 判定审查结果：只有恰好选中「批准」选项才算批准；其他任何作答（含自定义
 * 反馈文本）都是拒绝并携带反馈；answers 缺省/空视为用户忽略（保持计划模式）。
 */
export function parsePlanReview(answers: string[] | undefined): PlanReviewOutcome {
  if (!answers || answers.length === 0) return { status: "cancelled" };
  const answer = answers[0]!.trim();
  if (answer === PLAN_APPROVE_OPTION) return { status: "approved" };
  return { status: "rejected", feedback: answer === PLAN_REVISE_OPTION ? "" : answer };
}

function errorResult(text: string): { content: { type: "text"; text: string }[]; details: object; isError: true } {
  return { content: [{ type: "text", text }], details: { status: "invalid" }, isError: true };
}

/** Build the plan-mode customTools (enter_plan_mode + exit_plan_mode). */
export function buildPlanTools(deps: PlanToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "enter_plan_mode",
      label: "进入计划模式",
      description: [
        "切换到计划模式：当任务明显需要先规划再实施时调用——多步骤、多文件协同、方案存在取舍、需要先研究现状的任务。",
        "进入后应先探索研究（只读）、产出完整计划，经 exit_plan_mode 提交用户审查，批准后才开始实施。",
        "简单琐碎任务不要进入；已在计划模式时无需调用。"
      ].join(""),
      promptSnippet: "enter_plan_mode: 进入计划模式（先出计划，批准后实施）",
      parameters: Type.Object({}),
      execute: async () => {
        if (deps.getEnabled()) {
          return {
            content: [{ type: "text" as const, text: "当前已处于计划模式：请继续产出计划，完成后调用 exit_plan_mode 提交审查。" }],
            details: { status: "already-enabled" }
          };
        }
        deps.setEnabled(true);
        return {
          content: [{ type: "text" as const, text: "已切换到计划模式：请先探索研究现状，然后产出完整计划，通过 exit_plan_mode 提交审查；批准前不要实施。" }],
          details: { status: "enabled" }
        };
      }
    }),
    defineTool({
      name: "exit_plan_mode",
      label: "提交计划并退出计划模式",
      description: [
        "提交计划供用户审查（仅计划模式可用）。把完整计划作为 markdown 写入 plan 参数，用户会在审查面板中看到计划全文并选择批准或提出修改意见。",
        "这是本次回复中应调用的最后一个工具调用：批准后本会话退出计划模式，按计划开始实施；被拒时返回用户的修改意见，据此完善计划后重新提交。",
        "不在计划模式时调用会被拒绝。"
      ].join(""),
      promptSnippet: "exit_plan_mode: 提交计划文档供用户审查（批准后开始实施）",
      parameters: Type.Object({
        plan: Type.String({ description: "完整计划，markdown 格式，至少包含背景与目标、实施步骤（每步涉及的文件与改动）、验证方式、风险与假设" })
      }),
      execute: async (id, params) => {
        if (!deps.getEnabled()) {
          return errorResult("当前不在计划模式，exit_plan_mode 不可用。简单任务直接实施即可，无需提交计划。");
        }
        const plan = typeof params?.plan === "string" ? params.plan.trim() : "";
        if (!plan) {
          return errorResult("plan 参数无效：需要一段非空 markdown 计划文本。请补全计划后重试。");
        }
        const outcome = await deps.broker.request({
          sessionId: deps.getSessionId() ?? "unknown",
          toolCallId: String(id ?? ""),
          questions: [planReviewQuestion(plan)]
        });
        if (outcome.status === "cancelled") {
          return {
            content: [{ type: "text" as const, text: "用户尚未审查计划（忽略）。请继续完善计划，或询问用户希望如何处理。" }],
            details: { status: "cancelled" }
          };
        }
        const verdict = parsePlanReview(outcome.answers);
        if (verdict.status === "cancelled") {
          // 理论不可达：outcome.cancelled 分支已提前返回。
          return {
            content: [{ type: "text" as const, text: "审查未决（用户未作答）。请继续完善计划，或询问用户希望如何处理。" }],
            details: { status: "cancelled" }
          };
        }
        if (verdict.status === "approved") {
          deps.setEnabled(false);
          const saved = deps.savePlan(plan);
          const archive = "path" in saved ? `计划已留档至 ${saved.path}；` : `计划留档失败（${saved.error}），但不影响实施；`;
          return {
            content: [{ type: "text" as const, text: `计划已批准，本会话已退出计划模式。${archive}请严格按照计划从第一步开始实施，全部完成后总结结果。` }],
            details: { status: "approved", saved: "path" in saved ? saved.path : undefined }
          };
        }
        const feedback = verdict.feedback
          ? `用户的修改意见：${verdict.feedback}`
          : "用户选择了继续完善，但未给出具体意见——请主动询问需要调整的方向。";
        return {
          content: [{ type: "text" as const, text: `计划未获批准，本会话仍处于计划模式。${feedback}据此完善计划后重新调用 exit_plan_mode 提交。` }],
          details: { status: "rejected", feedback: verdict.feedback },
          isError: true
        };
      }
    })
  ];
}