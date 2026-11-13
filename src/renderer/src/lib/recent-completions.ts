import type { SessionSummary } from "../../../shared/protocol";

/**
 * 侧栏顶部「已完成」分区（2026-11-13 用户需求：顶部只列了跨工作区「运行中」，
 * 刚在别的工作区跑完的会话还得切回那个工作区翻分组才找得到）。
 *
 * 数据来源是 main 侧贴好的 `completedAt` / `completedOutcome`（持久化在
 * `<agentDir>/pidesktop-recent-completions.json`，重启仍在、点开不清），因此这里
 * 是纯投影：筛出「回合已结束且带完成记录」的会话，按完成时间取最近 5 个。
 *
 * 三条口径（与用户对齐）：
 * - 成功 / 失败 / 中止都算「已完成」——它就是「运行中」的另一半；结局只影响
 *   状态点颜色（渲染端按 `completedOutcome` 取绿/红/灰），不影响入选。
 * - 全局跨工作区，不分工作区各留 5 个。
 * - **已在眼前的会话（激活会话、分屏格子里的）不显示**：分区只负责「找回来」，
 *   不重复占一行。切走之后它会自动回到列表（如果还在前 5 内）。
 *
 * 过滤顺序：先按搜索词筛再取前 N，这样搜索能命中「本来排第 6 的」那一条；
 * 搜索命中口径与 `collectRunningSessions` / `groupSessionsByWorkspace` 一致
 * （标题 / 工作区 / 调用方解析好的助手名）。
 */

/** 分区里最多显示几条（用户口径：最近 5 个）。 */
export const RECENT_COMPLETED_LIMIT = 5;

export interface RecentCompletedOptions {
  /** 侧栏搜索词（空/空白 = 不过滤）。 */
  query?: string;
  /** 助手 id → 显示名（搜索命中口径）。 */
  agentNames?: Record<string, string>;
  /** 已在眼前、不该重复占位的会话 id（激活会话 + 分屏格子）。 */
  excludeSessionIds?: ReadonlySet<string>;
  /** 测试用；缺省 {@link RECENT_COMPLETED_LIMIT}。 */
  limit?: number;
}

export function collectRecentCompletedSessions(
  sessions: readonly SessionSummary[],
  options: RecentCompletedOptions = {}
): SessionSummary[] {
  const search = (options.query ?? "").trim().toLowerCase();
  const exclude = options.excludeSessionIds;
  const limit = options.limit ?? RECENT_COMPLETED_LIMIT;
  return sessions
    .filter((session) => typeof session.completedAt === "number" && Number.isFinite(session.completedAt))
    // 上一轮完成、这一轮又在跑：它属于「运行中」分区，别两处都出现。
    .filter((session) => session.runStatus !== "running")
    .filter((session) => !exclude?.has(session.id))
    .filter((session) => !search
      || `${session.title} ${session.workspace} ${options.agentNames?.[session.agentId] ?? ""}`.toLowerCase().includes(search))
    .slice()
    .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
    .slice(0, limit);
}
