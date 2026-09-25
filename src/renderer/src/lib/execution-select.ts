import type { ToolExecution } from "../../../shared/protocol";

/**
 * App 的 executions 派生选择器（2026-09-25 性能 P0）。
 *
 * 为什么需要它们：App 原来直接订阅 `state.snapshot.executions`（整数组）。store
 * 的身份保留只保证「内容未变时数组引用不变」，而工具正在跑时 output 逐帧增长 →
 * 每帧都是新数组 → App 整棵子树（侧栏分组/会话行、顶栏、预览壳）以 ~20 fps
 * 全量重建。App 的注释写明了设计意图（细粒度订阅 + 靠身份保留让流式帧不触发
 * 选择器），只有这一条漏了。
 *
 * 这两个选择器**只返回原始值**（string | undefined），zustand 用 `Object.is`
 * 比较即可命中早退：工具 output 增长时返回值不变 → App 不重渲染。因此实现上
 * 必须单次循环、**零分配**（不得返回新对象/数组，否则等于没改）。
 * E 是数百量级，每帧 O(E) 的成本可忽略。
 */

/** 工具栏「查看最新变更」的可用态：最后一条带 patch 的执行。 */
export function lastReviewExecutionId(executions: readonly ToolExecution[]): string | undefined {
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const execution = executions[index];
    if (execution?.patch) return execution.id;
  }
  return undefined;
}

/**
 * 「AI 改动了正在编辑的文件」同步 effect 的触发键：最后一条已完成且带
 * `changedFile` 的执行。effect 本身按 tab 逐条比对具体路径，这里只需要一个
 * 「有新变更了」的变化信号。
 */
export function lastCompletedChangedExecutionId(executions: readonly ToolExecution[]): string | undefined {
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const execution = executions[index];
    if (execution?.status === "completed" && execution.changedFile) return execution.id;
  }
  return undefined;
}
