import type { DesktopSettings } from "../../../shared/protocol";

/**
 * 新建话题的目标助手。
 *
 * 沿用当前激活会话的助手；它已归档时不能作为目标（主进程 `session.new` 会拒绝
 * 归档助手），回落到第一个未归档助手，再回落到 `settings.currentAgentId`。
 *
 * 为什么是纯函数：合成器左下角的 `+`（`createNewSession`）与作品「继续开发」
 * 跨工作区时新建话题走同一条判定。两处各写一份的话，归档助手的守卫迟早漂移
 * ——一处修好另一处仍会拿归档助手去建会话，然后静默失败。
 */
export function pickTopicAgentId(
  settings: Pick<DesktopSettings, "agents" | "currentAgentId">,
  activeAgentId?: string
): string | undefined {
  const active = settings.agents.find((agent) => agent.id === activeAgentId);
  if (active && !active.archived) return active.id;
  return settings.agents.find((agent) => !agent.archived)?.id ?? settings.currentAgentId;
}
