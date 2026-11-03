// 右侧「自动化」面板（P0）：任务状态 / 下次触发 / 最近结果 / 运行记录 + 快捷控制。
// 数据源全部来自 store 的 automation / automationRuns / automationRun 推送；控制走
// 现有 automation.* 命令（停止为 2026-11-02 新增的 automation.stop）。
// 设计稿：outputs/automation-panel-designs.html（方案 B）；「管理全部」由 App 打开
// P1 的 AutomationCenter 管理页。

import { AlertCircle, Bot, CalendarClock, Check, ChevronRight, Clock, Folder, MessageSquare, Pencil, Play, Plus, Search, Settings2, Square, Trash2, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AutomationTask, DesktopSettings, ModelOption, ProviderOption } from "../../shared/protocol";
import { formatAutomationNextRun, formatAutomationSchedule, nextAutomationRun } from "../../shared/automation";
import { AUTOMATION_LAST_RUN_LABEL, AUTOMATION_STATE_LABEL, automationTaskState, automationTaskStateRank, formatElapsed, formatShortTime, workspaceDisplayName, type AutomationTaskState } from "./lib/automation-task-view";
import { AutomationForm } from "./AutomationSettings";
import { AutomationRuns, type AutomationRunsHighlight } from "./AutomationRuns";
import { ExitWrap, useExitPresenceValue } from "./components/Presence";
import { useDesktopStore } from "./store";

export type AutomationPanelTab = "tasks" | "runs";

export interface AutomationPanelProps {
  models: ModelOption[];
  providers: ProviderOption[];
  settings: DesktopSettings;
  workspacePath?: string;
  activeAgentId: string;
  tab: AutomationPanelTab;
  onTabChange(tab: AutomationPanelTab): void;
  highlight?: AutomationRunsHighlight;
  onClose(): void;
  onManageAll(): void;
  /** 打开某次运行/任务关联会话后，由宿主决定是否收起面板（P0 收起）。 */
  onOpenSession(): void;
}

type TaskFilter = "all" | "running" | "paused";

/**
 * 任务卡的动作区。运行中显示「停止本次」；workspaceIssue 禁用运行/启停；
 * 一次性已完成任务的启停禁用但允许查看/编辑/删除。
 */
function TaskActions({
  task,
  state,
  runningSince,
  now,
  onRun,
  onToggle,
  onEdit,
  onDelete,
  onOpenSession
}: {
  task: AutomationTask;
  state: AutomationTaskState;
  runningSince?: number;
  now: number;
  onRun(): void;
  onToggle(): void;
  onEdit(): void;
  onDelete(): void;
  onOpenSession(): void;
}): ReactNode {
  const completed = state === "completed";
  const issue = state === "issue";
  return (
    <div className="automation-panel-task-actions">
      {state === "running" ? (
        task.sessionId ? (
          <span className="automation-panel-action" title="会话绑定任务正在投递提醒，投递后不可停止">投递中…</span>
        ) : (
          <button type="button" className="automation-panel-action danger" data-control="automation-stop" title="停止本次运行（只中止本次，不暂停任务）" onClick={onRun}>
            <Square size={11} />停止本次
            {runningSince !== undefined && <span className="automation-panel-running-time">{formatElapsed(now - runningSince)}</span>}
          </button>
        )
      ) : (
        <button type="button" className="automation-panel-action primary" data-control="automation-run" disabled={issue} title={issue ? "需重新选择工作区" : "立即运行一次"} onClick={onRun}>
          <Play size={11} />运行一次
        </button>
      )}
      <button
        type="button"
        className={`automation-panel-toggle${task.enabled ? " on" : ""}`}
        data-control="automation-toggle"
        role="switch"
        aria-checked={task.enabled}
        aria-label={task.enabled ? "暂停任务" : "启用任务"}
        disabled={completed || issue}
        title={issue ? "需重新选择工作区后才能启用" : completed ? "一次性任务已完成，编辑改期可重新启用" : task.enabled ? "暂停任务" : "启用任务"}
        onClick={onToggle}
      />
      <button type="button" className="automation-panel-action" title="编辑任务" aria-label="编辑任务" onClick={onEdit}><Pencil size={12} /></button>
      {task.sessionId && <button type="button" className="automation-panel-action" title="打开关联会话" aria-label="打开关联会话" onClick={onOpenSession}><MessageSquare size={12} /></button>}
      <span className="automation-panel-grow" />
      <button type="button" className="automation-panel-action danger" title="删除任务" aria-label="删除任务" onClick={onDelete}><Trash2 size={12} /></button>
    </div>
  );
}

