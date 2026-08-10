import type { ChatMessage, ToolExecution } from "../../../shared/protocol";

export interface ReplyChangedFile {
  relativePath: string;
  execution: ToolExecution;
}

export function changedFilesForMessage(message: ChatMessage, executions: ToolExecution[]): ReplyChangedFile[] {
  if (message.role !== "assistant") return [];
  const callIds = new Set(message.blocks.filter((block) => block.type === "tool-call").map((block) => block.id));
  const files = new Map<string, ReplyChangedFile>();
  for (const execution of executions) {
    if (!callIds.has(execution.id) || execution.status === "error" || !execution.changedFile) continue;
    files.set(execution.changedFile.relativePath.toLowerCase(), {
      relativePath: execution.changedFile.relativePath,
      execution
    });
  }
  return [...files.values()];
}
