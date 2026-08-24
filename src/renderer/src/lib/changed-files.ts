import type { ChatMessage, ToolExecution } from "../../../shared/protocol";

export type ReplyArtifactKind = "image" | "file";

export interface ReplyChangedFile {
  relativePath: string;
  kind: ReplyArtifactKind;
  execution: ToolExecution;
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
      files.set(relativePath.toLowerCase(), { relativePath, kind: artifactKindForPath(relativePath), execution });
    }
  }
  return [...files.values()];
}