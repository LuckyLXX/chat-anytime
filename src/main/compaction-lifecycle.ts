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

/**
 * 自动压缩（阈值触发/溢出恢复）失败的提示文案。手动 /compact 的失败由
 * runManualCompaction 的控制消息兜底，返回 undefined 不重复提示；中止路径
 * Pi 不带 errorMessage，同样返回 undefined。
 */
export function autoCompactionFailureNotice(event: { reason: "manual" | "threshold" | "overflow"; errorMessage?: string }): string | undefined {
  if (event.reason === "manual" || !event.errorMessage) return undefined;
  return `自动压缩上下文失败：${event.errorMessage}`;
}
