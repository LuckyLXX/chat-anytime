import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatMessage, DelegationProgress, ToolExecution } from "../shared/protocol.js";
import { isDelegationProgress } from "../shared/protocol.js";
import { normalizeMessages } from "./message-normalize.js";
import { changedWorkspaceFile, changedWorkspaceFiles } from "./workspace-preview.js";

export const PI_DESKTOP_CONTROL_ENTRY_TYPE = "pidesktop-control";

export interface PersistedSessionEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  timestamp?: string;
  /** Pi 消息型 entry 的 envelope 负载（appendMessage 写入的 {type:"message", message}）。 */
  message?: unknown;
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
 * 从持久化的 toolResult details 提取 delegate_agent 进度快照：最终 toolResult 的
 * details 是顶层扁平展开的 DelegationProgress（runDelegation 返回值原样落盘）；
 * 另兼容嵌套 `{ delegation }` 形态（历史/防御），形状不符返回 undefined——被中断
 * 的执行（running→error 兜底分支）无 details，落回通用渲染。
 */
function delegationFromDetails(message: PersistedToolResultMessage): DelegationProgress | undefined {
  if (!message.details || typeof message.details !== "object") return undefined;
  if (isDelegationProgress(message.details)) return message.details;
  const delegation = (message.details as { delegation?: unknown }).delegation;
  return isDelegationProgress(delegation) ? delegation : undefined;
}

/**
 * 子代理完整记录查看：把 delegations/*.jsonl 的 message entries 归一化为
 * ChatMessage[]（与主会话同构，经 normalizeMessages 走同一渲染管线）。
 */
export function transcriptMessagesFromEntries(entries: readonly PersistedSessionEntry[]): ChatMessage[] {
  const messages = entries
    .map((entry) => (entry as { message?: unknown }).message)
    .filter((message): message is PersistedSessionMessage => Boolean(
      message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string"
    ));
  if (messages.length === 0) return [];
  return normalizeMessages(messages as unknown as AgentMessage[]);
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
          changedFile: changedWorkspaceFile(workspace, block.name, block.arguments),
          changedFiles: changedWorkspaceFiles(workspace, block.name, block.arguments)
        });
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const previous = executions.get(message.toolCallId);
    const output = resultText(message);
    const delegation = delegationFromDetails(message);
    executions.set(message.toolCallId, {
      id: message.toolCallId,
      name: previous?.name ?? message.toolName,
      args: previous?.args ?? {},
      status: message.isError ? "error" : "completed",
      startedAt: previous?.startedAt ?? message.timestamp,
      completedAt: message.timestamp,
      changedFile: previous?.changedFile ?? changedWorkspaceFile(workspace, message.toolName, previous?.args),
      changedFiles: previous?.changedFiles ?? changedWorkspaceFiles(workspace, message.toolName, previous?.args),
      ...(output ? { output } : {}),
      ...(resultPatch(message) ? { patch: resultPatch(message) } : {}),
      ...(delegation ? { delegation } : {})
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
