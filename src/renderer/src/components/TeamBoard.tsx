import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleStop,
  Clock,
  Coins,
  Cpu,
  FileText,
  Layers,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  ScrollText,
  Send,
  Terminal,
  Users,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { DelegationProgress, TeamMemberActivity, TeamMemberActivityStep, TeamMemberSummary, TeamSnapshot, TeamTaskSummary } from "../../../shared/protocol";
import { thinkingLevelLabels, toolLabel } from "../../../shared/locale";
import { useDesktopStore } from "../store";
import type { Artifact } from "../lib/content";
import { DelegationTranscript, TranscriptTimeline } from "./DelegationTranscript";

export interface TeamBoardProps {
  snapshot: TeamSnapshot;
  mode: "dock" | "full";
  width: number;
  sessionId?: string;
  selectedName?: string;
  onSelect(name: string): void;
  onResize(width: number): void;
  onToggleMode(): void;
  onClose(): void;
  onStopAll(): void;
  onStopMember(name: string): void | Promise<void>;
  onSend(name: string, text: string): Promise<void>;
  onOpenArtifact(artifact: Artifact): void;
}

const MIN_DOCK_WIDTH = 360;
const MAX_DOCK_WIDTH = 640;
const MAX_MESSAGE_BYTES = 65_536;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function statusLabel(status: TeamMemberSummary["status"]): string {
  switch (status) {
    case "running": return "运行中";
    case "inactive": return "空闲";
    case "provisioning": return "创建中";
    case "failed": return "失败";
  }
}

function taskStatusLabel(task: TeamTaskSummary): string {
  if (task.status === "in_progress") return "进行中";
  if (task.status === "completed") return "已完成";
  return task.ready ? "就绪" : "阻塞";
}

