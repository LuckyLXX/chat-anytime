import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * workspace-first 的接线契约（2026-10-26 方案 A）。
 *
 * 纯函数单测挡不住“命令又读回旧字段/旧入口没删”这类静默回潮：
 * - agent.select / session.open / workspace.open 再读写 agentWorkspaces 会让助手
 *   又把会话拖回它自己的旧工作区；
 * - workspace.remove 复活会把“从列表移除”重新绑成“删除全部会话”；
 * - startup 不读 lastWorkspace 则重启恢复退化为默认目录；
 * - session.open 不传 agentId 则跨助手会话打不开。
 */
describe("workspace-first wiring contract", () => {
  const runtime = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8").replace(/\r\n/gu, "\n");
  const main = readFileSync(join(__dirname, "index.ts"), "utf8").replace(/\r\n/gu, "\n");
  const protocol = readFileSync(join(__dirname, "..", "shared", "protocol.ts"), "utf8").replace(/\r\n/gu, "\n");

  it("removes workspace.remove from protocol / utility / main", () => {
    expect(protocol).not.toContain('type: "workspace.remove"');
    expect(runtime).not.toContain('case "workspace.remove"');
    expect(main).not.toContain('case "workspace.remove"');
  });

  it("agent.select never reads agentWorkspaces and keeps the current workspace", () => {
    const start = runtime.indexOf('case "agent.select": {');
    const end = runtime.indexOf('case "agent.save":', start);
    const branch = runtime.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(branch).not.toContain("agentWorkspaces");
    expect(branch).not.toContain("agentDefaultWorkspace()");
    expect(branch).toContain("openSession === false");
    expect(branch).toContain("pickRecentSession(");
  });

  it("startup uses lastWorkspace with existence-checked fallback chain", () => {
    expect(runtime).toContain("resolveStartupWorkspace({");
    expect(runtime).toContain("lastWorkspace: settings.lastWorkspace");
    expect(main).toContain('message.type === "runtime-context"');
    expect(main).toContain("source.lastWorkspace = nextWorkspace");
  });

  it("session.open resolves owner across agents and passes agentId into creation", () => {
    const start = runtime.indexOf('case "session.open": {');
    const end = runtime.indexOf('case "session.rename": {', start);
    const branch = runtime.slice(start, end);
    expect(branch).toContain("resolveSessionOwner(target, scopes");
    expect(branch).toContain("owner.agentId");
    expect(branch).toContain("agentOverride: ownerAgent");
    expect(branch).toContain("workspaceOverride: recordWorkspace");
  });

  it("workspace.forget exists and never deletes session files", () => {
    const start = runtime.indexOf('case "workspace.forget": {');
    const end = runtime.indexOf('case "session.new": {', start);
    const branch = runtime.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(branch).toContain("removeRecentWorkspace(");
    expect(branch).not.toContain("unlink(");
    expect(branch).not.toContain("deleteSessionByPath");
  });
});
