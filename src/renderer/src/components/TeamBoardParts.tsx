import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleStop,
  Clock,
  Coins,
  Cpu,
  FileText,
  Layers,
  LoaderCircle,
  MessageSquare,
  ScrollText,
  Send,
  Terminal
} from "lucide-react";
import type { ReactNode } from "react";
import type { ChatMessage, TeamMemberActivity, TeamMemberActivityStep, TeamMemberSummary, TeamTaskSummary } from "../../../shared/protocol";
import { thinkingLevelLabels, toolLabel } from "../../../shared/locale";
import type { Artifact } from "../lib/content";
import { TranscriptTimeline } from "./DelegationTranscript";

/**
 * 团队看板的共用零件：dock 右侧观察台与 full 编队页共用同一套步骤/任务/成员行/
 * 成员详情。抽出来是为了让全屏页复用发消息、停止、完整记录这些既有能力，而不是
 * 复制一份会漂移的实现。
 */

export function formatTokens(value: number | undefined): string {
  if (value === undefined || value <= 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatDurationMs(value: number | undefined): string {
  if (value === undefined) return "";
  if (value < 1_000) return `${Math.max(0, Math.round(value))}ms`;
  return `${(value / 1_000).toFixed(1)}s`;
}

export function formatElapsed(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return "—";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function statusLabel(status: TeamMemberSummary["status"]): string {
  switch (status) {
    case "running": return "运行中";
    case "inactive": return "空闲";
    case "provisioning": return "创建中";
    case "failed": return "失败";
  }
}

export function taskStatusLabel(task: TeamTaskSummary): string {
  if (task.status === "in_progress") return "进行中";
  if (task.status === "completed") return "已完成";
  return task.ready ? "就绪" : "阻塞";
}

function toolIcon(tool: string | undefined): ReactNode {
  if (!tool) return <MessageSquare size={11} />;
  if (tool === "bash" || tool === "powershell") return <Terminal size={11} />;
  if (tool === "read" || tool === "edit" || tool === "write") return <FileText size={11} />;
  if (tool === "team_task_create" || tool === "team_task_update") return <Layers size={11} />;
  return <Check size={11} />;
}

function stepLabel(step: TeamMemberActivityStep): string {
  return step.detail ? `${toolLabel(step.tool)} ${step.detail}` : toolLabel(step.tool);
}

export function StepsView({ activity, limit }: { activity?: TeamMemberActivity; limit?: number }): ReactNode {
  const steps = activity?.recent ?? [];
  if (steps.length === 0) {
    return <p className="team-board-empty">还没有工具步骤。成员开始执行后，这里会显示实时时间线。</p>;
  }
  const visible = typeof limit === "number" ? steps.slice(-limit) : steps;
  return (
    <div className="team-steps">
      {visible.map((step, index) => (
        <div className={`team-step ${step.status}`} key={`${step.startedAt}-${step.tool}-${index}`}>
          <span className="team-step-icon">
            {step.status === "running"
              ? <LoaderCircle size={11} className="spinning" />
              : step.status === "error"
                ? <AlertTriangle size={11} />
                : step.status === "aborted"
                  ? <CircleStop size={11} />
                  : <Check size={11} />}
          </span>
          <span className="team-step-copy">
            <strong>{toolLabel(step.tool)}</strong>
            {step.detail && <small title={step.detail}>{step.detail}</small>}
          </span>
          <span className="team-step-time">{step.status === "running" ? "now" : formatDurationMs(step.durationMs)}</span>
        </div>
      ))}
    </div>
  );
}

export type TeamTaskFilter = "all" | "in_progress" | "pending" | "completed";

export const TEAM_TASK_FILTERS: Array<{ key: TeamTaskFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "in_progress", label: "进行中" },
  { key: "pending", label: "待处理" },
  { key: "completed", label: "已完成" }
];

export function taskCounts(tasks: TeamTaskSummary[]): Record<TeamTaskFilter, number> {
  return {
    all: tasks.length,
    in_progress: tasks.filter((task) => task.status === "in_progress").length,
    pending: tasks.filter((task) => task.status === "pending").length,
    completed: tasks.filter((task) => task.status === "completed").length
  };
}

export function filterTasks(tasks: TeamTaskSummary[], filter: TeamTaskFilter = "all", query = ""): TeamTaskSummary[] {
  const needle = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filter !== "all" && task.status !== filter) return false;
    if (!needle) return true;
    return `${task.id} ${task.subject} ${task.ownerName ?? ""}`.toLowerCase().includes(needle);
  });
}

