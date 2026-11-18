import { describe, expect, it } from "vitest";
import { SessionOpenCoordinator } from "./session-open-coordinator.js";

/**
 * 请求合并的回归网（2026-11-18 P0 冷开优化第二批）。
 *
 * 这一层最容易破坏的是**操作语义**而不是性能：少淘汰一次只是慢一点，多淘汰
 * 一次就是「点了没反应」「消息发错会话」「分屏空白」。所以每条合并规则都要有
 * 一条对应反例——屏障、分屏保护、身份不明、同目标都在这里钉住。
 */
describe("SessionOpenCoordinator", () => {
  it("keeps only the last plain foreground open in one continuous batch", () => {
    const coordinator = new SessionOpenCoordinator();
    // 连续三次点击（侧边栏 -> 侧边栏 -> 侧边栏），中间没有任何其他命令。
    const a = coordinator.register({ pathKey: "c:/s/a.jsonl", sessionId: "a" });
    const b = coordinator.register({ pathKey: "c:/s/b.jsonl", sessionId: "b" });
    const c = coordinator.register({ pathKey: "c:/s/c.jsonl", sessionId: "c" });
    expect(a.isSuperseded()).toBe(true);
    expect(b.isSuperseded()).toBe(true);
    expect(c.isSuperseded()).toBe(false);
    // 已过期且未开始 → begin 返回 false（调用方直接跳过，不进磁盘/SDK）。
    expect(coordinator.begin(a.seq)).toBe(false);
    expect(coordinator.begin(c.seq)).toBe(true);
  });

  it("lets an in-flight open discover the switch at the next boundary", () => {
    const coordinator = new SessionOpenCoordinator();
    const a = coordinator.register({ pathKey: "c:/s/a.jsonl", sessionId: "a" });
    expect(coordinator.begin(a.seq)).toBe(true);
    // A 已经开始（例如正卡在 SessionManager.open 里），用户又点了 B。
    const b = coordinator.register({ pathKey: "c:/s/b.jsonl", sessionId: "b" });
    // 阶段边界读同一个票根：发现被取代 → 退出后续装配。
    expect(a.isSuperseded()).toBe(true);
    expect(coordinator.isSuperseded(a.seq)).toBe(true);
    expect(b.isSuperseded()).toBe(false);
  });

  it("treats any other queued command as a barrier (open A → prompt → open B)", () => {
    const coordinator = new SessionOpenCoordinator();
    const a = coordinator.register({ pathKey: "c:/s/a.jsonl", sessionId: "a" });
    coordinator.barrier(); // prompt 到达消息入口
    const b = coordinator.register({ pathKey: "c:/s/b.jsonl", sessionId: "b" });
    // A 必须先完成并向 A 发送；B 不能越过它。
    expect(a.isSuperseded()).toBe(false);
    expect(b.isSuperseded()).toBe(false);
    expect(coordinator.begin(a.seq)).toBe(true);
  });

  it("never supersedes a non-supersedable open, and starts a new batch after it", () => {
    const coordinator = new SessionOpenCoordinator();
    const foreground = coordinator.register({ pathKey: "c:/s/fg.jsonl", sessionId: "fg" });
    // 分屏背景格 / 自动化恢复：必须执行，同时充当屏障。
    const background = coordinator.register({ pathKey: "c:/s/bg.jsonl", sessionId: "bg", supersedable: false });
    const later = coordinator.register({ pathKey: "c:/s/later.jsonl", sessionId: "later" });
    expect(background.isSuperseded()).toBe(false);
    expect(foreground.isSuperseded()).toBe(false); // 屏障之前的打开不跨过屏障合并
    expect(later.isSuperseded()).toBe(false);
  });

  it("protects sessions that are registered split panes", () => {
    const coordinator = new SessionOpenCoordinator();
    // 分屏入口：先发 session.watch（登记保护），再发 session.open。
    coordinator.protectSession("pane");
    const pane = coordinator.register({ pathKey: "c:/s/pane.jsonl", sessionId: "pane" });
    const focused = coordinator.register({ pathKey: "c:/s/focus.jsonl", sessionId: "focus" });
    expect(pane.isSuperseded()).toBe(false);
    expect(focused.isSuperseded()).toBe(false);

    // 关闭格子后不再保护：下一批的前台打开可以正常淘汰它。
    coordinator.unprotectSession("pane");
    const next = coordinator.register({ pathKey: "c:/s/pane.jsonl", sessionId: "pane" });
    const after = coordinator.register({ pathKey: "c:/s/other.jsonl", sessionId: "other" });
    expect(next.isSuperseded()).toBe(true);
    expect(after.isSuperseded()).toBe(false);
  });

  it("protects opens whose identity cannot be resolved (conservative)", () => {
    const coordinator = new SessionOpenCoordinator();
    // 索引水合出来的行可能没有 id、或目标不在 currentSessions 里：无法判断它
    // 是否属于分屏 → 不淘汰。
    const unknown = coordinator.register({ pathKey: "c:/s/unknown.jsonl" });
    const known = coordinator.register({ pathKey: "c:/s/known.jsonl", sessionId: "known" });
    expect(unknown.isSuperseded()).toBe(false);
    expect(known.isSuperseded()).toBe(false);
  });

  it("does not supersede a duplicate open of the same target", () => {
    const coordinator = new SessionOpenCoordinator();
    const first = coordinator.register({ pathKey: "c:/s/a.jsonl", sessionId: "a" });
    const second = coordinator.register({ pathKey: "C:/S/A.jsonl", sessionId: "a" });
    expect(first.isSuperseded()).toBe(false);
    expect(second.isSuperseded()).toBe(false);
  });

  it("releases registrations on finish (no unbounded growth)", () => {
    const coordinator = new SessionOpenCoordinator();
    const a = coordinator.register({ pathKey: "c:/s/a.jsonl", sessionId: "a" });
    const b = coordinator.register({ pathKey: "c:/s/b.jsonl", sessionId: "b" });
    expect(coordinator.pending()).toBe(2);
    coordinator.finish(a.seq);
    coordinator.finish(b.seq);
    expect(coordinator.pending()).toBe(0);
    // 已释放的票根不再是「被取代」（保守：未知即执行）。
    expect(coordinator.isSuperseded(a.seq)).toBe(false);
    expect(coordinator.begin(a.seq)).toBe(true);
  });

  it("does not let a skipped request protect itself from a later batch", () => {
    const coordinator = new SessionOpenCoordinator();
    const a = coordinator.register({ pathKey: "c:/s/a.jsonl", sessionId: "a" });
    const b = coordinator.register({ pathKey: "c:/s/b.jsonl", sessionId: "b" });
    expect(a.isSuperseded()).toBe(true);
    coordinator.barrier();
    // 新批次里 A 的旧登记仍标记为过期（finish 之前不复活）。
    expect(a.isSuperseded()).toBe(true);
    expect(coordinator.begin(b.seq)).toBe(true);
  });
});
