import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 空话题切助手「就地换角色」的接线契约（2026-10-27 用户报：新建话题后输入框里
 * 切助手会被带去别的会话，助手切换在空话题里等于废掉）。
 *
 * 判定口径由 session-scope 的 isUnstartedSession 纯函数单测钉住；这里钉的是
 * pi-runtime 的接线顺序与关键参数——这几处正是「逻辑还在、接错了路径」的
 * 典型回潮点：
 * - 空话题分支必须早于 pickRecentSession（否则永远走「打开该助手最近会话」）；
 * - 必须晚于 openSession=false 的早退（automation.run.open 的跨角色定位只改
 *   默认助手，不能把后台任务的激活会话换掉）；
 * - 重建必须复用同一 sessionId（渲染端草稿与分屏绑定都按它存）并落到目标
 *   助手的会话目录；
 * - 三个会话级模式必须显式继承（换角色不是换话题）。
 */
describe("blank-topic agent switch wiring", () => {
  const runtime = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8").replace(/\r\n/gu, "\n");
  const branchStart = runtime.indexOf('case "agent.select": {');
  const branchEnd = runtime.indexOf('case "agent.save":', branchStart);
  const branch = runtime.slice(branchStart, branchEnd);

  it("switches an unstarted topic in place before opening the assistant's recent session", () => {
    const unstarted = branch.indexOf("isUnstartedRecord(activeRuntime)");
    const recent = branch.indexOf("pickRecentSession(");
    const openSessionGuard = branch.indexOf("command.openSession === false");
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(unstarted).toBeGreaterThan(-1);
    expect(recent).toBeGreaterThan(-1);
    // 早于 pickRecentSession：空话题不能被「打开最近会话」抢走。
    expect(unstarted).toBeLessThan(recent);
    // 晚于 openSession=false 的早退：那条路径必须保持「不动会话」。
    expect(openSessionGuard).toBeGreaterThan(-1);
    expect(openSessionGuard).toBeLessThan(unstarted);
  });

  it("rebuilds the blank topic under the target agent with the same session id", () => {
    const block = branch.slice(branch.indexOf("空话题（新建后还没"), branch.indexOf("pickRecentSession("));
    // 目标助手的会话目录（不是当前助手、不是全局工作区镜像）。
    expect(block).toContain("agentWorkspaceSessionDir(getAgentDir(), command.agentId");
    expect(block).toContain("previousRuntime.workspace");
    // 同一 sessionId：换角色不能让渲染端看起来像换了话题（草稿会丢）。
    expect(block).toContain("{ id: previousRuntime.session.sessionId }");
    expect(block).toContain("inheritDesignMode: previousRuntime.designMode.enabled");
    expect(block).toContain("inheritComputerMode: previousRuntime.computerMode.enabled");
    expect(block).toContain("inheritTeamMode: previousRuntime.teamMode.enabled");
    // 点到当前助手的行不重建（侧栏「当前助手」保持原有语义）。
    expect(block).toContain("activeRuntime.agent.id !== command.agentId");
  });

  it("derives the unstarted flag from the live record, including the persisted file", () => {
    const helperStart = runtime.indexOf("function isUnstartedRecord(");
    const helperEnd = runtime.indexOf("async function createSession(", helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    const helper = runtime.slice(helperStart, helperEnd);
    expect(helper).toContain("isUnstartedSession({");
    expect(helper).toContain("busy: record.busy");
    expect(helper).toContain("messageCount: record.session.state.messages.length");
    expect(helper).toContain("steeringCount: record.session.getSteeringMessages().length");
    expect(helper).toContain("followUpCount: record.session.getFollowUpMessages().length");
    expect(helper).toContain("existsSync(sessionFile)");
  });

  it("keeps pinned/archived blank topics on the old path (their keys are paths)", () => {
    // pin/archive 按路径落盘，重建会换路径 → 键失联；prune 又故意保留这类行，
    // 所以这种边缘情况宁可走旧的「打开最近会话」。
    const block = branch.slice(branch.indexOf("空话题（新建后还没"), branch.indexOf("pickRecentSession("));
    expect(block).toContain("isSessionPinned(settings.pinnedSessionPaths ?? [], unstartedPath)");
    expect(block).toContain("isSessionArchived(settings.archivedSessionPaths ?? [], unstartedPath)");
    expect(block).toContain("!unstartedMarked");
  });

  it("restores split-pane render bindings across the same-id rebuild", () => {
    // 同 id 重建会把会话从 renderedSessions/pendingWatchSessions 摘掉，而渲染端
    // 的 watch 注册是粘性的——不恢复，分屏的该格在后台会冻结。
    const createStart = runtime.indexOf("async function createSession(");
    const createEnd = runtime.indexOf("async function initialize(", createStart);
    const body = runtime.slice(createStart, createEnd);
    expect(createStart).toBeGreaterThan(-1);
    expect(body).toContain("const rebuildPaneBinding = existing");
    expect(body).toContain("pendingWatchSessions.add(result.session.sessionId)");
    expect(body).toContain("renderedSessions.add(result.session.sessionId)");
    // 恢复必须在记录真正入册之后（否则推送路径还不认这个 id）。
    expect(body.indexOf("liveSessions.set(result.session.sessionId, record)")).toBeLessThan(body.indexOf("rebuildPaneBinding?.rendered"));
  });

  it("keeps a user-given name on the synthesized sidebar row", () => {
    const start = runtime.indexOf("function ensureSessionInList(");
    const end = runtime.indexOf("function setTerminalRunStatus(", start);
    expect(start).toBeGreaterThan(-1);
    const body = runtime.slice(start, end);
    expect(body).toContain('manager.getSessionName() ?? "新会话"');
  });
});
