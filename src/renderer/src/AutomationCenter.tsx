// 自动化管理页（P0 的「管理全部」落地页）：左侧任务列表 + 右侧任务详情。
// 设计稿：outputs/automation-panel-designs.html（方案 A 的完整管理页形态）。
// 与右侧面板共用 lib/automation-task-view 的状态/时间口径，避免两处文案漂移。

import { AlertCircle, ArrowLeft, Bot, CalendarClock, Check, ChevronRight, Clock, Cpu, Folder, Key, MessageSquare, Pencil, Play, Plus, Search, Square, Trash2, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AccessMode, AutomationTask, DesktopSettings, ModelOption, ProviderOption } from "../../shared/protocol";
import { formatAutomationNextRun, formatAutomationSchedule, nextAutomationRun } from "../../shared/automation";
import { AutomationForm } from "./AutomationSettings";
import { AutomationRuns } from "./AutomationRuns";
import { AUTOMATION_LAST_RUN_LABEL, AUTOMATION_STATE_LABEL, automationTaskState, automationTaskStateRank, formatElapsed, formatShortTime, workspaceDisplayName, type AutomationTaskState } from "./lib/automation-task-view";
import { ExitWrap, useExitPresenceValue } from "./components/Presence";
import { useDesktopStore } from "./store";

export interface AutomationCenterProps {
  models: ModelOption[];
  providers: ProviderOption[];
  settings: DesktopSettings;
  workspacePath?: string;
  activeAgentId: string;
  initialTaskId?: string;
  onClose(): void;
  /** 打开某次运行/任务关联会话后，由宿主收起管理页（P0 行为）。 */
  onOpenSession(): void;
}

type TaskFilter = "all" | "running" | "paused" | "completed";

const FILTERS: { value: TaskFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "paused", label: "已暂停" },
  { value: "completed", label: "已完成" }
];

const ACCESS_LABEL: Record<AccessMode, string> = {
  full: "完全访问",
  workspace: "工作区访问",
  ask: "每次询问",
  "read-only": "只读"
};

const DAY_MS = 86_400_000;
const WEEKDAY_LABEL = ["日", "一", "二", "三", "四", "五", "六"] as const;

function taskFilterMatch(state: AutomationTaskState, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  if (filter === "running") return state === "running";
  if (filter === "paused") return state === "paused" || state === "issue";
  return state === "completed";
}

/** 近 7 天（含今天）按自然日聚合任务运行次数，供右侧迷你趋势条。 */
function weekTrend(taskRuns: ReturnType<typeof useDesktopStore.getState>["automationRuns"], taskId: string, now: number): { label: string; total: number; errors: number; today: boolean }[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const dayStart = startOfToday.getTime() - (6 - index) * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const runs = taskRuns.filter((run) => run.taskId === taskId && run.startedAt >= dayStart && run.startedAt < dayEnd && run.status !== "skipped");
    const date = new Date(dayStart);
    return {
      label: index === 6 ? "今天" : `周${WEEKDAY_LABEL[date.getDay()]}`,
      total: runs.length,
      errors: runs.filter((run) => run.status === "error").length,
      today: index === 6
    };
  });
}

/** 任务详情里参数行的小工具。 */
function ParamRow({ icon, label, value, title }: { icon: ReactNode; label: string; value: ReactNode; title?: string }): ReactNode {
  return <div className="automation-center-param" title={title}><span className="automation-center-param-icon">{icon}</span><span>{label}</span><b>{value}</b></div>;
}

