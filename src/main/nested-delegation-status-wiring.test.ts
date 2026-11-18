import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 嵌套委派的状态栏契约（2026-11-17）。
 *
 * codemode 脚本里 `await tools.delegate_agent(...)` 是合法调用（Pi 的脚本可调集
 * 包含所有激活的 direct 工具，只过滤 codemode 自己），它的 `tool_execution_update`
 * 事件带 `parentToolCallId`。`tool_execution_start` 早就约定「状态栏不跟随嵌套
 * 调用」（并行脚本会把状态栏抢成刷屏），但 update 的 delegation 分支漏了这道
 * 判断：脚本里跑子代理时，`record.status` 被嵌套步骤接管，脚本卡片本身反而从
 * 状态栏消失。
 *
 * 两条一起钉住：嵌套委派的进度必须照旧落进 `execution.delegation`（嵌套卡片要
 * 显示步骤），但不许写 `record.status`。删掉守卫、或把 delegation 赋值一起塞进
 * 守卫里，都会在这里失败。
 */
describe("nested delegation status wiring", () => {
  const source = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8");
  const start = source.indexOf('case "tool_execution_update": {');
  const end = source.indexOf('case "tool_execution_end": {', start);
  const body = start >= 0 && end > start ? source.slice(start, end) : "";

  it("slices the tool_execution_update branch out of pi-runtime", () => {
    expect(body).toContain("delegationFromToolResult(event.partialResult)");
    expect(body).toContain("current.delegation = delegation");
  });

  it("still records nested delegation progress on the execution", () => {
    const guard = body.indexOf("if (!event.parentToolCallId) {");
    expect(guard).toBeGreaterThan(-1);
    // 进度赋值必须在守卫之前：嵌套调用的卡片靠它渲染委派步骤。
    expect(body.indexOf("current.delegation = delegation")).toBeLessThan(guard);
  });

  it("keeps the status bar for top-level delegations only", () => {
    const guardStart = body.indexOf("if (!event.parentToolCallId) {");
    const guardEnd = body.indexOf("\n          }", guardStart);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guard = body.slice(guardStart, guardEnd);
    expect(guard).toContain("delegation.steps.at(-1)");
    expect(guard).toContain("record.status = lastStep");
    // 整个分支只有这一处写 status，且必须在守卫内（否则脚本内子代理又会抢状态栏）。
    expect(body.match(/record\.status =/g)?.length).toBe(1);
  });
});
