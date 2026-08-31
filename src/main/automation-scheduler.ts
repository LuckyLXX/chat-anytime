import type { AutomationTask } from "../shared/protocol.js";
import { cronMatches } from "./automation-cron.js";

/**
 * 自动化定时任务调度器（utility 进程内，零 Electron 依赖）。
 *
 * 每 60s tick 一次：读取「当前 Agent 的任务」（getTasks 回调实时读，Agent 切换
 * 自然跟随），命中 cron 且本分钟未触发过的启用任务进入一个串行队列，一次只跑一个
 * （避免与活跃会话/全局状态竞态）。runTask 的具体执行交给 pi-runtime 的回调。
 * 不精算「下一次触发时间」，靠「匹配 + 本分钟防重」实现，定时任务语义足够。
 */

export interface AutomationSchedulerDeps {
  /** 实时读取当前 Agent 的任务列表（每次 tick 调用，支持 Agent 切换跟随）。 */
  getTasks: () => AutomationTask[];
  /** 执行一个任务（pi-runtime 提供：后台建会话 + 跑提示词）。 */
  runTask: (task: AutomationTask) => Promise<void>;
  /** 调度层异常兜底（记录日志）。 */
  onError?: (message: string) => void;
}

export interface AutomationScheduler {
  start(): void;
  stop(): void;
  /** 立即执行一次匹配扫描（测试或手动触发用）。 */
  tick(now?: Date): void;
  /** 任务增删改后清防重键，允许下一次匹配分钟重新触发。 */
  refresh(): void;
  /** 队列是否仍在排空（防止重入）。 */
  draining(): boolean;
}

const TICK_MS = 60_000;

function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

export function createAutomationScheduler(deps: AutomationSchedulerDeps): AutomationScheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  const lastFiredMinute = new Map<string, string>();
  const queue: AutomationTask[] = [];
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const task = queue.shift()!;
        try {
          await deps.runTask(task);
        } catch (error) {
          deps.onError?.(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      draining = false;
    }
  }

  function tick(now: Date = new Date()): void {
    const key = minuteKey(now);
    for (const task of deps.getTasks()) {
      if (!task.enabled) continue;
      if (lastFiredMinute.get(task.id) === key) continue;
      // 同任务已在队列中等待/执行：避免高频 cron（如 `* * * * *`）单次运行跨分钟
      // 时被每分钟重复入队，造成队列无限积压（reviewer P1-3）。
      if (queue.some((candidate) => candidate.id === task.id)) continue;
      let hit = false;
      try {
        hit = cronMatches(task.schedule.cron, now, task.schedule.timezone);
      } catch {
        // 非法 cron 不应进入 store，但防御性跳过不炸 tick。
        continue;
      }
      if (!hit) continue;
      lastFiredMinute.set(task.id, key);
      queue.push(task);
    }
    if (queue.length > 0) void drain();
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      try {
        tick();
      } catch (error) {
        deps.onError?.(error instanceof Error ? error.message : String(error));
      }
    }, TICK_MS);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    start,
    stop,
    tick,
    refresh: () => lastFiredMinute.clear(),
    draining: () => draining
  };
}
