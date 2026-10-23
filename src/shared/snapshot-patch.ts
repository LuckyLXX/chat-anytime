/**
 * 快照增量补丁的纯函数实现（utility 生产、renderer/main 消费共用）。
 *
 * 设计约束：
 * - 消息对象在 renderer 端是「引用即内容」的不可变对象：normalize 层按 Pi 消息
 *   对象身份缓存，未变化的历史消息跨帧保持同一引用。因此差量只需比较引用。
 * - 执行记录在主进程会被原地修改（tool_execution_update 直接改 output），所以
 *   执行数组的「上一帧」必须存浅拷贝快照，不能存原对象引用。
 * - 任何拿不准的结构变化一律退化为全量替换，正确性优先。
 */

import type {
  ChatMessage,
  ChatMessagesPatch,
  RuntimeSnapshot,
  RuntimeStatePatch,
  SessionPaneSnapshot,
  SessionStatePatch,
  ToolExecution,
  ToolExecutionsPatch
} from "./protocol.js";

/** 应用消息补丁；索引非法（乱序/丢帧）时返回 undefined，由调用方丢弃该帧或等全量。 */
export function applyChatMessagesPatch(previous: readonly ChatMessage[], patch: ChatMessagesPatch): ChatMessage[] | undefined {
  if (patch.reset) return patch.reset;
  if (patch.append) return patch.append.length === 0 ? [...previous] : [...previous, ...patch.append];
  if (patch.truncateTo !== undefined) {
    if (patch.truncateTo < 0 || patch.truncateTo > previous.length) return undefined;
    return patch.truncateTo === previous.length ? [...previous] : previous.slice(0, patch.truncateTo);
  }
  if (patch.replaceFrom !== undefined) {
    if (patch.replaceFrom < 0 || patch.replaceFrom > previous.length) return undefined;
    return [...previous.slice(0, patch.replaceFrom), ...(patch.items ?? [])];
  }
  return [...previous];
}

/** 应用执行补丁：按 id 覆盖/追加，再过滤 removed id。 */
export function applyToolExecutionsPatch(previous: readonly ToolExecution[], patch: ToolExecutionsPatch): ToolExecution[] | undefined {
  if (patch.reset) return patch.reset;
  const next = [...previous];
  const indexById = new Map<string, number>();
  for (let index = 0; index < next.length; index += 1) indexById.set(next[index]!.id, index);
  for (const item of patch.upsert ?? []) {
    const index = indexById.get(item.id);
    if (index === undefined) {
      indexById.set(item.id, next.length);
      next.push(item);
    } else {
      next[index] = item;
    }
  }
  if (patch.remove && patch.remove.length > 0) {
    const removed = new Set(patch.remove);
    return next.filter((item) => !removed.has(item.id));
  }
  return next;
}

/** 把 `state.patch` 合并进当前激活快照。 */
export function applyRuntimeStatePatch(previous: RuntimeSnapshot, patch: RuntimeStatePatch): RuntimeSnapshot | undefined {
  const messages = patch.messages ? applyChatMessagesPatch(previous.messages, patch.messages) : previous.messages;
  if (!messages) return undefined;
  const executions = patch.executions ? applyToolExecutionsPatch(previous.executions, patch.executions) : previous.executions;
  if (!executions) return undefined;
  return { ...previous, ...patch.snapshot, messages, executions };
}

/** 把 `session.state.patch` 合并进分屏格子快照。 */
export function applySessionStatePatch(previous: SessionPaneSnapshot, patch: SessionStatePatch): SessionPaneSnapshot | undefined {
  const messages = patch.messages ? applyChatMessagesPatch(previous.messages, patch.messages) : previous.messages;
  if (!messages) return undefined;
  const executions = patch.executions ? applyToolExecutionsPatch(previous.executions, patch.executions) : previous.executions;
  if (!executions) return undefined;
  return { ...previous, ...patch.snapshot, messages, executions };
}

/**
 * 计算消息差量。返回 undefined 表示逐项引用完全一致。
 * 覆盖三种高频形态：尾部追加（新消息）、同长度尾替换（流式增长/落定）、
 * 尾部截断（再生成）。其余（压缩重排、编辑中间消息）走 reset。
 */
