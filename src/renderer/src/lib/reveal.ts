import type { ChatMessage } from "../../../shared/protocol";

/**
 * 在渲染端的消息数组里定位检索命中。
 *
 * 身份用 `timestamp + role`：扫描端解析 JSONL 时无法复刻渲染端的消息下标
 * （normalizeMessages 会按可见性过滤、压缩/regenerate 还会重排），但时间戳与
 * 角色在两侧同源。少数没有时间戳的历史消息会定位失败（返回 undefined），
 * 由调用方放弃高亮而不是滚到错误位置。
 */
export function findRevealMessage(
  messages: readonly ChatMessage[],
  target: { timestamp: number; role: "user" | "assistant" }
): ChatMessage | undefined {
  if (!target.timestamp) return undefined;
  return messages.find((message) => message.timestamp === target.timestamp && message.role === target.role);
}

/**
 * 命中消息所属轮的锚点 key。时间线的 `data-turn-key` 只挂在**轮首 user 消息**上
 * （缩略导航与窗口化共用这一约定），所以助手消息的命中不能直接拿自己的 key 去
 * 钉住——那样只会把消息实体化、不会滚动。向前找最近的轮首；找不到时返回
 * undefined，由调用方退回消息自身 key（至少保证高亮可见）。
 */
export function findRevealTurnKey(
  messages: readonly ChatMessage[],
  target: ChatMessage,
  isTurnStart: (message: ChatMessage) => boolean
): string | undefined {
  const index = messages.indexOf(target);
  if (index < 0) return undefined;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const message = messages[cursor]!;
    if (isTurnStart(message)) return message.uuid ?? message.id;
  }
  return undefined;
}
