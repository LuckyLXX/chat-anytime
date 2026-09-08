/**
 * 回合结局判定（纯函数）：「中止」与「失败」是两种语义。
 *
 * 用户点停止时 Pi 会落一条 stopReason=aborted 的 assistant 消息，errorMessage
 * 里塞的是各家 SDK 的中止原文（undici fetch 的 "This operation was aborted"、
 * anthropic 的 "Request was aborted"、proxy 的 "Request aborted by user" …）——
 * 绝不能靠匹配英文文案判定，统一按 stopReason 认。
 *
 * 口径唯一：侧栏圆点（pi-runtime resolveRunOutcome）、气泡提示
 * （message-normalize 的 aborted 标记）、钩子审计（runtime-hooks 的 isError）
 * 共用这里的判定，避免三处各写一份漂移。
 */

import type { SessionRunStatus } from "../shared/protocol.js";

/** Pi 消息里判定结局所需的最小形状（AgentMessage 的兼容子集）。 */
export interface OutcomeMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** 回合终态：running 是运行中的瞬时态，结算时不会用到。 */
export type TerminalRunStatus = Exclude<SessionRunStatus, "running">;

/** 该消息是否以「中止」结束（用户停止）。 */
export function isAbortedMessage(message: OutcomeMessageLike | undefined): boolean {
  return message?.role === "assistant" && message.stopReason === "aborted";
}

/**
 * 回合结束时的侧栏圆点：中止 → aborted（中性灰），真实错误 → failed，
 * 其余 → completed。abortRequested 是命令侧的「用户点过停止」标记——即使
 * Pi 因进程被强杀没能落出 aborted 消息，也按中止结算。
 */
export function resolveRunOutcomeStatus(abortRequested: boolean, messages: readonly OutcomeMessageLike[]): TerminalRunStatus {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (abortRequested || isAbortedMessage(lastAssistant)) return "aborted";
  return lastAssistant?.errorMessage ? "failed" : "completed";
}
