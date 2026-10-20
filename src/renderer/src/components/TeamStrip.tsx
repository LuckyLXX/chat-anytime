import { CircleStop, PanelRight, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { TeamSnapshot } from "../../../shared/protocol";

/**
 * 输入框上方的团队状态条（最小 UI）：成员名 + 状态点 + 「全部停止」。
 * 只在有队友时出现；不提供 roster 管理/任务板（MVP 的非目标）。
 * 放在 composer 的独立 grid 行里，与计划横幅/排队列表共存时由 CSS 依次占位。
 */
export function TeamStrip({ snapshot, onStopAll, onOpenBoard }: { snapshot?: TeamSnapshot; onStopAll(): void; onOpenBoard(): void }): ReactNode {
  if (!snapshot || snapshot.members.length === 0) return null;
  return (
    <div className="composer-team-strip" data-composer-zone="team" role="status" aria-label="团队成员状态">
      <span className="composer-team-title">
        <Users size={12} />
        团队 {snapshot.members.length} 人{snapshot.running > 0 ? ` · ${snapshot.running} 运行中` : ""}
      </span>
      <span className="composer-team-members">
        {snapshot.members.map((member) => {
          const detail = [member.description, member.subagent ? `子智能体：${member.subagent}` : "", member.error ?? ""]
            .filter(Boolean)
            .join("\n");
          return (
            <span className={`composer-team-member ${member.status}`} key={member.name} title={detail || member.name}>
              <i aria-hidden="true" />
              {member.name}
            </span>
          );
        })}
      </span>
      <button
        className="composer-team-open"
        data-control="team-open-board"
        type="button"
        title="打开团队看板：成员实时执行、任务板与完整记录"
        aria-label="打开团队看板"
        onClick={onOpenBoard}
      >
        <PanelRight size={11} />
        看板
      </button>
      <button
        className="composer-team-stop"
        data-control="team-stop-all"
        type="button"
        disabled={snapshot.running === 0}
        title={snapshot.running === 0 ? "没有正在运行的成员" : "停止所有成员的当前回合（保留排队消息与任务归属）"}
        aria-label="停止所有团队成员"
        onClick={onStopAll}
      >
        <CircleStop size={11} />
        全部停止
      </button>
    </div>
  );
}
