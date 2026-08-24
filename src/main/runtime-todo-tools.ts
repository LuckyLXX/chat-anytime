// Todo capability cluster extracted from pi-runtime.ts. dsh（deepseek-harness）
// 式单一所有者语义：唯一的 todo_write 工具整表替换清单，清单状态只通过
// 工具调用参数出现在对话尾部（纯追加，不破坏前缀 KV cache），结果只回
// 计数不回显整表；没有每轮系统提示注入，也没有部分更新或回读工具。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Todo, TodoStatus } from "../shared/protocol.js";
import type { TodoStore } from "./todo-store.js";
import { Type } from "typebox";

export interface TodoToolContext {
  store: TodoStore;
  /** Per-session tool-call pacer backing the anti-batching reminder. */
  pace: TodoPaceTracker;
}

/**
 * 距上次清单更新多少个工具调用后，todo_write 的返回文本开始附攒批提醒。
 * 审计实测模型平均隔 8~16 个调用才更新一次；理想节奏是每 1~2 步一更，
 * 取 4 作为提醒门槛——低于此不打扰，超过即温和戳一下。
 */
export const PACE_REMINDER_THRESHOLD = 4;

/**
 * Per-session counter of tool executions since the last todo_write. The audit
 * extension's tool_execution_start hook calls {@link TodoPaceTracker.record};
 * todo_write itself calls {@link TodoPaceTracker.consume} to read and reset.
 * A write's own start event lands before execute runs, so it is counted and
 * then wiped by the same call — no special-casing needed.
 */
export interface TodoPaceTracker {
  record(): void;
  /** Read the count of tool calls since the last write and reset it to zero. */
  consume(): number;
}

export function createTodoPaceTracker(): TodoPaceTracker {
  let count = 0;
  return {
    record: () => { count += 1; },
    consume: () => {
      const value = count;
      count = 0;
      return value;
    }
  };
}

/**
 * Result text for one todo_write. Beyond the compact counts, a large gap since
 * the previous write appends a batching nudge — appended at the conversation
 * tail only, so the prefix KV cache stays intact.
 */
export function todoWriteResultText(counts: { pending: number; inProgress: number; completed: number }, toolsSinceLastWrite: number): string {
  const base = `已更新任务清单：${counts.pending} 项待办、${counts.inProgress} 项进行中、${counts.completed} 项已完成。`;
  if (toolsSinceLastWrite < PACE_REMINDER_THRESHOLD) return base;
  return `${base}\n提示：距上次清单更新已执行 ${toolsSinceLastWrite} 个工具调用——一项完成立即标记 completed，不要攒批。`;
}

/**
 * Validate the constraints the parameter schema can't express and build the
 * canonical list: trimmed non-empty unique content, at most one item
 * `in_progress`（串行推进纪律，对齐 dsh allowParallelInProgress: false）.
 */
function toTodoList(raw: readonly { content?: unknown; status?: unknown }[]): Todo[] {
  const todos: Todo[] = [];
  const seen = new Set<string>();
  let active = 0;
  for (const item of raw) {
    const content = String(item?.content ?? "").trim();
    if (!content) throw new Error("invalid todo：content 必须是非空字符串");
    if (seen.has(content)) throw new Error(`invalid todos：content 重复「${content}」`);
    seen.add(content);
    const status = item?.status as TodoStatus;
    if (status === "in_progress") active++;
    todos.push({ content, status });
  }
  if (active > 1) throw new Error(`invalid todos：最多只能有一项 in_progress（当前 ${active} 项）`);
  return todos;
}

/** Build the Todo customTool（todo_write，整表替换 + 攒批软提醒）. */
export function buildTodoTools({ store, pace }: TodoToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "todo_write",
      label: "更新任务清单",
      description: [
        "记录并更新当前工作的结构化任务清单。每次调用发送完整清单，整体替换上一次（没有部分更新、没有单项编辑）。",
        "多步骤任务请在动手前用它拆出每个具体步骤；串行推进时保持恰好一项 in_progress；一项完成立即标记 completed，不要攒批；全部完成后才允许没有 in_progress 项。琐碎的单步任务不用建清单。",
        "status 三态：pending（未开始）/ in_progress（正在进行）/ completed（已完成）。"
      ].join(""),
      promptSnippet: "todo_write: 整表更新任务清单",
      parameters: Type.Object({
        todos: Type.Array(
          Type.Object({
            content: Type.String({ description: "任务内容——一句简短的祈使句" }),
            status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], { description: "pending（未开始）| in_progress（进行中）| completed（已完成）" })
          }),
          { description: "完整任务清单，整体替换之前的清单" }
        )
      }),
      execute: async (_id, params) => {
        const todos = toTodoList((params?.todos ?? []) as { content?: unknown; status?: unknown }[]);
        store.replaceAll(todos);
        const count = (status: TodoStatus): number => todos.filter((todo) => todo.status === status).length;
        const counts = { pending: count("pending"), inProgress: count("in_progress"), completed: count("completed") };
        return {
          content: [{ type: "text" as const, text: todoWriteResultText(counts, pace.consume()) }],
          details: { count: todos.length, ...counts }
        };
      }
    })
  ];
}
