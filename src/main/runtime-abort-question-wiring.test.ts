import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * session.abort 的交互请求收场契约（2026-10-21 计划审查卡死事故）。
 *
 * ask_question / exit_plan_mode / 权限确认都阻塞在 broker Promise 上；
 * session.abort() 只中止模型流，不替这些工具返回。若中止时不 cancel，
 * 工具永久挂起，运行无法 settle，用户看到的就是“停止按钮无效”。
 */
describe("session.abort interaction cleanup contract", () => {
  const runtime = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8").replace(new RegExp("\r\n", "gu"), "\n");

  function abortBlock(): string {
    return runtime.slice(runtime.indexOf('case "session.abort":'), runtime.indexOf('case "session.killExecution":'));
  }

  it("中止时取消挂起的提问（exit_plan_mode / ask_question 立即以 cancelled 收场）", () => {
    expect(abortBlock()).toContain("questionBroker.reset(record.session.sessionId)");
  });

  it("中止时取消挂起的权限确认，但不撤掉本会话已授予的 allow-session", () => {
    const block = abortBlock();
    expect(block).toContain("permissionBroker.cancelPending(record.session.sessionId)");
    expect(block).not.toContain("permissionBroker.reset(");
  });
});
