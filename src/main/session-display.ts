import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatMessage } from "../shared/protocol.js";
import { normalizeMessages } from "./message-normalize.js";
import { PI_DESKTOP_CONTROL_ENTRY_TYPE, restoreControlMessages } from "./session-history.js";

type DisplaySource = Pick<SessionManager, "getBranch" | "getEntryCount" | "getLeafId">;
type ContextEdit = Extract<SessionEntry, { type: "context_edit" }>;
type MessageEntry = Extract<SessionEntry, { type: "message" | "custom_message" }>;

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function mergeControls(messages: ChatMessage[], controls: ChatMessage[]): ChatMessage[] {
  return controls.length === 0
    ? messages
    : [...messages, ...controls].sort((left, right) => left.timestamp - right.timestamp);
}

function displayEntryMessages(entry: MessageEntry, edit?: ContextEdit): AgentMessage[] {
  // 早期条目可能绕过了 SDK 的压缩后投影校验。缺少消息体不应让整段历史打不开。
  if (entry.type === "message" && typeof entry.message?.role !== "string") return [];
  const replacement = edit?.replacement;
  if (replacement === null) return [];
  const messages = sessionEntryToContextMessages(entry);
  if (!replacement) return messages;
  const { content } = replacement;
  return messages.map((message) => {
    // 与 Pi 的上下文编辑保持一致，尤其是 assistant / toolResult 的块数组契约。
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult" && message.role !== "custom") return message;
    return {
      ...message,
      content: (message.role === "assistant" || message.role === "toolResult") && typeof content === "string"
        ? [{ type: "text", text: content }]
        : content
    } as AgentMessage;
  });
}

/** 按当前分支读取可回看的历史。压缩只改变 Pi 的模型上下文，历史仍来自原始条目。 */
export function createSessionDisplay(source: DisplaySource) {
  const entryMessages = new WeakMap<MessageEntry, { edit?: ContextEdit; messages: AgentMessage[] }>();
  const entryControls = new WeakMap<SessionEntry, ChatMessage[]>();
  let leafId: string | null = null;
  let entryCount = -1;
  let raw: AgentMessage[] = [];
  let controls: ChatMessage[] = [];
  let normalized = normalizeMessages(raw);
  let committed = normalized;

  function refresh(): void {
    const nextLeaf = source.getLeafId();
    const nextCount = source.getEntryCount();
    if (nextLeaf === leafId && nextCount === entryCount) return;
    const branch = source.getBranch();
    const edits = new Map<string, ContextEdit>();
    for (const entry of branch) {
      if (entry.type === "context_edit") edits.set(entry.targetId, entry);
    }
    const nextRaw: AgentMessage[] = [];
    const nextControls: ChatMessage[] = [];
    for (const entry of branch) {
      if (entry.type === "message" || entry.type === "custom_message") {
        const edit = edits.get(entry.id);
        let cached = entryMessages.get(entry);
        if (!cached || cached.edit !== edit) {
          cached = { edit, messages: displayEntryMessages(entry, edit) };
          entryMessages.set(entry, cached);
        }
        nextRaw.push(...cached.messages);
      } else if (entry.type === "custom" && entry.customType === PI_DESKTOP_CONTROL_ENTRY_TYPE) {
        let cached = entryControls.get(entry);
        if (!cached) {
          cached = restoreControlMessages([entry]);
          entryControls.set(entry, cached);
        }
        nextControls.push(...cached);
      }
    }
    // compaction / usage 等纯元数据条目推进了 leaf。复用不变的消息与快照基线。
    const rawChanged = !sameItems(raw, nextRaw);
    const controlsChanged = !sameItems(controls, nextControls);
    if (rawChanged) {
      raw = nextRaw;
      normalized = normalizeMessages(raw);
    }
    if (controlsChanged) controls = nextControls;
    if (rawChanged || controlsChanged) committed = mergeControls(normalized, controls);
    leafId = nextLeaf;
    entryCount = nextCount;
  }

  return {
    committedMessages(): readonly AgentMessage[] {
      refresh();
      return raw;
    },
    timeline(streaming?: AgentMessage): ChatMessage[] {
      refresh();
      if (!streaming) return committed;
      const next = normalizeMessages(raw, streaming);
      if (controls.length === 0) return next;
      if (next === normalized) return committed;
      const tail = next.at(-1);
      if (tail && next.length === normalized.length + 1 && tail.timestamp >= committed.at(-1)!.timestamp) {
        return [...committed, tail];
      }
      return mergeControls(next, controls);
    }
  };
}
