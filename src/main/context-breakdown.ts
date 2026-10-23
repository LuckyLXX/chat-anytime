import { estimateTokens } from "@earendil-works/pi-coding-agent";
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

/** 与估算同源的声明投影：只保留真正下发给模型的三项，避免把无关字段卷进指纹。 */
function declarationProjection(tool: ToolSchemaDescriptor): ToolSchemaDescriptor {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

export function estimateToolTokens(tools: readonly ToolSchemaDescriptor[]): number {
  let tokens = 0;
  for (const tool of tools) {
    tokens += Math.ceil(JSON.stringify(declarationProjection(tool)).length / 4) + TOOL_WRAPPER_OVERHEAD;
  }
  return tokens;
}

/**
 * 判断工具段缓存能否复用的完整声明指纹：名字 + 描述 + 参数 schema 的 JSON（键序
 * 按对象插入顺序稳定）。同名工具的 schema 变化、等长描述变化都会得到不同的串——
 * 只比较工具名或描述长度会让这类更新静默沿用旧估算。
 */
export function toolDeclarationsFingerprint(tools: readonly ToolSchemaDescriptor[]): string {
  return JSON.stringify(tools.map(declarationProjection));
}

/** 工具段估算缓存：指纹 + 结果（调用方按会话持有，快照只读）。 */
export interface ToolTokensCache {
  fingerprint: string;
  tokens: number;
}

/**
 * 声明没变就复用缓存，变了才重新估算。注意成本口径：指纹本身是 O(声明总字节)
 * 的一次 stringify（内容级失效检测的必要代价），缓存真正省掉的是命中时的第二遍
 * per-tool stringify 与开销计算。调用方只在稳定边界（消息落定/压缩/切模型/工具
 * 事件）调 refreshContextBreakdown，高频 snapshot 只读 record 上的缓存字段。
 */
export function cachedToolTokens(cache: ToolTokensCache | undefined, tools: readonly ToolSchemaDescriptor[]): ToolTokensCache {
  const fingerprint = toolDeclarationsFingerprint(tools);
  if (cache?.fingerprint === fingerprint) return cache;
  return { fingerprint, tokens: estimateToolTokens(tools) };
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
