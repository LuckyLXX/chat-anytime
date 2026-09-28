import type { SessionSummary } from "../../../shared/protocol";

/**
 * 话题侧栏的两个视图：全部（未归档）与已归档。
 *
 * 归档是**软归档**：会话文件与 sidecar 都留在原处，只是默认不进话题列表；
 * 判定字段由主进程每轮 `refreshSessions` 从 `settings.archivedSessionPaths`
 * 计算（见 `src/main/session-scope.ts` 的 `isSessionArchived`）。这里只做
 * 渲染端的纯投影与选择集运算，便于单测。
 */
export type SessionView = "active" | "archived";

/** 当前视图下的会话（`archived` 缺省视为未归档）。 */
export function sessionsForView(sessions: readonly SessionSummary[], view: SessionView): SessionSummary[] {
  return sessions.filter((session) => (view === "archived" ? session.archived === true : session.archived !== true));
}

export function archivedSessionCount(sessions: readonly SessionSummary[]): number {
  let count = 0;
  for (const session of sessions) if (session.archived) count += 1;
  return count;
}

/**
 * 多选集合以会话**路径**为键（与主进程命令的入参口径一致：archivedSessionPaths /
 * session.archive 都用路径），不用 id——归档集合本身就是路径集合，两端口径统一。
 */
export type SessionSelection = Record<string, true>;

export function toggleSessionSelection(selected: SessionSelection, path: string): SessionSelection {
  if (!selected[path]) return { ...selected, [path]: true };
  const next = { ...selected };
  delete next[path];
  return next;
}

export function selectSessionPaths(paths: readonly string[]): SessionSelection {
  const next: SessionSelection = {};
  for (const path of paths) next[path] = true;
  return next;
}

/**
 * 选中项里「当前视图内仍然存在」的路径。
 *
 * 选择集是按路径记的，而列表每轮刷新都是新数据：选中项可能被别的入口删掉、
 * 或跑到另一个视图（取消归档后它离开归档屏）。操作前一律以此函数收口，
 * 避免把陈旧路径发进删除 / 归档命令。
 */
export function selectedPathsInView(selected: SessionSelection, sessions: readonly SessionSummary[], view: SessionView): string[] {
  return sessionsForView(sessions, view)
    .filter((session) => selected[session.path] === true)
    .map((session) => session.path);
}
