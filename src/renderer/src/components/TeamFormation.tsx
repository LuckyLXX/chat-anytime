import { AlertTriangle, CheckCircle2, Clock, Coins, Cpu, Layers, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatMessage, TeamMemberSummary, TeamSnapshot } from "../../../shared/protocol";
import type { Artifact } from "../lib/content";
import { TeamGraph } from "./TeamGraph";
import {
  TEAM_TASK_FILTERS,
  TasksView,
  TeamMemberDetail,
  formatElapsed,
  formatTokens,
  statusLabel,
  taskCounts,
  type TeamTaskFilter
} from "./TeamBoardParts";

/**
 * 全屏「团队编队」页（方案 B·作战台）：汇总条 + 左成员栏 + 中列（Agent 网络图 +
 * 选中成员控制台）+ 右列（任务板 + 通讯记录）。成员操作复用 TeamMemberDetail，
 * 与右侧 dock 的行为保持一致。
 */

export interface TeamFormationProps {
  snapshot: TeamSnapshot;
  selectedName?: string;
  now: number;
  transcript?: ChatMessage[];
  transcriptError?: string;
  draft: string;
  onDraftChange(value: string): void;
  sending: boolean;
  actionError?: string;
  onSubmitSend(): void;
  onSelect(name: string): void;
  onStop(): void;
  onOpenTranscript(): void;
  onOpenArtifact(artifact: Artifact): void;
  /** 测试/静态预览用：固定网络图宽度（缺省由容器测量）。 */
  graphWidth?: number;
}

type MemberFilter = "all" | "running" | "inactive" | "failed";
type MemberSort = "recent" | "name" | "steps";

const MEMBER_FILTERS: Array<{ key: MemberFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "running", label: "运行中" },
  { key: "inactive", label: "空闲" },
  { key: "failed", label: "失败" }
];

const MESSAGE_KIND: Record<"report" | "assign" | "direct", { label: string; className: string }> = {
  report: { label: "回报", className: "report" },
  assign: { label: "指派", className: "assign" },
  direct: { label: "私信", className: "direct" }
};

