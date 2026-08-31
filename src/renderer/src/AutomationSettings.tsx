// 设置页「自动化任务」tab：定时任务列表（全部/进行中/已暂停过滤 + 搜索）+ 创建/编辑表单弹窗。
// 数据源 store.automation（automation 推送维护）；增删改走 automation.* 命令。

import { Clock, ListChecks, MessageSquarePlus, Pause, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { AccessMode, AutomationTask, DesktopSettings, ModelOption, ProviderOption } from "../../shared/protocol";
import { groupModelsByProvider, selectableCatalogModels } from "./lib/model-list";
import { useDesktopStore } from "./store";

type Filter = "all" | "enabled" | "paused";

export interface AutomationSettingsProps {
  models: ModelOption[];
  providers: ProviderOption[];
  settings: DesktopSettings;
  workspaceConfigured: boolean;
  workspaceName?: string;
}

interface AutomationFormProps {
  initial: AutomationTask | null;
  models: ModelOption[];
  providers: ProviderOption[];
  settings: DesktopSettings;
  workspaceName?: string;
  onSubmit: (task: AutomationTask) => void;
  onCancel: () => void;
}

const ACCESS_MODES: { value: AccessMode; label: string }[] = [
  { value: "full", label: "完全访问（无人值守推荐）" },
  { value: "workspace", label: "工作区访问" },
  { value: "ask", label: "每次询问" },
  { value: "read-only", label: "只读" }
];

const CRON_HINT = "cron 为 5 字段（分 时 日 月 周）。例：0 9 * * 1-5 = 工作日每天 09:00；0 18 * * * = 每天 18:00；*/15 * * * * = 每 15 分钟。";

function agentDefaultModel(settings: DesktopSettings): { provider: string; id: string } | undefined {
  const agent = settings.agents.find((item) => item.id === settings.currentAgentId);
  return agent?.defaultModel ?? settings.model;
}

function scheduleLabel(task: AutomationTask): string {
  const { cron, timezone } = task.schedule;
  return `${cron}${timezone ? ` · ${timezone}` : " · 本地"}`;
}

function AutomationForm({ initial, models, providers, settings, workspaceName, onSubmit, onCancel }: AutomationFormProps): ReactNode {
  const [name, setName] = useState(initial?.name ?? "");
  const [cron, setCron] = useState(initial?.schedule.cron ?? "");
  const [timezone, setTimezone] = useState(initial?.schedule.timezone ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [modelValue, setModelValue] = useState(initial?.model ? `${initial.model.provider}/${initial.model.id}` : "");
  const [workspace, setWorkspace] = useState(initial?.workspace ? (initial.workspace === workspaceName ? "current" : "other") : "current");
  const [accessMode, setAccessMode] = useState<AccessMode>(initial?.accessMode ?? "full");
  const [error, setError] = useState<string>();

  const defaultModel = agentDefaultModel(settings);
  const groups = useMemo(() => groupModelsByProvider(selectableCatalogModels(models), (providerId) => providers.find((item) => item.id === providerId)?.name), [models, providers]);

  function submit(): void {
    if (!name.trim()) { setError("请填写任务名称"); return; }
    if (!cron.trim()) { setError("请填写 cron 调度表达式"); return; }
    if (cron.trim().split(/\s+/u).length !== 5) { setError("cron 需要 5 个字段（分 时 日 月 周），如 0 9 * * 1-5"); return; }
    if (!prompt.trim()) { setError("请填写任务提示词"); return; }
    const model = modelValue ? (() => { const slash = modelValue.indexOf("/"); return slash > 0 ? { provider: modelValue.slice(0, slash), id: modelValue.slice(slash + 1) } : undefined; })() : undefined;
    onSubmit({
      id: initial?.id ?? "",
      name: name.trim(),
      schedule: { cron: cron.trim(), ...(timezone.trim() ? { timezone: timezone.trim() } : {}) },
      prompt: prompt.trim(),
      agentId: settings.currentAgentId,
      workspace: workspace === "current" ? workspaceName : undefined,
      model,
      accessMode,
      enabled: initial?.enabled ?? true,
      createdAt: initial?.createdAt ?? Date.now(),
      // 编辑保留近一次运行摘要（否则 normalize 会因缺少该字段而抹掉）。
      ...(initial?.lastRun ? { lastRun: initial.lastRun } : {})
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="automation-dialog" data-pane="automation-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><ListChecks size={18} /><div><h2>{initial ? "编辑定时任务" : "创建定时任务"}</h2><p>到点后让 Agent 在后台用下面的提示词跑一次。</p></div></div>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={onCancel}><X size={17} /></button>
        </header>
        <div className="automation-dialog-body">
          <div className="automation-field-grid">
            <label>任务名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如: 每日项目巡检" /></label>
            <label>时区<input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="跟随系统（留空）" /></label>
          </div>
          <label>调度方式（cron）<input value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" /></label>
          <p className="automation-hint">{CRON_HINT}</p>
          <label>模型<select value={modelValue} onChange={(event) => setModelValue(event.target.value)}>
            <option value="">{defaultModel ? `继承默认（${defaultModel.id}）` : "请先配置并选择模型"}</option>
            {modelValue && !groups.some((group) => group.models.some((model) => `${group.provider}/${model.id}` === modelValue)) && <option value={modelValue}>{modelValue}</option>}
            {groups.map((group) => <optgroup key={group.provider} label={group.providerName}>{group.models.map((model) => <option key={model.id} value={`${group.provider}/${model.id}`}>{model.name}</option>)}</optgroup>)}
          </select></label>
          <label>任务提示词<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder="描述定时任务执行时要让 Agent 做什么。" /></label>
          <div className="automation-field-grid">
            <label>空间<select value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value="current">{workspaceName ? `当前工作区（${workspaceName}）` : "当前工作区"}</option><option value="none">不选择空间</option><option value="other">其它空间（仅存为元数据）</option></select></label>
            <label>权限<select value={accessMode} onChange={(event) => setAccessMode(event.target.value as AccessMode)}>{ACCESS_MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          </div>
          <p className="automation-hint">无人值守下建议「完全访问」：受限权限遇到工具确认会挂起。模型与空间执行时按当前上下文处理。</p>
          {error && <p className="automation-form-error">{error}</p>}
        </div>
        <footer><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button type="button" className="primary-button" onClick={submit}>{initial ? "保存" : "创建"}</button></footer>
      </section>
    </div>
  );
}

export function AutomationSettings({ models, providers, settings, workspaceConfigured, workspaceName }: AutomationSettingsProps): ReactNode {
  const automation = useDesktopStore((state) => state.automation);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<{ mode: "create" } | { mode: "edit"; task: AutomationTask } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return automation.filter((task) => {
      if (filter === "enabled" && !task.enabled) return false;
      if (filter === "paused" && task.enabled) return false;
      if (q && !task.name.toLowerCase().includes(q) && !task.schedule.cron.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [automation, filter, query]);

  function send(command: Parameters<typeof window.piDesktop.send>[0]): void { void window.piDesktop.send(command); }

  return (
    <div className="automation-settings" data-pane="automation-settings">
      <header className="automation-settings-head">
        <div><h3>自动化任务</h3><p>按 cron 调度，让 Agent 在后台定时执行提示词。</p></div>
        <div className="automation-head-actions">
          <button type="button" className="secondary-button" onClick={() => { send({ type: "session.new" }); }}><MessageSquarePlus size={15} />去会话中创建</button>
          <button type="button" className="primary-button" disabled={!workspaceConfigured} onClick={() => setForm({ mode: "create" })}><Plus size={15} />创建定时任务</button>
        </div>
      </header>

      <div className="automation-filter-bar">
        <div className="automation-filter-tabs">
          <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button>
          <button type="button" className={filter === "enabled" ? "active" : ""} onClick={() => setFilter("enabled")}>进行中</button>
          <button type="button" className={filter === "paused" ? "active" : ""} onClick={() => setFilter("paused")}>已暂停</button>
        </div>
        <label className="automation-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" /></label>
      </div>

      {filtered.length === 0
        ? <p className="panel-empty">{automation.length === 0 ? "还没有定时任务，点击「创建定时任务」或「去会话中创建」。" : "没有匹配的任务。"}</p>
        : <div className="automation-list">
            {filtered.map((task) => (
              <div className="automation-row" key={task.id} data-role="automation-task">
                <div className="automation-row-main">
                  <strong>{task.name}</strong>
                  <span className="automation-row-schedule"><Clock size={13} />{scheduleLabel(task)}</span>
                  {task.model && <span className="automation-row-model">{task.model.id}</span>}
                  {task.lastRun && <span className={`automation-row-lastrun ${task.lastRun.status}`}>{task.lastRun.status === "ok" ? "已运行" : "运行失败"}</span>}
                </div>
                <div className="automation-row-actions">
                  <button type="button" title="运行一次" aria-label="运行一次" onClick={() => send({ type: "automation.run", id: task.id })}><Play size={15} /></button>
                  <button type="button" title={task.enabled ? "暂停" : "启用"} aria-label={task.enabled ? "暂停" : "启用"} onClick={() => send({ type: "automation.toggle", id: task.id, enabled: !task.enabled })}>{task.enabled ? <Pause size={15} /> : <Play size={15} />}</button>
                  <button type="button" title="编辑" aria-label="编辑" onClick={() => setForm({ mode: "edit", task })}><Pencil size={15} /></button>
                  <button type="button" title="删除" aria-label="删除" className="danger" onClick={() => { if (window.confirm(`删除定时任务「${task.name}」？`)) send({ type: "automation.delete", id: task.id }); }}><Trash2 size={15} /></button>
                </div>
                <span className={`automation-row-state ${task.enabled ? "on" : "off"}`}>{task.enabled ? "进行中" : "已暂停"}</span>
              </div>
            ))}
          </div>}

      {form && (
        <AutomationForm
          initial={form.mode === "edit" ? form.task : null}
          models={models}
          providers={providers}
          settings={settings}
          workspaceName={workspaceName}
          onCancel={() => setForm(null)}
          onSubmit={(task) => { send({ type: "automation.save", task }); setForm(null); }}
        />
      )}
    </div>
  );
}
