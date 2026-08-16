// Todo capability cluster extracted from pi-runtime.ts: the four customTools
// plus the system-prompt blocks that steer the model toward using them. The
// store lifecycle (createTodoStore / session-scoped file) stays in pi-runtime;
// these builders are pure over their inputs.

import { defineTool, type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Todo } from "../shared/protocol.js";
import type { TodoStore } from "./todo-store.js";
import { Type } from "typebox";

export function summarizeTodos(items: readonly Todo[]): string {
  if (items.length === 0) return "（暂无 Todo）";
  return items.map((todo) => {
    const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : " ";
    return `- [${mark}] ${todo.title}${todo.notes ? `（${todo.notes}）` : ""}（id: ${todo.id}）`;
  }).join("\n");
}

/** 引导模型主动使用 Todo 工具维护任务清单的系统提示词块。 */
export function buildTodoSystemPromptBlock(): string {
  return [
    "【任务清单（Todo）】",
    "多步骤任务请先用 todo_create 把步骤拆成待办项，进度变化时用 todo_update 更新状态（in_progress/completed），需要时用 todo_list 查看最新清单、todo_delete 清理已完成项。",
    "用户也可能直接在任务面板中增删或勾选待办：每轮开始时如有疑问，先用 todo_list 同步最新清单再继续。"
  ].join("\n");
}

/** 当前待办清单的紧凑文本，注入到每轮系统提示词里，保证模型与任务面板同步。 */
export function buildTodoPromptBlock(todos: readonly Todo[]): string | undefined {
  if (todos.length === 0) return undefined;
  return `当前任务清单（Todo 面板）：\n${summarizeTodos(todos)}`;
}

/**
 * 每轮注入当前任务清单的 inline extension。清单内容通过
 * `before_agent_start` 追加到当轮系统提示词，而不是拼进用户消息文本，
 * 这样模型始终能看到最新清单，同时用户消息气泡和会话历史不会被
 * Todo 内容污染。
 */
export function createTodoContextExtension(deps: { todos: () => readonly Todo[] }): InlineExtension {
  return {
    name: "chat-anytime-todo-context",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", (event) => {
        const block = buildTodoPromptBlock(deps.todos());
        if (!block) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      });
    }
  };
}

export interface TodoToolContext {
  store: TodoStore;
  /** Broadcast after every mutation so the task panel stays in sync. */
  onChanged: () => void;
}

/** Build the Todo customTools (todo_create/list/update/delete). */
export function buildTodoTools({ store, onChanged }: TodoToolContext): ToolDefinition[] {
  const summarize = () => ({ content: [{ type: "text" as const, text: summarizeTodos(store.list()) }], details: { count: store.list().length } });
  const listText = (): string => summarizeTodos(store.list());
  const count = (): number => store.list().length;
  return [
    defineTool({
      name: "todo_create",
      label: "新建 Todo",
      description: "创建一个新的待办事项。多步骤任务请用它把步骤拆成待办并跟踪进度，不要只把步骤写在回复里。",
      promptSnippet: "todo_create: 新建待办事项",
      parameters: Type.Object({
        title: Type.String({ description: "待办标题" }),
        notes: Type.Optional(Type.String({ description: "可选备注" }))
      }),
      execute: async (_id, params) => {
        const created = store.create(String(params?.title ?? ""), params?.notes as string | undefined);
        onChanged();
        return {
          content: [{ type: "text", text: `已创建 Todo「${created.title}」，id: ${created.id}。\n\n当前待办：\n${listText()}` }],
          details: { count: count(), createdId: created.id }
        };
      }
    }),
    defineTool({
      name: "todo_list",
      label: "列出 Todo",
      description: "列出所有待办事项及其状态（即任务面板当前的最新清单），每行末尾的（id: …）可用于后续更新或删除。",
      promptSnippet: "todo_list: 列出待办事项",
      parameters: Type.Object({}),
      execute: async () => summarize()
    }),
    defineTool({
      name: "todo_update",
      label: "更新 Todo",
      description: "更新待办事项的标题、备注或状态。status 可为 pending/in_progress/completed。进度变化时请及时更新状态，避免清单与实际情况脱节。id 取 todo_list 返回的（id: …）。",
      promptSnippet: "todo_update: 更新待办事项",
      parameters: Type.Object({
        id: Type.String({ description: "待办 id（来自 todo_list 输出中的（id: …））" }),
        title: Type.Optional(Type.String()),
        notes: Type.Optional(Type.String()),
        status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]))
      }),
      execute: async (_id, params) => {
        const id = String(params?.id ?? "");
        const updated = store.update(id, {
          ...(typeof params?.title === "string" ? { title: params.title } : {}),
          ...(params?.notes !== undefined ? { notes: params.notes as string } : {}),
          ...(typeof params?.status === "string" ? { status: params.status as Todo["status"] } : {})
        });
        onChanged();
        const heading = updated
          ? `已更新 Todo「${updated.title}」（id: ${id}）。`
          : `未找到 id 为「${id}」的 Todo，未做任何修改。请先用 todo_list 确认正确的 id。`;
        return { content: [{ type: "text", text: `${heading}\n\n当前待办：\n${listText()}` }], details: { count: count(), updated: Boolean(updated) } };
      }
    }),
    defineTool({
      name: "todo_delete",
      label: "删除 Todo",
      description: "按 id 删除一个待办事项。id 取 todo_list 返回的（id: …）。",
      promptSnippet: "todo_delete: 删除待办事项",
      parameters: Type.Object({ id: Type.String({ description: "待办 id（来自 todo_list 输出中的（id: …））" }) }),
      execute: async (_id, params) => {
        const id = String(params?.id ?? "");
        const removed = store.remove(id);
        onChanged();
        const heading = removed
          ? `已删除 id 为「${id}」的 Todo。`
          : `未找到 id 为「${id}」的 Todo，未删除任何内容。请先用 todo_list 确认正确的 id。`;
        return { content: [{ type: "text", text: `${heading}\n\n当前待办：\n${listText()}` }], details: { count: count(), removed } };
      }
    })
  ];
}
