import { estimateTokens } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextUsageBreakdown } from "../shared/protocol.js";

/**
 * 上下文三段明细（系统提示词 / 活动工具 schema / 对话消息）的本地启发式
 * 估算，dsh ContextMeter 同款语义：与占用总量不同源（总量是 usage 锚定的
 * 官方估算，含图片等本估算覆盖不到的部分），三行带 ~ 前缀展示、加总不必
 * 等于总量。消息段直接复用 Pi 的 estimateTokens（chars/4，与压缩阈值同
 * 口径）；密度对齐 dsh（4 字符/token）。
 */

/** 工具的最小 schema 投影（ToolInfo 的 Pick；request 里随函数定义下发）。 */
export interface ToolSchemaDescriptor {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** 单个工具定义的估算：JSON 全串 /4 + 函数包装开销（dsh BLOCK_OVERHEAD）。 */
const TOOL_WRAPPER_OVERHEAD = 4;

export function estimateToolTokens(tools: readonly ToolSchemaDescriptor[]): number {
  let tokens = 0;
  for (const tool of tools) {
    tokens += Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length / 4) + TOOL_WRAPPER_OVERHEAD;
  }
  return tokens;
}

export interface ContextBreakdownInput {
  systemPrompt?: string;
  /** 活动工具定义的估算（estimateToolTokens；调用方按活动集缓存）。 */
  toolTokens: number;
  messages: readonly AgentMessage[];
}

export function estimateContextBreakdown(input: ContextBreakdownInput): ContextUsageBreakdown {
  const system = input.systemPrompt ? Math.ceil(input.systemPrompt.length / 4) : 0;
  let messages = 0;
  for (const message of input.messages) messages += estimateTokens(message);
  return { system, tools: input.toolTokens, messages };
}
