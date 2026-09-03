import type { RecentWorkspace, SessionSummary } from "../../../shared/protocol";

export interface SessionWorkspaceGroup {
  key: string;
  workspace: string;
  sessions: SessionSummary[];
  /** When the workspace was last opened, when known (drives group ordering). */
  openedAt?: number;
}

export function workspaceKey(workspace: string): string {
  return workspace.trim().replaceAll("\\", "/").toLowerCase();
}

/**
 * Group sessions by workspace, then merge in the ACTIVE workspace when it
 * has no sessions yet (a freshly opened project) so the sidebar reflects it
 * immediately. Recent-workspace history is global across assistants while
 * the session list is agent-scoped, so other session-less workspaces are NOT
 * shown — a brand-new assistant starts with an empty topic list. Groups rank
 * by their latest activity: the most recent session touch, or the last time
 * the workspace was opened for empty groups.
 */
export function groupSessionsByWorkspace(sessions: readonly SessionSummary[], query = "", recentWorkspaces: readonly RecentWorkspace[] = [], activeWorkspace?: string): SessionWorkspaceGroup[] {
  const search = query.trim().toLowerCase();
  const recentByKey = new Map(recentWorkspaces.map((item) => [workspaceKey(item.path), item]));
  const groups = new Map<string, SessionWorkspaceGroup>();

  for (const session of sessions) {
    const workspace = session.workspace.trim() || "未知工作区";
    const haystack = `${session.title} ${workspace}`.toLowerCase();
    if (search && !haystack.includes(search)) continue;
    const key = workspaceKey(workspace);
    const group = groups.get(key) ?? { key, workspace, sessions: [], openedAt: recentByKey.get(key)?.openedAt };
    group.sessions.push(session);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sessions.sort((left, right) => (Number(right.pinned ?? false) - Number(left.pinned ?? false)) || right.modifiedAt - left.modifiedAt);
  }

  // The ACTIVE workspace without any session (e.g. a just-opened empty
  // project) still gets a sidebar group so the directory shows up immediately
  // instead of waiting for the first topic to be created. Other session-less
  // recent workspaces stay hidden: that history is shared across assistants,
  // and showing it to an assistant that never used them would surface a pile
  // of empty groups (the fresh-assistant bug).
  const activeKey = activeWorkspace?.trim() ? workspaceKey(activeWorkspace) : undefined;
  for (const recent of recentWorkspaces) {
    const key = workspaceKey(recent.path);
    if (groups.has(key)) continue;
    if (activeKey !== key) continue;
    if (search && !recent.path.toLowerCase().includes(search)) continue;
    groups.set(key, { key, workspace: recent.path, sessions: [], openedAt: recent.openedAt });
  }

  return [...groups.values()].sort((left, right) =>
    Math.max(right.sessions[0]?.modifiedAt ?? 0, right.openedAt ?? 0) - Math.max(left.sessions[0]?.modifiedAt ?? 0, left.openedAt ?? 0)
  );
}
