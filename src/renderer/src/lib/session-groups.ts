import type { SessionSummary } from "../../../shared/protocol";

export interface SessionWorkspaceGroup {
  key: string;
  workspace: string;
  sessions: SessionSummary[];
}

function workspaceKey(workspace: string): string {
  return workspace.trim().replaceAll("\\", "/").toLowerCase();
}

export function groupSessionsByWorkspace(sessions: readonly SessionSummary[], query = ""): SessionWorkspaceGroup[] {
  const search = query.trim().toLowerCase();
  const groups = new Map<string, SessionWorkspaceGroup>();

  for (const session of sessions) {
    const workspace = session.workspace.trim() || "未知工作区";
    const haystack = `${session.title} ${workspace}`.toLowerCase();
    if (search && !haystack.includes(search)) continue;
    const key = workspaceKey(workspace);
    const group = groups.get(key) ?? { key, workspace, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sessions.sort((left, right) => (Number(right.pinned ?? false) - Number(left.pinned ?? false)) || right.modifiedAt - left.modifiedAt);
  }

  return [...groups.values()].sort((left, right) => (right.sessions[0]?.modifiedAt ?? 0) - (left.sessions[0]?.modifiedAt ?? 0));
}
