// 设置页「自动化任务」tab：定时任务列表（全部/进行中/已暂停/已完成过滤 + 搜索）+ 创建/编辑表单弹窗。
// 数据源 store.automation（automation 推送维护）；增删改走 automation.* 命令。
//
// 2026-10-21：支持 cron 周期 + after/at 一次性；任务可绑定会话（到期投递回原对话）。

import { CalendarClock, Folder, ListChecks, MessageSquare, MessageSquarePlus, Pencil, Play, Plus, Search, Trash2, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AccessMode, AutomationSchedule, AutomationTask, DesktopSettings, ModelOption, ProviderOption } from "../../shared/protocol";
import { formatAutomationDelay, formatAutomationSchedule } from "../../shared/automation";
import { buildCron, describeCron, DEFAULT_SCHEDULE_PARTS, pad2, SCHEDULE_PRESETS, WEEKDAY_OPTIONS, type SchedulePreset } from "./lib/automation-schedule";
import { selectableCatalogModels } from "./lib/model-list";
import { workspaceDisplayLabel, workspaceKey } from "./lib/session-groups";
import { ModelSelect } from "./components/ModelSelect";
import { useDesktopStore } from "./store";
import { ExitWrap, useExitPresenceValue } from "./components/Presence";
import { AutomationRuns, type AutomationRunsHighlight } from "./AutomationRuns";

type Filter = "all" | "enabled" | "paused" | "completed";
type TimingKind = "cron" | "after" | "at";
type DelayUnit = "minute" | "hour";

const TIMING_OPTIONS: { value: TimingKind; label: string }[] = [
  { value: "cron", label: "周期任务（cron）" },
  { value: "after", label: "仅一次 · 延时" },
  { value: "at", label: "仅一次 · 指定时间" }
];

export interface AutomationSettingsProps {
  models: ModelOption[];
  providers: ProviderOption[];
  settings: DesktopSettings;
  workspaceConfigured: boolean;
  /** 当前工作区完整路径（新调用方传 snapshot.workspace；缺省由组件读快照兜底）。 */
  workspacePath?: string;
  /** 激活会话的助手 id（快照 agentId）；缺省读 store 快照以兼容旧调用。 */
  activeAgentId?: string;
  /** @deprecated 已不再使用（空间标签统一按完整路径推导），仅为旧调用方保留。 */
  workspaceName?: string;
  /** 「去会话中创建」：由宿主先关设置页再新建会话（含分屏落位等完整逻辑）。 */
  onCreateInSession: () => void;
  /** 运行记录「查看会话/切换角色查看」、任务行「打开关联会话」：由宿主先关设置页再跳转目标会话。 */
  onOpenRunSession: () => void;
}

interface AutomationFormProps {
  initial: AutomationTask | null;
  models: ModelOption[];
  providers: ProviderOption[];
  settings: DesktopSettings;
  workspacePath?: string;
  activeAgentId: string;
  onSubmit: (task: AutomationTask) => void;
  onCancel: () => void;
}

const ACCESS_MODES: { value: AccessMode; label: string }[] = [
  { value: "full", label: "完全访问（无人值守推荐）" },
  { value: "workspace", label: "工作区访问" },
  { value: "ask", label: "每次询问" },
  { value: "read-only", label: "只读" }
];

const ACCESS_MODE_SHORT: Record<AccessMode, string> = { full: "完全访问", workspace: "工作区访问", ask: "每次询问", "read-only": "只读" };

const CRON_HINT = "cron 为 5 字段（分 时 日 月 周）。例：0 9 * * 1-5 = 工作日每天 09:00；0 18 * * * = 每天 18:00；*/15 * * * * = 每 15 分钟。";

function numberOptions(from: number, to: number, suffix = ""): { value: number; label: string }[] {
  return Array.from({ length: to - from + 1 }, (_, index) => ({ value: from + index, label: `${pad2(from + index)}${suffix}` }));
}

function agentDefaultModel(settings: DesktopSettings, activeAgentId: string): { provider: string; id: string } | undefined {
  const agent = settings.agents.find((item) => item.id === activeAgentId);
  return agent?.defaultModel ?? settings.model;
}

