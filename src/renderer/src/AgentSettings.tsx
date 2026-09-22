import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  Copy,
  Puzzle,
  Save,
  Search,
  Terminal,
  Wrench,
  X
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { resourceScopeLabels, thinkingLevelLabels, toolLabel } from "../../shared/locale";
import type {
  AgentProfile,
  BuiltinToolName,
  DivBubbleMode,
  ModelOption,
  ProviderOption,
  ResourceCatalog,
  ThinkingLevel
} from "../../shared/protocol";
import { THINKING_LEVELS } from "../../shared/thinking-levels";
import { ModelSelect } from "./components/ModelSelect";

/**
 * 角色页（设置页「Agent 角色」tab）。
 *
 * 从 App.tsx 抽出（2026-09-22）：原实现是 `agent-settings` 里一行 1600+ 字符的
 * JSX，所有字段平铺在同一个容器、共用 `.settings-dialog label` 的
 * `margin: 15px 18px`——「名称」与「系统提示词」视觉权重完全相同，没有任何
 * 分区语义，既不好看也不好配。抽出的同时按用户对齐结果重排：
 *
 * ① 两栏（角色列表 + 编辑器），保存条**固定在编辑器顶部**不再需要滚到底；
 * ② 编辑器按「身份 / 人格与系统提示词 / 对话行为 / 技能 / 扩展能力 / 内建工具权限」
 *    分成带标题与副标题的卡片，同权重字段并排（row2 / row3）；
 * ③ Skill 与工具都从「chips + 折叠下拉」改为「已选 chips + 内联可搜索全量列表 +
 *    全选/全不选/恢复默认」，22 个 Skill 时不必再展开浮层；
 * ④ 角色列表加「使用中」徽标与搜索框（用户本轮指定）。
 *
 * 未纳入本轮（用户明确排除）：归档角色的查看/恢复区、能力开关的 token 成本标注、
 * 「未保存更改」脏标记与离开提醒。
 */

/** 内建工具（powershell 为 opt-in，新建角色默认关闭，与 settings.defaultToolEnabled 对齐）。 */
const AGENT_TOOLS: BuiltinToolName[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** 走权限闸口的工具：与新建角色默认值无关，只用于面板上的提示徽标。 */
const GATED_TOOLS = new Set<BuiltinToolName>(["bash", "edit", "write"]);

const DIV_MODE_OPTIONS: Array<{ value: DivBubbleMode; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "auto", label: "智能判断（按场景使用）" },
  { value: "always", label: "始终开启（全部回复使用）" }
];

const SKILL_SCOPE_TAG: Partial<Record<ResourceCatalog["skills"][number]["scope"], string>> = {
  bundled: "内置",
  global: "全局",
  project: "项目"
};

/** 角色头像色板：按角色 id 稳定取色，避免每次渲染变色。 */
const AVATAR_COLORS = ["#4f46e5", "#0d9488", "#d97706", "#e11d48", "#7c3aed", "#2563eb", "#059669", "#ea580c"];

