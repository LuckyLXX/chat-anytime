// 设置页「自动化任务」→「运行记录」子页：全角色运行历史面板。
// 数据源 store.automationRuns（automation-runs 推送全量替换）；运行中条目由
// automation-run running 推送合成置顶。「查看会话」只发 runId，主进程负责
// 跨角色切换/定位/激活恢复（automation.run.open）。

import { CheckCircle2, CheckCheck, ChevronDown, CircleSlash, CircleStop, Clock, Loader2, MessageSquare, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AutomationRunRecord, DesktopSettings } from "../../shared/protocol";
import { useDesktopStore } from "./store";

export interface AutomationRunsHighlight {
  runId: string;
  at: number;
}

export interface AutomationRunsProps {
  settings: DesktopSettings;
  /** 激活会话的助手 id（快照 agentId）；缺省读 store 快照。 */
  activeAgentId?: string;
  /** toast「查看结果」直达信号：切到本子页后滚动+描边高亮该条（描边 2s 后消隐，展开保留）。 */
  highlight?: AutomationRunsHighlight;
  /** 「查看会话/切换角色查看」：由宿主先关设置页（跳转后的会话不被弹窗遮挡）。 */
  onOpenSession: () => void;
  /** 右侧自动化面板的紧凑形态：只保留 全部/成功/失败，隐藏任务筛选与计数。 */
  compact?: boolean;
  /** 宿主选中的任务：进入运行记录时默认把任务筛选切到它（管理页用）。 */
  initialTaskFilter?: string;
}

type StatusFilter = "all" | "ok" | "error" | "aborted" | "skipped" | "delivered";