function formatTokens(value: number | undefined): string {
  if (value === undefined || value <= 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDurationMs(value: number | undefined): string {
  if (value === undefined) return "";
  if (value < 1_000) return `${Math.max(0, Math.round(value))}ms`;
  return `${(value / 1_000).toFixed(1)}s`;
}

function formatElapsed(startedAt: number | undefined, now: number): string {
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

function StepsView({ activity, limit }: { activity?: TeamMemberActivity; limit?: number }): ReactNode {
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

function TasksView({ tasks, full = false }: { tasks: TeamTaskSummary[]; full?: boolean }): ReactNode {
  const groups: Array<{ key: string; label: string; rows: TeamTaskSummary[] }> = [
    { key: "in_progress", label: "进行中", rows: tasks.filter((task) => task.status === "in_progress") },
    { key: "pending", label: "待处理", rows: tasks.filter((task) => task.status === "pending") },
    { key: "completed", label: "已完成", rows: tasks.filter((task) => task.status === "completed") }
  ];
  const warnings = [...new Set(tasks.flatMap((task) => task.writeScopeWarnings))];
  if (tasks.length === 0) {
    return <p className="team-board-empty">任务板还是空的。让 Lead 用 team_task_create 拆任务后，这里会显示 owner、依赖和写入范围告警。</p>;
  }
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

function transcriptTarget(member: TeamMemberSummary): DelegationProgress | undefined {
  if (!member.sessionFile || !member.sessionId) return undefined;
  const [provider, ...rest] = (member.model ?? "").split("/");
  return {
    childSessionId: member.sessionId,
    childSessionFile: member.sessionFile,
    role: "custom",
    model: { provider: provider || "unknown", id: rest.join("/") || "unknown" },
    steps: []
  };
}

export function TeamBoard({
  snapshot,
  mode,
  width,
  sessionId,
  selectedName,
  onSelect,
  onResize,
  onToggleMode,
  onClose,
  onStopAll,
  onStopMember,
  onSend,
  onOpenArtifact
}: TeamBoardProps): ReactNode {
  const full = mode === "full";
  const members = snapshot.members;
  const tasks = snapshot.tasks ?? [];
  const selected = members.find((member) => member.name === selectedName)
    ?? members.find((member) => member.status === "running")
    ?? members[0];
  const [tab, setTab] = useState<"members" | "tasks">("members");
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [pendingSend, setPendingSend] = useState<{ text: string; at: number }>();
  const [transcriptMember, setTranscriptMember] = useState<TeamMemberSummary>();
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const sendErrorRef = useRef(false);
  const transcript = useDesktopStore((state) => selected?.sessionId ? state.transcripts[selected.sessionId] : undefined);
  const transcriptError = useDesktopStore((state) => selected?.sessionId ? state.transcriptErrors[selected.sessionId] : undefined);
  const commandError = useDesktopStore((state) => state.commandError);

  useEffect(() => {
    if (snapshot.running === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot.running]);

  useEffect(() => {
    setActionError(undefined);
    setDraft("");
  }, [selected?.name]);

  useEffect(() => {
    if (!pendingSend) return;
    const timer = window.setTimeout(() => setPendingSend(undefined), 5_000);
    return () => window.clearTimeout(timer);
  }, [pendingSend]);

  useEffect(() => {
    if (!pendingSend || !commandError || commandError.at < pendingSend.at) return;
    if (sessionId === undefined ? commandError.sessionId !== undefined : commandError.sessionId !== sessionId) return;
    sendErrorRef.current = true;
    setActionError(commandError.message);
    setDraft((current) => current.trim() ? current : pendingSend.text);
    setPendingSend(undefined);
  }, [commandError, pendingSend, sessionId]);

  useEffect(() => {
    if (!full || !selected?.sessionId || !selected.sessionFile) return;
    let cancelled = false;
    const request = (): void => {
      if (cancelled) return;
      void window.piDesktop.send({
        type: "subagent.transcript",
        childSessionId: selected.sessionId!,
        path: selected.sessionFile!,
        kind: "team"
      }).catch(() => undefined);
    };
    request();
    if (selected.status !== "running") return () => { cancelled = true; };
    const timer = window.setInterval(request, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [full, selected?.sessionId, selected?.sessionFile, selected?.status]);

  const teamStartedAt = members.reduce<number | undefined>((earliest, member) => {
    const startedAt = member.activity?.startedAt;
    if (startedAt === undefined) return earliest;
    return earliest === undefined ? startedAt : Math.min(earliest, startedAt);
  }, undefined);

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (full) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { x: event.clientX, width };
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = resizeStart.current;
    if (!start) return;
    onResize(clamp(start.width - (event.clientX - start.x), MIN_DOCK_WIDTH, MAX_DOCK_WIDTH));
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>): void {
    resizeStart.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be gone.
    }
  }

  async function submitSend(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = draft.trim();
    if (!selected || !text || sending || selected.status === "failed") return;
    if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) {
      setActionError(`消息超过 ${MAX_MESSAGE_BYTES} 字节上限`);
      return;
    }
    setSending(true);
    setActionError(undefined);
    sendErrorRef.current = false;
    setPendingSend({ text, at: Date.now() });
    try {
      await onSend(selected.name, text);
      // 命令通道不会 reject；若 commandError 还没回来就先清空，回来后会恢复草稿。
      if (!sendErrorRef.current) setDraft((current) => current === text ? "" : current);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setPendingSend(undefined);
    } finally {
      setSending(false);
    }
  }

  function stopSelected(): void {
    if (!selected) return;
    setActionError(undefined);
    void Promise.resolve(onStopMember(selected.name)).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }

  const sendForm = selected && (
    <form className="team-send-form" onSubmit={(event) => void submitSend(event)}>
      <input
        className="team-send-input"
        data-control="team-board-send"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={selected.status === "failed" ? "该成员创建失败，无法发消息" : `给 ${selected.name} 发消息…`}
        disabled={selected.status === "failed" || sending}
        aria-label={`给 ${selected.name} 发消息`}
      />
      <button className="team-send-button" type="submit" data-control="team-board-send-submit" disabled={!draft.trim() || sending || selected.status === "failed"} title="发送（Lead 身份）" aria-label="发送">
        <Send size={13} />
      </button>
    </form>
  );

  const detail = selected && (
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
        <button className="team-detail-action" type="button" onClick={() => setTranscriptMember(selected)} disabled={!transcriptTarget(selected)}>
          <ScrollText size={11} />查看完整记录
        </button>
        <button className="team-detail-action danger" type="button" onClick={stopSelected} disabled={selected.status !== "running"}>
          <CircleStop size={11} />停止成员
        </button>
      </div>
      {actionError && <p className="team-detail-error"><AlertTriangle size={11} />{actionError}</p>}
      {sendForm}
    </div>
  );

  return (
    <aside
      className={`team-board ${full ? "full" : "dock"}`}
      data-control="team-board"
      data-team-mode={mode}
      style={{ "--team-board-width": `${width}px` } as CSSProperties}
      aria-label="团队看板"
    >
      {!full && <div className="team-board-resize" role="separator" aria-label="调整团队面板宽度" title="拖动调整宽度" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} />}
      <header className="team-board-header">
        {full && <button className="team-board-back" type="button" onClick={onToggleMode}><ArrowLeft size={13} />返回对话</button>}
        <span className="team-board-title"><Users size={14} />{full ? "团队工作台" : "团队"}</span>
        <span className="team-board-sub">{members.length} 人 · {snapshot.running} 运行中</span>
        <span className="team-board-grow" />
        <span className="team-board-elapsed"><Clock size={11} />{snapshot.running > 0 ? formatElapsed(teamStartedAt, now) : "—"}</span>
        <button className="team-board-icon danger" type="button" data-control="team-board-stop-all" title="停止所有成员的当前回合（保留队列与任务归属）" aria-label="全部停止" onClick={onStopAll} disabled={snapshot.running === 0}>
          <CircleStop size={14} />
        </button>
        <button className="team-board-icon" type="button" title={full ? "收起到右侧" : "放大为工作台"} aria-label={full ? "收起到右侧" : "放大为工作台"} onClick={onToggleMode}>
          {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button className="team-board-icon" type="button" data-control="team-board-close" title="关闭团队看板" aria-label="关闭团队看板" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      {!full && (
        <div className="team-board-tabs">
          <button className={tab === "members" ? "active" : ""} type="button" onClick={() => setTab("members")}><Users size={12} />成员<em>{members.length}</em></button>
          <button className={tab === "tasks" ? "active" : ""} type="button" onClick={() => setTab("tasks")}><Layers size={12} />任务<em>{tasks.length}</em></button>
        </div>
      )}

      {full ? (
        <div className="team-workbench">
          <aside className="team-workbench-roster">
            <div className="team-pane-title"><Users size={12} />成员<em>{members.length} · {snapshot.running} 运行中</em></div>
            <div className="team-member-list">
              {members.map((member) => <MemberRow key={member.name} member={member} selected={selected?.name === member.name} now={now} onSelect={onSelect} />)}
            </div>
          </aside>
          <section className="team-workbench-focus">
            {detail ?? <p className="team-board-empty">暂无成员。</p>}
          </section>
          <aside className="team-workbench-tasks">
            <div className="team-pane-title"><Layers size={12} />任务板<em>{tasks.length} 项</em></div>
            <TasksView tasks={tasks} full />
          </aside>
        </div>
      ) : tab === "members" ? (
        <div className="team-board-members">
          <div className="team-member-list">
            {members.map((member) => <MemberRow key={member.name} member={member} selected={selected?.name === member.name} now={now} onSelect={onSelect} />)}
          </div>
          {detail ?? <p className="team-board-empty">暂无成员。</p>}
        </div>
      ) : (
        <TasksView tasks={tasks} />
      )}

      {transcriptMember && transcriptTarget(transcriptMember) && (
        <DelegationTranscript
          delegation={transcriptTarget(transcriptMember)!}
          title="成员完整记录"
          subtitle={[
            statusLabel(transcriptMember.status),
            transcriptMember.model,
            transcriptMember.activity ? `${transcriptMember.activity.steps} 步 · ${formatTokens(transcriptMember.activity.tokens)} tokens` : "",
            transcriptMember.taskSubject
          ].filter(Boolean).join(" · ")}
          kind="team"
          onClose={() => setTranscriptMember(undefined)}
          onOpenArtifact={onOpenArtifact}
        />
      )}
    </aside>
  );
}

function MemberRow({ member, selected, now, onSelect }: {
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
