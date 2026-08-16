import { describe, expect, it } from "vitest";
import type { Todo } from "../shared/protocol.js";
import { buildTodoPromptBlock, createTodoContextExtension, summarizeTodos } from "./runtime-todo-tools.js";

interface FakePi {
  handlers: Map<string, (event: Record<string, unknown>) => unknown>;
  on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
}

function makeFakePi(): FakePi {
  return {
    handlers: new Map(),
    on(event, handler) {
      this.handlers.set(event, handler);
    }
  };
}

function bind(deps: { todos: () => readonly Todo[] }): FakePi {
  const pi = makeFakePi();
  (createTodoContextExtension(deps) as unknown as { factory: (pi: FakePi) => void }).factory(pi);
  return pi;
}

const sampleTodos: Todo[] = [
  { id: "todo-1", title: "审阅变更", status: "in_progress", createdAt: 1, updatedAt: 2 },
  { id: "todo-2", title: "提交", status: "completed", createdAt: 3, updatedAt: 3 }
];

describe("todo prompt block", () => {
  it("returns undefined for an empty list", () => {
    expect(buildTodoPromptBlock([])).toBeUndefined();
  });

  it("summarizes todos with status marks", () => {
    expect(summarizeTodos(sampleTodos)).toContain("- [~] 审阅变更");
    expect(summarizeTodos(sampleTodos)).toContain("- [x] 提交");
  });
});

describe("todo context extension", () => {
  it("injects the current todo list into the per-turn system prompt", () => {
    const pi = bind({ todos: () => sampleTodos });
    const handler = pi.handlers.get("before_agent_start")!;

    const result = handler({ type: "before_agent_start", prompt: "继续", systemPrompt: "基础提示词" });

    expect(result).toBeDefined();
    const { systemPrompt } = result as { systemPrompt: string };
    expect(systemPrompt).toContain("基础提示词");
    expect(systemPrompt).toContain("当前任务清单（Todo 面板）");
    expect(systemPrompt).toContain("- [x] 提交");
    // The user prompt itself must stay untouched.
    expect(systemPrompt).not.toContain("继续");
  });

  it("leaves the system prompt unchanged when there are no todos", () => {
    const pi = bind({ todos: () => [] });
    const handler = pi.handlers.get("before_agent_start")!;

    expect(handler({ type: "before_agent_start", prompt: "继续", systemPrompt: "基础提示词" })).toBeUndefined();
  });

  it("re-reads the todo list lazily so each turn sees the latest state", () => {
    let current: readonly Todo[] = [];
    const pi = bind({ todos: () => current });
    const handler = pi.handlers.get("before_agent_start")!;

    expect(handler({ type: "before_agent_start", prompt: "继续", systemPrompt: "基础提示词" })).toBeUndefined();

    current = sampleTodos;
    const result = handler({ type: "before_agent_start", prompt: "继续", systemPrompt: "基础提示词" }) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("当前任务清单（Todo 面板）");
  });
});
