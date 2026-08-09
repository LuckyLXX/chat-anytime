import type { ToolExecution } from "../shared/protocol.js";

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
export function restoreToolExecutions(messages: readonly PersistedSessionMessage[]): ToolExecution[] {
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
          startedAt: message.timestamp
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
