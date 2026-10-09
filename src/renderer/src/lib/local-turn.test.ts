import { describe, expect, it } from "vitest";
import { LOCAL_TURN_FALLBACK_MS, commandErrorTargetsPane, localTurnDeadline, localTurnForPane } from "./local-turn";

/**
 * 乐观待回复的判定（2026-10-09 用户报告：「多角色多会话多开」时聊天区底部留着一条
 * 假的「Pi 正在努力输出中……」+ 从点击时刻起算、一直跳的耗时读数）。
 *
 * 现场取证：那条气泡的尺寸与 `PendingResponse` 完全一致，耗时行是「回答耗时 等待输出」
 * （本地乐观没有 answerStartedAt），而所属会话的 jsonl 在那次点击前后没有任何写入
 * ——即「以为发出去了、其实被运行时拒了」。过去的清除路径只有 data.busy 翻转，
 * 所以它要等到别的事件把 busy 带着翻过来才消失。
 */
describe("localTurnForPane", () => {
  it("sessionId 真实相等时给出计时", () => {
    expect(localTurnForPane({ startedAt: 123, sessionId: "s1" }, "s1")).toEqual({ startedAt: 123 });
  });

  it("别的会话/别的格子不命中", () => {
    expect(localTurnForPane({ startedAt: 123, sessionId: "s1" }, "s2")).toBeUndefined();
  });

  it("两边都缺省也不算命中（未水合的格子不会凭空长出待回复行）", () => {
    expect(localTurnForPane({ startedAt: 123, sessionId: undefined }, undefined)).toBeUndefined();
    expect(localTurnForPane({ startedAt: 123, sessionId: "s1" }, undefined)).toBeUndefined();
    expect(localTurnForPane({ startedAt: 123, sessionId: undefined }, "s1")).toBeUndefined();
  });

  it("没有本地待回复时缺省", () => {
    expect(localTurnForPane(undefined, "s1")).toBeUndefined();
  });
});

describe("commandErrorTargetsPane", () => {
  it("会话级命令失败命中发起格", () => {
    expect(commandErrorTargetsPane({ sessionId: "s1", message: "该会话不在运行中" }, "s1")).toBe(true);
  });

  it("别的会话的命令失败不命中（不误收别格的待回复）", () => {
    expect(commandErrorTargetsPane({ sessionId: "s2", message: "x" }, "s1")).toBe(false);
  });

  it("进程级失败（无 sessionId）不命中任何一格", () => {
    expect(commandErrorTargetsPane({ message: "x" }, "s1")).toBe(false);
    expect(commandErrorTargetsPane(undefined, "s1")).toBe(false);
  });

  it("格子身份缺省时不命中", () => {
    expect(commandErrorTargetsPane({ sessionId: "s1", message: "x" }, undefined)).toBe(false);
  });
});

describe("localTurnDeadline", () => {
  it("兜底窗口是固定常量（静默失败路径靠它收，不靠任何推送）", () => {
    expect(localTurnDeadline({ startedAt: 1_000, sessionId: "s1" })).toBe(1_000 + LOCAL_TURN_FALLBACK_MS);
    expect(LOCAL_TURN_FALLBACK_MS).toBeGreaterThanOrEqual(5_000);
  });
});
