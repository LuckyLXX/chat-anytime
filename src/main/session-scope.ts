import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { SessionSummary, ThinkingLevel } from "../shared/protocol.js";

export function workspaceHash(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 20);
}

export function agentWorkspaceSessionDir(agentRoot: string, agentId: string, workspace: string): string {
  return join(agentRoot, "chatanytime-sessions", agentId, workspaceHash(workspace));
}

export function resolveNewSessionDefaults<TModel>(hasExistingMessages: boolean, agentModel: TModel | undefined, globalModel: TModel | undefined, agentThinking: ThinkingLevel, globalThinking: ThinkingLevel): { model: TModel | undefined; thinkingLevel: ThinkingLevel | undefined } {
  if (hasExistingMessages) return { model: undefined, thinkingLevel: undefined };
  return { model: agentModel ?? globalModel, thinkingLevel: agentThinking ?? globalThinking };
}

/**
 * 会话列表“已就绪”不只是非空：还必须是按当前 Agent 的目录作用域拉取的。
 * 切换 Agent 后旧列表虽非空，但作用域已变，createSession 必须重拉——
 * 否则话题页会继续显示上一个角色的会话。
 */
export function sessionListReadyFor(listCount: number, listAgentId: string | undefined, agentId: string | undefined): boolean {
  return listCount > 0 && listAgentId === agentId;
}

/**
 * 把一条会话摘要合并进侧边栏列表（内存级 upsert，不触磁盘扫描）。
 * 语义与 refreshSessions 的去重/排序完全一致：按绝对路径去重、按 modifiedAt
 * 降序。已存在的条目保持不变（精确信息由 refreshSessions 校正），仅真正新增
 * 的会话（新建话题、删除当前会话后自动补的空白会话）被插入——保证新会话
 * 创建后左侧第一时间可见，发送消息时 runStatus "running" 也能通过
 * patchSessionRunStatus 即时打上「执行中」圆点，不再依赖全量磁盘扫描的耗时返回。
 */
export function mergeSessionSummary(list: SessionSummary[], incoming: SessionSummary): SessionSummary[] {
  const key = (item: SessionSummary) => resolve(item.path).toLowerCase();
  const keyOfIncoming = key(incoming);
  return [...list.filter((item) => key(item) !== keyOfIncoming), incoming].sort((left, right) => right.modifiedAt - left.modifiedAt);
}

/** 回填用的活跃会话最小投影（来自 liveSessions 记录，见 backfillUnpersistedSessions）。 */
export interface LiveSessionSeed {
  sessionId: string;
  path: string | undefined;
  workspace: string;
  agentId: string;
  activatedAt: number;
  title?: string;
  runStatus?: SessionSummary["runStatus"];
}

/**
 * 全量磁盘重建后的回填：会话文件直到首条 assistant 消息才落盘（Pi
 * SessionManager._persist 的 hasAssistant 门槛），新建的空会话只存在于
 * liveSessions。refreshSessions 若不回填，任何迟到的全量刷新（后台/停靠
 * 会话回合结束后的 500ms 防抖、pin/rename/delete 后的显式刷新）都会把刚建
 * 的新话题从侧边栏抹掉，直到用户发出第一条消息。已在磁盘列表中的会话不动；
 * 回填优先沿用重建前列表里的同名条目（保留重命名/置顶/圆点），否则按 seed
 * 合成；runStatus 以 live 记录为准覆盖。无回填时原样返回入参引用。
 */
export function backfillUnpersistedSessions(
  list: SessionSummary[],
  previous: readonly SessionSummary[],
  live: readonly LiveSessionSeed[],
  listAgentId: string | undefined
): SessionSummary[] {
  if (live.length === 0) return list;
  const key = (path: string) => resolve(path).toLowerCase();
  const listedKeys = new Set(list.map((item) => key(item.path)));
  const previousByKey = new Map(previous.map((item) => [key(item.path), item]));
  let next = list;
  for (const seed of live) {
    if (!seed.path || seed.agentId !== listAgentId) continue;
    const seedKey = key(seed.path);
    if (listedKeys.has(seedKey)) continue;
    listedKeys.add(seedKey);
    const prior = previousByKey.get(seedKey);
    const synthetic: SessionSummary = {
      id: seed.sessionId,
      path: seed.path,
      workspace: seed.workspace,
      title: seed.title ?? "新会话",
      modifiedAt: seed.activatedAt,
      messageCount: 0
    };
    const base = prior ?? synthetic;
    next = mergeSessionSummary(next, seed.runStatus ? { ...base, runStatus: seed.runStatus } : base);
  }
  return next;
}
