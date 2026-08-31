/**
 * 会话消息 → 渲染端 ChatMessage 的归一化(Pi AgentMessage → 协议消息)。
 *
 * 从 pi-runtime.ts 拆出的纯构建器:快照(state)与分屏推送(session.state)共用,
 * 每 50/100ms flush 都要跑一遍,是热路径——因此带按消息对象身份的 WeakMap 缓存:
 * committed 消息对象在两次提交之间引用稳定(Pi 只对流式中的消息逐事件 spread
 * 新对象),命中条件 = 对象身份 + visible 序列中的 index 相同,命中即复用归一化
 * 结果,把每次 flush 的 O(历史) 正则/重建/克隆降为 O(1)(仅流式消息重算)。
 * index 参与校验是因为 uuid 含 index,regenerate 截断或压缩重排会让幸存消息
 * 的 index 位移,此时必须重算。流式消息不缓存:它的对象每帧都换,缓存永不命中,
 * 排除写入反而明确「缓存条目永远是已定稿消息」。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { messageUuid } from "./message-identity.js";
import { parseCommandPrompt, type CommandPromptDisplay } from "./command-catalog.js";
import { parseSkillPrompt, type SkillPromptDisplay } from "./skill-prompt.js";
import { stripVisionHint } from "./runtime-vision.js";
import type { ChatMessage, MessageBlock } from "../shared/protocol.js";

interface RuntimeCustomMessage {
  role: "custom";
  customType: string;
  content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

function cloneProtocolValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

export function userMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  const text = typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  // The vision hint is model-directed transport, not user content: display and
  // regenerate matching see the original text without it.
  return stripVisionHint(text);
}

function blocksFromMessage(message: AgentMessage, skillPrompt?: SkillPromptDisplay, commandPrompt?: CommandPromptDisplay): MessageBlock[] {
  if (message.role === "user") {
    const user = message as UserMessage;
    if (skillPrompt) {
      const blocks: MessageBlock[] = skillPrompt.instructions ? [{ type: "text", text: skillPrompt.instructions }] : [];
      if (typeof user.content !== "string") {
        blocks.push(...user.content.filter((content) => content.type === "image").map((content) => ({ type: "image" as const, data: content.data, mimeType: content.mimeType })));
      }
      return blocks;
    }
    if (commandPrompt) {
      // 命令消息与 skill 同构：气泡只回显参数正文，模板本体留在文件里。
      const blocks: MessageBlock[] = commandPrompt.args ? [{ type: "text", text: commandPrompt.args }] : [];
      if (typeof user.content !== "string") {
        blocks.push(...user.content.filter((content) => content.type === "image").map((content) => ({ type: "image" as const, data: content.data, mimeType: content.mimeType })));
      }
      return blocks;
    }
    if (typeof user.content === "string") return [{ type: "text", text: stripVisionHint(user.content) }];
    // Attached images stay in the transcript (rendered here) even for text-only
    // conversation models; the vision hint suffix is stripped from display.
    const blocks = user.content.map((content) =>
      content.type === "text"
        ? { type: "text" as const, text: stripVisionHint(content.text) }
        : { type: "image" as const, data: content.data, mimeType: content.mimeType }
    );
    return blocks.filter((block) => block.type !== "text" || block.text.length > 0);
  }

  if (message.role === "custom") {
    const custom = message as unknown as RuntimeCustomMessage;
    if (typeof custom.content === "string") return [{ type: "text", text: custom.content }];
    return custom.content.map((content) => content.type === "text"
      ? { type: "text" as const, text: content.text }
      : { type: "image" as const, data: content.data, mimeType: content.mimeType });
  }

  if (message.role !== "assistant") return [];
  return (message as AssistantMessage).content.map((content) => {
    if (content.type === "text") return { type: "text" as const, text: content.text };
    if (content.type === "thinking") return { type: "thinking" as const, text: content.thinking };
    return {
      type: "tool-call" as const,
      id: content.id,
      name: content.name,
      arguments: content.arguments
    };
  });
}

let normalizedCache = new WeakMap<AgentMessage, { index: number; message: ChatMessage }>();

// Maps each Pi AgentMessage object to a stable uuid so a message keeps its
// identity across the partial (streamingMessage) and final (committed into
// session.state.messages) frames. Pi 每个流式事件都 spread 出新对象、提交时
// 又是另一对象，但 timestamp/role/index 三者全帧一致，故用确定性 uuid
// （message-identity.ts）；含自增序号的旧实现会让每帧 uuid 不同，渲染端
// key 逐帧变化、气泡每帧重挂载闪烁。
export function normalizeMessages(messages: AgentMessage[], streamingMessage?: AgentMessage): ChatMessage[] {
  const visible = messages.filter((message) => message.role === "user" || message.role === "assistant" || (message.role === "custom" && (message as unknown as RuntimeCustomMessage).display));
  if (streamingMessage && streamingMessage.role === "assistant") {
    const last = visible.at(-1);
    if (last !== streamingMessage) visible.push(streamingMessage);
  }
  return visible.map((message, index) => {
    const cached = normalizedCache.get(message);
    if (cached && cached.index === index) return cached.message;
    const skillPrompt = message.role === "user" ? parseSkillPrompt(userMessageText(message)) : undefined;
    const commandPrompt = message.role === "user" && !skillPrompt ? parseCommandPrompt(userMessageText(message)) : undefined;
    const normalized: ChatMessage = {
      id: `${message.timestamp ?? 0}-${index}-${message.role}`,
      uuid: messageUuid(message, index),
      role: message.role === "custom" ? "extension" : message.role as "user" | "assistant",
      timestamp: message.timestamp ?? Date.now(),
      blocks: blocksFromMessage(message, skillPrompt, commandPrompt),
      extension: message.role === "custom" ? { customType: (message as unknown as RuntimeCustomMessage).customType, details: cloneProtocolValue((message as unknown as RuntimeCustomMessage).details) } : undefined,
      skill: skillPrompt ? { name: skillPrompt.name } : undefined,
      command: commandPrompt ? { name: commandPrompt.name } : undefined,
      streaming: message === streamingMessage,
      error: message.role === "assistant" ? (message as AssistantMessage).errorMessage : undefined
    };
    if (message !== streamingMessage) normalizedCache.set(message, { index, message: normalized });
    return normalized;
  });
}

/** 测试用：清空归一化缓存（模块级 WeakMap 单例，换新实例）。 */
export function resetNormalizeCacheForTest(): void {
  normalizedCache = new WeakMap();
}
