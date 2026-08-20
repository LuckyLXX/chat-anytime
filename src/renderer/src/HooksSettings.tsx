import { Bell, Globe, Pencil, Play, Plus, ShieldAlert, TerminalSquare, Trash2, X, Zap } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { HookAction, HookEventName, HookRuleDraft, HookSummary, ResourceCatalog, RuntimeCommand } from "../../shared/protocol";
import { useDesktopStore } from "./store";

const hookEventLabels: Record<HookEventName, string> = {
  session_start: "会话启动",
  tool_call: "工具调用前",
  tool_execution_end: "工具执行后",
  agent_end: "回复结束（整次）",
  turn_end: "单轮调用结束"
};

const hookEventHints: Record<HookEventName, string> = {
  session_start: "会话创建完成时触发；命令会被等待完成（环境准备）",
  tool_call: "工具执行前触发；拦截型钩子可直接否决（命令防火墙）",
  tool_execution_end: "工具执行完成后触发（改完即格式化）",
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

const isToolEvent = (event: HookEventName): boolean => event === "tool_call" || event === "tool_execution_end";

interface HooksSettingsProps {
  resources: ResourceCatalog;
  workspaceOpen: boolean;
}

export function HooksSettings({ resources, workspaceOpen }: HooksSettingsProps): ReactNode {
  const hookRun = useDesktopStore((state) => state.hookRun);
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
  const runResultFor = (hook: HookSummary) => hookRun && hookRun.name === hook.name && hookRun.scope === hook.scope ? hookRun : undefined;

  return (
    <div className="resource-settings">
      <div className="resource-settings-header">
        <div>
          <h3><Zap size={16} />钩子</h3>
          <p>会话生命周期事件触发的自动化：通知、推送、拦截规则与本机命令。命令直接在你的机器上执行（等同终端输入），不会经过助手权限确认。</p>
        </div>
        <label className="resource-toggle"><input type="checkbox" checked={resources.hooksEnabled} disabled={controlsBusy} onChange={(changeEvent) => void run({ type: "hooks.settings", hooks: { enabled: changeEvent.target.checked } })} /><span>启用钩子</span></label>
      </div>
      {localError && <p className="form-error resource-error">{localError}</p>}
      <section className="resource-section">
        <div className="resource-section-heading">
          <span><Zap size={14} />规则</span>
          <div className="resource-section-actions"><small>{resources.hooks.length} 条</small><button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={openCreate}><Plus size={13} />新建钩子</button></div>
        </div>
        <p className="resource-form-help">
          事件：<strong>会话启动</strong>（命令会被等待，适合环境准备）· <strong>工具调用前</strong>（拦截型可否决工具执行）· <strong>工具执行后</strong>（改完即格式化）· <strong>回复结束</strong>（整次回复只触发一次，跑完通知）· <strong>单轮调用结束</strong>（每个模型调用小轮触发，一次回复多次）。
          配置文件：项目 <code>.pidesktop-hooks.json</code> 覆盖全局（同名规则生效前者）。命令钩子通过 stdin 收到 JSON 上下文，另有 <code>HOOK_EVENT / HOOK_SESSION_ID / HOOK_WORKSPACE / HOOK_TOOL</code> 环境变量；通知文案可用 <code>{"{sessionTitle}"}</code>、<code>{"{toolName}"}</code> 等占位符。
        </p>
        {resources.hooks.length === 0 ? <p className="resource-empty">还没有钩子。点击“新建钩子”，或把规则写入 <code>.pidesktop-hooks.json</code>。</p> : (
          <div className="resource-list">
            {resources.hooks.map((hook) => {
              const ActionIcon = hookActionIcons[hook.actionKind];
              const result = runResultFor(hook);
              return (
                <div className="resource-item" key={`${hook.scope}/${hook.name}`}>
                  <div className="resource-item-icon"><ActionIcon size={14} /></div>
                  <div className="resource-item-copy">
                    <strong>{hook.name}{hook.blocking ? "（拦截型）" : ""}</strong>
                    <small>{hookEventLabels[hook.event]}{hook.matcher ? ` · 匹配 ${hook.matcher}` : ""} · {hookActionLabels[hook.actionKind]} · {hookScopeLabels[hook.scope]}</small>
                    <em>{hook.actionPreview}</em>
                    {result && <span className="hook-run-result" data-ok={result.ok || undefined} data-blocked={result.blocked || undefined}>测试（{result.durationMs}ms）：{result.blocked ? `已拦截——${result.detail}` : result.ok ? result.detail : `失败——${result.detail}`}</span>}
                  </div>
                  <label className="resource-toggle"><input type="checkbox" checked={hook.enabled} disabled={controlsBusy} onChange={(changeEvent) => void run({ type: "hooks.toggle", name: hook.name, scope: hook.scope, enabled: changeEvent.target.checked })} /><span>启用</span></label>
                  <button className="icon-button" type="button" title={`测试 ${hook.name}`} aria-label={`测试钩子 ${hook.name}`} disabled={controlsBusy} onClick={() => void run({ type: "hooks.run", name: hook.name, scope: hook.scope, ...(sample.trim() ? { sample: sample.trim() } : {}) })}><Play size={14} /></button>
                  <button className="icon-button" type="button" title={`编辑 ${hook.name}`} aria-label={`编辑钩子 ${hook.name}`} disabled={controlsBusy} onClick={() => openEdit(hook)}><Pencil size={14} /></button>
                  <button className="icon-button resource-remove" type="button" title={`删除 ${hook.name}`} aria-label={`删除钩子 ${hook.name}`} disabled={controlsBusy} onClick={() => void run({ type: "hooks.delete", name: hook.name, scope: hook.scope })}><Trash2 size={14} /></button>
                </div>
              );
            })}
          </div>
        )}
        {resources.hooks.length > 0 && (
          <label className="hook-sample-field">测试样例行（拦截规则 / 命令钩子的模拟输入）<input value={sample} placeholder="git push --force" onChange={(changeEvent) => setSample(changeEvent.target.value)} /></label>
        )}
      </section>
      {formOpen && (
        <form className="mcp-config-form" onSubmit={(formEvent) => void saveHook(formEvent)}>
          <div className="mcp-form-grid">
            <label>名称<input value={name} placeholder="例如 git防火墙" autoFocus onChange={(changeEvent) => setName(changeEvent.target.value)} /></label>
            <label>写入范围
              <select value={scope} disabled={editingName !== undefined} onChange={(changeEvent) => setScope(changeEvent.target.value as HookRuleDraft["scope"])}>
                <option value="project" disabled={!workspaceOpen}>{workspaceOpen ? "当前项目 .pidesktop-hooks.json" : "当前项目（需先打开工作区）"}</option>
                <option value="global">用户全局配置</option>
              </select>
            </label>
            <label>触发事件<select value={event} onChange={(changeEvent) => setEvent(changeEvent.target.value as HookEventName)}>{(Object.keys(hookEventLabels) as HookEventName[]).map((item) => <option key={item} value={item}>{hookEventLabels[item]}</option>)}</select></label>
            <label>动作类型<select value={actionKind} onChange={(changeEvent) => setActionKind(changeEvent.target.value as HookAction["kind"])}>{(Object.keys(hookActionLabels) as HookAction["kind"][]).map((item) => <option key={item} value={item}>{hookActionLabels[item]}</option>)}</select></label>
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
              {event === "tool_call" && <label className="checkbox-setting"><input type="checkbox" checked={blocking} onChange={(changeEvent) => setBlocking(changeEvent.target.checked)} />阻断型（退出码 2 或输出 {"{\"block\":true}"} 时否决工具调用）</label>}
            </>}
          </div>
          <p className="resource-form-help">{hookEventHints[event]}。命令钩子是用户自写配置，直接在本机执行、不经助手权限门；超时或出错按放行处理并记录日志。</p>
          <footer className="mcp-form-actions">
            <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => { setFormOpen(false); setEditingName(undefined); }}><X size={13} />取消</button>
            <button className="primary-button" type="submit" disabled={controlsBusy}>{editingName !== undefined ? "保存修改" : "添加钩子"}</button>
          </footer>
        </form>
      )}
    </div>
  );
}
