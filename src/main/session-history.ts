import type { ChatMessage, ToolExecution } from "../shared/protocol.js";
import { changedWorkspaceFile } from "./workspace-preview.js";

export const PI_DESKTOP_CONTROL_ENTRY_TYPE = "pidesktop-control";

export interface PersistedSessionEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  timestamp?: string;
}

type CompactControlEntryData = {
  kind: "compact-command" | "compact-result";
  text: string;
};

export interface PersistedToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export interface PersistedAssistantMessage {
  role: "assistant";
  timestamp: number;
  content: ReadonlyArray<PersistedToolCallBlock | { type: "text" | "thinking" | "image" }>;
}

export interface PersistedToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ReadonlyArray<{ type: "text" | "image"; text?: string }>;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type PersistedSessionMessage = PersistedAssistantMessage | PersistedToolResultMessage | { role: "user" | "bashExecution" | "custom" | "compactionSummary" | "branchSummary" };

function isCompactControlEntryData(value: unknown): value is CompactControlEntryData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CompactControlEntryData>;
  return (data.kind === "compact-command" || data.kind === "compact-result") && typeof data.text === "string";
}

function controlMessageFromEntry(entry: PersistedSessionEntry, data: CompactControlEntryData): ChatMessage {
  const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  const messageTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
  const id = `pidesktop-control-${entry.id}`;
  return {
    id,
    uuid: id,
    role: data.kind === "compact-command" ? "user" : "assistant",
    timestamp: messageTimestamp,
    blocks: [{ type: "text", text: data.text }],
    control: "compact"
  };
}

export function restoreControlMessages(entries: readonly PersistedSessionEntry[]): ChatMessage[] {
  return entries.flatMap((entry) => {
    const isDesktopControl = entry.type === "custom" && entry.customType === PI_DESKTOP_CONTROL_ENTRY_TYPE;
    if (!isDesktopControl || !isCompactControlEntryData(entry.data)) return [];
    return [controlMessageFromEntry(entry, entry.data)];
  });
}

function resultText(message: PersistedToolResultMessage): string | undefined {
  const text = message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

function resultPatch(message: PersistedToolResultMessage): string | undefined {
  if (!message.details || typeof message.details !== "object") return undefined;
  const patch = (message.details as { patch?: unknown }).patch;
  return typeof patch === "string" ? patch : undefined;
}

/**
 * Rebuild the right activity panel from Pi's persisted assistant/tool messages.
 * An unfinished call is marked as interrupted so a restarted app never shows
 * a stale spinner as if the tool were still running.
 */
export function restoreToolExecutions(messages: readonly PersistedSessionMessage[], workspace?: string): ToolExecution[] {
  const executions = new Map<string, ToolExecution>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        executions.set(block.id, {
          id: block.id,
          name: block.name,
          args: block.arguments,
          status: "running",
          startedAt: message.timestamp,
          changedFile: changedWorkspaceFile(workspace, block.name, block.arguments)
        });
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const previous = executions.get(message.toolCallId);
    const output = resultText(message);
    executions.set(message.toolCallId, {
      id: message.toolCallId,
      name: previous?.name ?? message.toolName,
      args: previous?.args ?? {},
      status: message.isError ? "error" : "completed",
      startedAt: previous?.startedAt ?? message.timestamp,
      completedAt: message.timestamp,
      changedFile: previous?.changedFile ?? changedWorkspaceFile(workspace, message.toolName, previous?.args),
      ...(output ? { output } : {}),
      ...(resultPatch(message) ? { patch: resultPatch(message) } : {})
    });
  }

  return [...executions.values()].map((execution) => execution.status === "running"
    ? {
      ...execution,
      status: "error",
      completedAt: execution.startedAt,
      output: "工具执行在应用关闭或会话切换前未返回结果。"
    }
    : execution);
}
