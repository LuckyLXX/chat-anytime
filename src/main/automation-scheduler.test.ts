import { describe, expect, it } from "vitest";
import { createAutomationScheduler } from "./automation-scheduler.js";
import type { AutomationTask } from "../shared/protocol.js";

function makeTask(id: string, cron: string, enabled = true): AutomationTask {
  return {
    id,
    name: `任务 ${id}`,
    schedule: { cron },
    prompt: "跑一次",
    agentId: "default",
    accessMode: "full",
    enabled,
    createdAt: 0
  };
}

// 2026-09-15 09:30 本地时刻，`30 9 * * *` 恒命中。
const MATCH_DATE = new Date(2026, 8, 15, 9, 30);

describe("automation scheduler", () => {
  it("fires runTask for an enabled matching task once", () => {
    const calls: string[] = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "30 9 * * *")],
      runTask: async (task) => {
        calls.push(task.id);
      }
    });
    scheduler.tick(MATCH_DATE);
    expect(calls).toEqual(["a"]);
  });

  it("skips disabled tasks and non-matching crons", () => {
    const calls: string[] = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [
        makeTask("off", "30 9 * * *", false),
        makeTask("late", "0 10 * * *")
      ],
      runTask: async (task) => {
        calls.push(task.id);
      }
    });
    scheduler.tick(MATCH_DATE);
    expect(calls).toEqual([]);
  });

  it("does not fire twice within the same minute", () => {
    const calls: string[] = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "30 9 * * *")],
      runTask: async (task) => {
        calls.push(task.id);
      }
    });
    scheduler.tick(MATCH_DATE);
    scheduler.tick(MATCH_DATE);
    expect(calls).toEqual(["a"]);
  });

  it("processes multiple matching tasks serially (queue order preserved)", async () => {
    const order: string[] = [];
    const gate: Array<() => void> = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "30 9 * * *"), makeTask("b", "30 9 * * *")],
      runTask: (task) =>
        new Promise<void>((resolve) => {
          order.push(`start:${task.id}`);
          gate.push(resolve);
        })
    });
    scheduler.tick(MATCH_DATE);
    // a 先入队并开始；b 也在本分钟命中，追加到队列。
    expect(order).toEqual(["start:a"]);
    expect(scheduler.draining()).toBe(true);
    // 放行 a → drain 继续到 b。
    gate.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start:a", "start:b"]);
    gate.shift()!();
    await Promise.resolve();
    expect(scheduler.draining()).toBe(false);
  });

  it("does not re-enqueue a task that is already queued across minutes", async () => {
    const calls: string[] = [];
    const gates: Array<() => void> = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "30 9 * * *")],
      runTask: (task) => new Promise<void>((resolve) => { calls.push(task.id); gates.push(resolve); })
    });
    scheduler.tick(new Date(2026, 8, 15, 9, 30));
    expect(calls).toEqual(["a"]);
    // 下一分钟（minuteKey 不同）任务仍在其队列/执行中：不应重复入队（防 `* * * * *` 跨分钟积压）。
    scheduler.tick(new Date(2026, 8, 15, 9, 31));
    expect(calls).toEqual(["a"]);
    gates.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["a"]);
  });

  it("refresh clears the minute guard allowing a later minute to refire", async () => {
    let calls = 0;
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "30 9 * * *")],
      runTask: async () => {
        calls += 1;
      }
    });
    scheduler.tick(MATCH_DATE);
    scheduler.tick(MATCH_DATE);
    expect(calls).toBe(1);
    scheduler.refresh();
    scheduler.tick(MATCH_DATE);
    // 让上一个 drain 微任务恢复并取出队列里新入队的任务。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });
});

/**
 * skipped 回调（2026-09-13 C1）：调度器保持零存储依赖，只把「本轮本该运行但没运行」
 * 的事实与原因回调出去，落盘/去重交给消费者。
 */
