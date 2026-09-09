import type { ChatMessage, MessageBlock } from "../../../shared/protocol";

export interface AssistantToolLayout {
  leading: MessageBlock[];
  process: Array<Extract<MessageBlock, { type: "tool-call" }>>;
  trailing: MessageBlock[];
}

/**
 * 把消息流切成「源分组」：连续 assistant 归为一组（最终合并成单条可视化回复），
 * 其余角色各自成组。分组的角色由首条消息决定——只有 assistant 会向后合并。
 */
function toSourceGroups(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (message.role === "assistant" && previous && previous[0]!.role === "assistant") previous.push(message);
    else groups.push([message]);
  }
  return groups;
}

/**
 * 把一组源消息合并成单条回复对象。Pi 在一次任务里可能产出多条 assistant 消息
 * （穿插工具调用），这里折叠成一条：blocks 顺序拼接，streaming 取或，error /
 * aborted 取「后者优先」（末段被中止时整条回复都要出中性提示）。单条源消息时
 * 等价于浅拷贝 + blocks 复制。
 */
function mergeSourceGroup(sources: ChatMessage[]): ChatMessage {
  const first = sources[0]!;
  const grouped: ChatMessage = { ...first, blocks: [...first.blocks] };
  for (const message of sources.slice(1)) {
    grouped.blocks = [...grouped.blocks, ...message.blocks];
    grouped.streaming = Boolean(grouped.streaming || message.streaming);
    grouped.error = message.error ?? grouped.error;
    grouped.aborted = message.aborted ?? grouped.aborted;
  }
  return grouped;
}

/**
 * Pi may emit several assistant messages while it is working through tools.
 * Keep those segments as one visual reply until the next user message.
 */
export function groupAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return toSourceGroups(messages).map((sources) => mergeSourceGroup(sources));
}

/** 带身份保留的分组器：见 createAssistantMessageGrouper。 */
export interface AssistantMessageGrouper {
  (messages: ChatMessage[]): ChatMessage[];
}

/**
 * 创建「身份保留」的分组器。无状态 groupAssistantMessages 每帧都为每条消息生成
 * 全新对象，配合 displayMessages 的 useMemo（依赖每帧都变的 data.messages），会让
 * 所有历史气泡的 message prop 每帧换引用，击穿 MessageView 的 memo。
 *
 * 这里缓存上一帧每个分组的「源消息引用 + 输出对象」：当某组的源消息引用与上一帧
 * 逐项相同时复用旧输出对象。store 的 mergeMessagesPreservingIdentity 已保证未变
 * 消息引用稳定、仅 streaming 消息取新引用，因此流式期间只有末组（含 streaming
 * 消息）重建，历史组输出对象跨帧保持同一引用，memo 化的历史气泡得以跳过重渲染。
 *
 * 实例须用 useRef 持有以跨渲染保留缓存；缓存随每次调用就地更新，与返回数组一致。
 */
export function createAssistantMessageGrouper(): AssistantMessageGrouper {
  let cache: Array<{ sources: ChatMessage[]; grouped: ChatMessage }> = [];
  return (messages) => {
    const sourceGroups = toSourceGroups(messages);
    const nextCache: Array<{ sources: ChatMessage[]; grouped: ChatMessage }> = [];
    const result: ChatMessage[] = [];
    for (let index = 0; index < sourceGroups.length; index++) {
      const sources = sourceGroups[index]!;
      const cached = cache[index];
      if (cached && cached.sources.length === sources.length && cached.sources.every((message, position) => message === sources[position])) {
        nextCache.push(cached);
        result.push(cached.grouped);
        continue;
      }
      const grouped = mergeSourceGroup(sources);
      nextCache.push({ sources, grouped });
      result.push(grouped);
    }
    cache = nextCache;
    return result;
  };
}

/** Keep prose around the folded tool process, matching ChatAnyTime's layout. */
export function splitAssistantToolLayout(message: ChatMessage): AssistantToolLayout | undefined {
  if (message.role !== "assistant") return undefined;
  const firstToolIndex = message.blocks.findIndex((block) => block.type === "tool-call");
  if (firstToolIndex < 0) return undefined;
  const lastToolIndex = message.blocks.reduce((index, block, currentIndex) => block.type === "tool-call" ? currentIndex : index, -1);
  if (lastToolIndex < firstToolIndex) return undefined;
  const process = message.blocks.slice(firstToolIndex, lastToolIndex + 1).filter((block): block is Extract<MessageBlock, { type: "tool-call" }> => block.type === "tool-call");
  if (!process.length) return undefined;
  const trailing = [
    ...message.blocks.slice(firstToolIndex, lastToolIndex + 1).filter((block) => block.type !== "tool-call" && block.type !== "thinking"),
    ...message.blocks.slice(lastToolIndex + 1).filter((block) => block.type !== "thinking")
  ];
  return {
    leading: message.blocks.slice(0, firstToolIndex).filter((block) => block.type !== "thinking"),
    process,
    trailing
  };
}
