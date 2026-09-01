import { Bot, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { BuiltinToolName, ModelOption, ProviderOption, ResourceCatalog, RuntimeCommand, SubagentDefinition, SubagentScope } from "../../shared/protocol";
import { toolLabel } from "../../shared/locale";
import { selectableCatalogModels } from "./lib/model-list";
import { ModelSelect } from "./components/ModelSelect";
import { useDesktopStore } from "./store";

const SUBAGENT_TOOLS: BuiltinToolName[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const SCOPE_LABELS: Record<SubagentScope, string> = { global: "用户（全局）", project: "当前项目" };
const COLOR_OPTIONS = ["amber", "rose", "orange", "emerald", "teal", "blue", "violet", "slate"];
const COLOR_SWATCHES: Record<string, string> = {
  amber: "#d97706",
  rose: "#e11d48",
  orange: "#ea580c",
  emerald: "#059669",
  teal: "#0d9488",
  blue: "#2563eb",
  violet: "#7c3aed",
  slate: "#64748b",
};

const subagentScopeLabel = (scope: SubagentScope): string => SCOPE_LABELS[scope];

interface SubagentSettingsProps {
  resources: ResourceCatalog;
  workspaceOpen: boolean;
  models: ModelOption[];
  providers: ProviderOption[];
}

export function SubagentSettings({ resources, workspaceOpen, models, providers }: SubagentSettingsProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState("");
  const [color, setColor] = useState("amber");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [scope, setScope] = useState<SubagentScope>("global");
  const [injectAgentsMd, setInjectAgentsMd] = useState(false);
  const [inherited, setInherited] = useState<boolean>(true);
  const [tools, setTools] = useState<Record<BuiltinToolName, boolean>>(() => Object.fromEntries(SUBAGENT_TOOLS.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean>);

  // 与顶栏模型选择器/Agent 默认模型下拉同口径：只保留已勾选（enabled !== false）且已配置的模型。
  const configuredModels = selectableCatalogModels(models).filter((model) => model.configured);

  async function run(command: RuntimeCommand): Promise<boolean> {
    setBusy(true);
    setLocalError(undefined);
    try {
      await window.piDesktop.send(command);
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "子智能体操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function resetForm(): void {
    setName("");
    setColor("amber");
    setDescription("");
    setModel("");
    setSystemPrompt("");
    setScope(workspaceOpen ? "project" : "global");
    setInjectAgentsMd(false);
    setInherited(true);
    setTools(Object.fromEntries(SUBAGENT_TOOLS.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean>);
  }

  function openCreate(): void {
    setEditingId(undefined);
    resetForm();
    setFormOpen(true);
  }

  function openEdit(subagent: SubagentDefinition): void {
    setEditingId(subagent.id);
    setName(subagent.name);
    setColor(subagent.color ?? "amber");
    setDescription(subagent.description);
    // 已取消勾选的模型不在可选项中：回落为「继承默认模型」，避免受控 select 无
    // 匹配 option 显示空白、且原样保存把失效引用写回定义文件（2026-09-02 审查）。
    const modelValue = subagent.model ? `${subagent.model.provider}/${subagent.model.id}` : "";
    setModel(modelValue && configuredModels.some((item) => `${item.provider}/${item.id}` === modelValue) ? modelValue : "");
    setSystemPrompt(subagent.systemPrompt);
    setScope(subagent.scope);
    setInjectAgentsMd(subagent.injectAgentsMd === true);
    if (subagent.tools === "inherit") {
      setInherited(true);
      setTools(Object.fromEntries(SUBAGENT_TOOLS.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean>);
    } else {
      setInherited(false);
      setTools({ ...Object.fromEntries(SUBAGENT_TOOLS.map((tool) => [tool, true])), ...subagent.tools } as Record<BuiltinToolName, boolean>);
    }
    setFormOpen(true);
  }

  async function saveSubagent(formEvent: FormEvent): Promise<void> {
    formEvent.preventDefault();
    if (!workspaceOpen && scope === "project") {
      setLocalError("项目级子智能体需要先打开工作区");
      return;
    }
    const id = editingId ?? `subagent-${Date.now().toString(36)}`;
    // 保存兜底：表单打开期间模型被取消勾选时同样回落（与 openEdit 同口径）。
    const modelValue = model && configuredModels.some((item) => `${item.provider}/${item.id}` === model) ? model : "";
    const definition: SubagentDefinition = {
      id,
      name: name.trim(),
      description: description.trim(),
      color,
      ...(modelValue ? { model: { provider: modelValue.slice(0, modelValue.indexOf("/")), id: modelValue.slice(modelValue.indexOf("/") + 1) } } : {}),
      systemPrompt: systemPrompt.trim() || "完成委派给你的独立子任务。",
      scope,
      ...(injectAgentsMd ? { injectAgentsMd: true } : {}),
      tools: inherited ? "inherit" : tools
    };
    const success = await run({ type: "subagent.save", subagent: definition });
    if (!success) return;
    setEditingId(undefined);
    setFormOpen(false);
  }

  async function deleteSubagent(subagent: SubagentDefinition): Promise<void> {
    await run({ type: "subagent.delete", id: subagent.id, scope: subagent.scope });
  }

  const controlsBusy = busy;

  return (
    <div className="resource-settings">
      <div className="resource-settings-header">
        <div>
          <h3><Bot size={16} />子智能体</h3>
          <p>定义可保存、可复用的子智能体：委派时按名称引用，覆盖固定的 role 枚举。每个子智能体有独立的系统提示词、模型与工具集。</p>
        </div>
      </div>
      {localError && <p className="form-error resource-error">{localError}</p>}
      <section className="resource-section">
        <div className="resource-section-heading">
          <span><Bot size={14} />定义</span>
          <div className="resource-section-actions"><small>{resources.subagents.length} 个</small><button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={openCreate}><Plus size={13} />新建子智能体</button></div>
        </div>
        <p className="resource-form-help">
          子智能体与主会话共享同一套白名单工具，但可按需收窄；模型缺省继承当前会话模型。作用域：项目级（<code>.pidesktop-subagents.json</code>）覆盖全局（同 id 时生效前者）。委派时传给 <code>delegate_agent</code> 的 <code>subagent</code> 参数即可引用。
        </p>
        {resources.subagents.length === 0 ? <p className="resource-empty">还没有子智能体。点击“新建子智能体”，定义名称、系统提示词与工具范围后保存。</p> : (
          <div className="resource-list">
            {resources.subagents.map((subagent) => (
              <div className="resource-item" key={`${subagent.scope}/${subagent.id}`}>
                <div className="resource-item-icon subagent-color" data-color={subagent.color ?? "amber"}><Bot size={14} /></div>
                <div className="resource-item-copy">
                  <strong>{subagent.name}</strong>
                  <small>{subagentScopeLabel(subagent.scope)} · {subagent.model ? `${subagent.model.provider}/${subagent.model.id}` : "继承默认模型"} · {subagent.tools === "inherit" ? "继承父会话工具" : "自定义工具"}</small>
                  <em>{subagent.description || subagent.systemPrompt}</em>
                </div>
                <button className="icon-button" type="button" title={`编辑 ${subagent.name}`} aria-label={`编辑子智能体 ${subagent.name}`} disabled={controlsBusy} onClick={() => openEdit(subagent)}><Pencil size={14} /></button>
                <button className="icon-button resource-remove" type="button" title={`删除 ${subagent.name}`} aria-label={`删除子智能体 ${subagent.name}`} disabled={controlsBusy} onClick={() => void deleteSubagent(subagent)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </section>
      {formOpen && (
        <form className="mcp-config-form" onSubmit={(formEvent) => void saveSubagent(formEvent)}>
          <div className="mcp-form-grid">
            <label>名称<input value={name} placeholder="例如 code-reviewer" autoFocus onChange={(changeEvent) => setName(changeEvent.target.value)} /></label>
            <label>颜色标记
              <div className="subagent-color-picker">
                {COLOR_OPTIONS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`subagent-color-swatch ${color === item ? "selected" : ""}`}
                    style={{ backgroundColor: COLOR_SWATCHES[item] }}
                    onClick={() => setColor(item)}
                    title={item}
                    aria-label={`选择颜色 ${item}`}
                  />
                ))}
              </div>
            </label>
            <label>模型<ModelSelect models={configuredModels} providers={providers} value={model} placeholder="继承默认模型" onChange={setModel} /></label>
            <label>作用域
              <select value={scope} onChange={(changeEvent) => setScope(changeEvent.target.value as SubagentScope)}>
                <option value="project" disabled={!workspaceOpen}>{workspaceOpen ? "当前项目 .pidesktop-subagents.json" : "当前项目（需先打开工作区）"}</option>
                <option value="global">用户全局配置</option>
              </select>
            </label>
            <label className="mcp-form-wide">描述<input value={description} placeholder="展示给模型的简短说明" onChange={(changeEvent) => setDescription(changeEvent.target.value)} /></label>
            <label className="checkbox-setting"><input type="checkbox" checked={injectAgentsMd} onChange={(changeEvent) => setInjectAgentsMd(changeEvent.target.checked)} />注入 AGENTS.md（子代理运行前遵循工作区规范）</label>
          </div>
          <label className="mcp-form-wide">系统提示词<textarea value={systemPrompt} rows={6} placeholder="描述这个子智能体的角色、边界和规则…" onChange={(changeEvent) => setSystemPrompt(changeEvent.target.value)} /></label>
          <fieldset className="mcp-form-wide">
            <legend>可用工具</legend>
            <label className="checkbox-setting"><input type="checkbox" checked={inherited} onChange={(changeEvent) => { setInherited(changeEvent.target.checked); if (changeEvent.target.checked) setTools(Object.fromEntries(SUBAGENT_TOOLS.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean>); }} />继承父会话工具集</label>
            {!inherited && (
              <div className="tool-grid">
                {SUBAGENT_TOOLS.map((tool) => (
                  <label className="tool-toggle" key={tool}><input type="checkbox" checked={tools[tool]} onChange={(changeEvent) => setTools({ ...tools, [tool]: changeEvent.target.checked })} />{toolLabel(tool)}</label>
                ))}
              </div>
            )}
          </fieldset>
          <p className="resource-form-help">运行时：子代理与主会话同口径套用用户手动修正的 token 限额；风险工具（bash/edit/write 等）仍走同一审批闸口。委派时按名称传给 <code>delegate_agent</code> 的 <code>subagent</code> 参数，名称与 id 均可。</p>
          <footer className="mcp-form-actions">
            <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => { setFormOpen(false); setEditingId(undefined); }}><X size={13} />取消</button>
            <button className="primary-button" type="submit" disabled={controlsBusy || !name.trim()}>{editingId !== undefined ? "保存修改" : "添加子智能体"}</button>
          </footer>
        </form>
      )}
    </div>
  );
}
