import type { ChatMessage, MessageBlock } from "../../../shared/protocol";

export interface AssistantToolLayout {
  leading: MessageBlock[];
  process: Array<Extract<MessageBlock, { type: "tool-call" }>>;
  trailing: MessageBlock[];
}

/**
 * Pi may emit several assistant messages while it is working through tools.
 * Keep those segments as one visual reply until the next user message.
 */
export function groupAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  const grouped: ChatMessage[] = [];
  for (const message of messages) {
    const previous = grouped.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      previous.blocks = [...previous.blocks, ...message.blocks];
      previous.streaming = Boolean(previous.streaming || message.streaming);
      previous.error = message.error ?? previous.error;
      continue;
    }
    grouped.push({ ...message, blocks: [...message.blocks] });
  }
  return grouped;
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