export function TasksView({ tasks, full = false, filter = "all", query = "" }: {
  tasks: TeamTaskSummary[];
  full?: boolean;
  filter?: TeamTaskFilter;
  query?: string;
}): ReactNode {
  const visibleTasks = filterTasks(tasks, filter, query);
  if (tasks.length === 0) {
    return <p className="team-board-empty">任务板还是空的。让 Lead 用 team_task_create 拆任务后，这里会显示 owner、依赖和写入范围告警。</p>;
  }
  if (visibleTasks.length === 0) {
    return <p className="team-board-empty">没有匹配的任务。</p>;
  }
  const groups: Array<{ key: TeamTaskSummary["status"]; label: string; rows: TeamTaskSummary[] }> = [
    { key: "in_progress", label: "进行中", rows: visibleTasks.filter((task) => task.status === "in_progress") },
    { key: "pending", label: "待处理", rows: visibleTasks.filter((task) => task.status === "pending") },
    { key: "completed", label: "已完成", rows: visibleTasks.filter((task) => task.status === "completed") }
  ];
  const warnings = [...new Set(visibleTasks.flatMap((task) => task.writeScopeWarnings))];
  return (
    <div className={`team-tasks-view${full ? " full" : ""}`}>
      {warnings.length > 0 && (
        <div className="team-task-warning">
          <AlertTriangle size={11} />
          <span>{warnings.join("；")}</span>
        </div>
      )}
      {groups.map((group) => group.rows.length > 0 && (
        <section className="team-task-group" key={group.key}>
          <div className="team-task-group-title"><i className={`team-status-dot ${group.key}`} />{group.label}<em>{group.rows.length}</em></div>
          {group.rows.map((task) => (
            <article className="team-task-card" data-control="team-task" data-task-id={task.id} key={task.id}>
              <div className="team-task-top">
                <span className="team-task-id">{task.id}</span>
                <strong className="team-task-title" title={task.subject}>{task.subject}</strong>
                <span className={`team-task-status ${task.status === "pending" ? (task.ready ? "ready" : "blocked") : task.status}`}>{taskStatusLabel(task)}</span>
              </div>
              <div className="team-task-meta">
                {task.ownerName && <span className="team-task-owner"><i className={`team-status-dot ${task.ownerName === "lead" ? "lead" : "running"}`} />{task.ownerName}</span>}
                {task.blockedBy.length > 0 && <span>依赖 {task.blockedBy.join(" / ")}</span>}
                {task.status === "pending" && !task.ready && <span className="team-task-blocked">等待依赖</span>}
              </div>
              {task.writeScopeWarnings.map((warning) => <p className="team-task-scope-warning" key={warning}>{warning}</p>)}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

export function MemberRow({ member, selected, now, onSelect }: {
  member: TeamMemberSummary;
  selected: boolean;
  now: number;
  onSelect(name: string): void;
}): ReactNode {
  const activity = member.activity;
  const current = activity?.currentTool
    ? `${toolLabel(activity.currentTool)}${activity.currentDetail ? ` ${activity.currentDetail}` : ""}`
    : member.taskSubject ?? member.description ?? "等待任务";
  return (
    <button
      className={`team-member-row${selected ? " selected" : ""} ${member.status}`}
      type="button"
      data-control="team-member-row"
      data-member={member.name}
      onClick={() => onSelect(member.name)}
      title={member.error ?? current}
    >
      <span className={`team-status-dot ${member.status}`} />
      <span className="team-member-copy">
        <span className="team-member-line">
          <strong>{member.name}</strong>
          <span className={`team-status-badge ${member.status}`}>{statusLabel(member.status)}</span>
          <span className="team-member-time">{member.status === "running" ? formatElapsed(activity?.startedAt, now) : activity ? `${activity.steps} 步` : "—"}</span>
        </span>
        <span className="team-member-now">
          {activity?.currentTool ? toolIcon(activity.currentTool) : <ChevronRight size={11} />}
          <span title={current}>{current}</span>
        </span>
      </span>
      <ChevronRight className="team-member-chevron" size={12} />
    </button>
  );
}

export interface TeamMemberDetailProps {
  member: TeamMemberSummary;
  mode: "dock" | "full";
  now: number;
  transcript?: ChatMessage[];
  transcriptError?: string;
  draft: string;
  onDraftChange(value: string): void;
  sending: boolean;
  actionError?: string;
  onSubmitSend(): void;
  onStop(): void;
  onOpenTranscript(): void;
  onOpenArtifact(artifact: Artifact): void;
}

/** 成员详情（dock 右侧 / full 控制台共用）：统计、步骤或完整记录、停止与发消息。 */
export function TeamMemberDetail({
  member: selected,
  mode,
  now,
  transcript,
  transcriptError,
  draft,
  onDraftChange,
  sending,
  actionError,
  onSubmitSend,
  onStop,
  onOpenTranscript,
  onOpenArtifact
}: TeamMemberDetailProps): ReactNode {
  const full = mode === "full";
  return (
    <div className={`team-member-detail${full ? " full" : ""}`}>
      <div className="team-detail-head">
        <span className={`team-status-dot ${selected.status}`} />
        <strong>{selected.name}</strong>
        <span className={`team-status-badge ${selected.status}`}>{statusLabel(selected.status)}</span>
        <span className="team-detail-meta">
          {[selected.model, selected.thinkingLevel ? `思考 ${thinkingLevelLabels[selected.thinkingLevel]}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="team-detail-stats">
        <span><Coins size={10} />{formatTokens(selected.activity?.tokens)} tokens</span>
        <span><Cpu size={10} />上下文 {selected.activity?.contextPercent === undefined ? "—" : `${Math.round(selected.activity.contextPercent)}%`}</span>
        <span><Clock size={10} />{selected.activity?.steps ?? 0} 步</span>
        <span><Clock size={10} />{selected.status === "running" ? formatElapsed(selected.activity?.startedAt, now) : "—"}</span>
        {selected.taskSubject && <span className="team-detail-task"><Layers size={10} />{selected.taskId ? `${selected.taskId} ` : ""}{selected.taskSubject}</span>}
      </div>
      {selected.error && <p className="team-detail-error"><AlertTriangle size={11} />{selected.error}</p>}
      {full ? (
        <div className="team-transcript-panel">
          {transcript && transcript.length > 0
            ? <TranscriptTimeline messages={transcript} onOpenArtifact={onOpenArtifact} />
            : transcriptError
              ? <p className="team-board-empty">{transcriptError}</p>
              : <StepsView activity={selected.activity} />}
        </div>
      ) : (
        <StepsView activity={selected.activity} limit={5} />
      )}
      <div className="team-detail-actions">
        <button className="team-detail-action" type="button" onClick={onOpenTranscript} disabled={!selected.sessionFile}>
          <ScrollText size={11} />查看完整记录
        </button>
        <button className="team-detail-action danger" type="button" onClick={onStop} disabled={selected.status !== "running"}>
          <CircleStop size={11} />停止成员
        </button>
      </div>
      {actionError && <p className="team-detail-error"><AlertTriangle size={11} />{actionError}</p>}
      <form className="team-send-form" onSubmit={(event) => { event.preventDefault(); onSubmitSend(); }}>
        <input
          className="team-send-input"
          data-control="team-board-send"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={selected.status === "failed" ? "该成员创建失败，无法发消息" : `给 ${selected.name} 发消息…`}
          disabled={selected.status === "failed" || sending}
          aria-label={`给 ${selected.name} 发消息`}
        />
        <button className="team-send-button" type="submit" data-control="team-board-send-submit" disabled={!draft.trim() || sending || selected.status === "failed"} title="发送（Lead 身份）" aria-label="发送">
          <Send size={13} />
        </button>
      </form>
    </div>
  );
}
