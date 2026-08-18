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
 * Group sessions by workspace, then merge in recently opened workspaces that
 * have no sessions yet (freshly created projects) so the sidebar reflects them
 * immediately. Groups rank by their latest activity: the most recent session
 * touch, or the last time the workspace was opened for empty groups.
 */
export function groupSessionsByWorkspace(sessions: readonly SessionSummary[], query = "", recentWorkspaces: readonly RecentWorkspace[] = []): SessionWorkspaceGroup[] {
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

  // Workspaces without any session (e.g. a just-created empty project) still
  // get a sidebar group so the directory shows up immediately instead of
  // waiting for the first topic to be created.
  for (const recent of recentWorkspaces) {
    const key = workspaceKey(recent.path);
    if (groups.has(key)) continue;
    if (search && !recent.path.toLowerCase().includes(search)) continue;
    groups.set(key, { key, workspace: recent.path, sessions: [], openedAt: recent.openedAt });
  }

  return [...groups.values()].sort((left, right) =>
    Math.max(right.sessions[0]?.modifiedAt ?? 0, right.openedAt ?? 0) - Math.max(left.sessions[0]?.modifiedAt ?? 0, left.openedAt ?? 0)
  );
}
