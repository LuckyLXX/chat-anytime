import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTodoTools, createTodoPaceTracker, PACE_REMINDER_THRESHOLD, type TodoVerifyDeps } from "./runtime-todo-tools.js";
import { createTodoStore } from "./todo-store.js";
import type { VerifyResult } from "./todo-verify.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTool(overrides: Partial<TodoVerifyDeps> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-todo-tool-"));
  temporaryDirectories.push(directory);
  let changes = 0;
  const store = createTodoStore(join(directory, "todos.json"), () => { changes += 1; });
  const pace = createTodoPaceTracker();
  const verify: TodoVerifyDeps = {
    run: vi.fn(async () => passedResult()),
    shellEnabled: () => true,
    requestPermission: async () => true,
    ...overrides
  };
  const tools = buildTodoTools({ store, pace, verify });
  return { tool: tools[0]!, store, pace, verify, get changes() { return changes; } };
}

function passedResult(output = ""): VerifyResult {
  return { ok: true, exitCode: 0, timedOut: false, aborted: false, output, durationMs: 12 };
}

function failedResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return { ok: false, exitCode: 1, timedOut: false, aborted: false, output: "boom", durationMs: 7, ...overrides };
}

interface ToolRunResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

// defineTool 推断的 execute 需要全部 5 个参数；测试里其余参数恒为空。
async function runTool(tool: { execute?: unknown } | undefined, id: string, params: unknown, signal?: AbortSignal): Promise<ToolRunResult> {
  if (typeof tool?.execute !== "function") throw new Error("tool has no execute");
  const execute = tool.execute as (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: undefined) => Promise<ToolRunResult>;
  return execute(id, params, signal, undefined, undefined);
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

  it("keeps verify on the item and only executes it on the completion transition", async () => {
    const harness = await makeTool();
    const run = vi.mocked(harness.verify.run);

    await runTool(harness.tool, "call-1", { todos: [{ content: "跑测试", status: "in_progress", verify: "npm test" }] });
    expect(run).not.toHaveBeenCalled();
    expect(harness.store.list()).toEqual([{ content: "跑测试", status: "in_progress", verify: "npm test" }]);

    const result = await runTool(harness.tool, "call-2", { todos: [{ content: "跑测试", status: "completed", verify: "npm test" }] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("npm test", undefined);
    expect(resultText(result)).toContain("验收通过 1 项：npm test");
    expect(result.isError).toBeUndefined();
    expect(harness.store.list()[0]).toMatchObject({ content: "跑测试", status: "completed", verify: "npm test", verifyOk: true });
    expect(harness.store.list()[0]?.verifiedAt).toBeTypeOf("number");
  });

  it("downgrades a failed item to in_progress and returns the output tail as an error result", async () => {
    const harness = await makeTool({ run: vi.fn(async () => failedResult({ exitCode: 2, output: "TypeError: x is undefined" })) });

    const result = await runTool(harness.tool, "call-1", { todos: [{ content: "提交", status: "completed", verify: "npm run build" }] });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("验收未通过 1 项，已退回未完成");
    expect(resultText(result)).toContain("npm run build");
    expect(resultText(result)).toContain("退出码 2");
    expect(resultText(result)).toContain("TypeError: x is undefined");
    // The stored truth wins over the model's claim.
    expect(resultText(result)).toContain("0 项已完成");
    expect(resultText(result)).toContain("1 项进行中");
    expect(harness.store.list()[0]).toMatchObject({ content: "提交", status: "in_progress", verifyOk: false });
  });

  it("re-sending an already completed item does not run its verify again", async () => {
    const harness = await makeTool();
    const run = vi.mocked(harness.verify.run);

    await runTool(harness.tool, "call-1", { todos: [{ content: "跑测试", status: "completed", verify: "npm test" }] });
    const firstVerifiedAt = harness.store.list()[0]?.verifiedAt;
    expect(run).toHaveBeenCalledTimes(1);

    await runTool(harness.tool, "call-2", { todos: [
      { content: "跑测试", status: "completed", verify: "npm test" },
      { content: "写文档", status: "in_progress" }
    ] });

    expect(run).toHaveBeenCalledTimes(1);
    expect(harness.store.list()[0]?.verifiedAt).toBe(firstVerifiedAt);
  });

  it("re-runs verification after a failure is fixed and re-completed", async () => {
    const run = vi.fn(async () => failedResult());
    run.mockResolvedValueOnce(failedResult()).mockResolvedValueOnce(passedResult());
    const harness = await makeTool({ run });

    await runTool(harness.tool, "call-1", { todos: [{ content: "修构建", status: "completed", verify: "npm run build" }] });
    expect(harness.store.list()[0]?.status).toBe("in_progress");

    await runTool(harness.tool, "call-2", { todos: [{ content: "修构建", status: "completed", verify: "npm run build" }] });

    expect(run).toHaveBeenCalledTimes(2);
    expect(harness.store.list()[0]).toMatchObject({ status: "completed", verifyOk: true });
  });

  it("drops a stale pass marker when the item no longer declares verify", async () => {
    const harness = await makeTool();
    await runTool(harness.tool, "call-1", { todos: [{ content: "跑测试", status: "completed", verify: "npm test" }] });
    expect(harness.store.list()[0]?.verifyOk).toBe(true);

    await runTool(harness.tool, "call-2", { todos: [{ content: "跑测试", status: "completed" }] });

    expect(harness.store.list()).toEqual([{ content: "跑测试", status: "completed" }]);
  });

  it("refuses to run verify when the session has no shell capability", async () => {
    const run = vi.fn(async () => passedResult());
    const harness = await makeTool({ run, shellEnabled: () => false });

    const result = await runTool(harness.tool, "call-1", { todos: [{ content: "跑测试", status: "completed", verify: "npm test" }] });

    expect(run).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("验收未执行 1 项");
    expect(resultText(result)).toContain("未启用 shell 工具");
    expect(harness.store.list()[0]).toMatchObject({ content: "跑测试", status: "in_progress" });
    expect(harness.store.list()[0]?.verifyOk).toBeUndefined();
  });

  it("downgrades when the permission gate denies the verify command", async () => {
    const run = vi.fn(async () => passedResult());
    const requestPermission = vi.fn(async () => false);
    const harness = await makeTool({ run, requestPermission });

    const result = await runTool(harness.tool, "call-1", { todos: [{ content: "跑测试", status: "completed", verify: "npm test" }] });

    expect(requestPermission).toHaveBeenCalledWith("npm test", "call-1");
    expect(run).not.toHaveBeenCalled();
    expect(resultText(result)).toContain("验收命令未获授权");
    expect(harness.store.list()[0]?.status).toBe("in_progress");
  });

  it("downgrades when a user block hook rejects the command", async () => {
    const run = vi.fn(async () => passedResult());
    const checkBlock = vi.fn(() => ({ blocked: true, reason: "钩子「危险命令」拦截了 bash：命中规则 rm -rf" }));
    const harness = await makeTool({ run, checkBlock });

    const result = await runTool(harness.tool, "call-1", { todos: [{ content: "清目录", status: "completed", verify: "rm -rf build" }] });

    expect(checkBlock).toHaveBeenCalledWith("rm -rf build");
    expect(run).not.toHaveBeenCalled();
    expect(resultText(result)).toContain("命中规则 rm -rf");
    expect(harness.store.list()[0]?.status).toBe("in_progress");
  });

  it("treats an aborted run as neither a pass nor a failure", async () => {
    const run = vi.fn(async () => failedResult({ aborted: true, exitCode: undefined, output: "验收命令已中止。" }));
    const harness = await makeTool({ run });

    const result = await runTool(harness.tool, "call-1", { todos: [{ content: "跑测试", status: "completed", verify: "npm test" }] });

    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("验收被中止 1 项");
    expect(harness.store.list()[0]).toMatchObject({ content: "跑测试", status: "in_progress", verify: "npm test" });
    expect(harness.store.list()[0]?.verifyOk).toBeUndefined();
  });

  it("keeps at most one in_progress item when a failure is rolled back", async () => {
    const run = vi.fn(async () => failedResult());
    const harness = await makeTool({ run });

    await runTool(harness.tool, "call-1", { todos: [
      { content: "改后端", status: "in_progress" },
      { content: "跑测试", status: "completed", verify: "npm test" }
    ] });

    const active = harness.store.list().filter((todo) => todo.status === "in_progress");
    expect(active).toHaveLength(1);
    expect(harness.store.list().find((todo) => todo.content === "跑测试")?.status).toBe("pending");
  });

  it("runs a shared verify command once and applies the result to every item", async () => {
    const run = vi.fn(async () => passedResult());
    const harness = await makeTool({ run });

    await runTool(harness.tool, "call-1", { todos: [
      { content: "改后端", status: "completed", verify: "npm test" },
      { content: "改前端", status: "completed", verify: "npm test" }
    ] });

    expect(run).toHaveBeenCalledTimes(1);
    expect(harness.store.list().filter((todo) => todo.verifyOk === true)).toHaveLength(2);
  });

  it("rejects an over-long verify command", async () => {
    const { tool } = await makeTool();
    await expect(runTool(tool, "call-1", { todos: [{ content: "跑测试", status: "pending", verify: "a".repeat(501) }] })).rejects.toThrow("500");
  });

  it("forwards the tool abort signal to the verifier", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (_command: string, _signal?: AbortSignal) => passedResult());
    const harness = await makeTool({ run });

    await runTool(harness.tool, "call-1", { todos: [{ content: "跑测试", status: "completed", verify: "npm test" }] }, controller.signal);

    expect(run).toHaveBeenCalledWith("npm test", controller.signal);
  });
});
