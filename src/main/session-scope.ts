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
