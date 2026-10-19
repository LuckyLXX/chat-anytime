import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 验收闭环的接线契约（2026-10-19）。
 *
 * 为什么需要源码断言：`runtime-todo-tools.test.ts` 只能证明「传了 verify 依赖时
 * 行为正确」，证明不了 pi-runtime 真的把依赖传了进去。漏传时工具会静默降级成
 * 「未启用验收执行」——单测全绿，而用户侧永远看不到验收发生。这里把接线钉死：
 * 执行器、能力开关、权限门三者缺一不可。
 */
describe("todo verify wiring contract", () => {
  const runtime = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8");
  const tools = readFileSync(join(__dirname, "runtime-todo-tools.ts"), "utf8");

  it("会话创建时把 verify 依赖传给 todo 工具", () => {
    expect(runtime).toContain("buildTodoTools(recordTodoStore, recordTodoPace, todoVerifyContext)");
    expect(runtime).toContain("runVerifyCommand(command, {");
    expect(runtime).toContain("cwd: session.workspace");
    expect(runtime).toContain("return decision !== \"deny\"");
  });

  it("验收命令走与 bash 相同的权限门与用户 block 钩子", () => {
    expect(runtime).toContain(
      'runtimePermissions.requestPermission(session.permissionDeps, "bash", { command }, toolCallId)'
    );
    expect(runtime).toContain('evaluateToolCallBlock(recordHooksDeps, "bash", { command })');
  });

  it("验收命令沿用用户配置的 shellPath / commandPrefix", () => {
    expect(runtime).toContain("shellPath: settingsManager.getShellPath() ?? undefined");
    expect(runtime).toContain("commandPrefix: settingsManager.getShellCommandPrefix() ?? undefined");
    expect(runtime).toContain("shellPath: session.shellPath");
    expect(runtime).toContain("commandPrefix: session.commandPrefix");
  });

  it("角色关闭 shell 时验收不执行（不能从 todo 侧绕过能力开关）", () => {
    expect(runtime).toContain("session.agent.tools?.bash !== false || session.agent.tools?.powershell === true");
  });

  it("只有本次新完成的条目才执行验收，且失败会写回未完成", () => {
    expect(tools).toContain('todo.status === "completed" && todo.verify && previous.get(todo.content)?.status !== "completed"');
    expect(tools).toContain("verify.run(command, signal)");
    expect(tools).toContain("store.replaceAll(finalList)");
    expect(tools).toContain('status: TodoStatus = activeTaken ? "pending" : "in_progress"');
  });

  it("todo_write 串行执行，避免同批并行时互相覆盖失败回滚", () => {
    expect(tools).toContain('executionMode: "sequential"');
  });
});
