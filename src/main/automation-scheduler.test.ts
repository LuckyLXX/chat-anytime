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