function isCompleted(task: AutomationTask): boolean {
  return task.completedAt !== undefined;
}

/** 空间下拉候选：路径 + 来源（决定文案）+ 目录是否已失效。 */
interface WorkspaceChoice {
  path: string;
  kind: "current" | "initial" | "recent" | "session" | "picked";
  missing: boolean;
}

/** 空间选项文案：只显示目录名（同名时逐级补上级），完整路径放在 title/hint 里。 */
function workspaceOptionLabel(choice: WorkspaceChoice, allPaths: readonly string[]): string {
  const name = workspaceDisplayLabel(choice.path, allPaths);
  const base = choice.kind === "current" ? `当前工作区（${name}）` : choice.kind === "initial" ? `任务原工作区（${name}）` : name;
  return choice.missing ? `${base} · 目录不存在` : base;
}

function lastRunTitle(task: AutomationTask): string | undefined {
  const lastRun = task.lastRun;
  if (!lastRun) return undefined;
  const time = new Date(lastRun.startedAt).toLocaleString();
  const detail = lastRun.status === "ok" || lastRun.status === "delivered" ? lastRun.preview : lastRun.error;
  return detail ? `${time}\n${detail}` : time;
}

function lastRunLabel(task: AutomationTask): string | undefined {
  if (!task.lastRun) return undefined;
  return task.lastRun.status === "ok"
    ? "已运行"
    : task.lastRun.status === "delivered"
      ? "已投递"
      : task.lastRun.status === "aborted"
        ? "已中止"
        : "运行失败";
}