export function diffChatMessages(previous: readonly ChatMessage[], next: readonly ChatMessage[]): ChatMessagesPatch | undefined {
  if (previous === next) return undefined;
  const shared = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < shared && previous[prefix] === next[prefix]) prefix += 1;
  if (prefix === previous.length) {
    if (prefix === next.length) return undefined;
    return { append: next.slice(prefix) };
  }
  if (previous.length === next.length) {
    return { replaceFrom: prefix, items: next.slice(prefix) };
  }
  if (prefix === next.length && next.length < previous.length) {
    return { truncateTo: next.length };
  }
  return { reset: [...next] };
}

/** 执行记录「是否同一内容」的廉价判定：字符串按引用/值比较，数组逐路径比较。 */
export function toolExecutionPatchEqual(left: ToolExecution, right: ToolExecution): boolean {
  if (left === right) return true;
  if (left.id !== right.id || left.name !== right.name || left.status !== right.status
    || left.startedAt !== right.startedAt || left.completedAt !== right.completedAt
    || left.output !== right.output || left.patch !== right.patch
    || left.changedFile?.relativePath !== right.changedFile?.relativePath) return false;
  if (left.args !== right.args) return false;
  const leftFiles = left.changedFiles ?? [];
  const rightFiles = right.changedFiles ?? [];
  if (leftFiles.length !== rightFiles.length) return false;
  for (let index = 0; index < leftFiles.length; index += 1) {
    if (leftFiles[index]?.relativePath !== rightFiles[index]?.relativePath) return false;
  }
  if (left.delegation !== right.delegation) {
    if (!left.delegation || !right.delegation) return false;
    if (left.delegation.childSessionId !== right.delegation.childSessionId
      || left.delegation.steps.length !== right.delegation.steps.length) return false;
    const leftLast = left.delegation.steps.at(-1);
    const rightLast = right.delegation.steps.at(-1);
    if (leftLast?.status !== rightLast?.status || leftLast?.label !== rightLast?.label) return false;
  }
  return true;
}

/** 执行记录的不可变浅拷贝：output/args 是共享字符串/对象，changedFiles 逐项复制。 */
export function snapshotToolExecution(execution: ToolExecution): ToolExecution {
  return {
    ...execution,
    ...(execution.changedFile ? { changedFile: { ...execution.changedFile } } : {}),
    ...(execution.changedFiles ? { changedFiles: execution.changedFiles.map((file) => ({ ...file })) } : {})
  };
}

/**
 * 计算执行差量并返回下一帧用于比较的不可变快照数组。
 * 未变化的执行复用上一帧快照对象，避免每帧为数百条历史执行重新分配对象。
 */
export function diffToolExecutions(
  previous: readonly ToolExecution[] | undefined,
  next: readonly ToolExecution[]
): { patch: ToolExecutionsPatch | undefined; snapshots: ToolExecution[] } {
  if (!previous) return { patch: { reset: [...next] }, snapshots: next.map(snapshotToolExecution) };
  const previousById = new Map<string, ToolExecution>();
  for (const item of previous) previousById.set(item.id, item);
  const nextIds = new Set<string>();
  const upsert: ToolExecution[] = [];
  const snapshots: ToolExecution[] = [];
  let changedCount = 0;
  for (const item of next) {
    nextIds.add(item.id);
    const previousItem = previousById.get(item.id);
    if (previousItem && toolExecutionPatchEqual(previousItem, item)) {
      snapshots.push(previousItem);
      continue;
    }
    upsert.push(item);
    snapshots.push(snapshotToolExecution(item));
    changedCount += 1;
  }
  let removedCount = 0;
  const remove: string[] = [];
  for (const item of previous) {
    if (nextIds.has(item.id)) continue;
    remove.push(item.id);
    removedCount += 1;
  }
  if (changedCount === 0 && removedCount === 0) return { patch: undefined, snapshots };
  // 大面积变化（会话恢复/批量中止）直接全量，避免补丁本身比快照还大。
  if (changedCount + removedCount > Math.max(8, next.length * 0.5)) {
    return { patch: { reset: [...next] }, snapshots };
  }
  return {
    patch: {
      upsert: upsert.length > 0 ? upsert : undefined,
      remove: remove.length > 0 ? remove : undefined
    },
    snapshots
  };
}
