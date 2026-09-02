// 设置页「自动化任务」→「运行记录」子页：全角色运行历史面板。
// 数据源 store.automationRuns（automation-runs 推送全量替换）；运行中条目由
// automation-run running 推送合成置顶。「查看会话」只发 runId，主进程负责
// 跨角色切换/定位/激活恢复（automation.run.open）。

import { CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, MessageSquare, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AutomationRunRecord, DesktopSettings } from "../../shared/protocol";
import { useDesktopStore } from "./store";

export interface AutomationRunsHighlight {
  runId: string;
  at: number;
}

export interface AutomationRunsProps {
  settings: DesktopSettings;
  /** toast「查看结果」直达信号：切到本子页后滚动+描边高亮该条（描边 2s 后消隐，展开保留）。 */
  highlight?: AutomationRunsHighlight;
}

type StatusFilter = "all" | "ok" | "error";

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

export function AutomationRuns({ settings, highlight }: AutomationRunsProps): ReactNode {
  const runs = useDesktopStore((state) => state.automationRuns);
  const automation = useDesktopStore((state) => state.automation);
  const automationRun = useDesktopStore((state) => state.automationRun);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [taskFilter, setTaskFilter] = useState<string>("all");
  const [expandedRunId, setExpandedRunId] = useState<string | undefined>(undefined);
  const [highlightRunId, setHighlightRunId] = useState<string | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);

  // 直达信号：滚动到该行并描边高亮（2s 后描边消隐，展开保留）。
  // at 是每次点击的唯一时间戳：同 runId 再次点击（新 at）也能重新触发；
  // 仅依赖 at——highlight 对象每次渲染都是新引用，不能作为依赖。
  const highlightAt = highlight?.at;
  useEffect(() => {
    if (!highlight) return;
    setExpandedRunId(highlight.runId);
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

  const taskOptions = useMemo(() => {
    // 任务筛选数据源 = 当前全角色任务；运行记录里已删除任务的行不受筛选影响。
    return automation
      .filter((task) => runs.some((run) => run.taskId === task.id))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map((task) => ({ id: task.id, name: task.name, agentId: task.agentId, agentName: settings.agents.find((agent) => agent.id === task.agentId)?.name ?? task.agentId }));
  }, [automation, runs, settings.agents]);

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

  function toggleExpand(runId: string): void {
    setExpandedRunId((current) => (current === runId ? undefined : runId));
  }

  return (
    <div className="automation-runs" ref={panelRef}>
      <div className="automation-runs-toolbar">
        <div className="automation-filter-tabs" role="tablist" aria-label="运行状态筛选">
          <button type="button" className={statusFilter === "all" ? "active" : ""} role="tab" aria-selected={statusFilter === "all"} onClick={() => setStatusFilter("all")}>全部</button>
          <button type="button" className={statusFilter === "ok" ? "active" : ""} role="tab" aria-selected={statusFilter === "ok"} onClick={() => setStatusFilter("ok")}>成功</button>
          <button type="button" className={statusFilter === "error" ? "active" : ""} role="tab" aria-selected={statusFilter === "error"} onClick={() => setStatusFilter("error")}>失败</button>
        </div>
        <label className="automation-runs-task-filter" aria-label="任务筛选"><span>任务</span>
          <select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}>
            <option value="all">全部任务</option>
            {taskOptions.map((task) => <option key={task.id} value={task.id}>{task.name}{task.agentName !== task.agentId ? ` · ${task.agentName}` : ""}</option>)}
          </select>
          <ChevronDown size={12} className="automation-runs-task-chevron" aria-hidden="true" />
        </label>
        <span className="automation-runs-count">共 {filteredCount} 条 · 保留最近 200 条</span>
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
            <p>{runningNow ? "换个筛选条件试试。" : "任务下一次触发后会出现在这里——每次运行（定时或手动）都会保留任务名、结果摘要与用时。"}</p>
          </div>
        : <div className="automation-runs-groups">
            {groups.map(([label, dayRuns]) => (
              <section className="automation-runs-group" key={label}>
                <header className="automation-runs-group-head"><strong>{label}</strong><span>{dayRuns.length} 条</span></header>
                <div className="automation-runs-list">
                  {dayRuns.map((run) => {
                    const expanded = expandedRunId === run.id;
                    const crossRole = run.agentId !== settings.currentAgentId;
                    const task = automation.find((candidate) => candidate.id === run.taskId);
                    return (
                      <div
                        className={`automation-runs-row ${run.status}${expanded ? " expanded" : ""}${highlightRunId === run.id ? " highlight" : ""}`}
                        key={run.id}
                        data-run-id={run.id}
                        role="button"
                        tabIndex={0}
                        aria-expanded={expanded}
                        onClick={() => toggleExpand(run.id)}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleExpand(run.id); } }}
                      >
                        <div className="automation-runs-row-line">
                          <span className={`automation-runs-status ${run.status}`} aria-hidden="true">{run.status === "ok" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}</span>
                          <strong>{run.taskName}</strong>
                          <span className="automation-runs-agent">{run.agentName}</span>
                          <span className="automation-runs-time">{formatTime(run.startedAt)}</span>
                          <span className="automation-runs-duration">用时 {formatDuration(run.durationMs)}</span>
                          <span className={`automation-runs-trigger ${run.trigger}`}>{run.trigger === "cron" ? "定时" : "手动"}</span>
                          <ChevronRight size={14} className="automation-runs-chevron" />
                        </div>
                        {/* 失败优先可见：error 与 preview 折叠态都行内截断展示 */}
                        {!expanded && run.status === "error" && run.error && <p className="automation-runs-summary error"><span className="automation-runs-summary-label">错误：</span>{run.error}</p>}
                        {!expanded && run.status === "ok" && run.preview && <p className="automation-runs-summary">{run.preview}</p>}
                        {expanded && (
                          <div className="automation-runs-detail">
                            <div className="automation-runs-detail-block">
                              <strong>{run.status === "ok" ? "结果" : "错误详情"}</strong>
                              <p>{run.status === "ok" ? (run.preview || "运行成功（无文本输出）") : (run.error || "运行失败（无错误详情）")}</p>
                            </div>
                            {task && <div className="automation-runs-detail-block"><strong>任务提示词</strong><p className="automation-runs-prompt">{task.prompt}</p></div>}
                            <div className="automation-runs-detail-meta">
                              {run.modelId && <span>模型：{run.modelId}</span>}
                              <span>会话：{run.sessionId}</span>
                              <span>触发：{run.trigger === "cron" ? "定时" : "手动"}</span>
                            </div>
                            <div className="automation-runs-detail-actions">
                              <button
                                type="button"
                                className="secondary-button"
                                title={crossRole ? "该运行属于其他角色：将切换到该角色（当前会话会被保留）后打开" : "打开该运行的会话"}
                                onClick={(event) => { event.stopPropagation(); send({ type: "automation.run.open", runId: run.id }); }}
                              ><MessageSquare size={14} />{crossRole ? "切换角色查看" : "查看会话"}</button>
                            </div>
                          </div>
                        )}
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