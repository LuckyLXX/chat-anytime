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
 * 每条消息的预览缓存（按对象身份 + 截断长度）。
 *
 * 为什么必须有：`buildTurnSummaries` 的调用方每帧都会拿到新的消息数组，但历史消息
 * 对象是稳定的（store 的 uuid 复用 + 分组器身份保留）；流式期间只有尾部一条换对象。
 * 没有缓存时每一帧都要对**整条会话**的文本重新跑 `truncatePreview` 的正则归一化
 * （实测 400 条 / 233KB markdown = 2.55ms/帧，20fps ≈ 5% 单核，弱机翻倍），而其中
 * 99% 的文本根本没变。缓存随消息对象一起被 GC，不需要手工清理。
 */
const previewCache = new WeakMap<ChatMessage, Map<number, string>>();

function previewOf(message: ChatMessage, maxChars: number): string {
  const cached = previewCache.get(message)?.get(maxChars);
  if (cached !== undefined) return cached;
  const preview = truncatePreview(collectText(message.blocks), maxChars);
  const byLength = previewCache.get(message);
  if (byLength) byLength.set(maxChars, preview);
  else previewCache.set(message, new Map([[maxChars, preview]]));
  return preview;
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
        userText: previewOf(message, maxPreviewChars),
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
      // 已截断的摘要不会再变：后续拼接只会被同一次截断丢弃。跳过它省掉尾部长回复
      // 每帧的全文正则（历史轮次全部命中这条早退）。
      if (current.aiText.length <= maxPreviewChars) {
        const preview = previewOf(message, maxPreviewChars);
        // 多条 assistant 文本以换行拼接后整体截断，避免分段截断留下多个省略号。
        if (preview) {
          current.aiText = truncatePreview([current.aiText, preview].filter(Boolean).join("\n"), maxPreviewChars);
        }
      }
    }
    // extension 等其它角色不贡献摘要但计入轮内消息数。
    current.messageCount += 1;
  }

  if (current) turns.push(current);
  return turns;
}
