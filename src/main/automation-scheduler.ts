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
  /**
   * 本轮命中 cron 但**没有执行**时回调（原因写进运行记录的 skipped 条目）。
   *
   * 为什么需要：用户发现「今天的日报没跑」，打开运行记录却是一片空白，无法区分
   * 「当时应用没开」「任务被暂停」「上一轮还没结束」。调度器保持零存储依赖——
   * 「是否已经有对应记录、要不要落盘」由消费者（pi-runtime）决定。
   */
  onSkip?: (task: AutomationTask, reason: string, at: number) => void;
  /**
   * 启动时扫描「今日已错过的时间点」所需的运行记录判据：给定 taskId 与时间点，
   * 返回该时间点之后是否已有一条运行记录。缺省视为「没有」。
   *
   * 做成注入而非直接读 store：调度器是纯模块（零 Electron/零 fs 依赖），
   * 而且「什么算跑过」的判据属于持久化层。
   */
  hasRunSince?: (taskId: string, since: number) => boolean;
}

export interface AutomationScheduler {
  start(): void;
  stop(): void;
  /** 立即执行一次匹配扫描（测试或手动触发用）。 */
  tick(now?: Date): void;
  /** 任务增删改后清防重键，允许下一次匹配分钟重新触发。 */
  refresh(): void;
  /**
   * 启动时扫描：今日已过去的 cron 命中分钟里，最后一次命中至今没有对应运行记录的
   * 启用任务 → 回调 onSkip（原因「应用启动时发现今日已错过该时间点」）。
   * 只报**最后一次**命中，避免逐分钟刷屏；同一任务最多一条。
   */
  reportMissed(now?: Date): void;
  /** 队列是否仍在排空（防止重入）。 */
  draining(): boolean;
}

const TICK_MS = 60_000;
/** 报告「错过」的缓冲：距上一个命中分钟不足这段时间时不报（正常触发可能正在进行）。 */
export const MISSED_GRACE_MS = 2 * 60_000;

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
      if (queue.some((candidate) => candidate.id === task.id)) {
        // 已 skip 也算本分钟处理过，避免同一分钟反复回调（与入队路径同一口径）。
        deps.onSkip?.(task, "上一轮尚未结束，本轮已跳过（串行队列避免并发）", now.getTime());
        lastFiredMinute.set(task.id, key);
        continue;
      }
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

  /**
   * 今日已过去的分钟里最后一个 cron 命中时刻（本地时刻逐分钟比对，与 tick 口径
   * 一致；≤1440 次 cronMatches，成本可忽略）。无命中返回 undefined。
   */
  function lastMatchToday(task: AutomationTask, now: Date): number | undefined {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let last: number | undefined;
    for (let minute = 0; ; minute++) {
      const moment = new Date(startOfDay.getTime() + minute * 60_000);
      if (moment.getTime() > now.getTime()) break;
      let hit = false;
      try {
        hit = cronMatches(task.schedule.cron, moment, task.schedule.timezone);
      } catch {
        return undefined;
      }
      if (hit) last = moment.getTime();
    }
    return last;
  }

  function reportMissed(now: Date = new Date()): void {
    // 只在启动时调用：每分钟扫描是没必要的开销，且「错过」一旦报告过就不会再变。
    for (const task of deps.getTasks()) {
      if (!task.enabled) continue;
      const lastMatch = lastMatchToday(task, now);
      if (lastMatch === undefined) continue;
      // 给正常触发留缓冲：距上一个命中分钟不足 MISSED_GRACE_MS 时不报
      // （那一分钟可能正在触发，或者本轮 tick 还没跑到）。
      if (now.getTime() - lastMatch < MISSED_GRACE_MS) continue;
      if (deps.hasRunSince?.(task.id, lastMatch)) continue;
      deps.onSkip?.(task, "应用未在计划时间运行（今日已错过该时间点）", lastMatch);
    }
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
    reportMissed,
    refresh: () => lastFiredMinute.clear(),
    draining: () => draining
  };
}
