import type { RecentWorkspace, SessionSummary } from "../../../shared/protocol";

export interface SessionWorkspaceGroup {
  key: string;
  workspace: string;
  sessions: SessionSummary[];
  /** When the workspace was last opened, when known (drives group ordering). */
  openedAt?: number;
  /** 目录不存在/不是目录（由 RecentWorkspace.missing 透传；有会话的组也可由摘要补充）。 */
  missing?: boolean;
}

export function workspaceKey(workspace: string): string {
  return workspace.trim().replaceAll("\\", "/").toLowerCase();
}

function splitWorkspacePath(path: string): string[] {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "").split("/").filter(Boolean);
}

/**
 * 侧栏工作区分组标题：默认显示目录名（basename）；多个工作区同名时逐级
 * 追加上级目录，直到能唯一区分（例如两个 `src` → `A/src` / `B/src`）。
 * 全路径本身重复或已无更多上级时返回完整路径。
 */
export function workspaceDisplayLabel(path: string, allPaths: readonly string[] = []): string {
  const segments = splitWorkspacePath(path);
  if (segments.length === 0) return path;
  const basename = segments.at(-1)!;
  const normalizedAll = [...new Map(allPaths
    .map((item) => splitWorkspacePath(item))
    .filter((parts) => parts.length > 0)
    .map((parts) => [parts.join("/").toLowerCase(), parts] as const)).values()];
  const sameBasename = normalizedAll.filter((parts) => parts.at(-1)?.toLowerCase() === basename.toLowerCase());
  if (sameBasename.length <= 1) return basename;
  const separator = path.includes("\\") ? "\\" : "/";
  for (let depth = 1; depth < segments.length; depth += 1) {
    const candidate = segments.slice(-(depth + 1));
    const matches = sameBasename.filter((parts) => parts.slice(-(depth + 1)).join("/").toLowerCase() === candidate.join("/").toLowerCase());
    if (matches.length <= 1) return candidate.join(separator);
  }
  return segments.join(separator);
}

/**
 * Group sessions by workspace and merge in every recent workspace that has no
 * session yet. `recentWorkspaces` is now a global workspace list (not an
 * assistant-scoped history), so empty projects are part of the sidebar; the
 * active workspace is still added as a fallback when it has not made it into
 * recents yet (startup/default-directory case).
 *
 * 搜索命中范围：话题标题、工作区路径、以及调用方解析好的助手名（避免把
 * agentName 塞进每轮 IPC 的 SessionSummary）。
 */
export function groupSessionsByWorkspace(
  sessions: readonly SessionSummary[],
  query = "",
  recentWorkspaces: readonly RecentWorkspace[] = [],
  activeWorkspace?: string,
  agentNames?: Record<string, string>
): SessionWorkspaceGroup[] {
  const search = query.trim().toLowerCase();
  const recentByKey = new Map(recentWorkspaces.map((item) => [workspaceKey(item.path), item]));
  const groups = new Map<string, SessionWorkspaceGroup>();

  // 侧栏工作区清单以 recents 为准（workspace-first）：空工作区与有会话的工作区
  // 一视同仁；"从列表移除"（workspace.forget）只动 recents，因此有会话但已
  // forget 的工作区会从侧栏消失（搜索/顶栏仍可达）——这是非破坏性移除的关键。
  // 首次启动 recents 为空/仅测试数据时退回按会话分组，避免整屏空白。
  const activePath = activeWorkspace?.trim();
  const activeKey = activePath ? workspaceKey(activePath) : undefined;
  for (const recent of recentWorkspaces) {
    const key = workspaceKey(recent.path);
    groups.set(key, { key, workspace: recent.path, sessions: [], openedAt: recent.openedAt, missing: recent.missing });
  }
  if (activeKey && activePath && !groups.has(activeKey)) {
    // 当前工作区即使尚未进入 recents 也应出现（它是用户此刻正在看的目录）。
    groups.set(activeKey, { key: activeKey, workspace: activePath, sessions: [], openedAt: Date.now() });
  }
  const restrictToKnown = groups.size > 0;

  for (const session of sessions) {
    const workspace = session.workspace.trim() || "未知工作区";
    const key = workspaceKey(workspace);
    // 归档视图仍要能找到“已从列表移除”的工作区里的归档会话（否则只能靠搜索）；
    // 活跃视图不因归档会话把整个工作区重新顶回来。
    if (restrictToKnown && !groups.has(key) && session.archived !== true) continue;
    const haystack = `${session.title} ${workspace} ${agentNames?.[session.agentId] ?? ""}`.toLowerCase();
    if (search && !haystack.includes(search)) continue;
    const group = groups.get(key) ?? { key, workspace, sessions: [] };
    if (recentByKey.get(key)?.missing) group.missing = true;
    if (session.workspaceMissing) group.missing = true;
    group.sessions.push(session);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sessions.sort((left, right) => (Number(right.pinned ?? false) - Number(left.pinned ?? false)) || right.modifiedAt - left.modifiedAt);
  }

  // 搜索时隐藏完全无匹配的空工作区（有会话的组已经按 haystack 过滤过）。
  for (const [key, group] of [...groups]) {
    if (!search) continue;
    if (group.sessions.length > 0) continue;
    if (group.workspace.toLowerCase().includes(search)) continue;
    groups.delete(key);
  }

  /**
   * 分组排序取组内**真正的**最新活动，而不是排序后的第一行。
   *
   * 置顶项排第一后 `sessions[0]` 就是那条**旧的**置顶话题 —— 旧实现拿它当分组的
   * 时间戳，于是「置顶一个老话题」会把整个工作区分组往列表下方拖（刷新后该组跳到
   * 后面，别的工作区的新会话跑到它上面）。分组的时间语义应该是「这个工作区最近活动
   * 到什么时候」，置顶只影响组内行序，不该影响组的排名。
   */
  const latestActivity = (group: SessionWorkspaceGroup): number => group.sessions.reduce((latest, session) => Math.max(latest, session.modifiedAt), 0);

  return [...groups.values()].sort((left, right) =>
    Math.max(latestActivity(right), right.openedAt ?? 0) - Math.max(latestActivity(left), left.openedAt ?? 0)
  );
}