/** 把 epoch ms 转为 `<input type="datetime-local">` 需要的本地时间串。 */
function toDatetimeLocal(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 从任务反推表单的延时数值与单位（优先整小时，其次整分钟）。 */
function delayParts(seconds: number): { value: number; unit: DelayUnit } {
  if (seconds >= 3_600 && seconds % 3_600 === 0) return { value: seconds / 3_600, unit: "hour" };
  return { value: Math.max(1, Math.round(seconds / 60)), unit: "minute" };
}

function AutomationForm({ initial, models, providers, settings, workspacePath, activeAgentId, onSubmit, onCancel }: AutomationFormProps): ReactNode {
  const sessions = useDesktopStore((state) => state.snapshot.sessions);
  const activeSessionId = useDesktopStore((state) => state.snapshot.sessionId);
  const [name, setName] = useState(initial?.name ?? "");
  const initialCron = initial?.schedule.kind === "cron" ? initial.schedule : undefined;
  const initialSchedule = useMemo(() => (initialCron ? describeCron(initialCron.cron) : DEFAULT_SCHEDULE_PARTS), [initialCron]);
  const [timing, setTiming] = useState<TimingKind>(initial?.schedule.kind ?? "cron");
  const [preset, setPreset] = useState<SchedulePreset>(initialSchedule.preset);
  const [minute, setMinute] = useState(initialSchedule.minute);
  const [hour, setHour] = useState(initialSchedule.hour);
  const [weekday, setWeekday] = useState(initialSchedule.weekday);
  const [monthDay, setMonthDay] = useState(initialSchedule.monthDay);
  const [customCron, setCustomCron] = useState(initialCron?.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(initialCron?.timezone ?? "");
  const initialDelay = initial?.schedule.kind === "after" ? delayParts(initial.schedule.afterSeconds) : { value: 5, unit: "minute" as DelayUnit };
  const [delayValue, setDelayValue] = useState(initialDelay.value);
  const [delayUnit, setDelayUnit] = useState<DelayUnit>(initialDelay.unit);
  const [atValue, setAtValue] = useState(initial?.schedule.kind === "at" ? toDatetimeLocal(initial.schedule.scheduledAt) : toDatetimeLocal(Date.now() + 3_600_000));
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [modelValue, setModelValue] = useState(initial?.model ? `${initial.model.provider}/${initial.model.id}` : "");
  // 「空间」存完整路径：新任务默认当前工作区；编辑保留 task.workspace；workspaceIssue
  // 的任务强制从空值重新选择，避免把不可用的旧路径静默存回去。
  const [workspace, setWorkspace] = useState(initial?.workspaceIssue ? "" : initial?.workspace ?? workspacePath ?? "");
  const recentWorkspaces = useDesktopStore((state) => state.snapshot.recentWorkspaces);
  const [accessMode, setAccessMode] = useState<AccessMode>(initial?.accessMode ?? "full");
  const [target, setTarget] = useState<"background" | "session">(initial?.sessionId ? "session" : "background");
  const [sessionId, setSessionId] = useState(initial?.sessionId ?? "");
  const [error, setError] = useState<string>();

  const defaultModel = agentDefaultModel(settings, activeAgentId);
  // 与全局模型选择器同口径：只保留已勾选（enabled !== false）且已配置的模型。
  const configuredModels = useMemo(() => selectableCatalogModels(models).filter((model) => model.configured), [models]);
  const resolvedCron = preset === "custom" ? customCron.trim() : buildCron({ preset, minute, hour, weekday, monthDay });
  // 归属角色：编辑保留原归属，新建默认当前角色；创建后不迁移。
  const ownerAgentId = initial?.agentId ?? activeAgentId;
  const ownerName = settings.agents.find((item) => item.id === ownerAgentId)?.name ?? ownerAgentId;

  // 会话下拉：只列归属角色自己的会话（跨助手列表上线后不能把别人的会话
  // 静默绑给当前任务）；当前激活会话排最前；编辑旧任务时保留已不在列表的
  // 绑定会话，并在选项上标出它的真实归属助手。
  const sessionChoices = useMemo(() => {
    const sorted = sessions
      .filter((session) => session.agentId === ownerAgentId)
      .sort((left, right) => {
        if (left.id === activeSessionId) return -1;
        if (right.id === activeSessionId) return 1;
        return right.modifiedAt - left.modifiedAt;
      });
    const choices = sorted.map((session) => ({ id: session.id, title: session.title, modifiedAt: session.modifiedAt, agentId: session.agentId }));
    if (initial?.sessionId && !choices.some((choice) => choice.id === initial.sessionId)) {
      const initialSession = sessions.find((session) => session.id === initial.sessionId);
      choices.unshift({
        id: initial.sessionId,
        title: initial.sessionTitle ?? initialSession?.title ?? initial.sessionId,
        modifiedAt: initial.createdAt,
        agentId: initialSession?.agentId ?? ownerAgentId
      });
    }
    return choices;
  }, [sessions, activeSessionId, initial, ownerAgentId]);

  // 空间候选（2026-10-26）：除当前/任务原工作区外，把最近工作区与有会话的工作区一并列出；
  // 都不在清单里时用「浏览…」直接调系统目录选择器选任意目录（后台执行只要求目录存在）。
  const workspaceChoices = useMemo(() => {
    const byKey = new Map<string, WorkspaceChoice>();
    const add = (path: string | undefined, kind: WorkspaceChoice["kind"], missing = false): void => {
      const trimmed = path?.trim();
      if (!trimmed) return;
      const key = workspaceKey(trimmed);
      const existing = byKey.get(key);
      if (existing) {
        if (missing) existing.missing = true;
        return;
      }
      byKey.set(key, { path: trimmed, kind, missing });
    };
    add(workspacePath, "current");
    if (!initial?.workspaceIssue) add(initial?.workspace, "initial");
    for (const recent of recentWorkspaces) add(recent.path, "recent", recent.missing);
    for (const session of sessions) add(session.workspace, "session", session.workspaceMissing);
    add(workspace, "picked");
    return [...byKey.values()];
  }, [workspacePath, initial?.workspace, initial?.workspaceIssue, recentWorkspaces, sessions, workspace]);
  const workspaceChoicePaths = workspaceChoices.map((choice) => choice.path);
  const selectedWorkspace = workspaceChoices.find((choice) => workspaceKey(choice.path) === workspaceKey(workspace));

  async function browseWorkspace(): Promise<void> {
    try {
      const path = await window.piDesktop.chooseWorkspace();
      if (path) {
        setWorkspace(path);
        setError(undefined);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "选择工作区失败");
    }
  }

  const selectedSession = sessions.find((session) => session.id === sessionId);

  function submit(): void {
    if (!name.trim()) { setError("请填写任务名称"); return; }
    if (!prompt.trim()) { setError("请填写任务提示词"); return; }

    let schedule: AutomationSchedule;
    if (timing === "cron") {
      if (!resolvedCron) { setError("请填写 cron 调度表达式"); return; }
      if (resolvedCron.split(/\s+/u).length !== 5) { setError("cron 需要 5 个字段（分 时 日 月 周），如 0 9 * * 1-5"); return; }
      schedule = { kind: "cron", cron: resolvedCron, ...(timezone.trim() ? { timezone: timezone.trim() } : {}) };
    } else if (timing === "after") {
      const unitSeconds = delayUnit === "hour" ? 3_600 : 60;
      const afterSeconds = Math.round(delayValue * unitSeconds);
      if (!Number.isFinite(afterSeconds) || afterSeconds < 1) { setError("延时必须大于 0"); return; }
      schedule = { kind: "after", afterSeconds, scheduledAt: Date.now() + afterSeconds * 1_000 };
    } else {
      const scheduledAt = new Date(atValue).getTime();
      if (!Number.isFinite(scheduledAt)) { setError("请选择有效的执行时间"); return; }
      if (scheduledAt <= Date.now()) { setError("执行时间必须晚于当前时间"); return; }
      schedule = { kind: "at", scheduledAt };
    }

    if (target === "session" && !sessionId) { setError("请选择要关联的会话"); return; }
    if (target === "background" && !workspace.trim()) { setError(initial?.workspaceIssue ? "需重新选择工作区" : "请选择后台任务执行的工作区"); return; }

    const model = modelValue ? (() => { const slash = modelValue.indexOf("/"); return slash > 0 ? { provider: modelValue.slice(0, slash), id: modelValue.slice(slash + 1) } : undefined; })() : undefined;
    const keepInitialSession = target === "session" && !selectedSession && initial?.sessionId === sessionId;
    const sessionFields = target === "session"
      ? {
          sessionId,
          ...(selectedSession?.path || keepInitialSession ? { sessionPath: selectedSession?.path ?? initial?.sessionPath } : {}),
          ...(selectedSession?.title || keepInitialSession ? { sessionTitle: selectedSession?.title ?? initial?.sessionTitle } : {}),
          ...(selectedSession?.workspace || keepInitialSession ? { workspace: selectedSession?.workspace ?? initial?.workspace } : {})
        }
      : {};
    // 已完成的一次性任务改期后重新启用；其他任务保留原启停状态。
    const enabled = initial && isCompleted(initial) ? true : (initial?.enabled ?? true);

    onSubmit({
      id: initial?.id ?? "",
      name: name.trim(),
      schedule,
      prompt: prompt.trim(),
      agentId: ownerAgentId,
      ...sessionFields,
      // 空间存完整路径；用户重选后不再带 workspaceIssue（保存即清除）。
      ...(target === "background" ? { workspace: workspace.trim() || undefined } : {}),
      model,
      accessMode,
      enabled,
      createdAt: initial?.createdAt ?? Date.now(),
      // 编辑保留近一次运行摘要（否则 normalize 会因缺少该字段而抹掉）。
      ...(initial?.lastRun ? { lastRun: initial.lastRun } : {})
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="automation-dialog" data-pane="automation-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><ListChecks size={18} /><div><h2>{initial ? "编辑定时任务" : "创建定时任务"}</h2><p>到点后让 Agent 执行提示词；可绑定会话，把提醒作为消息投递回原对话。</p></div></div>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={onCancel}><X size={17} /></button>
        </header>
        <div className="automation-dialog-body">
          <p className="automation-hint">归属角色：<strong className="automation-owner">{ownerName}</strong>{initial ? "（创建后不迁移）" : "——创建后不迁移，仅该角色激活时执行"}</p>
          <div className="automation-field-grid">
            <label>任务名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如: 每日项目巡检" /></label>
            {timing === "cron" && <label>时区<input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="跟随系统（留空）" /></label>}
          </div>
          <label>触发方式<select value={timing} onChange={(event) => setTiming(event.target.value as TimingKind)}>{TIMING_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>

          {timing === "cron" ? (
            <>
              <label>调度方式<select value={preset} onChange={(event) => setPreset(event.target.value as SchedulePreset)}>{SCHEDULE_PRESETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              {preset === "custom" ? (
                <>
                  <label>调度表达式（cron）<input value={customCron} onChange={(event) => setCustomCron(event.target.value)} placeholder="0 9 * * 1-5" /></label>
                  <p className="automation-hint">{CRON_HINT}</p>
                </>
              ) : (
                <>
                  <div className="automation-field-grid">
                    {preset === "hourly" && <label>第几分钟<select value={minute} onChange={(event) => setMinute(Number(event.target.value))}>{numberOptions(0, 59, " 分").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
                    {preset === "weekly" && <label>周几<select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>{WEEKDAY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
                    {preset === "monthly" && <label>每月几号<select value={monthDay} onChange={(event) => setMonthDay(Number(event.target.value))}>{numberOptions(1, 31, " 日").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
                    {preset !== "hourly" && <label>执行时间<div className="automation-time-pair"><select value={hour} onChange={(event) => setHour(Number(event.target.value))} aria-label="小时">{numberOptions(0, 23, " 时").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><select value={minute} onChange={(event) => setMinute(Number(event.target.value))} aria-label="分钟">{numberOptions(0, 59, " 分").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></label>}
                  </div>
                  <p className="automation-hint">等价表达式：<code className="automation-cron-preview">{resolvedCron}</code>{preset === "monthly" && "（部分月份无该日期时当月不触发）"}</p>
                </>
              )}
            </>
          ) : timing === "after" ? (
            <>
              <div className="automation-field-grid">
                <label>延时<input type="number" min={1} value={delayValue} onChange={(event) => setDelayValue(Number(event.target.value))} /></label>
                <label>单位<select value={delayUnit} onChange={(event) => setDelayUnit(event.target.value as DelayUnit)}><option value="minute">分钟</option><option value="hour">小时</option></select></label>
              </div>
              <p className="automation-hint">从保存时刻起算，只触发一次；约 {formatAutomationDelay(Math.max(1, Math.round(delayValue * (delayUnit === "hour" ? 3_600 : 60))))}后。调度器每 60 秒检查一次，实际误差不超过约 1 分钟。</p>
            </>
          ) : (
            <label>执行时间<input type="datetime-local" value={atValue} onChange={(event) => setAtValue(event.target.value)} /><span className="automation-hint">只触发一次；必须晚于当前时间。</span></label>
          )}

          <label>模型<ModelSelect models={configuredModels} providers={providers} value={modelValue} placeholder={defaultModel ? `继承默认（${defaultModel.id}）` : "请先配置并选择模型"} onChange={setModelValue} /></label>
          <label>任务提示词<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder="描述定时任务执行时要让 Agent 做什么。绑定会话时可直接写「检查刚才的后台任务」这类依赖上文的指令。" /></label>
          <div className="automation-field-grid">
            <label>执行位置<select value={target} onChange={(event) => setTarget(event.target.value as "background" | "session")}><option value="background">后台新会话（独立执行）</option><option value="session">关联会话（到期投递消息）</option></select></label>
            {target === "session" ? (
              <label>关联会话<select value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">请选择会话</option>{sessionChoices.map((choice) => { const owner = choice.agentId !== ownerAgentId ? settings.agents.find((agent) => agent.id === choice.agentId)?.name ?? choice.agentId : undefined; return <option key={choice.id} value={choice.id}>{choice.title}{choice.id === activeSessionId ? "（当前）" : ""}{owner ? ` · ${owner}` : ""}</option>; })}</select></label>
            ) : (
              <div className="automation-workspace-field">
                {/* select 必须留在 label 里：label 的 11px 字号是下拉与选项的字号来源，
                    移出 label 后会继承到根字号（16px）——原生下拉会变成刺眼的大字。
                    「浏览…」放 label 外，避开 label 把点击转发给 select 的默认行为。 */}
                <label>空间<select data-control="automation-workspace" value={workspace} title={workspace || undefined} onChange={(event) => setWorkspace(event.target.value)}>
                  {workspace === "" ? <option value="">请选择工作区</option> : null}
                  {workspaceChoices.map((choice) => (
                    <option key={workspaceKey(choice.path)} value={choice.path} title={choice.path}>{workspaceOptionLabel(choice, workspaceChoicePaths)}</option>
                  ))}
                </select></label>
                <button type="button" className="secondary-button" data-control="automation-choose-workspace" title="浏览任意文件夹作为任务工作区" onClick={() => void browseWorkspace()}>浏览…</button>
              </div>
            )}
          </div>
          {target === "background" && <p className="automation-hint automation-workspace-path">{selectedWorkspace?.missing ? `目录不存在：${workspace}——任务到点会因工作区失效被暂停，请重新选择或浏览其他文件夹。` : workspace ? `完整路径：${workspace}` : "后台任务需要一个工作区目录；可从列表选，也可「浏览…」挑任意文件夹。"}</p>}
          {target === "background" && initial?.workspaceIssue && <p className="automation-form-error">需重新选择工作区：{initial.workspaceIssue}</p>}
          <div className="automation-field-grid">
            <label>权限<select value={accessMode} onChange={(event) => setAccessMode(event.target.value as AccessMode)}>{ACCESS_MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label>目标说明<span className="automation-hint">{target === "session" ? "到期把提醒作为普通用户消息投递进所选会话（沿用该会话上下文与权限）。" : "到期新建后台会话独立执行（旧行为，适合巡检/报告）。"}</span></label>
          </div>
          <p className="automation-hint">无人值守下建议「完全访问」：受限权限遇到工具确认会挂起。关联会话任务沿用原会话的权限模式。</p>
          {error && <p className="automation-form-error">{error}</p>}
        </div>
        <footer><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button type="button" className="primary-button" onClick={submit}>{initial ? "保存" : "创建"}</button></footer>
      </section>
    </div>
  );
}

export function AutomationSettings({ models, providers, settings, workspaceConfigured, workspacePath, activeAgentId, onCreateInSession, onOpenRunSession }: AutomationSettingsProps): ReactNode {
  const automation = useDesktopStore((state) => state.automation);
  const sessions = useDesktopStore((state) => state.snapshot.sessions);
  const snapshotAgentId = useDesktopStore((state) => state.snapshot.agentId);
  const snapshotWorkspace = useDesktopStore((state) => state.snapshot.workspace);
  // 当前助手/工作区都以激活会话快照为准；显式 props 优先（App 已传 snapshot 值）。
  // 归档助手不能新建/接管自动化任务：当前激活会话属于归档助手时回落到未归档助手。
  const requestedAgentId = activeAgentId ?? snapshotAgentId;
  const requestedProfile = settings.agents.find((agent) => agent.id === requestedAgentId);
  const effectiveActiveAgentId = requestedProfile?.archived
    ? (settings.agents.find((agent) => !agent.archived)?.id ?? requestedAgentId)
    : requestedAgentId;
  // 新语义：不接受旧 settings.workspace（已废弃停写）；缺省用焦点会话工作区。
  const resolvedWorkspacePath = workspacePath ?? snapshotWorkspace;
  const runsSignal = useDesktopStore((state) => state.automationRunsSignal);
  // 子页：任务列表（默认）/ 运行记录；toast「查看结果」信号切入运行记录子页并高亮该条。
  const [runsTab, setRunsTab] = useState<"tasks" | "runs">("tasks");
  const [pendingHighlight, setPendingHighlight] = useState<AutomationRunsHighlight | undefined>(undefined);
  useEffect(() => {
    if (!runsSignal) return;
    setRunsTab("runs");
    setPendingHighlight({ runId: runsSignal.runId, at: runsSignal.at });
    // 一次性消费：清除信号，避免下次打开设置页仍停留在「运行记录」子页。
    useDesktopStore.setState({ automationRunsSignal: undefined });
  }, [runsSignal]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<{ mode: "create" } | { mode: "edit"; task: AutomationTask } | null>(null);
  // 创建/编辑弹窗的关闭退场（styles.css automation-dialog 退场 160ms）。
  const formPresence = useExitPresenceValue(form, 160);

  const counts = useMemo(() => ({
    all: automation.length,
    enabled: automation.filter((task) => task.enabled).length,
    paused: automation.filter((task) => !task.enabled && !isCompleted(task)).length,
    completed: automation.filter((task) => isCompleted(task)).length
  }), [automation]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return automation.filter((task) => {
      if (filter === "enabled" && !task.enabled) return false;
      if (filter === "paused" && (task.enabled || isCompleted(task))) return false;
      if (filter === "completed" && !isCompleted(task)) return false;
      if (q && !task.name.toLowerCase().includes(q) && !formatAutomationSchedule(task.schedule).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [automation, filter, query]);

  // 按归属角色分组：组名取 Agent 显示名，找不到（归档/未知角色）回落 agentId。
  const groups = useMemo(() => {
    const names = new Map<string, string>();
    for (const agent of settings.agents) names.set(agent.id, agent.name);
    const byAgent = new Map<string, { name: string; tasks: AutomationTask[] }>();
    for (const task of filtered) {
      const entry = byAgent.get(task.agentId) ?? { name: names.get(task.agentId) ?? task.agentId, tasks: [] };
      entry.tasks.push(task);
      byAgent.set(task.agentId, entry);
    }
    return [...byAgent.values()];
  }, [filtered, settings.agents]);

  function send(command: Parameters<typeof window.piDesktop.send>[0]): void { void window.piDesktop.send(command); }

  function sessionTitle(task: AutomationTask): string {
    return sessions.find((session) => session.id === task.sessionId)?.title ?? task.sessionTitle ?? task.sessionId ?? "关联会话";
  }

  return (
    <div className="automation-settings" data-pane="automation-settings">
      <header className="automation-settings-head">
        <div><h3><Zap size={15} className="automation-head-icon" />自动化任务</h3><p>按 cron 周期或一次性延时调度；可让提醒回到原会话继续处理。</p></div>
        <div className="automation-head-actions">
          <button type="button" className="secondary-button" disabled={!workspaceConfigured} onClick={onCreateInSession}><MessageSquarePlus size={15} />去会话中创建</button>
          <button type="button" className="primary-button" disabled={!workspaceConfigured} onClick={() => setForm({ mode: "create" })}><Plus size={15} />创建定时任务</button>
        </div>
      </header>

      <div className="automation-sub-tabs" role="tablist" aria-label="自动化任务视图">
        <button type="button" className={runsTab === "tasks" ? "active" : ""} role="tab" aria-selected={runsTab === "tasks"} onClick={() => setRunsTab("tasks")}>任务</button>
        <button type="button" className={runsTab === "runs" ? "active" : ""} role="tab" aria-selected={runsTab === "runs"} data-control="automation-runs-tab" onClick={() => setRunsTab("runs")}>运行记录</button>
      </div>

      {runsTab === "runs" ? <AutomationRuns settings={settings} activeAgentId={effectiveActiveAgentId} highlight={pendingHighlight} onOpenSession={onOpenRunSession} /> : <>

      <div className="automation-settings-body">
      <div className="automation-filter-bar">
        <div className="automation-filter-tabs">
          <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部<span className="automation-filter-count">{counts.all}</span></button>
          <button type="button" className={filter === "enabled" ? "active" : ""} onClick={() => setFilter("enabled")}>进行中<span className="automation-filter-count">{counts.enabled}</span></button>
          <button type="button" className={filter === "paused" ? "active" : ""} onClick={() => setFilter("paused")}>已暂停<span className="automation-filter-count">{counts.paused}</span></button>
          <button type="button" className={filter === "completed" ? "active" : ""} onClick={() => setFilter("completed")}>已完成<span className="automation-filter-count">{counts.completed}</span></button>
        </div>
        <label className="automation-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" /></label>
      </div>

      {filtered.length === 0
        ? <div className="automation-empty">
            <ListChecks size={22} />
            <strong>{automation.length === 0 ? "还没有定时任务" : "没有匹配的任务"}</strong>
            <p>{automation.length === 0 ? "点击右上角「创建定时任务」手动配置，或「去会话中创建」让 AI 帮你设置。任务归属当前角色，其他角色的任务会按角色分组展示在这里。" : "换个关键词或切换过滤条件试试。"}</p>
          </div>
        : <div className="automation-groups">
            {groups.map((group) => (
              <section className="automation-group" key={group.name}>
                <header className="automation-group-head">
                  <strong>{group.name}</strong>
                  <span>{group.tasks.length} 条</span>
                </header>
                <div className="automation-list">
                  {group.tasks.map((task) => {
                    const completed = isCompleted(task);
                    return (
                      <div className="automation-row" key={task.id} data-role="automation-task">
                        <span className={`automation-row-dot ${task.enabled ? "on" : "off"}`} aria-hidden="true" />
                        <div className="automation-row-main">
                          <div className="automation-row-title">
                            <strong>{task.name}</strong>
                            {task.workspaceIssue && <span className="automation-row-lastrun error" title={task.workspaceIssue}>需重新选择工作区</span>}
                            {task.lastRun && <span className={`automation-row-lastrun ${task.lastRun.status}`} title={lastRunTitle(task)}>{lastRunLabel(task)}</span>}
                            <span className={`automation-row-state ${completed ? "done" : task.enabled ? "on" : "off"}`}>{completed ? "已完成" : task.enabled ? "进行中" : "已暂停"}</span>
                          </div>
                          <div className="automation-row-meta">
                            <span><CalendarClock size={12} />{formatAutomationSchedule(task.schedule)}</span>
                            <span>{ACCESS_MODE_SHORT[task.accessMode]}</span>
                            {task.model && <span>{task.model.id}</span>}
                            {task.sessionId && (
                              <button
                                type="button"
                                className="automation-session-link"
                                title={`打开关联会话：${sessionTitle(task)}`}
                                onClick={() => { send({ type: "automation.session.open", taskId: task.id }); onOpenRunSession(); }}
                              ><MessageSquare size={12} />{sessionTitle(task)}</button>
                            )}
                            {!task.sessionId && task.workspace && <span><Folder size={12} />{task.workspace}</span>}
                          </div>
                          <p className="automation-row-prompt">{task.prompt}</p>
                        </div>
                        <div className="automation-row-actions">
                          <button
                            type="button"
                            className={`automation-row-toggle ${task.enabled ? "on" : ""}`}
                            data-control="automation-toggle"
                            role="switch"
                            aria-checked={task.enabled}
                            disabled={completed || Boolean(task.workspaceIssue)}
                            title={task.workspaceIssue ? "需重新选择工作区后才能启用" : completed ? "一次性任务已完成；编辑改期可重新启用" : task.enabled ? "暂停任务" : "启用任务"}
                            aria-label={task.workspaceIssue ? "需重新选择工作区" : completed ? "一次性任务已完成" : task.enabled ? "暂停任务" : "启用任务"}
                            onClick={() => send({ type: "automation.toggle", id: task.id, enabled: !task.enabled, agentId: task.agentId })}
                          />
                          <button type="button" data-control="automation-run" title={task.workspaceIssue ? "需重新选择工作区" : "运行一次"} aria-label="运行一次" disabled={Boolean(task.workspaceIssue)} onClick={() => send({ type: "automation.run", id: task.id, agentId: task.agentId })}><Play size={15} /></button>
                          <button type="button" title="编辑" aria-label="编辑" onClick={() => setForm({ mode: "edit", task })}><Pencil size={15} /></button>
                          <button type="button" title="删除" aria-label="删除" className="danger" onClick={() => { if (window.confirm(`删除定时任务「${task.name}」？`)) send({ type: "automation.delete", id: task.id, agentId: task.agentId }); }}><Trash2 size={15} /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>}
      </div>

      {formPresence.rendered && (() => { const form = formPresence.value; if (!form) return null; return (
        <ExitWrap exiting={formPresence.exiting}>
        <AutomationForm
          initial={form.mode === "edit" ? form.task : null}
          models={models}
          providers={providers}
          settings={settings}
          workspacePath={resolvedWorkspacePath}
          activeAgentId={effectiveActiveAgentId}
          onCancel={() => setForm(null)}
          onSubmit={(task) => { send({ type: "automation.save", task }); setForm(null); }}
        />
        </ExitWrap>
      ); })()}
      </>}
    </div>
  );
}
