import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「会话还在跑吗」的接线契约（源码级断言，同 skill-store-wiring / recent-completions-wiring 的形态）。
 *
 * 为什么必须钉源码：`run-state.test.ts` 只能证明那个布尔取或是对的，证明不了
 * `pi-runtime` 真的拿它当口径。2026-11-13 内网用户报的 bug（绘画还没完成、输入框
 * 已显示完成、回车被 Pi 以英文 "Agent is already processing…" 拒收）就是**接线**
 * 错了：快照 busy 只读 `record.busy`、发送守卫只读 `record.busy`，而 `agent_end`
 * 一响 `record.busy` 就清了 —— 收尾窗口（自动重试 / 压缩恢复 / 排队 followUp）里
 * UI 与 Pi 对「忙」的判断正面冲突。任何一处退回旧写法都必须让本文件转红。
 *
 * 源码行尾在本地工作区（LF）与 CI 检出（CRLF）之间不一致：读入即归一化。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

const runtime = read("pi-runtime.ts");
const helper = read("run-state.ts");

/** 切出一段 `case "<start>":` 到下一个 `case "<end>":` 之间的源码。 */
function caseBlock(source: string, start: string, end: string): string {
  const from = source.indexOf(`case "${start}":`);
  expect(from, `源码里找不到 case "${start}"`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(`case "${end}":`, from + 1);
  expect(to, `case "${start}" 之后找不到 case "${end}"`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("run-state.runActive 是唯一口径", () => {
  it("helper 说明为什么不能只看 record.busy（agent_end ≠ 会话终点）", () => {
    expect(helper).toContain("export function runActive(");
    expect(helper).toContain("record.busy || record.session.isStreaming");
    expect(helper).toContain("agent_settled");
  });

  it("pi-runtime 只从 run-state 取这个口径，不再手写 record.busy || session.isStreaming", () => {
    expect(runtime).toContain('import { runActive } from "./run-state.js";');
    expect(runtime).not.toContain("record.busy || record.session.isStreaming");
    expect(runtime).not.toContain("record?.busy ?? false");
  });
});

describe("快照的 busy 字段（输入框停止/发送按钮、队列模式都由它驱动）", () => {
  it("激活会话全量快照", () => {
    expect(runtime).toContain("busy: (record ? runActive(record) : false) || transitionStatus !== undefined,");
  });

  it("分屏格子快照 + 面板实时投影都走 runActive", () => {
    // paneSnapshotFrom / buildLiveSessions 两处都是这一行；至少两处。
    expect(runtime.split("busy: runActive(record),").length - 1).toBeGreaterThanOrEqual(2);
    expect(runtime).not.toContain("busy: record.busy,");
  });

  it("空闲会话驱逐与「未开始空话题」判定也按 runActive（收尾中不能被回收/重建）", () => {
    expect(runtime).toContain("!runActive(record) && !renderedSessions.has(record.session.sessionId)");
    expect(runtime).toContain("return isUnstartedSession({\n    busy: runActive(record),");
  });
});

describe("发送类守卫（兜住 UI 状态滞后：宁可等，也不能把被拒的消息记成失败回合）", () => {
  it("三条守卫都先判 runActive，并区分「真的在跑」与「还在收尾」两种文案", () => {
    const guards = runtime.split("if (runActive(record)) throw new Error(record.busy ?").length - 1;
    expect(guards).toBeGreaterThanOrEqual(3); // session.prompt / session.regenerate / session.compact
    for (const text of ["当前话题正在执行，请等待完成或停止后再发送", "上一回合仍在收尾（自动重试 / 压缩上下文），请稍候再发送", "请稍候再重新生成", "请稍候再压缩"]) {
      expect(runtime).toContain(text);
    }
  });

  it("排队投递 / 立即发送 / IM 入站 / 能力管理一律认同一个口径", () => {
    expect(runtime.split("if (runActive(record)) {").length - 1).toBeGreaterThanOrEqual(3);
    expect(runtime).toContain("? promoteQueueMessage(state, command.kind, command.index, command.text, runActive(record))");
    expect(runtime).toContain("if (sendNow && !runActive(record) && outcome.target) {");
    expect(runtime).toContain("if (runActive(record) || resourceOperationBusy)");
  });
});

describe("回合终点（agent_end 只是底层 run 边界，定稿归 agent_settled）", () => {
  const agentEnd = caseBlock(runtime, "agent_end", "agent_settled");
  // handleImSessionEvent 也有一段 `case "agent_settled":`（在 agent_end 之前），
  // 所以从 agent_end 之后再取，并切到下一个 `case "turn_start":` 为止。
  const settledStart = runtime.indexOf('case "agent_settled":', runtime.indexOf('case "agent_end":'));
  const settled = runtime.slice(settledStart, runtime.indexOf('case "turn_start":', settledStart));

  it("agent_end 不再清 busy、不再落「就绪」、不再定稿回合或结算圆点", () => {
    expect(agentEnd).not.toContain("record.busy = false");
    expect(agentEnd).not.toContain('record.status = "就绪"');
    expect(agentEnd).not.toContain("completeTurn(record)");
    expect(agentEnd).not.toContain("resolveRunOutcome(record, event.messages)");
    // IM 收尾仍在这里（必须在 resolveRunOutcome 清掉 abortRequested 之前读结局）。
    expect(agentEnd).toContain("imTurnEnd(record, event.messages);");
  });

  it("agent_settled 才清 busy / 定稿 / 结算，并且无条件刷新生命周期帧", () => {
    expect(settled).toContain("record.busy = false;");
    expect(settled).toContain('record.status = "就绪";');
    expect(settled).toContain("completeTurn(record);");
    expect(settled).toContain("resolveRunOutcome(record, record.session.state.messages);");
    // 结局不再按 runStatus 设门槛：切进会话时清圆点不代表这一轮没结束，
    // completedAt 必须照记（否则侧栏「已完成」分区漏掉这轮）。
    expect(settled).not.toContain('if (record.runStatus === "running")');
    // busy/状态变了就是生命周期帧，必须在结算之后立刻置真（不能被 20fps 合帧丢掉）。
    const lifecycleAt = settled.indexOf("lifecycle = true;");
    expect(lifecycleAt).toBeGreaterThan(settled.indexOf("completeTurn(record);"));
  });
});
