import type { ChatMessage } from "../../../shared/protocol";

/** 兜底预览长度；调用方可通过 buildTurnSummaries 的 maxPreviewChars 覆盖。 */
export const DEFAULT_TURN_PREVIEW_CHARS = 120;

export interface TurnSummary {
  /** 该轮首条消息的 uuid/id，用于时间线锚点与滚动定位。 */
  key: string;
  /** 轮次序号（从 0 起），导航条显示用。 */
  index: number;
  /** 用户输入文本摘要（text blocks 拼接；图片/空文本忽略，保留首行，超长截断）。 */
  userText: string;
  /** AI 输出文本摘要（text blocks 拼接；thinking/tool-call 忽略，保留首行，超长截断）。 */
  aiText: string;
  /** 该轮涵盖的消息数（用于导航条徽标）。 */
  messageCount: number;
}

/**
 * 摘要预览：压缩行内连续空白、去掉首尾空白、把连续空行折叠为单个换行，
 * 保留多行结构（导航卡片可显示多行）；按 maxChars 截断并加省略号。留空返回 ""。
 */
export function truncatePreview(text: string, maxChars: number): string {
  const normalized = text.replace(/[ \t]+/gu, " ").trim().replace(/\n{2,}/gu, "\n");
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

/** 从消息 blocks 里收集某类纯文本块并拼接。 */
function collectText(blocks: ChatMessage["blocks"]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 把已经过 groupAssistantMessages 分组的会话消息切成「轮」——以一个
 * role="user" 消息为锚点，直到下一个 user 消息为止（一次提问 + 其后全部
 * AI/工具回复）。纯函数、可单测。
 *
 * 约定：接受 groupAssistantMessages 的输出（连续 assistant 已合并），
 * 因此一轮内最多一条 assistant 消息。空数组返回空列表。
 */
export function buildTurnSummaries(messages: ChatMessage[], maxPreviewChars = DEFAULT_TURN_PREVIEW_CHARS): TurnSummary[] {
  const turns: TurnSummary[] = [];
  let current: { key: string; index: number; userText: string; aiText: string; messageCount: number } | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      // 上一轮就此结束（若轮头 user 无后续 assistant 也已记录）。
      if (current) turns.push(current);
      current = {
        key: message.uuid ?? message.id,
        index: turns.length,
        userText: truncatePreview(collectText(message.blocks), maxPreviewChars),
        aiText: "",
        messageCount: 1
      };
      continue;
    }

    if (!current) {
      // 会话开头没有 user（如仅有一条历史 assistant）：跳过，不虚构轮次。
      continue;
    }

    if (message.role === "assistant") {
      const text = collectText(message.blocks);
      // 多条 assistant 文本以换行拼接后整体截断，避免分段截断留下多个省略号。
      current.aiText = truncatePreview([current.aiText, text].filter(Boolean).join("\n"), maxPreviewChars);
    }
    // extension 等其它角色不贡献摘要但计入轮内消息数。
    current.messageCount += 1;
  }

  if (current) turns.push(current);
  return turns;
}
