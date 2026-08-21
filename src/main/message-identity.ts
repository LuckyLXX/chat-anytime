import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * 会话消息的稳定 uuid（确定性生成，无状态）。
 *
 * Pi agent-loop 每个流式事件携带 `{ ...partialMessage }` 新对象、提交时
 * `response.result()` 又是另一个对象，但三者的 timestamp/role 与其在消息
 * 数组中的 index 完全一致（provider 的 output 对象在流开始时创建一次、
 * timestamp 固定；index 在追加式消息数组中对该消息恒定）。因此
 * `${timestamp}-${role}-${index}` 对同一条消息的全部帧恒定：渲染端 React
 * key 不会在流式期间逐帧变化（此前每帧重挂载导致气泡闪烁），store 按
 * uuid 合并的优化也随之真正生效。
 *
 * 注意：uuid 成分里不要加入按对象身份或自增序号的项——那会让每个流式帧
 * 拿到不同 uuid，正是 2026-08-21 修复的闪烁 bug。
 */
export function messageUuid(message: AgentMessage, index: number): string {
  return `${message.timestamp ?? 0}-${message.role}-${index}`;
}
