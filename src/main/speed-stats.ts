import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SpeedStats } from "../shared/protocol.js";
import { validAssistantUsage } from "./runtime-context-usage.js";

/**
 * dsh（deepseek-harness）StatsLine 的口径移植：输出速度 = Σ(带 usage 步的
 * 输出 token) / Σ(该步首帧→完成时长)，天然排除 TTFT 等待与全部工具执行；
 * LLM 耗时与工具耗时按步配对互斥累计。与 dsh 的差异只有一处：Pi 的事件流
 * 没有 request-dispatch 打点，步起点用 turn_start（每次模型调用周期的开始）
 * 近似，多算了上下文组装的几十毫秒。
 *
 * 计数字段每步即时累计，agent_end / agent_settled 再用 transcript 重扫收敛
 * （regenerate 截断后不残留旧账）。时间指标不落盘（JSONL 只有消息完成时间
 * 戳），恢复会话只回填计数字段。
 */

/** 一次模型调用周期的瞬态打点（turn_start 开步，message_end 收步）。 */
export interface SpeedStep {
  /** turn_start 时刻（步起点 ≈ 请求发出）。 */
  startedAt: number;
  /** 流式首帧时刻（message_start）；无则该步无 TTFT/解码读数。 */
  firstTokenAt?: number;
}

export function zeroSpeedStats(): SpeedStats {
  return { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeTokens: 0, decodeMs: 0, promptTokens: 0, outputTokens: 0 };
}

/** 用户轮次 +1（beginTurn：发送、重新生成等一次完整回复的起点）。 */
export function beginSpeedTurn(stats: SpeedStats): SpeedStats {
  return { ...stats, turns: stats.turns + 1 };
}

/**
 * 收一步（assistant 消息完成）：LLM 耗时总是累计；首帧存在时累计 TTFT；
 * 消息带有效 usage（调用方已过 validAssistantUsage）时计步并累计解码读数
 * ——token 计数不在本函数维护（快照时从 cacheUsage 合入，单一账本）。
 */
export function closeSpeedStep(stats: SpeedStats, step: SpeedStep, endedAt: number, usage: { output: number } | undefined): SpeedStats {
  const next: SpeedStats = { ...stats, llmMs: stats.llmMs + Math.max(0, endedAt - step.startedAt) };
  if (usage) next.steps = stats.steps + 1;
  if (step.firstTokenAt === undefined) return next;
  next.ttftMs = stats.ttftMs + Math.max(0, step.firstTokenAt - step.startedAt);
  next.ttftSteps = stats.ttftSteps + 1;
  if (usage && usage.output > 0) {
    next.decodeMs = stats.decodeMs + Math.max(0, endedAt - step.firstTokenAt);
    next.decodeTokens = stats.decodeTokens + usage.output;
  }
  return next;
}

/** 工具执行耗时累计（单次调用 = end − start）。 */
export function addSpeedToolMs(stats: SpeedStats, durationMs: number): SpeedStats {
  return { ...stats, toolMs: stats.toolMs + Math.max(0, durationMs) };
}

/** 从 transcript 重派计数字段（时间与轮次保留原值；token 由快照合入 cacheUsage）。 */
function deriveCounters(messages: readonly AgentMessage[]): { steps: number } {
  let steps = 0;
  for (const message of messages) {
    if (validAssistantUsage(message)) steps += 1;
  }
  return { steps };
}

/**
 * 恢复会话的冷启动回填：轮步计数来自 transcript，时间字段清零（重启前
 * 的耗时读数无从重派，状态行只统计本进程内发生的部分）。
 */
export function seedSpeedStats(messages: readonly AgentMessage[]): SpeedStats {
  let turns = 0;
  for (const message of messages) {
    if (message.role === "user") turns += 1;
  }
  return { ...zeroSpeedStats(), turns, ...deriveCounters(messages) };
}

/** agent_end / agent_settled 兜底：regenerate 截断后步数与 transcript 收敛。 */
export function syncSpeedCounters(stats: SpeedStats, messages: readonly AgentMessage[]): SpeedStats {
  return { ...stats, ...deriveCounters(messages) };
}
