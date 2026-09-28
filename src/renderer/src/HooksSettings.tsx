import { Bell, ChevronDown, Globe, Pencil, Play, Plus, ShieldAlert, ShieldCheck, TerminalSquare, Trash2, X, Zap } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { HookAction, HookEventName, HookRuleDraft, HookSummary, ResourceCatalog, RuntimeCommand } from "../../shared/protocol";
import { useDesktopStore, type HookRunResult } from "./store";

const hookEventLabels: Record<HookEventName, string> = {
  session_start: "会话启动",
  tool_call: "工具调用前",
  tool_execution_end: "工具执行后",
  tool_result: "工具结果生成后",
  user_input: "用户输入提交前",
  session_before_compact: "上下文压缩前",
  session_end: "会话销毁",
  agent_end: "回复结束（整次）",
  turn_end: "单轮调用结束"
};

const hookEventHints: Record<HookEventName, string> = {
  session_start: "会话创建完成时触发；命令会被等待完成（环境准备）",
  tool_call: "工具执行前触发；拦截型钩子可直接否决（命令防火墙）",
  tool_execution_end: "工具执行完成后触发（改完即格式化）",
  tool_result: "工具结果生成后、进入对话前触发；观察型（命令不等待）",
  user_input: "用户消息（含排队的补充消息）提交前触发；拦截型钩子可吞掉这次输入",
  session_before_compact: "手动 /compact、超阈值或溢出恢复导致压缩前触发；阻断型命令可取消这次压缩",
  session_end: "会话运行时被销毁（重建 / 删除 / 被淘汰）前触发；切换会话（park）不触发，退出应用或进程被杀不保证送达",
  agent_end: "一次完整回复（用户消息 → 全部工具调用轮次 → 最终答案）结束时触发，只通知一次；附累计 token 用量与失败标记——跑完通知/用量统计用这个",
  turn_end: "每个模型调用小轮结束时触发，一次回复会触发多次；大多数场景应选「回复结束」"
};

const hookActionLabels: Record<HookAction["kind"], string> = {
  notify: "桌面通知",
  http: "HTTP 推送",
  block: "拦截规则",
  command: "执行命令"
};

const hookActionIcons: Record<HookAction["kind"], typeof Bell> = {
  notify: Bell,
  http: Globe,
  block: ShieldAlert,
  command: TerminalSquare
};

const hookScopeLabels: Record<"project" | "global", string> = {
  project: "当前项目",
  global: "全局"
};

const toolMatchEvents: HookEventName[] = ["tool_call", "tool_execution_end", "tool_result"];
const blockEvents: HookEventName[] = ["tool_call", "user_input"];
const blockingCommandEvents: HookEventName[] = ["tool_call", "user_input", "session_before_compact"];

const isToolEvent = (event: HookEventName): boolean => toolMatchEvents.includes(event);
const allowsBlock = (event: HookEventName): boolean => blockEvents.includes(event);
const allowsBlockingCommand = (event: HookEventName): boolean => blockingCommandEvents.includes(event);

/** 动作类型按事件过滤：拦截规则只对有阻断语义的事件开放，避免存不进去的死路。 */
function actionKindsFor(event: HookEventName): HookAction["kind"][] {
  return (Object.keys(hookActionLabels) as HookAction["kind"][]).filter((kind) => kind !== "block" || allowsBlock(event));
}