export function AutomationCenter({ models, providers, settings, workspacePath, activeAgentId, initialTaskId, onClose, onOpenSession }: AutomationCenterProps): ReactNode {
  const automation = useDesktopStore((state) => state.automation);
  const runs = useDesktopStore((state) => state.automationRuns);
  const live = useDesktopStore((state) => state.automationRun);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialTaskId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState<{ mode: "create" } | { mode: "edit"; task: AutomationTask } | null>(null);
  const [actionError, setActionError] = useState<string>();
  const formPresence = useExitPresenceValue(form, 160);
  const runningTaskId = live?.status === "running" ? live.id : undefined;

  useEffect(() => {
    if (initialTaskId) setSelectedId(initialTaskId);
  }, [initialTaskId]);

  // 任务被删除/初始为空时落回「运行中 → 已排定 → 第一条」，避免详情区白屏。
  useEffect(() => {
    if (selectedId && automation.some((task) => task.id === selectedId)) return;
    const preferred = automation.find((task) => automationTaskState(task, runningTaskId) === "running")
      ?? automation.find((task) => automationTaskState(task, runningTaskId) === "scheduled")
      ?? automation[0];
    setSelectedId(preferred?.id);
  }, [automation, selectedId, runningTaskId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), runningTaskId ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [runningTaskId]);

  const agentNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const agent of settings.agents) names.set(agent.id, agent.name);
    return names;
  }, [settings.agents]);

  const filteredTasks = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return automation
      .filter((task) => {
        if (!taskFilterMatch(automationTaskState(task, runningTaskId), filter)) return false;
        if (!keyword) return true;
        return task.name.toLowerCase().includes(keyword)
          || task.prompt.toLowerCase().includes(keyword)
          || formatAutomationSchedule(task.schedule).toLowerCase().includes(keyword);
      })
      .sort((left, right) => {
        const rank = automationTaskStateRank(automationTaskState(left, runningTaskId)) - automationTaskStateRank(automationTaskState(right, runningTaskId));
        return rank !== 0 ? rank : right.createdAt - left.createdAt;
      });
  }, [automation, filter, query, runningTaskId]);

  // 按状态分组（列表仍保持「运行中在前」的组序）。
  const grouped = useMemo(() => {
    const order: AutomationTaskState[] = ["running", "scheduled", "paused", "issue", "completed"];
    return order
      .map((state) => ({ state, tasks: filteredTasks.filter((task) => automationTaskState(task, runningTaskId) === state) }))
      .filter((group) => group.tasks.length > 0);
  }, [filteredTasks, runningTaskId]);

  const selectedTask = automation.find((task) => task.id === selectedId);
  const selectedRuns = useMemo(() => runs.filter((run) => run.taskId === selectedTask?.id), [runs, selectedTask?.id]);
  const last7Runs = useMemo(() => {
    const since = now - 7 * DAY_MS;
    return selectedRuns.filter((run) => run.startedAt >= since && run.status !== "skipped");
  }, [selectedRuns, now]);
  const successCount = last7Runs.filter((run) => run.status === "ok" || run.status === "delivered").length;
  const successRate = last7Runs.length > 0 ? Math.round((successCount / last7Runs.length) * 100) : undefined;
  const averageDuration = useMemo(() => {
    const timed = last7Runs.filter((run) => run.durationMs > 0);
    if (timed.length === 0) return undefined;
    return Math.round(timed.reduce((sum, run) => sum + run.durationMs, 0) / timed.length);
  }, [last7Runs]);
  const nextRunAt = selectedTask && selectedTask.enabled && !selectedTask.completedAt && !selectedTask.workspaceIssue
    ? nextAutomationRun(selectedTask.schedule, now)
    : undefined;
  const trend = useMemo(() => (selectedTask ? weekTrend(runs, selectedTask.id, now) : []), [runs, selectedTask, now]);
  const trendMax = Math.max(1, ...trend.map((day) => day.total));

  // 页头的全局今日概览。
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayRuns = runs.filter((run) => run.startedAt >= startOfToday.getTime() && run.status !== "skipped");
  const todaySuccess = todayRuns.filter((run) => run.status === "ok" || run.status === "delivered").length;
  const todayRate = todayRuns.length > 0 ? Math.round((todaySuccess / todayRuns.length) * 100) : undefined;
  const nextAny = automation
    .filter((task) => task.enabled && !task.completedAt && !task.workspaceIssue)
    .map((task) => nextAutomationRun(task.schedule, now))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];

  function send(command: Parameters<typeof window.piDesktop.send>[0]): void {
    setActionError(undefined);
    void window.piDesktop.send(command).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : "操作失败");
    });
  }

  function deleteTask(task: AutomationTask): void {
    if (!window.confirm(`删除定时任务「${task.name}」？`)) return;
    send({ type: "automation.delete", id: task.id, agentId: task.agentId });
  }

  function openSession(task: AutomationTask): void {
    if (!task.sessionId) return;
    send({ type: "automation.session.open", taskId: task.id });
    onOpenSession();
  }

  function runAction(task: AutomationTask): void {
    const state = automationTaskState(task, runningTaskId);
    if (state === "running") {
      if (!task.sessionId) send({ type: "automation.stop", id: task.id, agentId: task.agentId });
      return;
    }
    send({ type: "automation.run", id: task.id, agentId: task.agentId });
  }

  return (
    <section className="automation-center" data-pane="automation-center" aria-label="自动化中心">
      <header className="automation-center-head">
        <button type="button" className="automation-center-back" data-control="automation-center-back" title="返回对话" onClick={onClose}><ArrowLeft size={14} />返回对话</button>
        <div className="automation-center-heading"><Zap size={16} /><strong>自动化中心</strong><small>{automation.length} 个任务{runningTaskId ? " · 1 运行中" : ""}</small></div>
        <div className="automation-center-head-stats">
          <span>今日 <b>{todayRuns.length + (runningTaskId ? 1 : 0)}</b> 次</span>
          <span>成功率 <b>{todayRate === undefined ? "—" : `${todayRate}%`}</b></span>
          <span>下次触发 <b>{formatAutomationNextRun(nextAny, now) ?? "—"}</b></span>
        </div>
        <span className="automation-center-grow" />
        <button type="button" className="automation-center-new" onClick={() => setForm({ mode: "create" })}><Plus size={14} />新建任务</button>
      </header>

      <div className="automation-center-body">
        <aside className="automation-center-list" aria-label="任务列表">
          <div className="automation-center-list-tools">
            <label className="automation-center-search"><Search size={12} /><input value={query} placeholder="搜索任务" aria-label="搜索任务" onChange={(event) => setQuery(event.target.value)} /></label>
            <div className="automation-center-filters" role="tablist" aria-label="任务筛选">
              {FILTERS.map((item) => <button key={item.value} type="button" role="tab" aria-selected={filter === item.value} className={filter === item.value ? "active" : ""} onClick={() => setFilter(item.value)}>{item.label}</button>)}
            </div>
          </div>
          <div className="automation-center-list-scroll">
            {grouped.length === 0 ? (
              <div className="automation-center-list-empty">{automation.length === 0 ? "还没有定时任务" : "没有匹配的任务"}</div>
            ) : grouped.map((group) => (
              <div className="automation-center-group" key={group.state}>
                <div className={`automation-center-group-label ${group.state}`}><span className={`automation-center-dot ${group.state}`} />{AUTOMATION_STATE_LABEL[group.state]}<em>{group.tasks.length}</em></div>
                {group.tasks.map((task) => {
                  const state = automationTaskState(task, runningTaskId);
                  const next = task.enabled && !task.completedAt && !task.workspaceIssue ? nextAutomationRun(task.schedule, now) : undefined;
                  return (
                    <button type="button" key={task.id} className={`automation-center-task${selectedTask?.id === task.id ? " selected" : ""}${state === "running" ? " running" : ""}`} onClick={() => setSelectedId(task.id)}>
                      <span className={`automation-center-dot ${state}`} />
                      <span className="automation-center-task-copy">
                        <strong>{task.name}</strong>
                        <small>{formatAutomationSchedule(task.schedule, now)}{next !== undefined ? ` · 下次 ${formatAutomationNextRun(next, now)}` : ""}</small>
                      </span>
                      {state === "running" ? <span className="automation-center-live" title="运行中">运行</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="automation-center-list-foot"><span>共 {automation.length} 个任务</span><span>{automation.filter((task) => task.enabled).length} 启用</span></div>
        </aside>

        <main className="automation-center-detail">
          {!selectedTask ? (
            <div className="automation-center-empty">
              <Zap size={24} />
              <strong>{automation.length === 0 ? "还没有定时任务" : "选择左侧任务查看详情"}</strong>
              <p>创建任务后，这里会展示调度、运行记录和最近趋势。</p>
              <button type="button" className="automation-center-new" onClick={() => setForm({ mode: "create" })}><Plus size={14} />创建第一个任务</button>
            </div>
          ) : (() => {
            const state = automationTaskState(selectedTask, runningTaskId);
            const running = state === "running";
            return (
              <>
                <div className="automation-center-detail-head">
                  <div className="automation-center-avatar"><Zap size={20} /></div>
                  <div className="automation-center-detail-title">
                    <div className="automation-center-title-row">
                      <h1>{selectedTask.name}</h1>
                      <span className={`automation-center-state ${state}`}>{AUTOMATION_STATE_LABEL[state]}</span>
                      {selectedTask.workspaceIssue ? <span className="automation-center-issue" title={selectedTask.workspaceIssue}><AlertCircle size={12} />需重新选择工作区</span> : null}
                    </div>
                    <div className="automation-center-detail-sub"><CalendarClock size={12} />{formatAutomationSchedule(selectedTask.schedule, now)}{nextRunAt !== undefined ? <><span>·</span>下次 <b>{formatAutomationNextRun(nextRunAt, now)}</b></> : null}</div>
                    <div className="automation-center-chips">
                      <span><Bot size={11} />{agentNames.get(selectedTask.agentId) ?? selectedTask.agentId}</span>
                      {selectedTask.workspace ? <span><Folder size={11} />{workspaceDisplayName(selectedTask.workspace)}</span> : null}
                      <span><Cpu size={11} />{selectedTask.model ? selectedTask.model.id : "继承默认"}</span>
                      <span><Key size={11} />{ACCESS_LABEL[selectedTask.accessMode]}</span>
                      <span><MessageSquare size={11} />{selectedTask.sessionId ? "关联会话投递" : "后台新会话"}</span>
                    </div>
                  </div>
                  <div className="automation-center-actions">
                    {running ? (
                      selectedTask.sessionId
                        ? <span className="automation-center-action muted">投递中…</span>
                        : <button type="button" className="automation-center-action danger" data-control="automation-stop" title="停止本次运行" onClick={() => runAction(selectedTask)}><Square size={12} />停止本次</button>
                    ) : (
                      <button type="button" className="automation-center-action primary" data-control="automation-run" disabled={Boolean(selectedTask.workspaceIssue)} onClick={() => runAction(selectedTask)}><Play size={12} />运行一次</button>
                    )}
                    <button type="button" className={`automation-center-toggle${selectedTask.enabled ? " on" : ""}`} data-control="automation-toggle" role="switch" aria-checked={selectedTask.enabled} aria-label={selectedTask.enabled ? "暂停任务" : "启用任务"} disabled={Boolean(selectedTask.completedAt) || Boolean(selectedTask.workspaceIssue)} title={selectedTask.enabled ? "暂停任务" : "启用任务"} onClick={() => send({ type: "automation.toggle", id: selectedTask.id, enabled: !selectedTask.enabled, agentId: selectedTask.agentId })} />
                    <button type="button" className="automation-center-action" title="编辑任务" onClick={() => setForm({ mode: "edit", task: selectedTask })}><Pencil size={12} />编辑</button>
                    {selectedTask.sessionId ? <button type="button" className="automation-center-action" title="打开关联会话" onClick={() => openSession(selectedTask)}><MessageSquare size={12} />关联会话</button> : null}
                    <button type="button" className="automation-center-action danger" title="删除任务" onClick={() => deleteTask(selectedTask)}><Trash2 size={12} /></button>
                  </div>
                </div>

                <div className="automation-center-stats">
                  <div><span>近 7 天运行</span><strong>{last7Runs.length}<em>次</em></strong></div>
                  <div><span>成功率</span><strong className={successRate === 100 ? "good" : ""}>{successRate === undefined ? "—" : `${successRate}%`}</strong></div>
                  <div><span>平均耗时</span><strong>{averageDuration === undefined ? "—" : formatElapsed(averageDuration)}</strong></div>
                  <div><span>下次触发</span><strong className="accent">{formatAutomationNextRun(nextRunAt, now) ?? "—"}</strong></div>
                </div>

                <div className="automation-center-main">
                  <section className="automation-center-runs-card">
                    <header className="automation-center-card-head"><h3><Clock size={13} />运行记录</h3><span>共 {selectedRuns.length} 条</span><span className="automation-center-grow" /><span className="automation-center-hint">按任务筛选</span></header>
                    <AutomationRuns settings={settings} activeAgentId={activeAgentId} initialTaskFilter={selectedTask.id} onOpenSession={onOpenSession} />
                  </section>
                  <aside className="automation-center-rail">
                    <section className="automation-center-card">
                      <header className="automation-center-card-head"><h3><CalendarClock size={13} />任务参数</h3></header>
                      <div className="automation-center-params">
                        <ParamRow icon={<CalendarClock size={11} />} label="调度" value={selectedTask.schedule.kind === "cron" ? selectedTask.schedule.cron : "仅一次"} title={formatAutomationSchedule(selectedTask.schedule, now)} />
                        {selectedTask.schedule.kind === "cron" && <ParamRow icon={<Clock size={11} />} label="时区" value={selectedTask.schedule.timezone ?? "本地"} />}
                        <ParamRow icon={<Bot size={11} />} label="角色" value={agentNames.get(selectedTask.agentId) ?? selectedTask.agentId} />
                        <ParamRow icon={<Folder size={11} />} label="工作区" value={selectedTask.workspace ? workspaceDisplayName(selectedTask.workspace) : "关联会话"} title={selectedTask.workspace} />
                        <ParamRow icon={<Cpu size={11} />} label="模型" value={selectedTask.model ? selectedTask.model.id : "继承默认"} />
                        <ParamRow icon={<Key size={11} />} label="权限" value={ACCESS_LABEL[selectedTask.accessMode]} />
                        <ParamRow icon={<MessageSquare size={11} />} label="执行方式" value={selectedTask.sessionId ? "关联会话" : "后台新会话"} />
                        {selectedTask.lastRun && <ParamRow icon={<Check size={11} />} label="上次运行" value={`${formatShortTime(selectedTask.lastRun.startedAt, now)} · ${AUTOMATION_LAST_RUN_LABEL[selectedTask.lastRun.status]}`} title={selectedTask.lastRun.preview ?? selectedTask.lastRun.error} />}
                      </div>
                    </section>

                    <section className="automation-center-card">
                      <header className="automation-center-card-head"><h3><Zap size={13} />任务提示词</h3><span className="automation-center-grow" /><button type="button" className="automation-center-link" onClick={() => setForm({ mode: "edit", task: selectedTask })}>编辑<ChevronRight size={11} /></button></header>
                      <p className="automation-center-prompt">{selectedTask.prompt}</p>
                    </section>

                    <section className="automation-center-card">
                      <header className="automation-center-card-head"><h3><Clock size={13} />近 7 天运行</h3><span>{last7Runs.length} 次</span></header>
                      <div className="automation-center-trend">
                        {trend.map((day) => (
                          <div className={`automation-center-trend-day${day.today ? " today" : ""}`} key={day.label} title={`${day.label}：${day.total} 次${day.errors ? `，${day.errors} 次失败` : ""}`}>
                            <div className="automation-center-trend-bar"><i className={day.errors > 0 ? "bad" : ""} style={{ height: `${Math.max(6, Math.round((day.total / trendMax) * 100))}%` }} /></div>
                            <span>{day.label}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  </aside>
                </div>
              </>
            );
          })()}
        </main>
      </div>

      {actionError ? <div className="automation-center-error"><AlertCircle size={13} /><span>{actionError}</span><button type="button" title="关闭" aria-label="关闭错误提示" onClick={() => setActionError(undefined)}><X size={12} /></button></div> : null}

      {formPresence.rendered && (() => {
        const current = formPresence.value;
        if (!current) return null;
        return (
          <ExitWrap exiting={formPresence.exiting}>
            <AutomationForm
              initial={current.mode === "edit" ? current.task : null}
              models={models}
              providers={providers}
              settings={settings}
              workspacePath={workspacePath}
              activeAgentId={activeAgentId}
              onCancel={() => setForm(null)}
              onSubmit={(task) => { send({ type: "automation.save", task }); setForm(null); }}
            />
          </ExitWrap>
        );
      })()}
    </section>
  );
}