function avatarColor(agentId: string): string {
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function avatarText(name: string): string {
  return name.trim().slice(0, 1) || "?";
}

/** 角色级 Skill 生效值：overlay 优先，否则跟随 Skill 自身默认。 */
function agentSkillEnabled(agent: AgentProfile, skill: ResourceCatalog["skills"][number]): boolean {
  return agent.skillOverrides?.[skill.id] ?? skill.defaultEnabled;
}

/** 角色级能力工具 overlay：缺省（无键）= 启用，显式 false 才禁用；键域 browser/ssh/mcp:<server>。 */
function agentToolEnabled(agent: AgentProfile, key: string): boolean {
  return agent.toolOverrides?.[key] !== false;
}

interface AgentSettingsProps {
  agents: AgentProfile[];
  /** 当前正在使用的角色 id（快照 agentId），用于列表「使用中」徽标。 */
  activeAgentId?: string;
  selectedAgentId: string;
  models: ModelOption[];
  providers: ProviderOption[];
  resources: ResourceCatalog;
  onSelect(agentId: string): void;
  onCreate(): void;
  onUpdate(patch: Partial<AgentProfile>): void;
  onUpdateSkillOverride(skillId: string, enabled: boolean): void;
  onUpdateToolOverride(key: string, enabled: boolean): void;
  onSave(): void;
  onDuplicate(): void;
  onArchive(): void;
}

export function AgentSettings({
  agents,
  activeAgentId,
  selectedAgentId,
  models,
  providers,
  resources,
  onSelect,
  onCreate,
  onUpdate,
  onUpdateSkillOverride,
  onUpdateToolOverride,
  onSave,
  onDuplicate,
  onArchive
}: AgentSettingsProps): ReactNode {
  const [query, setQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const visibleAgents = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return agents
      .filter((agent) => !agent.archived)
      .filter((agent) => !keyword || `${agent.name} ${agent.description}`.toLowerCase().includes(keyword));
  }, [agents, query]);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const configuredModels = models.filter((model) => model.configured);
  const skills = resources.skills;
  const visibleSkills = useMemo(() => {
    const keyword = skillQuery.trim().toLowerCase();
    return skills.filter((skill) => !keyword || `${skill.name} ${skill.description}`.toLowerCase().includes(keyword));
  }, [skills, skillQuery]);

  if (!selectedAgent) {
    return (
      <div className="agent-settings" data-pane="agent-settings">
        <p className="agent-editor-empty">还没有任何角色。点击左侧「新建角色」开始。</p>
      </div>
    );
  }

  const selectedSkills = skills.filter((skill) => agentSkillEnabled(selectedAgent, skill));
  const selectableSkills = skills.filter((skill) => skill.toggleable);
  const enabledTools = AGENT_TOOLS.filter((tool) => selectedAgent.tools[tool]);

  /**
   * 批量写入 Skill overlay：一次性构造完整 overlay、单次 onUpdate 提交。
   * 不能循环调用 onUpdateSkillOverride——同一事件里多次 setState 用的是
   * 同一个闭包里的旧 selectedAgent.skillOverrides，逐键写入会互相覆盖，
   * 最终只剩列表最后一个技能生效（2026-09-23「全选/全不选没反应」的根因）。
   * 只对可切换的 Skill 写键（运行时动态提供的保持原样）。
   */
  /**
   * 批量写入 Skill overlay：一次性构造完整 overlay、单次 onUpdate 提交。
   * 不能循环调用 onUpdateSkillOverride——同一事件里多次 setState 用的是
   * 同一个闭包里的旧 selectedAgent.skillOverrides，逐键写入会互相覆盖，
   * 最终只剩列表最后一个技能生效（2026-09-23「全选/全不选没反应」的根因）。
   * 只对可切换的 Skill 写键（运行时动态提供的保持原样）。
   */
  function setAllSkills(enabled: boolean, list: ResourceCatalog["skills"]): void {
    const overrides: Record<string, boolean> = { ...selectedAgent?.skillOverrides };
    for (const skill of list) {
      if (skill.toggleable) overrides[skill.id] = enabled;
    }
    onUpdate({ skillOverrides: overrides });
  }

  /** 恢复默认 = 清空角色级 Skill overlay（回到每个 Skill 自身的 defaultEnabled）。 */
  function resetSkillOverrides(): void {
    onUpdate({ skillOverrides: undefined });
  }

  return (
    <div className="agent-settings" data-pane="agent-settings">
      <div className="agent-rail">
        <div className="agent-rail-search">
          <Search size={13} />
          <input value={query} placeholder="搜索角色…" aria-label="搜索角色" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="agent-rail-list">
          {visibleAgents.length === 0
            ? <p className="agent-rail-empty">没有匹配「{query.trim()}」的角色</p>
            : visibleAgents.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  className={agent.id === selectedAgent.id ? "agent-rail-item active" : "agent-rail-item"}
                  onClick={() => onSelect(agent.id)}
                >
                  <span className="agent-rail-avatar" style={{ background: avatarColor(agent.id) }}>{avatarText(agent.name)}</span>
                  <span className="agent-rail-copy">
                    <strong>{agent.name}{agent.id === activeAgentId && <em className="agent-rail-live">使用中</em>}</strong>
                    <small>{agent.description || "未填写说明"}</small>
                  </span>
                </button>
              ))}
        </div>
        <button type="button" className="agent-rail-new" data-control="agent-new" onClick={onCreate}>+ 新建角色</button>
      </div>

      <div className="agent-editor">
        <header className="agent-editor-bar">
          <span className="agent-editor-avatar" style={{ background: avatarColor(selectedAgent.id) }}>{avatarText(selectedAgent.name)}</span>
          <span className="agent-editor-title">
            <strong>{selectedAgent.name || "未命名角色"}</strong>
            <small>{selectedAgent.description || "未填写说明"}</small>
          </span>
          <span className="agent-editor-actions">
            <button type="button" className="danger-button compact-button" disabled={selectedAgent.id === "default"} onClick={onArchive}><Archive size={13} />归档</button>
            <button type="button" className="secondary-button compact-button" onClick={onDuplicate}><Copy size={13} />复制</button>
            <button type="button" className="primary-button compact-button" data-control="agent-save" onClick={onSave}><Save size={13} />保存角色</button>
          </span>
        </header>

        <div className="agent-editor-body">
          <section className="agent-card" aria-label="身份">
            <div className="agent-card-head"><strong>身份</strong><small>显示在角色列表与侧栏</small></div>
            <div className="agent-card-body">
              <div className="agent-field-row">
                <label className="agent-field"><span>名称</span><input value={selectedAgent.name} onChange={(event) => onUpdate({ name: event.target.value })} /></label>
                <label className="agent-field"><span>说明</span><input value={selectedAgent.description} placeholder="一句话描述这个角色的用途" onChange={(event) => onUpdate({ description: event.target.value })} /></label>
              </div>
            </div>
          </section>

          <section className="agent-card" aria-label="人格与系统提示词">
            <div className="agent-card-head">
              <strong>人格与系统提示词</strong>
              <small>新建会话时注入 · 改动保存后重建会话生效</small>
              <em className="agent-card-count">{selectedAgent.systemPrompt.length} 字</em>
            </div>
            <div className="agent-card-body">
              <label className="agent-field"><textarea value={selectedAgent.systemPrompt} rows={7} placeholder="描述这个角色的职责、边界与工作方式…" onChange={(event) => onUpdate({ systemPrompt: event.target.value })} /></label>
              <p className="agent-hint">系统提示词属请求前缀的固定段：会话内不变、不重复计费，但改动会让已缓存的前缀失效。</p>
            </div>
          </section>

          <section className="agent-card" aria-label="对话行为">
            <div className="agent-card-head"><strong>对话行为</strong><small>新会话的默认值，可在顶栏临时覆盖</small></div>
            <div className="agent-card-body">
              <div className="agent-field-row three">
                <label className="agent-field"><span>Div 气泡模式</span><select value={selectedAgent.divMode} onChange={(event) => onUpdate({ divMode: event.target.value as DivBubbleMode })}>{DIV_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="agent-field">
                  <span>默认模型</span>
                  <ModelSelect models={configuredModels} providers={providers} value={selectedAgent.defaultModel ? `${selectedAgent.defaultModel.provider}/${selectedAgent.defaultModel.id}` : ""} placeholder="跟随全局默认模型" onChange={(value) => { const slash = value.indexOf("/"); onUpdate({ defaultModel: value && slash > 0 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : undefined }); }} />
                </label>
                <label className="agent-field"><span>默认思考等级</span><select value={selectedAgent.defaultThinkingLevel} onChange={(event) => onUpdate({ defaultThinkingLevel: event.target.value as ThinkingLevel })}>{THINKING_LEVELS.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label>
              </div>
            </div>
          </section>

          <section className="agent-card" aria-label="技能">
            <div className="agent-card-head">
              <strong>技能 Skill</strong>
              <small>已选 {selectedSkills.length} / {skills.length}</small>
              <span className="agent-card-actions">
                <button type="button" className="secondary-button compact-button" disabled={selectableSkills.length === 0} onClick={() => setAllSkills(true, skills)}>全选</button>
                <button type="button" className="secondary-button compact-button" disabled={selectableSkills.length === 0} onClick={() => setAllSkills(false, skills)}>全不选</button>
                <button type="button" className="secondary-button compact-button" disabled={!selectedAgent.skillOverrides} onClick={resetSkillOverrides}>恢复默认</button>
              </span>
            </div>
            <div className="agent-card-body">
              {selectedSkills.length > 0
                ? (
                  <div className="agent-chips">
                    {selectedSkills.map((skill) => (
                      <span className="agent-chip" key={skill.id}>
                        <Puzzle size={12} />
                        <span>{skill.name}</span>
                        {skill.toggleable && <button type="button" title={`移除 ${skill.name}`} aria-label={`移除 Skill ${skill.name}`} onClick={() => onUpdateSkillOverride(skill.id, false)}><X size={12} /></button>}
                      </span>
                    ))}
                  </div>
                )
                : <p className="agent-empty">未选择 Skill</p>}
              {skills.length === 0
                ? <p className="agent-empty">当前没有可用 Skill。</p>
                : (
                  <div className="agent-picker">
                    {skills.length > 8 && (
                      <div className="agent-picker-search">
                        <Search size={13} />
                        <input value={skillQuery} placeholder="搜索 Skill 名称或说明" aria-label="搜索 Skill" onChange={(event) => setSkillQuery(event.target.value)} />
                      </div>
                    )}
                    <div className="agent-picker-list">
                      {visibleSkills.length === 0
                        ? <p className="agent-empty">没有匹配「{skillQuery.trim()}」的 Skill</p>
                        : visibleSkills.map((skill) => {
                            const checked = agentSkillEnabled(selectedAgent, skill);
                            return (
                              <label className={checked ? "agent-check on" : "agent-check"} key={skill.id} title={skill.toggleable ? skill.description : "该 Skill 由运行时动态提供，不可关闭"}>
                                <input type="checkbox" checked={checked} disabled={!skill.toggleable} onChange={(event) => onUpdateSkillOverride(skill.id, event.target.checked)} />
                                <span className="agent-check-box">{checked && <Check size={11} />}</span>
                                <span className="agent-check-name">{skill.name}</span>
                                <em>{SKILL_SCOPE_TAG[skill.scope] ?? resourceScopeLabels[skill.scope]}</em>
                              </label>
                            );
                          })}
                    </div>
                  </div>
                )}
            </div>
          </section>

          <section className="agent-card" aria-label="扩展能力">
            <div className="agent-card-head"><strong>扩展能力</strong><small>整族开关；关掉即从每请求前缀摘除该族的工具 schema</small></div>
            <div className="agent-card-body">
              <label className="agent-switch-row">
                <span className="agent-switch-icon"><Bot size={13} /></span>
                <span className="agent-switch-copy"><strong>浏览器自动化</strong><small>16 个 browser_* 工具</small></span>
                <input type="checkbox" className="agent-switch" checked={agentToolEnabled(selectedAgent, "browser")} onChange={(event) => onUpdateToolOverride("browser", event.target.checked)} />
              </label>
              <label className="agent-switch-row">
                <span className="agent-switch-icon"><Terminal size={13} /></span>
                <span className="agent-switch-copy"><strong>SSH 远程终端</strong><small>8 个 ssh_* 工具</small></span>
                <input type="checkbox" className="agent-switch" checked={agentToolEnabled(selectedAgent, "ssh")} onChange={(event) => onUpdateToolOverride("ssh", event.target.checked)} />
              </label>
              {resources.mcpServers.map((server) => (
                <label className="agent-switch-row" key={`mcp:${server.name}`} title={server.disabled ? "该服务器已在 MCP 设置中停用" : undefined}>
                  <span className="agent-switch-icon"><Wrench size={13} /></span>
                  <span className="agent-switch-copy">
                    <strong>{server.name}</strong>
                    <small>{server.disabled ? "MCP · 已在 MCP 设置中停用" : `MCP · ${server.toolCount} 个工具`}</small>
                  </span>
                  <input type="checkbox" className="agent-switch" checked={agentToolEnabled(selectedAgent, `mcp:${server.name}`)} onChange={(event) => onUpdateToolOverride(`mcp:${server.name}`, event.target.checked)} />
                </label>
              ))}
              {resources.mcpServers.length === 0 && <p className="agent-empty">未发现 MCP Server，配置后可在这里按服务器启停。</p>}
            </div>
          </section>

          <section className="agent-card" aria-label="内建工具权限">
            <div className="agent-card-head">
              <strong>内建工具权限</strong>
              <small>关掉 = 模型完全看不到该工具 · 已启用 {enabledTools.length}/{AGENT_TOOLS.length}</small>
              <span className="agent-card-actions">
                <button type="button" className="secondary-button compact-button" disabled={enabledTools.length === AGENT_TOOLS.length} onClick={() => onUpdate({ tools: Object.fromEntries(AGENT_TOOLS.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean> })}>全部启用</button>
                <button type="button" className="secondary-button compact-button" disabled={enabledTools.length === 0} onClick={() => onUpdate({ tools: Object.fromEntries(AGENT_TOOLS.map((tool) => [tool, false])) as Record<BuiltinToolName, boolean> })}>全部关闭</button>
              </span>
            </div>
            <div className="agent-card-body">
              <div className="agent-tool-grid">
                {AGENT_TOOLS.map((tool) => {
                  const checked = selectedAgent.tools[tool];
                  return (
                    <label className={checked ? "agent-check on" : "agent-check"} key={tool}>
                      <input type="checkbox" checked={checked} onChange={(event) => onUpdate({ tools: { ...selectedAgent.tools, [tool]: event.target.checked } })} />
                      <span className="agent-check-box">{checked && <Check size={11} />}</span>
                      <span className="agent-check-name">{toolLabel(tool)}</span>
                      {GATED_TOOLS.has(tool) ? <em className="agent-check-gate"><AlertTriangle size={10} />需审批</em> : tool === "powershell" ? <em>默认关</em> : null}
                    </label>
                  );
                })}
              </div>
              <p className="agent-hint">权限轴（每次询问 / 允许工作区 / 完全允许）在顶栏统一切换；这里的开关只决定角色自己能用哪些工具。</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