describe("automation scheduler skip reporting", () => {
  /**
   * 队列去重的时序（实测，容易想错）：`drain()` 会把任务**移出队列**再 await
   * runTask，所以一次「卡住的运行」在下一分钟会先被重新入队一次（这是有意的
   * cron 语义——又到期了，等队列空下来就跑），**再下一分钟**才发现队列里已有
   * 同名任务并跳过。所以跳过从第二个重触发分钟开始出现。
   */
  it("reports a skip once a re-triggered task is still waiting in the queue", () => {
    const skips: Array<{ id: string; reason: string }> = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "* * * * *")],
      runTask: () => new Promise<void>(() => {}),
      onSkip: (task, reason) => skips.push({ id: task.id, reason })
    });
    const minute = (offset: number) => new Date(MATCH_DATE.getTime() + offset * 60_000);
    scheduler.tick(minute(0)); // 入队 + 开始执行（卡住不返回）
    scheduler.tick(minute(1)); // 又到期 → 重新入队（队列里已有等待实例）
    expect(skips).toEqual([]);
    scheduler.tick(minute(2)); // 队列里仍有等待实例 → 跳过
    expect(skips).toHaveLength(1);
    expect(skips[0]!.id).toBe("a");
    expect(skips[0]!.reason).toContain("上一轮尚未结束");
  });

  it("reports at most one queue skip per minute even when ticked repeatedly", () => {
    const skips: string[] = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "* * * * *")],
      runTask: () => new Promise<void>(() => {}),
      onSkip: (task) => skips.push(task.id)
    });
    // 每分钟 tick 两次：跳过分支一旦命中即写 lastFiredMinute，同分钟不再重复回调。
    for (let offset = 0; offset <= 4; offset++) {
      const at = new Date(MATCH_DATE.getTime() + offset * 60_000);
      scheduler.tick(at);
      scheduler.tick(at);
    }
    // offset 0/1 是入队路径，offset 2/3/4 每分钟一条跳过。
    expect(skips).toEqual(["a", "a", "a"]);
  });

  it("never reports a skip on the normal firing path", () => {
    const skips: string[] = [];
    const runs: string[] = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "30 9 * * *")],
      runTask: async (task) => { runs.push(task.id); },
      onSkip: (task) => skips.push(task.id)
    });
    scheduler.tick(MATCH_DATE);
    expect(runs).toEqual(["a"]);
    expect(skips).toEqual([]);
  });

  it("reports today's missed slot at startup when nothing ran", () => {
    const skips: Array<{ id: string; reason: string; at: number }> = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "0 9 * * *")],
      runTask: async () => {},
      onSkip: (task, reason, at) => skips.push({ id: task.id, reason, at }),
      hasRunSince: () => false
    });
    // 09:00 已过、now=10:00，且没有任何运行记录 → 报一次「今日已错过」。
    scheduler.reportMissed(new Date(2026, 8, 15, 10, 0));
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toContain("今日已错过");
    expect(new Date(skips[0]!.at).getHours()).toBe(9);
  });

  it("stays silent when a run already happened at that slot", () => {
    const skips: string[] = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "0 9 * * *")],
      runTask: async () => {},
      onSkip: (task) => skips.push(task.id),
      hasRunSince: () => true
    });
    scheduler.reportMissed(new Date(2026, 8, 15, 10, 0));
    expect(skips).toEqual([]);
  });

  it("does not report a slot that just passed (grace window)", () => {
    const skips: string[] = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [makeTask("a", "0 * * * *")],
      runTask: async () => {},
      onSkip: (task) => skips.push(task.id),
      hasRunSince: () => false
    });
    // 10:00:30 时「10:00 命中」刚过去 30 秒：正常触发可能正在进行，不该报错过。
    scheduler.reportMissed(new Date(2026, 8, 15, 10, 0, 30));
    expect(skips).toEqual([]);
  });

  it("ignores disabled tasks and honors the task timezone", () => {
    const skips: string[] = [];
    const scheduler = createAutomationScheduler({
      getTasks: () => [
        makeTask("off", "0 9 * * *", false),
        { ...makeTask("tz", "0 9 * * *"), schedule: { cron: "0 9 * * *", timezone: "Asia/Tokyo" } }
      ],
      runTask: async () => {},
      onSkip: (task) => skips.push(task.id),
      hasRunSince: () => false
    });
    scheduler.reportMissed(new Date(2026, 8, 15, 23, 0));
    expect(skips).toEqual(["tz"]);
  });
});