function pad2(value: number): string {
  return `${value}`.padStart(2, "0");
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 用时：少于 1 分钟显示秒（12s），否则 1m32s / 2m。 */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m${pad2(rest)}s` : `${minutes}m`;
}

/** 日期分组标签：今天 / 昨天 / 更早显示完整日期（本地时区）。 */
function dayLabel(ts: number): string {
  const date = new Date(ts);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThatDay = new Date(date);
  startOfThatDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((startOfToday.getTime() - startOfThatDay.getTime()) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 按日期分组（保持出现顺序：运行倒序时今天在前），返回有序 [label, runs] 数组。 */
function groupByDay(runs: AutomationRunRecord[]): [string, AutomationRunRecord[]][] {
  const groups = new Map<string, AutomationRunRecord[]>();
  for (const run of runs) {
    const label = dayLabel(run.startedAt);
    const bucket = groups.get(label) ?? [];
    bucket.push(run);
    groups.set(label, bucket);
  }
  return [...groups.entries()];
}

export function AutomationRuns({ settings, activeAgentId, highlight, onOpenSession, compact = false, initialTaskFilter }: AutomationRunsProps): ReactNode {
  const runs = useDesktopStore((state) => state.automationRuns);
  const automation = useDesktopStore((state) => state.automation);
  const automationRun = useDesktopStore((state) => state.automationRun);
  // 跨角色判断以激活会话快照为准；旧调用未传 activeAgentId 时直接读 store 快照。
  const snapshotAgentId = useDesktopStore((state) => state.snapshot.agentId);
  const currentAgentId = activeAgentId ?? snapshotAgentId;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [taskFilter, setTaskFilter] = useState<string>(initialTaskFilter ?? "all");
  const [highlightRunId, setHighlightRunId] = useState<string | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);

  // 直达信号：滚动到该行并描边高亮（2s 后描边消隐）。
  // at 是每次点击的唯一时间戳：同 runId 再次点击（新 at）也能重新触发；
  // 仅依赖 at——highlight 对象每次渲染都是新引用，不能作为依赖。
  const highlightAt = highlight?.at;
  useEffect(() => {
    if (!highlight) return;
    setHighlightRunId(highlight.runId);
    const frame = requestAnimationFrame(() => {
      const element = panelRef.current?.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(highlight.runId)}"]`);
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    const timer = setTimeout(() => setHighlightRunId(undefined), 2000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- highlight 仅用于读取，at 唯一驱动
  }, [highlightAt]);

  // 管理页切换任务时把筛选跟过去；用户在记录里再手动改就是用户自己的选择。
  useEffect(() => {
    if (initialTaskFilter) setTaskFilter(initialTaskFilter);
  }, [initialTaskFilter]);

  const taskOptions = useMemo(() => {
    // 任务筛选数据源 = 当前全角色任务；运行记录里已删除任务的行不受筛选影响。
    return automation
      // 当前选中任务即使还没有运行记录也要出现在下拉里，否则 value 落空会看起来「筛选到了不存在的任务」。
      .filter((task) => task.id === initialTaskFilter || runs.some((run) => run.taskId === task.id))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map((task) => ({ id: task.id, name: task.name, agentId: task.agentId, agentName: settings.agents.find((agent) => agent.id === task.agentId)?.name ?? task.agentId }));
  }, [automation, runs, settings.agents, initialTaskFilter]);

  const filtered = useMemo(() => {
    return runs.filter((run) => {
      if (statusFilter !== "all" && run.status !== statusFilter) return false;
      if (taskFilter !== "all" && run.taskId !== taskFilter) return false;
      return true;
    });
  }, [runs, statusFilter, taskFilter]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);
  const runningNow = automationRun?.status === "running";
  const filteredCount = filtered.length + (runningNow ? 1 : 0);

  function send(command: Parameters<typeof window.piDesktop.send>[0]): void { void window.piDesktop.send(command); }

  /** 运行记录是导航入口而不是详情容器：有会话的运行直接打开，跳过记录没有可看的会话。 */
  function openRun(run: AutomationRunRecord): void {
    if (run.status === "skipped" || !run.sessionId) return;
    send({ type: "automation.run.open", runId: run.id });
    onOpenSession();
  }

  /** 行内只保留「状态 + 用时」，不再展示提示词/结果摘要。 */
  function outcomeText(run: AutomationRunRecord): string {
    if (run.status === "skipped") return "未运行";
    if (run.status === "delivered") return "已投递";
    const status = run.status === "ok" ? "成功" : run.status === "aborted" ? "已中止" : "失败";
    return `${status} · 用时 ${formatDuration(run.durationMs)}`;
  }

  return (
    <div className={`automation-runs${compact ? " compact" : ""}`} ref={panelRef}>
      <div className="automation-runs-toolbar">
        <div className="automation-filter-tabs" role="tablist" aria-label="运行状态筛选">
          <button type="button" className={statusFilter === "all" ? "active" : ""} role="tab" aria-selected={statusFilter === "all"} onClick={() => setStatusFilter("all")}>全部</button>
          <button type="button" className={statusFilter === "ok" ? "active" : ""} role="tab" aria-selected={statusFilter === "ok"} onClick={() => setStatusFilter("ok")}>成功</button>
          <button type="button" className={statusFilter === "error" ? "active" : ""} role="tab" aria-selected={statusFilter === "error"} onClick={() => setStatusFilter("error")}>失败</button>
          {!compact && <><button type="button" className={statusFilter === "aborted" ? "active" : ""} role="tab" aria-selected={statusFilter === "aborted"} onClick={() => setStatusFilter("aborted")}>已中止</button>
          <button type="button" className={statusFilter === "skipped" ? "active" : ""} role="tab" aria-selected={statusFilter === "skipped"} onClick={() => setStatusFilter("skipped")}>已跳过</button>
          <button type="button" className={statusFilter === "delivered" ? "active" : ""} role="tab" aria-selected={statusFilter === "delivered"} onClick={() => setStatusFilter("delivered")}>已投递</button></>}
        </div>
        {!compact && <label className="automation-runs-task-filter" aria-label="任务筛选"><span>任务</span>
          <select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}>
            <option value="all">全部任务</option>
            {taskOptions.map((task) => <option key={task.id} value={task.id}>{task.name}{task.agentName !== task.agentId ? ` · ${task.agentName}` : ""}</option>)}
          </select>
          <ChevronDown size={12} className="automation-runs-task-chevron" aria-hidden="true" />
        </label>}
        {!compact && <span className="automation-runs-count">共 {filteredCount} 条 · 保留最近 200 条</span>}
      </div>

      {runningNow && (
        <div className="automation-runs-row running" data-role="automation-running" aria-live="polite">
          <span className="automation-runs-status running"><Loader2 size={14} className="spinning" /></span>
          <strong>{automationRun.taskName ?? "定时任务"}</strong>
          <span className="automation-runs-running-since">运行中 · {formatTime(automationRun.at)} 起</span>
        </div>
      )}

      {groups.length === 0
        ? <div className="automation-empty">
            <Clock size={22} />
            <strong>{runningNow ? "没有匹配的运行记录" : "还没有运行记录"}</strong>
            <p>{runningNow ? "换个筛选条件试试。" : "任务下一次触发后会出现在这里——保留任务名、时间与结果状态。"}</p>
          </div>
        : <div className="automation-runs-groups">
            {groups.map(([label, dayRuns]) => (
              <section className="automation-runs-group" key={label}>
                <header className="automation-runs-group-head"><strong>{label}</strong><span>{dayRuns.length} 条</span></header>
                <div className="automation-runs-list">
                  {dayRuns.map((run) => {
                    const canOpen = run.status !== "skipped" && Boolean(run.sessionId);
                    const crossRole = run.agentId !== currentAgentId;
                    return (
                      <div
                        className={`automation-runs-row ${run.status}${canOpen ? " clickable" : " static"}${highlightRunId === run.id ? " highlight" : ""}`}
                        key={run.id}
                        data-run-id={run.id}
                        role={canOpen ? "button" : undefined}
                        tabIndex={canOpen ? 0 : undefined}
                        title={canOpen
                          ? (crossRole ? "打开会话（将切换到该运行所属角色）" : "打开该运行的会话")
                          : run.status === "skipped" ? (run.skipReason ?? "本轮未运行") : undefined}
                        onClick={canOpen ? () => openRun(run) : undefined}
                        onKeyDown={canOpen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openRun(run); } } : undefined}
                      >
                        <div className="automation-runs-row-line">
                          {/* skipped 用中性图标（CircleSlash），delivered 用 CheckCheck：跳过/投递都不是失败 */}
                          <span className={`automation-runs-status ${run.status}`} aria-hidden="true">{run.status === "ok" ? <CheckCircle2 size={14} /> : run.status === "aborted" ? <CircleStop size={14} /> : run.status === "skipped" ? <CircleSlash size={14} /> : run.status === "delivered" ? <CheckCheck size={14} /> : <XCircle size={14} />}</span>
                          <strong>{run.taskName}</strong>
                          <span className="automation-runs-time">{formatTime(run.startedAt)}</span>
                          <span className={`automation-runs-duration ${run.status}`}>{outcomeText(run)}</span>
                          {canOpen && <MessageSquare size={13} className="automation-runs-open-icon" aria-hidden="true" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>}
    </div>
  );
}