function formatCost(value: number | undefined): string {
  if (value === undefined || value <= 0) return "—";
  return `$${value < 10 ? value.toFixed(2) : value.toFixed(1)}`;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function memberReportText(member: TeamMemberSummary): string {
  return member.lastReport?.text ?? member.taskSubject ?? member.description ?? "还没有回报。";
}

export function TeamFormation({
  snapshot,
  selectedName,
  now,
  transcript,
  transcriptError,
  draft,
  onDraftChange,
  sending,
  actionError,
  onSubmitSend,
  onSelect,
  onStop,
  onOpenTranscript,
  onOpenArtifact,
  graphWidth
}: TeamFormationProps): ReactNode {
  const members = snapshot.members;
  const tasks = snapshot.tasks ?? [];
  const lead = snapshot.lead;
  const messages = snapshot.messages ?? [];
  const selected = members.find((member) => member.name === selectedName)
    ?? members.find((member) => member.status === "running")
    ?? members[0];
  const [leadSelected, setLeadSelected] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");
  const [memberSort, setMemberSort] = useState<MemberSort>("recent");
  const [taskQuery, setTaskQuery] = useState("");
  const [taskFilter, setTaskFilter] = useState<TeamTaskFilter>("all");

  useEffect(() => {
    setLeadSelected(false);
  }, [selectedName]);

  const filteredMembers = useMemo(() => {
    const needle = memberQuery.trim().toLowerCase();
    const rows = members.filter((member) => {
      if (memberFilter !== "all" && member.status !== memberFilter) return false;
      if (!needle) return true;
      return `${member.name} ${member.description ?? ""} ${member.taskSubject ?? ""} ${member.lastReport?.text ?? ""}`
        .toLowerCase()
        .includes(needle);
    });
    return [...rows].sort((left, right) => {
      if (memberSort === "name") return left.name.localeCompare(right.name);
      if (memberSort === "steps") return (right.activity?.steps ?? 0) - (left.activity?.steps ?? 0);
      const leftAt = left.activity?.lastActiveAt ?? left.activity?.startedAt ?? 0;
      const rightAt = right.activity?.lastActiveAt ?? right.activity?.startedAt ?? 0;
      return rightAt - leftAt;
    });
  }, [members, memberFilter, memberQuery, memberSort]);

  const memberCounts = useMemo(() => ({
    all: members.length,
    running: members.filter((member) => member.status === "running").length,
    inactive: members.filter((member) => member.status === "inactive").length,
    failed: members.filter((member) => member.status === "failed").length
  }), [members]);
  const counts = taskCounts(tasks);
  const completed = counts.completed;
  const progress = tasks.length === 0 ? 0 : Math.round((completed / tasks.length) * 100);
  const totalTokens = (lead?.tokens ?? 0) + members.reduce((sum, member) => sum + (member.activity?.tokens ?? 0), 0);
  const totalCost = (lead?.cost ?? 0) + members.reduce((sum, member) => sum + (member.activity?.cost ?? 0), 0);

  const newestFirst = useMemo(() => [...messages].reverse(), [messages]);

  const leadConsole = (
    <div className="team-member-detail full">
      <div className="team-detail-head">
        <span className="team-status-dot lead" />
        <strong>lead</strong>
        <span className="team-status-badge running">主导</span>
        <span className="team-detail-meta">{[lead?.model, "当前会话"].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="team-detail-stats">
        <span><Coins size={10} />{formatTokens(lead?.tokens)} tokens</span>
        <span><Cpu size={10} />上下文 {lead?.contextPercent === undefined ? "—" : `${Math.round(lead.contextPercent)}%`}</span>
        <span><Clock size={10} />{lead?.steps ?? 0} 步</span>
        <span><Coins size={10} />{formatCost(lead?.cost)}</span>
      </div>
      <p className="team-board-empty">
        Lead 的对话就是当前会话本身。左侧选一个成员，可在这里看它的完整记录、发消息或停止成员；
        汇总条与 Agent 网络会给全队的实时状态。
      </p>
    </div>
  );

  return (
    <div className="team-formation">
      <div className="team-summary">
        <span className="team-summary-chip"><Users size={12} />成员 <b>{members.length}</b></span>
        <span className="team-summary-chip"><i className="team-summary-dot running" />运行中 <b>{snapshot.running}</b></span>
        <span className="team-summary-chip"><CheckCircle2 size={12} />任务 <b>{completed}/{tasks.length}</b></span>
        <span className="team-summary-chip"><Layers size={12} />累计 <b>{formatTokens(totalTokens)}</b> tok</span>
        <span className="team-summary-chip"><Coins size={12} />预估 <b>{formatCost(totalCost)}</b></span>
        <span className="team-summary-progress">
          任务进度
          <span className="team-progress-bar"><i style={{ width: `${progress}%` }} /></span>
          <em>{completed}/{tasks.length}</em>
        </span>
      </div>

      <div className="team-formation-main">
        <aside className="team-rail">
          <div className="team-pane-title"><Users size={12} />成员<em>{members.length} · {snapshot.running} 运行中</em></div>
          <div className="team-rail-tools">
            <label className="team-search">
              <Search size={12} />
              <input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索成员…" aria-label="搜索团队成员" />
            </label>
            <div className="team-filter-row">
              {MEMBER_FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={memberFilter === item.key ? "active" : ""}
                  onClick={() => setMemberFilter(item.key)}
                >
                  {item.label} <em>{memberCounts[item.key]}</em>
                </button>
              ))}
            </div>
            <select className="team-sort" value={memberSort} onChange={(event) => setMemberSort(event.target.value as MemberSort)} aria-label="成员排序">
              <option value="recent">最近活动</option>
              <option value="name">名字</option>
              <option value="steps">步数</option>
            </select>
          </div>
          <div className="team-rail-list">
            <button
              type="button"
              className={`team-rail-item lead${leadSelected ? " selected" : ""}`}
              onClick={() => setLeadSelected(true)}
            >
              <span className="team-status-dot lead" />
              <span className="team-rail-copy">
                <span className="team-rail-line">
                  <strong>lead</strong>
                  <span className="team-status-badge running">主导</span>
                </span>
                <span className="team-rail-sub">{lead?.model ?? "当前会话"} · 当前会话</span>
                <span className="team-rail-meta">{formatTokens(lead?.tokens)} tok{lead?.steps !== undefined ? ` · ${lead.steps} 步` : ""}</span>
              </span>
            </button>
            {filteredMembers.map((member) => (
              <button
                key={member.name}
                type="button"
                className={`team-rail-item${!leadSelected && selected?.name === member.name ? " selected" : ""} ${member.status}`}
                onClick={() => { setLeadSelected(false); onSelect(member.name); }}
              >
                <span className={`team-status-dot ${member.status}`} />
                <span className="team-rail-copy">
                  <span className="team-rail-line">
                    <strong>{member.name}</strong>
                    <span className={`team-status-badge ${member.status}`}>{statusLabel(member.status)}</span>
                  </span>
                  <span className="team-rail-sub" title={memberReportText(member)}>{memberReportText(member)}</span>
                  <span className="team-rail-meta">
                    {formatTokens(member.activity?.tokens)} tok · {member.activity?.steps ?? 0} 步
                    {member.status === "running" && member.activity?.startedAt !== undefined ? ` · ${formatElapsed(member.activity.startedAt, now)}` : ""}
                  </span>
                </span>
              </button>
            ))}
            {filteredMembers.length === 0 && <p className="team-board-empty">没有匹配的成员。</p>}
          </div>
        </aside>

        <section className="team-formation-center">
          <div className="team-graph-card">
            <div className="team-pane-title">
              <Layers size={12} />Agent 网络
              <em>lead → 成员 → 当前任务 · 点击节点高亮</em>
              <span className="team-graph-legend">
                <span><i className="running" />运行中</span>
                <span><i className="inactive" />空闲</span>
                <span><i className="task" />任务</span>
                <span><i className="depends" />依赖</span>
              </span>
            </div>
            <TeamGraph
              members={members}
              tasks={tasks}
              lead={lead}
              selectedName={selected?.name}
              leadSelected={leadSelected}
              now={now}
              {...(graphWidth === undefined ? {} : { width: graphWidth })}
              onSelect={(name) => { setLeadSelected(false); onSelect(name); }}
              onSelectLead={() => setLeadSelected(true)}
            />
          </div>
          <div className="team-console">
            {leadSelected
              ? leadConsole
              : selected
                ? (
                  <TeamMemberDetail
                    member={selected}
                    mode="full"
                    now={now}
                    transcript={transcript}
                    transcriptError={transcriptError}
                    draft={draft}
                    onDraftChange={onDraftChange}
                    sending={sending}
                    actionError={actionError}
                    onSubmitSend={onSubmitSend}
                    onStop={onStop}
                    onOpenTranscript={onOpenTranscript}
                    onOpenArtifact={onOpenArtifact}
                  />
                )
                : <p className="team-board-empty">暂无成员。</p>}
          </div>
        </section>

        <aside className="team-formation-side">
          <div className="team-tasks-card">
            <div className="team-pane-title"><Layers size={12} />任务板<em>{tasks.length} 项</em></div>
            <div className="team-side-tools">
              <label className="team-search">
                <Search size={12} />
                <input value={taskQuery} onChange={(event) => setTaskQuery(event.target.value)} placeholder="搜索任务…" aria-label="搜索团队任务" />
              </label>
              <div className="team-filter-row">
                {TEAM_TASK_FILTERS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={taskFilter === item.key ? "active" : ""}
                    onClick={() => setTaskFilter(item.key)}
                  >
                    {item.label} <em>{counts[item.key]}</em>
                  </button>
                ))}
              </div>
            </div>
            <div className="team-task-scroll">
              <TasksView tasks={tasks} full filter={taskFilter} query={taskQuery} />
            </div>
          </div>

          <div className="team-comms-card">
            <div className="team-pane-title">
              <Layers size={12} />通讯记录<em>{messages.length} 条 · 仅本次运行</em>
            </div>
            <div className="team-comms-list">
              {newestFirst.length === 0 && <p className="team-board-empty">本次运行还没有团队消息。成员用 team_send 回报或私信后会出现在这里。</p>}
              {newestFirst.map((message) => {
                const kind = MESSAGE_KIND[message.kind];
                const targetName = message.sender === "lead" ? message.target : message.sender;
                return (
                  <button
                    key={message.id}
                    type="button"
                    className="team-comms-row"
                    onClick={() => {
                      if (members.some((member) => member.name === targetName)) {
                        setLeadSelected(false);
                        onSelect(targetName);
                      }
                    }}
                    title={message.text}
                  >
                    <span className="team-comms-time">{formatClock(message.at)}</span>
                    <span className={`team-comms-kind ${kind.className}`}>{kind.label}</span>
                    <span className="team-comms-route"><b>{message.sender}</b><i>→</i>{message.target}</span>
                    <span className="team-comms-text">{message.text}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      </div>

      {tasks.some((task) => task.writeScopeWarnings.length > 0) && (
        <div className="team-formation-warning">
          <AlertTriangle size={11} />
          写入范围有重叠的任务已在任务板内标红；这只是告警，不会阻止执行。
        </div>
      )}
    </div>
  );
}
