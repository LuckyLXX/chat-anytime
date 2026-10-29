import type { SessionSummary } from "../../../shared/protocol";

/**
 * 侧栏顶部「运行中」分区（2026-10-29 用户需求：不同工作区同时有会话在执行时不好切换）。
 *
 * 话题列表按**工作区**分组、且分组默认折叠，于是「B 工作区那个会话还在跑」这件事
 * 只能靠在几百条列表里翻分组才能找到——用户的实际动作是「切过去看一眼/发下一句」。
 * 这里把 `runStatus === "running"` 的会话跨工作区收成一条扁平清单，由侧栏放在所有
 * 分组之上（同一会话在所属分组里照旧保留，两处点的是同一条记录，视觉上一个叫
 * 「运行中」、一个是它自己的位置）。
 *
 * 纯投影：不改摘要、不排序 `runStatus`，只做筛选与排序，便于单测。
 * 过滤范围交给调用方（侧栏传 `sessionsForView(sessions, "active")`，归档视图不显示
 * 这个分区）；搜索命中口径与 `groupSessionsByWorkspace` 保持一致（标题 / 工作区 /
 * 调用方解析好的助手名），这样搜索框里也能把跑着的会话筛出来。
 *
 * 排序：最近活动在前（`modifiedAt` 在同一轮里会随流式消息刷新，于是「刚动过」的
 * 那个排第一）；不套用 `pinned`，这个分区是「此刻在跑的东西」，用户画的置顶与
 * 运行时无关。
 */
export function collectRunningSessions(
  sessions: readonly SessionSummary[],
  query = "",
  agentNames?: Record<string, string>
): SessionSummary[] {
  const search = query.trim().toLowerCase();
  return sessions
    .filter((session) => session.runStatus === "running")
    .filter((session) => !search
      || `${session.title} ${session.workspace} ${agentNames?.[session.agentId] ?? ""}`.toLowerCase().includes(search))
    .slice()
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

/** 该工作区分组里是否有会话正在执行（分组标题上的运行点）。 */
export function hasRunningSession(sessions: readonly SessionSummary[]): boolean {
  return sessions.some((session) => session.runStatus === "running");
}
