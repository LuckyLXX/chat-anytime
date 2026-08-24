import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTodoTools, createTodoPaceTracker, PACE_REMINDER_THRESHOLD } from "./runtime-todo-tools.js";
import { createTodoStore } from "./todo-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTool() {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-todo-tool-"));
  temporaryDirectories.push(directory);
  let changes = 0;
  const store = createTodoStore(join(directory, "todos.json"), () => { changes += 1; });
  const pace = createTodoPaceTracker();
  const tools = buildTodoTools({ store, pace });
  return { tool: tools[0]!, store, pace, get changes() { return changes; } };
}

interface ToolRunResult {
  content: { type: string; text?: string }[];
}

// defineTool 推断的 execute 需要全部 5 个参数；测试里其余参数恒为空。
async function runTool(tool: { execute?: unknown } | undefined, id: string, params: unknown): Promise<ToolRunResult> {
  if (typeof tool?.execute !== "function") throw new Error("tool has no execute");
  const execute = tool.execute as (toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: undefined) => Promise<ToolRunResult>;
  return execute(id, params, undefined, undefined, undefined);
}

function resultText(result: ToolRunResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("todo_write tool", () => {
  it("replaces the whole list and returns compact counts only", async () => {
    const harness = await makeTool();
    const { tool, store } = harness;

    const first = await runTool(tool, "call-1", { todos: [
      { content: "审阅变更", status: "in_progress" },
      { content: "提交", status: "pending" }
    ] });
    expect(resultText(first)).toContain("1 项待办、1 项进行中、0 项已完成");
    // The whole list already lives in the call args — the result must not echo it.
    expect(resultText(first)).not.toContain("审阅变更");

    const second = await runTool(tool, "call-2", { todos: [{ content: "审阅变更", status: "completed" }] });
    expect(resultText(second)).toContain("0 项待办、0 项进行中、1 项已完成");

    // Whole-list replacement: the second write replaced the first.
    expect(store.list()).toEqual([{ content: "审阅变更", status: "completed" }]);
    expect(harness.changes).toBe(2);
  });

  it("rejects empty or duplicate content and parallel in_progress items", async () => {
    const { tool } = await makeTool();

    await expect(runTool(tool, "call-1", { todos: [{ content: "  ", status: "pending" }] })).rejects.toThrow("非空");
    await expect(runTool(tool, "call-2", { todos: [
      { content: "同名", status: "pending" },
      { content: "同名", status: "completed" }
    ] })).rejects.toThrow("重复");
    await expect(runTool(tool, "call-3", { todos: [
      { content: "任务一", status: "in_progress" },
      { content: "任务二", status: "in_progress" }
    ] })).rejects.toThrow("in_progress");
  });

  it("trims content before persisting", async () => {
    const { tool, store } = await makeTool();
    await runTool(tool, "call-1", { todos: [{ content: "  审阅变更  ", status: "pending" }] });
    expect(store.list()).toEqual([{ content: "审阅变更", status: "pending" }]);
  });

  it("appends the anti-batching reminder only after the tool-call threshold since the last write", async () => {
    const { tool, pace } = await makeTool();

    // Below the threshold (including a fresh session) the result stays quiet.
    const first = await runTool(tool, "call-1", { todos: [{ content: "任务一", status: "in_progress" }] });
    expect(resultText(first)).not.toContain("提示");

    for (let index = 0; index < PACE_REMINDER_THRESHOLD - 1; index++) pace.record();
    const below = await runTool(tool, "call-2", { todos: [{ content: "任务一", status: "completed" }] });
    expect(resultText(below)).not.toContain("提示");

    for (let index = 0; index < PACE_REMINDER_THRESHOLD; index++) pace.record();
    const above = await runTool(tool, "call-3", { todos: [{ content: "任务二", status: "in_progress" }] });
    expect(resultText(above)).toContain(`距上次清单更新已执行 ${PACE_REMINDER_THRESHOLD} 个工具调用`);
    expect(resultText(above)).toContain("不要攒批");

    // consume() resets: the next write without intervening calls stays quiet.
    const after = await runTool(tool, "call-4", { todos: [{ content: "任务二", status: "completed" }] });
    expect(resultText(after)).not.toContain("提示");
  });
});
