import { ArrowLeft, CircleStop, Clock, Layers, Maximize2, Minimize2, Users, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { DelegationProgress, TeamMemberSummary, TeamSnapshot } from "../../../shared/protocol";
import { useDesktopStore } from "../store";
import type { Artifact } from "../lib/content";
import { DelegationTranscript } from "./DelegationTranscript";
import { MemberRow, TasksView, TeamMemberDetail, formatElapsed, formatTokens, statusLabel } from "./TeamBoardParts";
import { TeamFormation } from "./TeamFormation";

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
  /** 测试/静态预览用：固定编队页网络图宽度（缺省由容器测量）。 */
  graphWidth?: number;
}

const MIN_DOCK_WIDTH = 360;
const MAX_DOCK_WIDTH = 640;
const MAX_MESSAGE_BYTES = 65_536;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  onOpenArtifact,
  graphWidth
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

  async function submitSend(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
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
        <span className="team-board-title"><Users size={14} />{full ? "团队编队" : "团队"}</span>
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

      {full ? (
        <TeamFormation
          snapshot={snapshot}
          selectedName={selected?.name}
          now={now}
          transcript={transcript}
          transcriptError={transcriptError}
          draft={draft}
          onDraftChange={setDraft}
          sending={sending}
          actionError={actionError}
          onSubmitSend={() => void submitSend()}
          onSelect={onSelect}
          onStop={stopSelected}
          onOpenTranscript={() => selected && setTranscriptMember(selected)}
          onOpenArtifact={onOpenArtifact}
          {...(graphWidth === undefined ? {} : { graphWidth })}
        />
      ) : (
        <>
          <div className="team-board-tabs">
            <button className={tab === "members" ? "active" : ""} type="button" onClick={() => setTab("members")}><Users size={12} />成员<em>{members.length}</em></button>
            <button className={tab === "tasks" ? "active" : ""} type="button" onClick={() => setTab("tasks")}><Layers size={12} />任务<em>{tasks.length}</em></button>
          </div>
          {tab === "members" ? (
            <div className="team-board-members">
              <div className="team-member-list">
                {members.map((member) => <MemberRow key={member.name} member={member} selected={selected?.name === member.name} now={now} onSelect={onSelect} />)}
              </div>
              {selected ? (
                <TeamMemberDetail
                  member={selected}
                  mode="dock"
                  now={now}
                  transcript={transcript}
                  transcriptError={transcriptError}
                  draft={draft}
                  onDraftChange={setDraft}
                  sending={sending}
                  actionError={actionError}
                  onSubmitSend={() => void submitSend()}
                  onStop={stopSelected}
                  onOpenTranscript={() => setTranscriptMember(selected)}
                  onOpenArtifact={onOpenArtifact}
                />
              ) : <p className="team-board-empty">暂无成员。</p>}
            </div>
          ) : (
            <TasksView tasks={tasks} />
          )}
        </>
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