export function AutomationPanel({
  models,
  providers,
  settings,
  workspacePath,
  activeAgentId,
  tab,
  onTabChange,
  highlight,
  onClose,
  onManageAll,
  onOpenSession
}: AutomationPanelProps): ReactNode {
  const automation = useDesktopStore((state) => state.automation);
  const runs = useDesktopStore((state) => state.automationRuns);
  const live = useDesktopStore((state) => state.automationRun);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [form, setForm] = useState<{ mode: "create" } | { mode: "edit"; task: AutomationTask } | null>(null);
  const [actionError, setActionError] = useState<string>();
  const formPresence = useExitPresenceValue(form, 160);
  const runningTaskId = live?.status === "running" ? live.id : undefined;
  const runningSince = live?.status === "running" ? live.at : undefined;

  // 运行中按秒刷新耗时；空闲时 30 秒足够更新「下次触发」倒计时。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), runningTaskId ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [runningTaskId]);

  const agentNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const agent of settings.agents) names.set(agent.id, agent.name);
    return names;
  }, [settings.agents]);

  const nextAt = useMemo(() => {
    let earliest: number | undefined;
    for (const task of automation) {
      if (!task.enabled || task.completedAt || task.workspaceIssue) continue;
      const candidate = nextAutomationRun(task.schedule, now);
      if (candidate !== undefined && (earliest === undefined || candidate < earliest)) earliest = candidate;
    }
    return earliest;
  }, [automation, now]);

  const todayRuns = useMemo(() => {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return runs.filter((run) => run.startedAt >= startOfToday.getTime() && run.status !== "skipped");
  }, [runs, now]);
  const todaySuccess = todayRuns.filter((run) => run.status === "ok" || run.status === "delivered").length;
  const todayRate = todayRuns.length > 0 ? Math.round((todaySuccess / todayRuns.length) * 100) : undefined;
  const nextText = formatAutomationNextRun(nextAt, now);
  // 汇总卡只有 ~110px：只显示相对时间（5 分钟后 / 1 天后），完整日期放 title。
  const nextShort = nextText?.includes(" · ") ? nextText.slice(nextText.indexOf(" · ") + 3) : nextText;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return automation
      .filter((task) => {
        const state = automationTaskState(task, runningTaskId);
        if (filter === "running" && state !== "running") return false;
        if (filter === "paused" && state !== "paused" && state !== "issue") return false;
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

  function send(command: Parameters<typeof window.piDesktop.send>[0]): void {
    setActionError(undefined);
    void window.piDesktop.send(command).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : "操作失败");
    });
  }

  function openSessionForTask(task: AutomationTask): void {
    if (!task.sessionId) return;
    send({ type: "automation.session.open", taskId: task.id });
    onOpenSession();
  }

  function deleteTask(task: AutomationTask): void {
    if (!window.confirm(`删除定时任务「${task.name}」？`)) return;
    send({ type: "automation.delete", id: task.id, agentId: task.agentId });
  }

  return (
    <aside className="automation-panel" data-pane="automation-panel" aria-label="自动化任务面板">
      <header className="automation-panel-head">
        <span className="automation-panel-title"><Zap size={15} /><strong>自动化</strong><small>{automation.length} 个任务{runningTaskId ? " · 1 运行中" : ""}</small></span>
        <button type="button" className="automation-panel-icon" title="新建定时任务" aria-label="新建定时任务" onClick={() => setForm({ mode: "create" })}><Plus size={15} /></button>
        <button type="button" className="automation-panel-icon" data-control="automation-panel-close" title="关闭面板" aria-label="关闭面板" onClick={onClose}><X size={15} /></button>
      </header>

      <div className="automation-panel-summary">
        <div className="automation-panel-stat"><span>今日运行</span><b>{todayRuns.length + (runningTaskId ? 1 : 0)}<em>次</em></b></div>
        <div className="automation-panel-stat"><span>今日成功率</span><b className={todayRate === 100 ? "good" : ""}>{todayRate === undefined ? "—" : `${todayRate}%`}</b></div>
        <div className="automation-panel-stat" title={nextText}><span>下次触发</span><b className="accent">{nextShort ?? "—"}</b></div>
      </div>

      <div className="automation-panel-tabs" role="tablist" aria-label="自动化面板视图">
        <button type="button" role="tab" aria-selected={tab === "tasks"} className={tab === "tasks" ? "active" : ""} onClick={() => onTabChange("tasks")}><Zap size={12} />任务<em>{automation.length}</em></button>
        <button type="button" role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => onTabChange("runs")}><Clock size={12} />运行记录<em>{runs.length}</em></button>
      </div>

      <div className="automation-panel-body">
        {tab === "runs" ? (
          <AutomationRuns
            settings={settings}
            activeAgentId={activeAgentId}
            highlight={highlight}
            compact
            onOpenSession={onOpenSession}
          />
        ) : automation.length === 0 ? (
          <div className="automation-panel-empty">
            <Zap size={22} />
            <strong>还没有定时任务</strong>
            <p>让 Agent 按计划自动跑提示词：可以每天汇总新闻、定时巡检项目，也可以只提醒一次。</p>
            <button type="button" className="automation-panel-empty-action" onClick={() => setForm({ mode: "create" })}><Plus size={13} />创建第一个任务</button>
          </div>
        ) : (
          <>
            <div className="automation-panel-filter">
              <label className="automation-panel-search"><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" /></label>
              <div className="automation-panel-filter-tabs" role="tablist" aria-label="任务筛选">
                <button type="button" role="tab" aria-selected={filter === "all"} className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button>
                <button type="button" role="tab" aria-selected={filter === "running"} className={filter === "running" ? "active" : ""} onClick={() => setFilter("running")}>运行中</button>
                <button type="button" role="tab" aria-selected={filter === "paused"} className={filter === "paused" ? "active" : ""} onClick={() => setFilter("paused")}>已暂停</button>
              </div>
            </div>

            <div className="automation-panel-list">
              {filtered.length === 0
                ? <div className="automation-panel-list-empty">没有匹配的任务</div>
                : filtered.map((task) => {
                  const state = automationTaskState(task, runningTaskId);
                  const lastRun = task.lastRun;
                  const next = task.enabled && !task.completedAt && !task.workspaceIssue ? nextAutomationRun(task.schedule, now) : undefined;
                  return (
                    <article className={`automation-panel-task ${state}`} key={task.id} data-role="automation-task" data-task-id={task.id}>
                      <div className="automation-panel-task-head">
                        <span className={`automation-panel-dot ${state}`} aria-hidden="true" />
                        <div className="automation-panel-task-title">
                          <strong title={task.name}>{task.name}</strong>
                          <span className={`automation-panel-state ${state}`}>{AUTOMATION_STATE_LABEL[state]}</span>
                        </div>
                        {lastRun && <span className={`automation-panel-last-badge ${lastRun.status}`}>{AUTOMATION_LAST_RUN_LABEL[lastRun.status]}</span>}
                      </div>
                      <div className="automation-panel-task-meta">
                        <span><CalendarClock size={11} />{formatAutomationSchedule(task.schedule, now)}</span>
                        {next !== undefined && <span className="automation-panel-next">下次 {formatAutomationNextRun(next, now)}</span>}
                        {task.workspaceIssue && <span className="automation-panel-issue"><AlertCircle size={11} />{task.workspaceIssue}</span>}
                      </div>
                      <div className="automation-panel-task-context">
                        <span><Bot size={11} />{agentNames.get(task.agentId) ?? task.agentId}</span>
                        {task.workspace && <span><Folder size={11} />{workspaceDisplayName(task.workspace)}</span>}
                        {task.sessionId && <span><MessageSquare size={11} />关联会话</span>}
                      </div>
                      {task.prompt && <p className="automation-panel-prompt" title={task.prompt}>{task.prompt}</p>}
                      {lastRun && (
                        <div className={`automation-panel-last ${lastRun.status}`}>
                          <span>{formatShortTime(lastRun.startedAt, now)} · {AUTOMATION_LAST_RUN_LABEL[lastRun.status]}</span>
                          <span>{lastRun.status === "error" ? (lastRun.error ?? "运行失败") : (lastRun.preview ?? "无文本输出")}</span>
                        </div>
                      )}
                      <TaskActions
                        task={task}
                        state={state}
                        runningSince={runningTaskId === task.id ? runningSince : undefined}
                        now={now}
                        onRun={() => {
                          if (state === "running") send({ type: "automation.stop", id: task.id, agentId: task.agentId });
                          else send({ type: "automation.run", id: task.id, agentId: task.agentId });
                        }}
                        onToggle={() => send({ type: "automation.toggle", id: task.id, enabled: !task.enabled, agentId: task.agentId })}
                        onEdit={() => setForm({ mode: "edit", task })}
                        onDelete={() => deleteTask(task)}
                        onOpenSession={() => openSessionForTask(task)}
                      />
                    </article>
                  );
                })}
            </div>
          </>
        )}
      </div>

      {actionError && <div className="automation-panel-error"><AlertCircle size={12} /><span>{actionError}</span><button type="button" className="automation-panel-icon" title="关闭" aria-label="关闭错误提示" onClick={() => setActionError(undefined)}><X size={12} /></button></div>}

      <footer className="automation-panel-foot">
        <span><Check size={11} />自动化会话不进入话题列表</span>
        <button type="button" data-control="automation-panel-manage" onClick={onManageAll}><Settings2 size={12} />管理全部<ChevronRight size={11} /></button>
      </footer>

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
    </aside>
  );
}
