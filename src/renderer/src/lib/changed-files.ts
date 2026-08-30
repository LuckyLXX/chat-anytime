import type { ChatMessage, ToolExecution } from "../../../shared/protocol";

export type ReplyArtifactKind = "image" | "file";

export interface ReplyChangedFile {
  relativePath: string;
  kind: ReplyArtifactKind;
  execution: ToolExecution;
  /** 该文件在本回复内被改动的全部工具调用 id（含去重前的每次写入），单文件回滚的寻址依据。 */
  toolCallIds: string[];
}

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".ico", ".svg"]);

/** 按扩展名判定产物展示类型：图片走图片图标 + 右侧图像预览，其余为普通文件。 */
export function artifactKindForPath(relativePath: string): ReplyArtifactKind {
  const dot = relativePath.lastIndexOf(".");
  return dot < 0 ? "file" : imageExtensions.has(relativePath.slice(dot).toLowerCase()) ? "image" : "file";
}

/**
 * 聚合一条助手消息的工具调用产生的全部交付产物：优先读 execution.changedFiles
 * （产物数组，含 bash/MCP 等产出型工具的生成文件），向后兼容单文件 changedFile。
 * 同一文件被多次写入时合并到一行，toolCallIds 收集每次调用的 id（回滚时主进程
 * 取最早快照 = 回复动手前的状态）。
 */
export function changedFilesForMessage(message: ChatMessage, executions: ToolExecution[]): ReplyChangedFile[] {
  if (message.role !== "assistant") return [];
  const callIds = new Set(message.blocks.filter((block) => block.type === "tool-call").map((block) => block.id));
  const files = new Map<string, ReplyChangedFile>();
  for (const execution of executions) {
    if (!callIds.has(execution.id) || execution.status === "error") continue;
    const paths = execution.changedFiles?.map((item) => item.relativePath)
      ?? (execution.changedFile ? [execution.changedFile.relativePath] : []);
    for (const relativePath of paths) {
      const key = relativePath.toLowerCase();
      const existing = files.get(key);
      if (existing) {
        existing.toolCallIds.push(execution.id);
        // last-wins：execution/relativePath 取最后一次调用的（diff 按钮展示最新变更）。
        existing.execution = execution;
        existing.relativePath = relativePath;
        continue;
      }
      files.set(key, { relativePath, kind: artifactKindForPath(relativePath), execution, toolCallIds: [execution.id] });
    }
  }
  return [...files.values()];
}