export type ManualCompactionOutcome =
  | { type: "completed"; status: "就绪"; message: "已压缩上下文。" }
  | { type: "cancelled"; status: "已停止"; message: "已停止压缩上下文。" }
  | { type: "failed"; status: "压缩失败"; message: string; error: unknown };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Compaction cancelled");
}

export async function runManualCompaction(operation: () => Promise<unknown>): Promise<ManualCompactionOutcome> {
  try {
    await operation();
    return { type: "completed", status: "就绪", message: "已压缩上下文。" };
  } catch (error) {
    if (isCancelled(error)) return { type: "cancelled", status: "已停止", message: "已停止压缩上下文。" };
    return { type: "failed", status: "压缩失败", message: `压缩上下文失败：${errorText(error)}`, error };
  }
}
