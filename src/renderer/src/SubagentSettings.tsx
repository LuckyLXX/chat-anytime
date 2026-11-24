import { Bot, Pencil, Plus, Search, TerminalSquare, Trash2, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { BuiltinToolName, CodexCliSettings, ModelOption, ProviderOption, ResourceCatalog, RuntimeCommand, SubagentDefinition, SubagentScope, ThinkingLevel } from "../../shared/protocol";
import { DEFAULT_CODEX_CLI_SETTINGS } from "../../shared/codex";
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

/**
 * 子智能体页（设置页「子智能体」tab）。
 *
 * 2026-11-23 按用户口径改成两段式：左栏逐条列出已定义子智能体（含内置/全局/项目
 * 三档合并结果）与一个页面级「Codex CLI」入口，右栏是选中条目的只读详情 / 内置
 * 执行设置 / 可编辑定义表单 / Codex 配置。原实现是「Codex 卡 + 已定义卡 + 表单卡」
 * 一条滚动堆叠，与模型服务 / Agent 角色 / 消息通道的两栏体系不一致。
 *
 * 不变的部分：所有命令（subagent.save / subagent.delete / subagent.model /
 * subagent.thinking / codex.settings.save / codex.connection.test）的载荷与
 * `data-control` 钩子逐字保留；底部动作条仍在滚动主体之外（卡片 overflow:hidden
 * 使 sticky 失效，见 styles.css 的实测注释）。新增的 `selection` / `query` 只是
 * 展示层选中态，不写盘。
 */
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
  // 两段式选中态：'codex' = 页面级 Codex 配置；'__new__' = 新建草稿；
  // 其余值是子智能体 id（三档合并后同 id 只出现一次）。
  const [selection, setSelection] = useState<string>("codex");
  const [query, setQuery] = useState("");

  // —— Codex CLI 接入卡（独立命令 codex.settings.save / codex.connection.test）——
  // 草稿口径：`draft` 一旦被用户改过就以它为准，否则跟随已保存配置（首次挂载时
  // 设置还在加载的窗口里也不会把用户配置显示成默认值）。
  const savedCodex = useDesktopStore((state) => state.settings.codex);
  const codexTestStatus = useDesktopStore((state) => state.codexTestStatus);
  const codexTestMessage = useDesktopStore((state) => state.codexTestMessage);
  const [codexDraft, setCodexDraft] = useState<CodexCliSettings>();
  const [codexNote, setCodexNote] = useState<string>();
  const codex = codexDraft ?? savedCodex ?? DEFAULT_CODEX_CLI_SETTINGS;
  const updateCodex = (patch: Partial<CodexCliSettings>): void => {
    setCodexNote(undefined);
    setCodexDraft({ ...codex, ...patch });
  };

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
    setSelection("__new__");
  }

  function openEdit(subagent: SubagentDefinition): void {
    setSelection(subagent.id);
    setModelEditingId(undefined);
    if (subagent.scope === "bundled") {
      setFormOpen(false);
      return;
    }
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
    setSelection(id);
  }

  /** 保存 Codex 配置（原子替换整份配置；刻意与其他设置分开，见 protocol 的注释）。 */
  async function saveCodex(): Promise<void> {
    const success = await run({ type: "codex.settings.save", codex });
    if (success) {
      // 主进程会把归一化后的权威配置以 settings 事件回推：丢掉本地草稿，卡片跟随
      // 实际落盘的那一份（否则界面上还显示着被主进程修正前的旧值）。
      setCodexDraft(undefined);
      setCodexNote("已保存：下一个回合生效（未保存的改动不会被测试连接写盘）。");
    }
  }

  /**
   * 测试连接：用**当前表单**（含未保存改动）跑一次握手 + 读登录状态。
   * requestId 由渲染端生成，回执按它对号入座——连点两次时旧结果不会覆盖新结果。
   */
  async function testCodex(): Promise<void> {
    const requestId = `codex-test-${Date.now().toString(36)}`;
    setCodexNote(undefined);
    useDesktopStore.setState({ codexTestStatus: "loading", codexTestMessage: undefined, codexTestRequestId: requestId });
    try {
      await window.piDesktop.send({ type: "codex.connection.test", requestId, codex });
    } catch (error) {
      useDesktopStore.setState({ codexTestStatus: "error", codexTestMessage: error instanceof Error ? error.message : "测试连接失败" });
    }
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
  const subagents = resources.subagents;
  const visibleSubagents = subagents.filter((subagent) => `${subagent.name} ${subagent.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = subagents.find((subagent) => subagent.id === selection);
  const isNew = selection === "__new__";
  const showForm = formOpen && (isNew || (selected !== undefined && selected.scope !== "bundled"));
  const showCodex = selection === "codex";

  /** 左栏条目：图标沿用 subagent-color，选中态 .active；内置条目带「内置」徽标。 */
  function railItem(subagent: SubagentDefinition): ReactNode {
    const active = selection === subagent.id;
    return (
      <button type="button" key={`${subagent.scope}/${subagent.id}`} className={active ? "resource-split-rail-item active" : "resource-split-rail-item"} onClick={() => openEdit(subagent)}>
        <span className="resource-item-icon subagent-color" data-color={subagent.color ?? "amber"}><Bot size={13} /></span>
        <span className="resource-split-rail-copy"><strong>{subagent.name}</strong><small>{subagentScopeLabel(subagent.scope)} · {subagent.description || "未填写说明"}</small></span>
        {subagent.scope === "bundled" && <em className="resource-split-rail-badge">内置</em>}
      </button>
    );
  }

  /** 选中定义的只读摘要 + 内置条目的执行设置（写覆盖表，不改定义文件）。 */
  function subagentDetail(subagent: SubagentDefinition): ReactNode {
    return (
      <div className="resource-split-detail-stack">
        <div className="resource-item" data-subagent-scope={subagent.scope}>
          <div className="resource-item-icon subagent-color" data-color={subagent.color ?? "amber"}><Bot size={14} /></div>
          <div className="resource-item-copy">
            <strong>{subagent.name}</strong>
            <small>{subagentScopeLabel(subagent.scope)} · {subagent.model ? `${subagent.model.provider}/${subagent.model.id}` : "继承默认模型"} · {subagent.thinkingLevel ? `思考 ${thinkingLevelLabels[subagent.thinkingLevel]}` : "思考继承会话"} · {subagent.tools === "inherit" ? "继承父会话工具" : "自定义工具"}{subagent.browserTools ? " · 浏览器" : ""}</small>
            <em>{subagent.description || subagent.systemPrompt}</em>
          </div>
          {subagent.scope === "bundled"
            ? <button className="secondary-button compact-button" type="button" disabled={controlsBusy} title={`设置 ${subagent.name} 的执行模型与思考等级`} onClick={() => setModelEditingId((current) => current === subagent.id ? undefined : subagent.id)}><Pencil size={13} />执行设置</button>
            : <>
              <button className="icon-button" type="button" title={`编辑 ${subagent.name}`} aria-label={`编辑子智能体 ${subagent.name}`} disabled={controlsBusy} onClick={() => openEdit(subagent)}><Pencil size={14} /></button>
              <button className="icon-button resource-remove" type="button" title={`删除 ${subagent.name}`} aria-label={`删除子智能体 ${subagent.name}`} disabled={controlsBusy} onClick={() => void deleteSubagent(subagent)}><Trash2 size={14} /></button>
            </>}
        </div>

        {subagent.scope === "bundled" && modelEditingId === subagent.id && (
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
        )}

        <p className="resource-form-help">
          子智能体与主会话共享同一套白名单工具，但可按需收窄；模型与思考等级缺省继承当前会话。项目级放在 <code>.pidesktop-subagents.json</code>，用户全局在用户目录，内置随应用分发。委派 <code>delegate_agent</code> 时 <code>subagent</code> 参数必填，且只能填这里的名称或 id，未命中会被直接拒绝。
        </p>
        <p className="resource-form-help">作用域优先级：项目级 &gt; 用户全局 &gt; 内置（同 id 后者覆盖前者）；内置只读，仅可选执行模型与思考等级。</p>
        <pre className="resource-split-template"><code>{subagent.systemPrompt}</code></pre>
      </div>
    );
  }

  /** Codex CLI 接入卡：页面级配置，作为左栏独立入口放在右栏，不混入定义列表。 */
  function codexDetail(): ReactNode {
    return (
      <section className="resource-card" aria-label="Codex CLI 接入" data-codex-card>
        <div className="resource-card-head">
          <span className="resource-card-title"><TerminalSquare size={14} /><strong>Codex CLI</strong></span>
          <small>把本机 Codex 当作团队的外部运行时：Lead 用 team_spawn 派活，运行来源、进度与结算都进团队看板</small>
          <span className="resource-card-actions">
            <small className="resource-card-count">{codex.enabled ? "已启用" : "未启用"}</small>
            <button className="secondary-button compact-button" type="button" data-codex-test disabled={controlsBusy || codexTestStatus === "loading"} onClick={() => void testCodex()}>{codexTestStatus === "loading" ? "测试中" : "测试连接"}</button>
            <button className="secondary-button compact-button" type="button" data-codex-save disabled={controlsBusy} onClick={() => void saveCodex()}>保存</button>
          </span>
        </div>
        <div className="resource-card-body">
          <label className="checkbox-setting" data-codex-enable><input type="checkbox" checked={codex.enabled} onChange={(changeEvent) => updateCodex({ enabled: changeEvent.target.checked })} />启用 Codex 接入（默认关闭；关闭时团队只使用 Pi 成员）</label>
          <div className="mcp-form-grid">
            <label className="mcp-form-wide">可执行文件
              <input value={codex.executable ?? ""} placeholder="留空 = 自动探测 PATH 上的官方安装（Windows 含 npm 的 codex.cmd）" data-codex-executable onChange={(changeEvent) => updateCodex({ executable: changeEvent.target.value })} />
            </label>
            <label>访问上限
              <select value={codex.access} data-codex-access onChange={(changeEvent) => updateCodex({ access: changeEvent.target.value === "workspace-write" ? "workspace-write" : "read-only" })}>
                <option value="read-only">只读（默认）</option>
                <option value="workspace-write">当前工作区可写</option>
              </select>
            </label>
          </div>
          <p className="resource-form-help">
            凭据由你本机的 Codex 安装自己管理：这里只保存开关、可执行文件路径与访问上限，<strong>不存任何 Codex 令牌</strong>。Codex 访问它自己的本机线程记录，PiDesktop 只保留团队转写。
            「当前工作区可写」只是上限：每一轮还要同时满足 Lead 会话的当前模式（只读恒只读、ask 先拿本轮确认），写入根只有当前工作区并排除临时目录、禁用网络。Windows 上只读与工作区写入都要求 Codex 的 Windows 沙箱就绪（windowsSandbox/readiness = ready）；不 ready 或该版本不支持时两种访问级别都会被拦下并给出具体原因，不会静默降级成只读。「测试连接」只握手、读登录状态与 Windows 沙箱就绪（不建线程、不跑模型、不写配置），可以在保存前先测。
          </p>
          {codexTestStatus !== "idle" && <p className={codexTestStatus === "error" ? "form-error jev-test-result" : "form-hint jev-test-result"} data-role="codex-test-result">{codexTestStatus === "loading" ? "正在连接 Codex…" : codexTestMessage}</p>}
          {codexNote && <p className="form-hint" data-role="codex-save-note">{codexNote}</p>}
        </div>
      </section>
    );
  }

  /** 新建 / 编辑表单：结构与旧版逐字节一致，只换外层容器。 */
  function subagentForm(): ReactNode {
    return (
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
    );
  }

  const detailTitle = showCodex ? "Codex CLI 接入" : showForm ? (editingId !== undefined ? `编辑 ${name.trim() || "未命名"}` : "新建子智能体") : selected ? selected.name : "子智能体";
  const detailSubtitle = showCodex ? "页面级外部运行时配置；与单个子智能体定义无关" : showForm ? "填写定义并在底部保存；保存后即可被 delegate_agent 引用" : "选中左侧条目查看定义；内置只读，可单独设置执行模型与思考等级";
  const detail = showCodex ? codexDetail() : showForm ? subagentForm() : selected ? subagentDetail(selected) : <p className="resource-empty">还没有子智能体。点左下「新建子智能体」定义第一条，或从左侧选 Codex CLI 配置外部运行时。</p>;

  return (
    <form className="resource-page resource-split-page" data-pane="subagent-settings" onSubmit={(formEvent) => void saveSubagent(formEvent)}>
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>子智能体</strong>
          <small>定义可保存、可复用的子智能体：委派时按名称引用；每个子智能体有独立的系统提示词、模型、思考等级与工具集</small>
        </span>
        <span className="resource-page-actions">
          <button className="secondary-button compact-button" type="button" data-control="subagent-add" disabled={controlsBusy} onClick={openCreate}><Plus size={13} />新建子智能体</button>
        </span>
      </header>
      <div className="resource-split-layout">
        <aside className="resource-split-rail" aria-label="子智能体列表">
          <div className="resource-split-rail-head"><strong>子智能体</strong><span>{subagents.length}</span></div>
          <div className="resource-split-rail-search">
            <Search size={13} />
            <input value={query} placeholder="搜索名称或说明" aria-label="搜索子智能体" onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="resource-split-rail-list">
            <button type="button" className={showCodex ? "resource-split-rail-item active" : "resource-split-rail-item"} onClick={() => { setSelection("codex"); setFormOpen(false); }}>
              <span className="resource-split-rail-icon"><TerminalSquare size={13} /></span>
              <span className="resource-split-rail-copy"><strong>Codex CLI</strong><small>外部运行时 · 页面级配置</small></span>
            </button>
            {visibleSubagents.length === 0
              ? <p className="resource-split-rail-empty">{query.trim() ? `没有匹配「${query.trim()}」的子智能体` : "还没有子智能体"}</p>
              : visibleSubagents.map(railItem)}
          </div>
          <button className="resource-split-rail-new" type="button" disabled={controlsBusy} onClick={openCreate}><Plus size={13} />新建子智能体</button>
        </aside>
        <section className="resource-split-detail" aria-label="子智能体详情">
          <header className="resource-split-detail-bar">
            <span className="resource-split-detail-title"><strong>{detailTitle}</strong><small>{detailSubtitle}</small></span>
          </header>
          <div className="resource-split-detail-body">
            {localError && <p className="form-error resource-error">{localError}</p>}
            {detail}
          </div>
        </section>
      </div>
      {showForm && (
        <footer className="subagent-form-actions">
          <span className="subagent-form-note">{editingId !== undefined ? `正在编辑 ${name.trim() || "未命名"}` : "新建子智能体"}</span>
          <button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => { setFormOpen(false); setEditingId(undefined); if (isNew) setSelection("codex"); }}><X size={13} />取消</button>
          <button className="primary-button compact-button" type="submit" data-control="subagent-save" disabled={controlsBusy || !name.trim()}>{editingId !== undefined ? "保存修改" : "添加子智能体"}</button>
        </footer>
      )}
    </form>
  );
}
