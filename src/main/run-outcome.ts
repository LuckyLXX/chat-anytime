/**
 * 回合结局判定（纯函数）：「中止」与「失败」是两种语义。
 *
 * 用户点停止时 Pi 会落一条 stopReason=aborted 的 assistant 消息，errorMessage
 * 里塞的是各家 SDK 的中止原文（undici fetch 的 "This operation was aborted"、
 * anthropic 的 "Request was aborted"、proxy 的 "Request aborted by user" …）——
 * 判定以 stopReason 为准，不靠匹配英文文案。
 *
 * 但 stopReason 并非总是 aborted：网络层被中断、provider 把中止态报成错误时，
 * Pi 会落 stopReason=error 而 errorMessage 仍是中止原文（近 3 天会话里出现过
 * 4 次）。此时只认 stopReason 就会把用户主动停止渲染成红色失败气泡。因此这里
 * 提供两级判定：
 * - {@link isAbortedMessage} 严格版：只看 stopReason，是权威路径；
 * - {@link isAbortedOutcome} 宽版：stopReason=aborted，或已经有 error 态但
 *   文案是中止原文时降级为中止。**只在消息已落入 error/失败分支时**才做这层
 *   补救，绝不反过来用英文文案把一次真实失败洗成中止——那是本末倒置。
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

/**
 * 各家 SDK 的中止原文特征（小写匹配）。这是**补救**用的补集：只有当 Pi 已经
 * 把这一回合落成了 error/失败，而文案长这样时，才把它降级成中止。新增条目要
 * 足够具体——宽泛的词（如 "closed" / "cancelled"）会把真实失败误判成中止。
 */
/**
 * 中止原文特征（小写子串匹配）。收窄到「整个文案就是在说被中止」的形态：
 * 不允许 HTTP 错误码、限流/配额类字样同时出现——那说明这是真实的服务端错误，
 * 只是恰好带了 abort 这个词（例：上游返回 "429 abort"）。宁可漏判（爆红）
 * 也不要把真实失败洗成中止——前者只是难看，后者会让人以为任务没出错。
 */
const ABORT_TEXT_PATTERNS = [
  "operation was aborted",
  "request was aborted",
  "request aborted",
  "aborted by user",
  "abort error",
  "signal is aborted",
  "aborted"
];

/**
 * 真实错误的强特征：命中即否决中止判定（即使文案里出现了 abort 字样）。
 * 这些是服务端在「报错」，不是客户端在「停止」。
 */
const REAL_ERROR_PATTERNS = [
  "rate_limit",
  "rate limit",
  "quota_exceeded",
  "quota exceeded",
  "tpm/rpm",
  "insufficient",
  "unauthorized",
  "invalid api key",
  "context length",
  "context_length",
  "unexpected reasoning",
  "unsupported"
];

/** 文案是否像「用户/连接被中止」而非真实错误（空串不算）。 */
export function isAbortErrorMessage(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  // HTTP 状态码开头的（"429 status code (no body)"、"524 status code…"）一律是
  // 真实错误，不看后面带了什么词。
  if (/^\d{3}\b/u.test(errorMessage.trim())) return false;
  if (REAL_ERROR_PATTERNS.some((pattern) => lower.includes(pattern))) return false;
  return ABORT_TEXT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** 该消息是否以「中止」结束（用户停止）——严格版，只看 stopReason。 */
export function isAbortedMessage(message: OutcomeMessageLike | undefined): boolean {
  return message?.role === "assistant" && message.stopReason === "aborted";
}

/**
 * 宽版中止判定：stopReason=aborted，或 stopReason=error 且 errorMessage 是
 * 中止原文（Pi 偶尔把中止报成 error 态）。给气泡/圆点这类「要不要爆红」的
 * 展示口径使用；需要严格权威判定的地方仍用 {@link isAbortedMessage}。
 */
export function isAbortedOutcome(message: OutcomeMessageLike | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason === "aborted") return true;
  return isAbortErrorMessage(message.errorMessage);
}

/**
 * 回合结束时的侧栏圆点：中止 → aborted（中性灰），真实错误 → failed，
 * 其余 → completed。abortRequested 是命令侧的「用户点过停止」标记——即使
 * Pi 因进程被强杀没能落出 aborted 消息，也按中止结算。
 */
export function resolveRunOutcomeStatus(abortRequested: boolean, messages: readonly OutcomeMessageLike[]): TerminalRunStatus {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  // isAbortedOutcome 已覆盖 stopReason=aborted（严格版是它的子集），再加一层
  // Pi 把中止报成 error 态的补救判定。
  if (abortRequested || isAbortedOutcome(lastAssistant)) return "aborted";
  return lastAssistant?.errorMessage ? "failed" : "completed";
}