function formatRunTime(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1_000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function summarizeRunDetail(detail: string): string {
  const summary = detail.replace(/\s+/gu, " ").trim() || "无输出";
  return summary.length > 140 ? `${summary.slice(0, 140)}…` : summary;
}

function runStatusLabel(result: HookRunResult): string {
  return result.blocked ? "已拦截" : result.ok ? "成功" : "失败";
}

function runSourceLabel(result: HookRunResult): string {
  return result.source === "test" ? "测试" : "触发";
}

interface HooksSettingsProps {
  resources: ResourceCatalog;
  workspaceOpen: boolean;
}

export function HooksSettings({ resources, workspaceOpen }: HooksSettingsProps): ReactNode {
  const hookRuns = useDesktopStore((state) => state.hookRuns);
  const [expandedRunLog, setExpandedRunLog] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [editingName, setEditingName] = useState<string>();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<HookRuleDraft["scope"]>("global");
  const [event, setEvent] = useState<HookEventName>("agent_end");
  const [matcher, setMatcher] = useState("");
  const [actionKind, setActionKind] = useState<HookAction["kind"]>("notify");
  const [notifyTitle, setNotifyTitle] = useState("");
  const [notifyBody, setNotifyBody] = useState("");
  const [httpUrl, setHttpUrl] = useState("");
  const [denyLines, setDenyLines] = useState("");
  const [command, setCommand] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [timeoutSec, setTimeoutSec] = useState(10);
  const [sample, setSample] = useState("git push --force");

  async function run(command: RuntimeCommand): Promise<boolean> {
    setBusy(true);
    setLocalError(undefined);
    try {
      await window.piDesktop.send(command);
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "钩子操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function resetForm(): void {
    setName("");
    setScope(workspaceOpen ? "project" : "global");
    setEvent("agent_end");
    setMatcher("");
    setActionKind("notify");
    setNotifyTitle("");
    setNotifyBody("");
    setHttpUrl("");
    setDenyLines("");
    setCommand("");
    setBlocking(false);
    setTimeoutSec(10);
  }

  function openCreate(): void {
    setEditingName(undefined);
    resetForm();
    setFormOpen(true);
  }

  function openEdit(hook: HookSummary): void {
    setEditingName(hook.name);
    setName(hook.name);
    setScope(hook.scope);
    setEvent(hook.event);
    setMatcher(hook.matcher ?? "");
    setActionKind(hook.action.kind);
    setNotifyTitle(hook.action.kind === "notify" ? hook.action.title ?? "" : "");
    setNotifyBody(hook.action.kind === "notify" ? hook.action.body ?? "" : "");
    setHttpUrl(hook.action.kind === "http" ? hook.action.url : "");
    setDenyLines(hook.action.kind === "block" ? hook.action.deny.join("\n") : "");
    setCommand(hook.action.kind === "command" ? hook.action.command : "");
    setBlocking(hook.action.kind === "command" ? hook.action.blocking === true : false);
    setFormOpen(true);
  }

  async function saveHook(formEvent: FormEvent): Promise<void> {
    formEvent.preventDefault();
    // 整页是 <form>（底部动作条要放在滚动主体之外），未展开编辑器时的隐式提交直接忽略。
    if (!formOpen) return;
    let action: HookAction;
    if (actionKind === "notify") {
      action = { kind: "notify", ...(notifyTitle.trim() ? { title: notifyTitle.trim() } : {}), ...(notifyBody.trim() ? { body: notifyBody.trim() } : {}) };
    } else if (actionKind === "http") {
      action = { kind: "http", url: httpUrl.trim() };
    } else if (actionKind === "block") {
      action = { kind: "block", deny: denyLines.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) };
    } else {
      action = { kind: "command", command: command.trim(), ...(blocking ? { blocking: true } : {}) };
    }
    const draft: HookRuleDraft = {
      name: name.trim(),
      scope,
      event,
      ...(isToolEvent(event) && matcher.trim() ? { matcher: matcher.trim() } : {}),
      ...(actionKind === "command" && timeoutSec >= 1 && timeoutSec <= 120 ? { timeoutMs: Math.round(timeoutSec) * 1000 } : {}),
      action
    };
    const success = await run({ type: "hooks.save", hook: draft });
    if (!success) return;
    setEditingName(undefined);
    setFormOpen(false);
  }

  const controlsBusy = busy;
  const runResultsFor = (hook: HookSummary): HookRunResult[] => hookRuns[`${hook.scope}/${hook.name}`] ?? [];

  return (
    <form className="resource-page" data-pane="hooks-settings" onSubmit={(formEvent) => void saveHook(formEvent)}>
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>钩子</strong>
          <small>会话生命周期事件触发的自动化：通知、推送、拦截规则与本机命令；命令直接在你的机器上执行（等同终端输入），不经助手权限确认</small>
        </span>
        <span className="resource-page-actions">
          <label className="resource-toggle" title="总闸：关闭后所有钩子都不触发">
            <input type="checkbox" data-control="hooks-enable" checked={resources.hooksEnabled} disabled={controlsBusy} onChange={(changeEvent) => void run({ type: "hooks.settings", hooks: { enabled: changeEvent.target.checked } })} />
            <span>启用钩子</span>
          </label>
          <button className="secondary-button compact-button" type="button" data-control="hooks-add" disabled={controlsBusy} onClick={openCreate}><Plus size={13} />新建钩子</button>
        </span>
      </header>
      <div className="resource-page-body">
        {localError && <p className="form-error resource-error">{localError}</p>}

        <section className="resource-card" aria-label="钩子规则">
          <div className="resource-card-head">
            <span className="resource-card-title"><Zap size={14} /><strong>规则</strong></span>
            <small>项目 <code>.pidesktop-hooks.json</code> 覆盖全局（同名规则前者生效）</small>
            <span className="resource-card-actions"><small className="resource-card-count">{resources.hooks.length} 条</small></span>
          </div>
          <div className="resource-card-body">
            <ul className="hook-event-legend">
              {(Object.keys(hookEventLabels) as HookEventName[]).map((item) => (
                <li key={item}><strong>{hookEventLabels[item]}</strong><span>{hookEventHints[item]}</span></li>
              ))}
            </ul>
            <p className="resource-form-help">命令钩子通过 stdin 收到事件 JSON 上下文，另有 <code>HOOK_EVENT / HOOK_SESSION_ID / HOOK_WORKSPACE / HOOK_TOOL</code> 环境变量；通知文案可用 <code>{"{sessionTitle}"}</code>、<code>{"{toolName}"}</code> 等占位符。</p>
            {resources.hooks.length > 0 && (
              <label className="hook-sample-field"><span>测试样例行</span><input value={sample} placeholder="git push --force" onChange={(changeEvent) => setSample(changeEvent.target.value)} /><small>点行内「测试」时作为模拟输入喂给规则（拦截规则 / 命令钩子）</small></label>
            )}
            {resources.hooks.length === 0
              ? <p className="resource-empty">还没有钩子。点右上「新建钩子」，或把规则写入 <code>.pidesktop-hooks.json</code>。</p>
              : (
                <div className="resource-list">
                  {resources.hooks.map((hook) => {
                    const ActionIcon = hookActionIcons[hook.actionKind];
                    const results = runResultsFor(hook);
                    const result = results[0];
                    const runKey = `${hook.scope}/${hook.name}`;
                    return (
                      <div className="resource-item" key={`${hook.scope}/${hook.name}`} data-hook-name={hook.name}>
                        <div className="resource-item-icon"><ActionIcon size={14} /></div>
                        <div className="resource-item-copy">
                          <strong>{hook.name}{hook.blocking ? "（拦截型）" : ""}</strong>
                          <small>{hookEventLabels[hook.event]}{hook.matcher ? ` · 匹配 ${hook.matcher}` : ""} · {hookActionLabels[hook.actionKind]} · {hookScopeLabels[hook.scope]}</small>
                          {hook.scope === "project" && <span className="hook-trust-badge" data-hook-trust={hook.trust ?? "pending"}>{hook.trust === "trusted" ? "已信任" : "待批准"}</span>}
                          <em>{hook.actionPreview}</em>
                          {result && (
                            <div className="hook-run-status">
                              <div className="hook-run-latest" data-ok={result.ok || undefined} data-blocked={result.blocked || undefined}>
                                <strong>{hookEventLabels[result.event]} · {runSourceLabel(result)} · {runStatusLabel(result)}</strong>
                                <small>{result.durationMs}ms · {formatRunTime(result.at)}</small>
                                <span className="hook-run-summary" title={result.detail}>{summarizeRunDetail(result.detail)}</span>
                              </div>
                              <button className="icon-button hook-run-log-toggle" type="button" data-control="hooks-run-log" title={`查看 ${hook.name} 最近 3 次运行`} aria-label={`查看钩子 ${hook.name} 最近 3 次运行`} aria-expanded={expandedRunLog === runKey} onClick={() => setExpandedRunLog((current) => current === runKey ? undefined : runKey)}><ChevronDown size={13} /></button>
                              {expandedRunLog === runKey && (
                                <div className="hook-run-history">
                                  {results.map((item, index) => (
                                    <div className="hook-run-entry" key={`${item.at}-${index}`} data-ok={item.ok || undefined} data-blocked={item.blocked || undefined}>
                                      <strong>{hookEventLabels[item.event]} · {runSourceLabel(item)} · {runStatusLabel(item)}</strong>
                                      <time dateTime={new Date(item.at).toISOString()}>{item.durationMs}ms · {formatRunTime(item.at)}</time>
                                      <span className="hook-run-entry-detail">{item.detail || "无输出"}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <label className="resource-toggle"><input type="checkbox" checked={hook.enabled} disabled={controlsBusy} onChange={(changeEvent) => void run({ type: "hooks.toggle", name: hook.name, scope: hook.scope, enabled: changeEvent.target.checked })} /><span>启用</span></label>
                        {hook.scope === "project" && <button className="secondary-button compact-button hook-trust-action" type="button" data-control="hooks-trust" title={hook.trust === "trusted" ? `撤销 ${hook.name} 的信任` : `批准 ${hook.name} 执行`} aria-label={hook.trust === "trusted" ? `撤销钩子 ${hook.name} 的信任` : `批准钩子 ${hook.name} 执行`} disabled={controlsBusy} onClick={() => void run({ type: "hooks.trust", name: hook.name, scope: "project", trusted: hook.trust !== "trusted" })}>{hook.trust === "trusted" ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}{hook.trust === "trusted" ? "撤销信任" : "批准执行"}</button>}
                        <button className="icon-button" type="button" title={`测试 ${hook.name}`} aria-label={`测试钩子 ${hook.name}`} disabled={controlsBusy} onClick={() => void run({ type: "hooks.run", name: hook.name, scope: hook.scope, ...(sample.trim() ? { sample: sample.trim() } : {}) })}><Play size={14} /></button>
                        <button className="icon-button" type="button" title={`编辑 ${hook.name}`} aria-label={`编辑钩子 ${hook.name}`} disabled={controlsBusy} onClick={() => openEdit(hook)}><Pencil size={14} /></button>
                        <button className="icon-button resource-remove" type="button" title={`删除 ${hook.name}`} aria-label={`删除钩子 ${hook.name}`} disabled={controlsBusy} onClick={() => void run({ type: "hooks.delete", name: hook.name, scope: hook.scope })}><Trash2 size={14} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
        </section>

        {formOpen && (
          <section className="resource-card hook-form" aria-label="编辑钩子">
            <div className="resource-card-head">
              <span className="resource-card-title"><Zap size={14} /><strong>{editingName !== undefined ? "编辑钩子" : "新建钩子"}</strong></span>
              <small>{hookEventHints[event]}</small>
            </div>
            <div className="resource-card-body">
              <div className="mcp-form-grid">
                <label>名称<input value={name} placeholder="例如 git防火墙" autoFocus onChange={(changeEvent) => setName(changeEvent.target.value)} /></label>
                <label>写入范围
                  <select value={scope} disabled={editingName !== undefined} onChange={(changeEvent) => setScope(changeEvent.target.value as HookRuleDraft["scope"])}>
                    <option value="project" disabled={!workspaceOpen}>{workspaceOpen ? "当前项目 .pidesktop-hooks.json" : "当前项目（需先打开工作区）"}</option>
                    <option value="global">用户全局配置</option>
                  </select>
                </label>
                <label>触发事件<select value={event} onChange={(changeEvent) => { const next = changeEvent.target.value as HookEventName; setEvent(next); if (!actionKindsFor(next).includes(actionKind)) setActionKind("notify"); }}>{(Object.keys(hookEventLabels) as HookEventName[]).map((item) => <option key={item} value={item}>{hookEventLabels[item]}</option>)}</select></label>
                <label>动作类型<select value={actionKind} onChange={(changeEvent) => setActionKind(changeEvent.target.value as HookAction["kind"])}>{actionKindsFor(event).map((item) => <option key={item} value={item}>{hookActionLabels[item]}</option>)}</select></label>
                {isToolEvent(event) && <label className="mcp-form-wide">工具匹配正则（可选）<input value={matcher} placeholder="bash|write|edit（留空匹配全部工具）" onChange={(changeEvent) => setMatcher(changeEvent.target.value)} /></label>}
                {actionKind === "notify" && <>
                  <label className="mcp-form-wide">通知标题（可选）<input value={notifyTitle} placeholder="PiDesktop：{event}" onChange={(changeEvent) => setNotifyTitle(changeEvent.target.value)} /></label>
                  <label className="mcp-form-wide">通知正文（可选）<input value={notifyBody} placeholder="{sessionTitle} · {toolName}" onChange={(changeEvent) => setNotifyBody(changeEvent.target.value)} /></label>
                </>}
                {actionKind === "http" && <label className="mcp-form-wide">推送地址<input value={httpUrl} placeholder="https://api.day.app/your-key/PiDesktop" onChange={(changeEvent) => setHttpUrl(changeEvent.target.value)} /></label>}
                {actionKind === "block" && <label className="mcp-form-wide">拦截正则（每行一条，命中任一条即否决）<textarea value={denyLines} rows={3} placeholder={"git push.*--force\nrm\\s+-rf"} onChange={(changeEvent) => setDenyLines(changeEvent.target.value)} /></label>}
                {actionKind === "command" && <>
                  <label className="mcp-form-wide">命令（shell 语义；stdin 收到事件 JSON 上下文）<textarea value={command} rows={2} placeholder={"npx prettier --write src/"} onChange={(changeEvent) => setCommand(changeEvent.target.value)} /></label>
                  <label>超时（秒）<input type="number" min={1} max={120} value={timeoutSec} onChange={(changeEvent) => setTimeoutSec(Number(changeEvent.target.value))} /></label>
                  {allowsBlockingCommand(event) && <label className="checkbox-setting"><input type="checkbox" checked={blocking} onChange={(changeEvent) => setBlocking(changeEvent.target.checked)} />阻断型（退出码 2 或输出 {"{\"block\":true}"} 时{event === "tool_call" ? "否决工具调用" : event === "user_input" ? "吞掉这次输入" : "取消这次压缩"}）</label>}
                </>}
              </div>
              <p className="resource-form-help">命令钩子是用户自写配置，直接在本机执行、不经助手权限门；超时或出错按放行处理并记录日志。</p>
            </div>
          </section>
        )}
      </div>
      {formOpen && (
        <footer className="subagent-form-actions">
          <span className="subagent-form-note">{editingName !== undefined ? `正在编辑 ${name.trim() || "未命名"}` : "新建钩子"}</span>
          <button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => { setFormOpen(false); setEditingName(undefined); }}><X size={13} />取消</button>
          <button className="primary-button compact-button" type="submit" data-control="hooks-save" disabled={controlsBusy || !name.trim()}>{editingName !== undefined ? "保存修改" : "添加钩子"}</button>
        </footer>
      )}
    </form>
  );
}
