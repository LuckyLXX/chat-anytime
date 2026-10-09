import { Bot, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { BuiltinToolName, ModelOption, ProviderOption, ResourceCatalog, RuntimeCommand, SubagentDefinition, SubagentScope, ThinkingLevel } from "../../shared/protocol";
import { toolLabel, thinkingLevelLabels } from "../../shared/locale";
import { THINKING_LEVELS } from "../../shared/thinking-levels";
import { selectableCatalogModels } from "./lib/model-list";
import { ModelSelect } from "./components/ModelSelect";
import { useDesktopStore } from "./store";

const SUBAGENT_TOOLS: BuiltinToolName[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const SCOPE_LABELS: Record<SubagentScope, string> = { bundled: "内置", global: "用户（全局）", project: "当前项目" };
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
  // 「」= 继承主会话当前思考等级；档位值 = 显式设定（`off` 也是显式档位）。
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "">("");
  // 内置条目：只开放「执行模型」选择（定义本体只读），行内内联一个下拉而不是弹表单。
  const [modelEditingId, setModelEditingId] = useState<string>();
  const [systemPrompt, setSystemPrompt] = useState("");
  const [scope, setScope] = useState<SubagentScope>("global");
  const [injectAgentsMd, setInjectAgentsMd] = useState(false);
  // 浏览器能力独立于 inherited 开关：它不是 Pi 原生工具，主会话里也是常驻的
  // customTools 能力族；这里只是决定子代理要不要带上它。
  const [browserTools, setBrowserTools] = useState(false);
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
    setThinkingLevel("");
    setSystemPrompt("");
    setScope(workspaceOpen ? "project" : "global");
    setInjectAgentsMd(false);
    setBrowserTools(false);
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
    setThinkingLevel(subagent.thinkingLevel ?? "");
    setSystemPrompt(subagent.systemPrompt);
    setScope(subagent.scope);
    setInjectAgentsMd(subagent.injectAgentsMd === true);
    setBrowserTools(subagent.browserTools === true);
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
    // 整页是 <form>（底部动作条要在滚动主体之外），未展开编辑器时的隐式提交直接忽略。
    if (!formOpen) return;
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
      ...(thinkingLevel ? { thinkingLevel } : {}),
      systemPrompt: systemPrompt.trim() || "完成委派给你的独立子任务。",
      scope,
      ...(injectAgentsMd ? { injectAgentsMd: true } : {}),
      ...(browserTools ? { browserTools: true } : {}),
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

  /** 内置定义的执行模型：写覆盖表（不走定义文件），空串 = 回到继承默认模型。 */
  async function saveBundledModel(id: string, value: string): Promise<void> {
    const slash = value.indexOf("/");
    const modelValue = value && configuredModels.some((item) => `${item.provider}/${item.id}` === value) ? value : "";
    const ok = await run({
      type: "subagent.model",
      id,
      ...(modelValue ? { model: { provider: modelValue.slice(0, slash), id: modelValue.slice(slash + 1) } } : {})
    });
    if (ok) setModelEditingId(undefined);
  }

  /** 内置定义的思考等级：同样写覆盖表；空串 = 回到继承主会话档位。 */
  async function saveBundledThinking(id: string, value: string): Promise<void> {
    await run({ type: "subagent.thinking", id, ...(value ? { thinkingLevel: value as ThinkingLevel } : {}) });
  }

  const controlsBusy = busy;

  return (
    <form className="resource-page" data-pane="subagent-settings" onSubmit={(formEvent) => void saveSubagent(formEvent)}>
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>子智能体</strong>
          <small>定义可保存、可复用的子智能体：委派时按名称引用；每个子智能体有独立的系统提示词、模型、思考等级与工具集</small>
        </span>
        <span className="resource-page-actions">
          <button className="secondary-button compact-button" type="button" data-control="subagent-add" disabled={controlsBusy} onClick={openCreate}><Plus size={13} />新建子智能体</button>
        </span>
      </header>
      <div className="resource-page-body">
        {localError && <p className="form-error resource-error">{localError}</p>}

        <section className="resource-card" aria-label="已定义子智能体">
          <div className="resource-card-head">
            <span className="resource-card-title"><Bot size={14} /><strong>已定义</strong></span>
            <small>作用域优先级：项目级 &gt; 用户全局 &gt; 内置（同 id 后者覆盖前者）；内置只读，仅可选执行模型与思考等级</small>
            <span className="resource-card-actions"><small className="resource-card-count">{resources.subagents.length} 个</small></span>
          </div>
          <div className="resource-card-body">
            <p className="resource-form-help">
              子智能体与主会话共享同一套白名单工具，但可按需收窄；模型与思考等级缺省继承当前会话。项目级放在 <code>.pidesktop-subagents.json</code>，用户全局在用户目录，内置随应用分发。委派 <code>delegate_agent</code> 时 <code>subagent</code> 参数必填，且只能填这里的名称或 id，未命中会被直接拒绝。
            </p>
            {resources.subagents.length === 0
              ? <p className="resource-empty">还没有子智能体。点右上「新建子智能体」，定义名称、系统提示词与工具范围后保存。</p>
              : (
                <div className="resource-list">
                  {resources.subagents.map((subagent) => (
                    <div className="resource-item" key={`${subagent.scope}/${subagent.id}`} data-subagent-scope={subagent.scope}>
                      <div className="resource-item-icon subagent-color" data-color={subagent.color ?? "amber"}><Bot size={14} /></div>
                      <div className="resource-item-copy">
                        <strong>{subagent.name}</strong>
                        <small>{subagentScopeLabel(subagent.scope)} · {subagent.model ? `${subagent.model.provider}/${subagent.model.id}` : "继承默认模型"} · {subagent.thinkingLevel ? `思考 ${thinkingLevelLabels[subagent.thinkingLevel]}` : "思考继承会话"} · {subagent.tools === "inherit" ? "继承父会话工具" : "自定义工具"}{subagent.browserTools ? " · 浏览器" : ""}</small>
                        <em>{subagent.description || subagent.systemPrompt}</em>
                      </div>
                      {subagent.scope === "bundled" ? (
                        modelEditingId === subagent.id ? (
                          <div className="subagent-model-edit">
                            <ModelSelect models={configuredModels} providers={providers} value={subagent.model ? `${subagent.model.provider}/${subagent.model.id}` : ""} placeholder="继承当前会话模型" onChange={(value) => void saveBundledModel(subagent.id, value)} />
                            <select
                              className="subagent-thinking-select"
                              value={subagent.thinkingLevel ?? ""}
                              title="执行时的思考等级"
                              aria-label={`${subagent.name} 的思考等级`}
                              disabled={controlsBusy}
                              onChange={(changeEvent) => void saveBundledThinking(subagent.id, changeEvent.target.value)}
                            >
                              <option value="">思考：继承会话</option>
                              {THINKING_LEVELS.map((level) => <option key={level} value={level}>思考：{thinkingLevelLabels[level]}</option>)}
                            </select>
                            <button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => setModelEditingId(undefined)}>完成</button>
                          </div>
                        ) : (
                          <button className="secondary-button compact-button" type="button" disabled={controlsBusy} title={`设置 ${subagent.name} 的执行模型与思考等级`} onClick={() => setModelEditingId(subagent.id)}><Pencil size={13} />执行设置</button>
                        )
                      ) : (
                        <>
                          <button className="icon-button" type="button" title={`编辑 ${subagent.name}`} aria-label={`编辑子智能体 ${subagent.name}`} disabled={controlsBusy} onClick={() => openEdit(subagent)}><Pencil size={14} /></button>
                          <button className="icon-button resource-remove" type="button" title={`删除 ${subagent.name}`} aria-label={`删除子智能体 ${subagent.name}`} disabled={controlsBusy} onClick={() => void deleteSubagent(subagent)}><Trash2 size={14} /></button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </div>
        </section>

        {formOpen && (
          <section className="resource-card subagent-form" aria-label="编辑子智能体">
            <div className="resource-card-head">
              <span className="resource-card-title"><Bot size={14} /><strong>{editingId !== undefined ? "编辑子智能体" : "新建子智能体"}</strong></span>
              <small>{editingId !== undefined ? name.trim() || "未命名" : "保存后本条定义立即可被 delegate_agent 引用"}</small>
            </div>
            <div className="resource-card-body">
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
                <label>思考等级
                  <select value={thinkingLevel} onChange={(changeEvent) => setThinkingLevel(changeEvent.target.value as ThinkingLevel | "")}>
                    <option value="">继承当前会话档位</option>
                    {THINKING_LEVELS.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}
                  </select>
                </label>
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
                <label className="checkbox-setting" data-control="subagent-browser-tools"><input type="checkbox" checked={browserTools} onChange={(changeEvent) => setBrowserTools(changeEvent.target.checked)} />浏览器自动化（browser_*，可在实施中打开内置浏览器验证页面、点击调试与截图；与主会话共享同一浏览器，导航等敏感操作仍走同一道审批）</label>
              </fieldset>
              <p className="resource-form-help">运行时：子代理与主会话同口径套用用户手动修正的 token 限额；思考等级按「子模型实际支持的档位」自动降级（Pi 口径，与主会话菜单一致，可在委派卡片上看到本次实测档位）；风险工具（bash/edit/write 等）仍走同一审批闸口；开启浏览器能力后，browser_* 与主会话共享同一内置浏览器实例，浏览器总闸（设置 → 通用）实时生效。子代理空产出（既不返回文本也无工具调用）计为失败并上报原因，不再伪装成成功；新增定义后活动会话会自动重建以刷新可用清单（会话忙时跳过，下次重建生效）。</p>
            </div>
          </section>
        )}
      </div>
      {formOpen && (
        <footer className="subagent-form-actions">
          <span className="subagent-form-note">{editingId !== undefined ? `正在编辑 ${name.trim() || "未命名"}` : "新建子智能体"}</span>
          <button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => { setFormOpen(false); setEditingId(undefined); }}><X size={13} />取消</button>
          <button className="primary-button compact-button" type="submit" data-control="subagent-save" disabled={controlsBusy || !name.trim()}>{editingId !== undefined ? "保存修改" : "添加子智能体"}</button>
        </footer>
      )}
    </form>
  );
}
