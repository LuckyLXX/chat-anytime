import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

/**
 * 会话累计缓存命中率的计数逻辑（对齐 deepseek-harness 的 durable
 * projection 语义：计数器独立于 transcript，压缩不清零）。
 */

export interface CacheUsageTotals {
  cacheRead: number;
  /** 计费 prompt 侧 token：input + cacheRead + cacheWrite。 */
  promptTokens: number;
}

export function zeroCacheUsage(): CacheUsageTotals {
  return { cacheRead: 0, promptTokens: 0 };
}

/** 单条消息的有效 usage：跳过非 assistant、aborted/error、全零。 */
function validAssistantUsage(message: AgentMessage): Usage | undefined {
  if (!message || message.role !== "assistant") return undefined;
  const assistant = message as AssistantMessage;
  if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return undefined;
  const usage: Usage | undefined = assistant.usage;
  if (!usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite <= 0) return undefined;
  return usage;
}

/** 把一条消息的 usage 累加进计数器（无效消息原样返回）。 */
export function addMessageToCacheUsage(totals: CacheUsageTotals, message: AgentMessage): CacheUsageTotals {
  const usage = validAssistantUsage(message);
  if (!usage) return totals;
  return {
    cacheRead: totals.cacheRead + usage.cacheRead,
    promptTokens: totals.promptTokens + usage.input + usage.cacheRead + usage.cacheWrite
  };
}

/** 全量扫描 transcript 重建计数器（会话恢复初始化 / 回合结束兜底）。 */
export function scanCacheUsage(messages: readonly AgentMessage[]): CacheUsageTotals {
  let totals = zeroCacheUsage();
  for (const message of messages) totals = addMessageToCacheUsage(totals, message);
  return totals;
}

/** 累计命中率：ΣcacheRead / Σ(input + cacheRead + cacheWrite)；无计费输入时为 null。 */
export function cacheHitRateFrom(totals: CacheUsageTotals): number | null {
  return totals.promptTokens > 0 ? (totals.cacheRead / totals.promptTokens) * 100 : null;
}
