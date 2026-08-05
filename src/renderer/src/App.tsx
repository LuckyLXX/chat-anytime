import {
  AlertCircle,
  Bot,
  Check,
  Copy,
  ChevronDown,
  CircleStop,
  CodeXml,
  FileDiff,
  Folder,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  MessageSquarePlus,
  MessageCircle,
  Search,
  Users,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  Paperclip,
  Pencil,
  Settings,
  TerminalSquare,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  ChatMessage,
  AgentProfile,
  BuiltinToolName,
  ProviderSettings,
  CustomProviderModel,
  ModelOption,
  PermissionDecision,
  ProviderOption,
  ThinkingLevel,
  ThemePresetId,
  ToolExecution,
  MessageBlock
} from "../../shared/protocol";
import { thinkingLevelLabels, toolLabel } from "../../shared/locale";
import { ArtifactPreview } from "./components/ArtifactPreview";
import { DiffView } from "./components/DiffView";
import { RichContent } from "./components/RichContent";
import { compactPath, formatDuration, type Artifact } from "./lib/content";
import { groupAssistantMessages, splitAssistantToolLayout } from "./lib/chat-layout";
import { THEME_PRESETS, themePresetCss } from "./lib/theme-presets";
import { useDesktopStore } from "./store";

const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const agentTools: BuiltinToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function messageText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function thinkingText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === "thinking")
    .map((block) => block.text)
    .join("");
}

function blockText(blocks: MessageBlock[]): string {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function ImageMessageBlock({ block }: { block: Extract<MessageBlock, { type: "image" }> }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const src = `data:${block.mimeType};base64,${block.data}`;
  useEffect(() => {
    if (!expanded) return;
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);
  return (
    <>
      <button className="image-message" type="button" aria-label="放大图片" onClick={() => setExpanded(true)}><img src={src} alt="用户上传的图片" /></button>
      {expanded && <div className="modal-backdrop image-lightbox" role="presentation" onMouseDown={() => setExpanded(false)}><div className="image-lightbox-content" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={(event) => event.stopPropagation()}><button className="icon-button modal-close" type="button" title="关闭图片" aria-label="关闭图片" onClick={() => setExpanded(false)}><X size={17} /></button><img src={src} alt="用户上传的图片" /></div></div>}
    </>
  );
}

function ToolGroup({ calls, executions, streaming }: { calls: Array<Extract<MessageBlock, { type: "tool-call" }>>; executions: ToolExecution[]; streaming?: boolean }): ReactNode {
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  const items = calls.map((call) => ({ call, execution: byId.get(call.id) }));
  const active = streaming || items.some((item) => item.execution?.status === "running");
  const names = [...new Set(items.map((item) => toolLabel(item.call.name)))];
  const allDone = items.every((item) => item.execution?.status === "completed" || item.execution?.status === "error");
  return (
    <details className="tool-call-group" open={active}>
      <summary className="tool-call-group-summary">
        <span className="tool-call-group-title"><Wrench size={14} /><strong>{allDone ? "已处理" : "连续工具调用"} · {calls.length} 次</strong></span>
        <span className="tool-call-group-preview">{names.slice(0, 3).map((name) => <span className="tool-call-group-chip" key={name}>{name}</span>)}{names.length > 3 && <span className="tool-call-group-extra">+{names.length - 3}</span>}</span>
        <span className="tool-call-group-toggle" aria-hidden="true" />
      </summary>
      <div className="tool-call-group-body">
        {items.map(({ call, execution }) => (
          <div className="tool-call-group-item" key={call.id}>
            <div className={`tool-call-bubble${execution?.status === "completed" ? " completed" : ""}`}>
              <Wrench size={14} /><strong>{toolLabel(call.name)}</strong>
              {execution?.completedAt && <span className="tool-call-duration">{formatDuration(execution.startedAt, execution.completedAt)}</span>}
              <span className={`tool-call-status ${execution?.status === "completed" ? "done" : ""}`}>{execution?.status === "error" ? "失败" : execution?.status === "completed" ? "完成" : "执行中"}</span>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function MessageView({ message, executions, onOpenArtifact, onHtmlAction, onCopy, onEdit, onRegenerate, showThinking = true, busy = false }: { message: ChatMessage; executions: ToolExecution[]; onOpenArtifact(artifact: Artifact): void; onHtmlAction(text: string): void; onCopy(message: ChatMessage): void; onEdit(message: ChatMessage): void; onRegenerate(message: ChatMessage): void; showThinking?: boolean; busy?: boolean }): ReactNode {
  const text = messageText(message);
  const thinking = thinkingText(message);
  const toolLayout = splitAssistantToolLayout(message);

  if (message.role === "user") {
    const images = message.blocks.filter((block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image");
    return (
      <article className="message message-user">
        <div className="message-avatar user-avatar">我</div>
        <div className="message-body">{images.length > 0 && <div className="image-message-list">{images.map((block, index) => <ImageMessageBlock key={`${message.id}-image-${index}`} block={block} />)}</div>}{text && <p className="user-text">{text}</p>}<div className="message-actions"><button type="button" title="复制" aria-label="复制用户消息" onClick={() => onCopy(message)}><Copy size={13} /></button><button type="button" title="重新编辑" aria-label="重新编辑用户消息" onClick={() => onEdit(message)}><Pencil size={13} /></button></div></div>
      </article>
    );
  }

  return (
    <article className="message message-assistant">
      <div className="message-avatar pi-avatar"><Bot size={17} /></div>
      <div className="message-body">
        {thinking && showThinking && (
          <details className="thinking-block" open={message.streaming}>
            <summary><LoaderCircle size={14} className={message.streaming ? "spinning" : ""} /> 思考过程</summary>
            <p>{thinking}</p>
          </details>
        )}
        {toolLayout ? (
          <>
            {blockText(toolLayout.leading) && <RichContent streaming={false} artifactPrefix={`${message.id}-leading`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{blockText(toolLayout.leading)}</RichContent>}
            <ToolGroup calls={toolLayout.process} executions={executions} streaming={message.streaming} />
            {blockText(toolLayout.trailing) && <RichContent streaming={message.streaming} artifactPrefix={`${message.id}-trailing`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{blockText(toolLayout.trailing)}</RichContent>}
          </>
        ) : text && <RichContent streaming={message.streaming} artifactPrefix={message.id} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{text}</RichContent>}
        {message.error && <p className="inline-error"><AlertCircle size={15} />{message.error}</p>}
        {!message.streaming && !busy && <div className="message-actions"><button type="button" title="重新生成" aria-label="重新生成回复" onClick={() => onRegenerate(message)}><RefreshCw size={13} /></button><button type="button" title="复制" aria-label="复制 AI 回复" onClick={() => onCopy(message)}><Copy size={13} /></button></div>}
      </div>
    </article>
  );
}

function ExecutionItem({ execution, selected, onSelect }: { execution: ToolExecution; selected: boolean; onSelect(): void }): ReactNode {
  const statusIcon = execution.status === "running"
    ? <LoaderCircle size={14} className="spinning" />
    : execution.status === "error"
      ? <AlertCircle size={14} />
      : <Check size={14} />;
  return (
    <button type="button" className={`execution-item${selected ? " selected" : ""}`} onClick={onSelect}>
      <span className={`execution-status ${execution.status}`}>{statusIcon}</span>
      <span className="execution-copy">
        <strong>{toolLabel(execution.name)}</strong>
        <small>{formatDuration(execution.startedAt, execution.completedAt)}</small>
      </span>
      <ChevronDown size={14} className="execution-chevron" />
    </button>
  );
}

function ActivityPanel({ executions }: { executions: ToolExecution[] }): ReactNode {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = executions.find((item) => item.id === selectedId) ?? executions.at(-1);
  return (
    <div className="activity-panel">
      <div className="activity-list">
        {executions.length === 0 ? (
          <div className="panel-empty"><Wrench size={20} /><span>暂无工具活动</span></div>
        ) : executions.map((execution) => (
          <ExecutionItem
            key={execution.id}
            execution={execution}
            selected={selected?.id === execution.id}
            onSelect={() => setSelectedId(execution.id)}
          />
        ))}
      </div>
      {selected && (
        <div className="execution-detail">
          <div className="detail-section">
            <h3>输入</h3>
            <pre>{JSON.stringify(selected.args, null, 2)}</pre>
          </div>
          {selected.patch && <div className="detail-section"><h3>变更</h3><DiffView patch={selected.patch} /></div>}
          {selected.output && <div className="detail-section"><h3>输出</h3><pre>{selected.output}</pre></div>}
        </div>
      )}
    </div>
  );
}

function ChangesPanel({ executions }: { executions: ToolExecution[] }): ReactNode {
  const changes = executions.filter((execution) => execution.patch);
  if (changes.length === 0) return <div className="panel-empty"><FileDiff size={20} /><span>暂无文件变更</span></div>;
  return (
    <div className="changes-panel">
      {changes.map((execution) => (
        <details key={execution.id} open>
          <summary><FileDiff size={15} />{toolLabel(execution.name)}<span>{formatDuration(execution.startedAt, execution.completedAt)}</span></summary>
          <DiffView patch={execution.patch!} />
        </details>
      ))}
    </div>
  );
}

function ThemePreview(): ReactNode {
  const previewContent = `**实时主题预览**

Markdown、表格、代码、公式和图表会共用当前主题变量。

| 输出 | 状态 |
| --- | --- |
| 代码高亮 | 跟随主题 |
| HTML 片段 | 已清洗 |

\`\`\`ts
const theme = "live";
\`\`\`

$$E = mc^2$$

\`\`\`mermaid
flowchart LR
  Theme[主题] --> Preview[实时预览]
  Preview --> Output[消息输出]
\`\`\`

<assistant_html><div><strong>HTML 片段</strong><p>安全清洗后仍保留布局和交互样式。</p></div></assistant_html>`;
  return (
    <div className="theme-preview" aria-label="主题预览">
      <div className="theme-preview-header"><span className="theme-preview-dot" /><strong>Pi Desktop</strong><small>主题预览</small></div>
      <div className="theme-preview-body"><RichContent streaming={false} artifactPrefix="theme-preview" onOpenArtifact={() => undefined}>{previewContent}</RichContent></div>
    </div>
  );
}

function SettingsDialog({ settings, models, providers, customProvider, customProviderKeyConfigured, customModels, customModelFetchStatus, customModelFetchError, onClose }: { settings: import("../../shared/protocol").DesktopSettings; models: ModelOption[]; providers: ProviderOption[]; customProvider?: ProviderSettings; customProviderKeyConfigured: boolean; customModels: CustomProviderModel[]; customModelFetchStatus: "idle" | "loading" | "success" | "error"; customModelFetchError?: string; onClose(): void }): ReactNode {
  const customProviderId = "chatanytime-openai-compatible";
  const configuredProviders = settings.providers;
  const firstCustomProvider = configuredProviders[0];
  const [provider, setProvider] = useState(firstCustomProvider?.id ?? customProviderId);
  const selectedProvider = configuredProviders.find((item) => item.id === provider);
  const isCustomProvider = provider === customProviderId || provider.startsWith("provider-") || Boolean(selectedProvider);
  const [customName, setCustomName] = useState(selectedProvider?.name ?? customProvider?.name ?? "我的中转站");
  const [customBaseUrl, setCustomBaseUrl] = useState(selectedProvider?.baseUrl ?? customProvider?.baseUrl ?? "");
  const [customModelId, setCustomModelId] = useState(selectedProvider?.models[0]?.id ?? customProvider?.models[0]?.id ?? customModels[0]?.id ?? "");
  const [imageInputOverride, setImageInputOverride] = useState<boolean | undefined>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [tab, setTab] = useState<"general" | "models" | "agents" | "appearance">("general");
  const initialSettingsRef = useRef<import("../../shared/protocol").DesktopSettings>(structuredClone(settings));
  const [agentList, setAgentList] = useState<AgentProfile[]>(settings.agents);
  const [selectedAgentId, setSelectedAgentId] = useState(settings.currentAgentId);
  const cssFileInputRef = useRef<HTMLInputElement>(null);
  const selectedAgent = agentList.find((agent) => agent.id === selectedAgentId) ?? agentList[0];
  const configuredModels = models.filter((model) => model.configured);
  const hasSavedCustomKey = Boolean(selectedProvider?.keyConfigured) || (provider === customProviderId && customProviderKeyConfigured);
  const providerModels = isCustomProvider ? (selectedProvider?.models ?? customModels) : [];
  const enabledProviderModels = providerModels.filter((model) => model.enabled !== false);
  const selectedCustomModel = providerModels.find((model) => model.id === customModelId);
  function closeSettings(): void { useDesktopStore.setState({ settings: structuredClone(initialSettingsRef.current) }); onClose(); }
  function markSettingsSaved(nextSettings: import("../../shared/protocol").DesktopSettings): void {
    const saved = structuredClone(nextSettings);
    initialSettingsRef.current = saved;
    useDesktopStore.setState({ settings: saved });
  }

  async function importCustomCss(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const css = await file.text();
    useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, customCss: css } } });
  }

  useEffect(() => {
    const firstModel = enabledProviderModels.at(0) ?? providerModels.at(0);
    if (firstModel && !providerModels.some((model) => model.id === customModelId)) setCustomModelId(firstModel.id);
    setImageInputOverride(providerModels.find((model) => model.id === customModelId)?.imageInput);
  }, [customModelId, providerModels]);

  async function fetchModels(): Promise<void> {
    const fetchApiKey = apiKey.trim() || undefined;
    if (!customBaseUrl.trim() || (!fetchApiKey && !hasSavedCustomKey)) return;
    useDesktopStore.setState({ customModelFetchStatus: "loading", customModelFetchError: undefined });
    await window.piDesktop.send({ type: "provider.models.fetch", providerId: provider, baseUrl: customBaseUrl.trim(), apiKey: fetchApiKey });
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!provider || (!apiKey.trim() && !hasSavedCustomKey)) return;
    if (!apiKey.trim() && !hasSavedCustomKey) return;
    if (isCustomProvider && (!customName.trim() || !customBaseUrl.trim() || !customModelId.trim() || (providerModels.length > 0 && enabledProviderModels.length === 0))) return;
    setSaving(true);
    setFormError(undefined);
    try {
      if (isCustomProvider) {
        const modelsForProvider = providerModels;
        const providerConfig = { id: provider, name: customName.trim(), baseUrl: customBaseUrl.trim(), models: modelsForProvider.length ? modelsForProvider.map((model) => model.id === customModelId && imageInputOverride !== undefined ? { ...model, imageInput: imageInputOverride } : { ...model, enabled: model.enabled !== false }) : [{ id: customModelId.trim(), name: customModelId.trim(), imageInput: imageInputOverride ?? selectedCustomModel?.imageInput, enabled: true }] };
        await window.piDesktop.send({ type: "provider.save", provider: providerConfig, apiKey: apiKey.trim() || undefined });
        const nextProviders = settings.providers.some((item) => item.id === provider) ? settings.providers.map((item) => item.id === provider ? providerConfig : item) : [...settings.providers, providerConfig];
        markSettingsSaved({ ...settings, providers: nextProviders.map((item) => item.id === provider ? { ...item, keyConfigured: Boolean(apiKey.trim()) || selectedProvider?.keyConfigured } : item) });
      } else {
        await window.piDesktop.send({ type: "auth.set", provider, apiKey: apiKey.trim() });
      }
      setApiKey("");
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "应用模型服务设置失败");
    } finally {
      setSaving(false);
    }
  }

  function newProvider(): void {
    const id = `provider-${Date.now()}`;
    setProvider(id); setCustomName("新的模型服务"); setCustomBaseUrl(""); setCustomModelId(""); setApiKey("");
  }

  async function deleteProvider(): Promise<void> {
    if (!selectedProvider) return;
    await window.piDesktop.send({ type: "provider.delete", providerId: selectedProvider.id });
    const nextProviders = settings.providers.filter((item) => item.id !== selectedProvider.id);
    markSettingsSaved({
      ...settings,
      providers: nextProviders,
      model: settings.model?.provider === selectedProvider.id ? undefined : settings.model,
      agents: settings.agents.map((agent) => agent.defaultModel?.provider === selectedProvider.id ? { ...agent, defaultModel: undefined } : agent)
    });
    setProvider(nextProviders[0]?.id ?? customProviderId);
  }

  function newAgent(): void {
    const id = `agent-${Date.now()}`;
    const agent: AgentProfile = { id, name: "新 Agent", description: "", systemPrompt: "", defaultThinkingLevel: "medium", tools: Object.fromEntries(agentTools.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean> };
    setAgentList((current) => [...current, agent]);
    setSelectedAgentId(id);
  }

  function updateAgent(patch: Partial<AgentProfile>): void {
    if (!selectedAgent) return;
    setAgentList((current) => current.map((agent) => agent.id === selectedAgent.id ? { ...agent, ...patch } : agent));
  }

  async function saveAgent(): Promise<void> {
    if (!selectedAgent || !selectedAgent.name.trim()) return;
    const normalized = { ...selectedAgent, name: selectedAgent.name.trim() };
    await window.piDesktop.send({ type: "agent.save", agent: normalized });
    const nextSettings = { ...settings, agents: agentList.map((agent) => agent.id === normalized.id ? normalized : agent) };
    setAgentList(nextSettings.agents);
    markSettingsSaved(nextSettings);
  }

  function duplicateAgent(): void {
    if (!selectedAgent) return;
    const copy: AgentProfile = { ...selectedAgent, id: `agent-${Date.now()}`, name: `${selectedAgent.name} 副本`, tools: { ...selectedAgent.tools } };
    setAgentList((current) => [...current, copy]);
    setSelectedAgentId(copy.id);
  }

  async function archiveAgent(): Promise<void> {
    if (!selectedAgent || selectedAgent.id === "default") return;
    await window.piDesktop.send({ type: "agent.archive", agentId: selectedAgent.id, archived: true });
    const nextAgents = agentList.map((agent) => agent.id === selectedAgent.id ? { ...agent, archived: true } : agent);
    setAgentList(nextAgents);
    setSelectedAgentId("default");
    markSettingsSaved({ ...settings, agents: nextAgents, currentAgentId: settings.currentAgentId === selectedAgent.id ? "default" : settings.currentAgentId });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={closeSettings}>
      <section className="settings-dialog settings-center" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><Settings size={19} /><div><h2>ChatAnyTime 设置</h2><p>模型服务和 Agent 角色配置保存在本机。</p></div></div><button className="icon-button" type="button" title="关闭设置" aria-label="关闭设置" onClick={closeSettings}><X size={18} /></button></header>
        <div className="settings-body"><nav className="settings-tabs"><button type="button" className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>通用</button><button type="button" className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>模型服务</button><button type="button" className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>Agent 角色</button><button type="button" className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}>外观</button></nav><div className="settings-content">{tab === "general" ? <form onSubmit={(event) => { event.preventDefault(); const nextSettings = structuredClone(settings); void window.piDesktop.send({ type: "settings.save", settings: { model: nextSettings.model, thinkingLevel: nextSettings.thinkingLevel, appearance: nextSettings.appearance } }); markSettingsSaved(nextSettings); onClose(); }}>
          <label>全局默认模型<select value={settings.model ? `${settings.model.provider}/${settings.model.id}` : ""} onChange={(event) => { const value = event.target.value; const slash = value.indexOf("/"); useDesktopStore.setState({ settings: { ...settings, model: slash > 0 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : undefined } }); }}>{<option value="">请选择默认模型</option>}{models.filter((model) => model.configured).map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</select></label>
          <label>默认思考等级<select value={settings.thinkingLevel} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, thinkingLevel: event.target.value as ThinkingLevel } })}>{thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label>
          <label className="checkbox-setting"><input type="checkbox" checked={settings.appearance.showThinking} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, showThinking: event.target.checked } } })} />展示思考过程</label>
          <footer><button type="button" className="secondary-button" onClick={closeSettings}>取消</button><button className="primary-button" type="submit">保存通用设置</button></footer>
        </form> : tab === "models" ? <form onSubmit={save}>
        <div className="settings-provider-heading"><label>服务商<select value={provider} onChange={(event) => { const next = event.target.value; setProvider(next); const config = configuredProviders.find((item) => item.id === next); if (config) { setCustomName(config.name); setCustomBaseUrl(config.baseUrl); setCustomModelId(config.models[0]?.id ?? ""); } }}><optgroup label="内置服务">{providers.filter((item) => !item.custom && !configuredProviders.some((config) => config.id === item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}{item.configured ? " - 已配置" : ""}</option>)}</optgroup><optgroup label="OpenAI 兼容服务"><option value={customProviderId}>{customProvider?.name ?? "新的模型服务"}{customProviderKeyConfigured ? " - 已配置" : ""}</option>{configuredProviders.filter((item) => item.id !== customProviderId).map((item) => <option key={item.id} value={item.id}>{item.name}{item.keyConfigured ? " - 已配置" : ""}</option>)}</optgroup></select></label><button className="secondary-button" type="button" onClick={newProvider}>+ 新增服务</button>{selectedProvider && <button className="danger-button" type="button" onClick={() => void deleteProvider()}>删除服务</button>}</div>
        {isCustomProvider && <>
          <label>服务名称<input value={customName} placeholder="例如：公司中转站" onChange={(event) => setCustomName(event.target.value)} /></label>
          <div className="settings-action-row"><label>OpenAI 兼容接口地址<input value={customBaseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setCustomBaseUrl(event.target.value)} /></label><button className="secondary-button" type="button" disabled={customModelFetchStatus === "loading" || !customBaseUrl.trim() || (!apiKey.trim() && !customProviderKeyConfigured)} onClick={() => void fetchModels()}><RefreshCw size={14} className={customModelFetchStatus === "loading" ? "spinning" : undefined} />{customModelFetchStatus === "loading" ? "拉取中" : "拉取模型"}</button></div>
          <div className="model-selection"><div className="model-selection-heading"><span>可用模型</span><small>勾选后才会出现在输入区的模型切换列表</small></div>{providerModels.length === 0 ? <p className="panel-empty">请先拉取模型，或手动填写模型 ID</p> : providerModels.map((model) => <label className="checkbox-setting model-option" key={model.id}><input type="checkbox" checked={model.enabled !== false} onChange={(event) => { const next = event.target.checked; const updated = providerModels.map((item) => item.id === model.id ? { ...item, enabled: next } : item); useDesktopStore.setState({ customModels: provider === customProviderId ? updated : useDesktopStore.getState().customModels, settings: { ...settings, providers: settings.providers.some((item) => item.id === provider) ? settings.providers.map((item) => item.id === provider ? { ...item, models: updated } : item) : settings.providers } }); if (model.id === customModelId && !next) setCustomModelId(updated.find((item) => item.enabled !== false)?.id ?? model.id); }} /><span><strong>{model.name}</strong><small>{model.id}</small></span></label>)}</div>
          {customModelId && <label className="checkbox-setting"><input type="checkbox" checked={imageInputOverride ?? false} onChange={(event) => setImageInputOverride(event.target.checked)} />支持图片输入（手动覆盖推断）</label>}
          {providerModels.length > 0 && enabledProviderModels.length === 0 && <p className="form-error">请至少勾选一个模型</p>}
          {customModelFetchError && <p className="form-error">{customModelFetchError}</p>}
        </>}
        <label>API 密钥<input type="password" value={apiKey} autoFocus placeholder={isCustomProvider && hasSavedCustomKey ? "已保存，留空则继续使用" : "请输入 API 密钥"} onChange={(event) => setApiKey(event.target.value)} /></label>
        {formError && <p className="form-error">{formError}</p>}
        <footer><button type="button" className="secondary-button" onClick={closeSettings}>取消</button><button className="primary-button" disabled={saving || (!apiKey.trim() && !hasSavedCustomKey) || (isCustomProvider && (!customName.trim() || !customBaseUrl.trim() || !customModelId.trim() || (providerModels.length > 0 && enabledProviderModels.length === 0)))} type="submit">{saving ? "正在应用" : "保存设置"}</button></footer>
        </form> : tab === "agents" ? <div className="agent-settings">
          <div className="agent-list">{agentList.filter((agent) => !agent.archived).map((agent) => <button type="button" key={agent.id} className={agent.id === selectedAgent?.id ? "active" : ""} onClick={() => setSelectedAgentId(agent.id)}><strong>{agent.name}</strong><small>{agent.description || "未填写说明"}</small></button>)}<button type="button" className="secondary-button" onClick={newAgent}>+ 新建 Agent</button></div>
          {selectedAgent && <div className="agent-editor"><label>名称<input value={selectedAgent.name} onChange={(event) => updateAgent({ name: event.target.value })} /></label><label>说明<input value={selectedAgent.description} onChange={(event) => updateAgent({ description: event.target.value })} /></label><label>系统提示词<textarea value={selectedAgent.systemPrompt} rows={6} onChange={(event) => updateAgent({ systemPrompt: event.target.value })} /></label><label>默认模型<select value={selectedAgent.defaultModel ? `${selectedAgent.defaultModel.provider}/${selectedAgent.defaultModel.id}` : ""} onChange={(event) => { const value = event.target.value; updateAgent({ defaultModel: value ? { provider: value.slice(0, value.indexOf("/")), id: value.slice(value.indexOf("/") + 1) } : undefined }); }}><option value="">跟随全局默认模型</option>{configuredModels.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</select></label><label>默认思考等级<select value={selectedAgent.defaultThinkingLevel} onChange={(event) => updateAgent({ defaultThinkingLevel: event.target.value as ThinkingLevel })}>{thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label><fieldset><legend>工具权限</legend>{agentTools.map((tool) => <label className="tool-toggle" key={tool}><input type="checkbox" checked={selectedAgent.tools[tool]} onChange={(event) => updateAgent({ tools: { ...selectedAgent.tools, [tool]: event.target.checked } })} />{tool}</label>)}</fieldset><footer><button type="button" className="danger-button" disabled={selectedAgent.id === "default"} onClick={() => void archiveAgent()}>归档</button><button type="button" className="secondary-button" onClick={duplicateAgent}>复制</button><button type="button" className="primary-button" onClick={() => void saveAgent()}>保存 Agent</button></footer></div>}
        </div> : <form className="appearance-settings" onSubmit={(event) => { event.preventDefault(); const nextSettings = structuredClone(settings); void window.piDesktop.send({ type: "appearance.save", appearance: nextSettings.appearance }); markSettingsSaved(nextSettings); onClose(); }}>
          <div className="appearance-grid">
            <div>
              <label>主题模式<select value={settings.appearance.theme} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, theme: event.target.value as "system" | "light" | "dark" } } })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
              <label className="checkbox-setting"><input type="checkbox" checked={settings.appearance.showThinking} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, showThinking: event.target.checked } } })} />展示思考过程</label>
              <div className="theme-preset-field"><span className="settings-field-label">主题预设</span><div className="theme-preset-grid">{THEME_PRESETS.map((preset) => <button type="button" key={preset.id} className={`theme-preset-card${settings.appearance.themePreset === preset.id ? " active" : ""}`} onClick={() => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, themePreset: preset.id as ThemePresetId } } })}><span className="theme-swatches">{preset.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span><strong>{preset.name}</strong><small>{preset.description}</small></button>)}</div></div>
            </div>
            <ThemePreview />
          </div>
              <div className="custom-css-heading"><span>自定义 CSS</span><div><input ref={cssFileInputRef} hidden type="file" accept=".css,text/css" onChange={(event) => void importCustomCss(event)} /><button className="secondary-button" type="button" onClick={() => cssFileInputRef.current?.click()}>导入 CSS</button><button className="secondary-button" type="button" onClick={() => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, customCss: "" } } })}>清空</button></div></div>
              <label className="custom-css-field"><textarea value={settings.appearance.customCss} spellCheck={false} rows={11} placeholder={":root[data-theme-effective=\"dark\"] {\n  --accent: #8b5cf6;\n}"} aria-label="自定义 CSS" onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, customCss: event.target.value } } })} /></label>
          <footer><button type="button" className="secondary-button" onClick={closeSettings}>取消</button><button className="primary-button" type="submit">保存外观设置</button></footer>
        </form>}</div></div>
      </section>
    </div>
  );
}

function PermissionDialog({ request }: { request: NonNullable<ReturnType<typeof useDesktopStore.getState>["permission"]> }): ReactNode {
  async function resolve(decision: PermissionDecision): Promise<void> {
    await window.piDesktop.send({ type: "permission.resolve", id: request.id, decision });
    useDesktopStore.setState({ permission: undefined });
  }
  return (
    <div className="modal-backdrop permission-backdrop">
      <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label="工具权限确认">
        <header><div className={`risk-icon ${request.risk}`}><TerminalSquare size={20} /></div><div><h2>允许{toolLabel(request.toolName)}？</h2><p>{request.summary}</p></div></header>
        <pre>{JSON.stringify(request.args, null, 2)}</pre>
        <footer>
          <button className="danger-button" type="button" onClick={() => void resolve("deny")}>拒绝</button>
          <button className="secondary-button" type="button" onClick={() => void resolve("allow-once")}>仅允许一次</button>
          <button className="primary-button" type="button" onClick={() => void resolve("allow-session")}>本次会话允许</button>
        </footer>
      </div>
    </div>
  );
}

export function App(): ReactNode {
  const { ready, snapshot, models, providers, customProvider, customProviderKeyConfigured, customModels, customModelFetchStatus, customModelFetchError, permission, error, initialize, clearError } = useDesktopStore();
  const settings = useDesktopStore((state) => state.settings);
  const [input, setInput] = useState("");
  const [messageActionError, setMessageActionError] = useState<string>();
  // Tool details are already available inline in the conversation. Keep the
  // live activity panel opt-in so the first screen stays focused on the chat.
  const [rightPanel, setRightPanel] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"agents" | "topics">("topics");
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [panelTab, setPanelTab] = useState<"activity" | "changes">("activity");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [artifact, setArtifact] = useState<Artifact>();
  const [attachments, setAttachments] = useState<import("../../shared/protocol").PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const selectedModel = snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "";
  const availableModels = useMemo(() => models.filter((model) => model.configured), [models]);
  const visibleAgents = useMemo(() => settings.agents.filter((agent) => !agent.archived && `${agent.name} ${agent.description}`.toLowerCase().includes(sidebarQuery.trim().toLowerCase())), [settings.agents, sidebarQuery]);
  const visibleSessions = useMemo(() => snapshot.sessions.filter((item) => item.title.toLowerCase().includes(sidebarQuery.trim().toLowerCase())), [snapshot.sessions, sidebarQuery]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void initialize().then((unsubscribe) => {
      dispose = unsubscribe;
    });
    return () => dispose?.();
  }, [initialize]);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: snapshot.busy ? "smooth" : "auto" });
  }, [snapshot.messages, snapshot.busy]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => {
      root.dataset.theme = settings.appearance.theme;
      root.dataset.themeEffective = settings.appearance.theme === "dark" || (settings.appearance.theme === "system" && media.matches) ? "dark" : "light";
    };
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
      delete root.dataset.themeEffective;
    };
  }, [settings.appearance.theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.themePreset = settings.appearance.themePreset;
    const styleId = "pi-desktop-custom-theme";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = `${themePresetCss(settings.appearance.themePreset)}\n${settings.appearance.customCss}`;
    return () => {
      style?.remove();
      delete root.dataset.themePreset;
    };
  }, [settings.appearance.themePreset, settings.appearance.customCss]);

  async function openWorkspace(): Promise<void> {
    const path = await window.piDesktop.chooseWorkspace();
    if (path) await window.piDesktop.send({ type: "workspace.open", path });
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = input.trim();
    if ((!text && attachments.length === 0) || snapshot.busy) return;
    if (attachments.some((item) => item.kind === "image") && !models.find((item) => `${item.provider}/${item.id}` === selectedModel)?.imageInput) { setAttachmentError("当前模型不支持图片输入，请先切换多模态模型"); return; }
    try {
      await window.piDesktop.send({ type: "session.prompt", text, attachments });
      setInput("");
      setAttachments([]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "附件发送失败");
    }
  }

  async function copyMessage(message: ChatMessage): Promise<void> {
    const text = messageText(message);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setMessageActionError("复制失败，请检查剪贴板权限");
    }
  }

  function editMessage(message: ChatMessage): void {
    setInput(messageText(message));
    setMessageActionError(undefined);
  }

  function handleHtmlAction(text: string): void {
    setInput((current) => current.trim() ? `${current.trim()}\n${text}` : text);
    setMessageActionError(undefined);
  }

  async function regenerateMessage(message: ChatMessage): Promise<void> {
    if (snapshot.busy) return;
    const index = snapshot.messages.findIndex((item) => item.id === message.id);
    const previousUser = index > 0 ? [...snapshot.messages.slice(0, index)].reverse().find((item) => item.role === "user") : undefined;
    const text = previousUser ? messageText(previousUser) : "";
    if (!text) return;
    try {
      await window.piDesktop.send({ type: "session.regenerate", text, timestamp: previousUser?.timestamp });
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "重新生成失败");
    }
  }

  async function addAttachments(): Promise<void> {
    let selected: import("../../shared/protocol").PromptAttachment[];
    try {
      selected = await window.piDesktop.chooseAttachments(snapshot.workspace);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "读取附件失败");
      return;
    }
    const remaining = Math.max(0, 5 - attachments.length);
    const seen = new Set(attachments.map((item) => item.kind === "file" ? item.relativePath : `${item.name}:${item.size}`));
    const next = selected.filter((item) => {
      const key = item.kind === "file" ? item.relativePath : `${item.name}:${item.size}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, remaining);
    if (next.length < selected.length) setAttachmentError("已跳过重复附件或超出 5 个附件上限");
    setAttachments((current) => [...current, ...next]);
  }

  async function addLocalFiles(files: FileList | File[]): Promise<void> {
    const remaining = Math.max(0, 5 - attachments.length);
    const accepted: import("../../shared/protocol").PromptAttachment[] = [];
    for (const file of Array.from(files).slice(0, remaining)) {
      if (file.size > 20 * 1024 * 1024) { setAttachmentError(`${file.name} 超过 20 MB 限制`); continue; }
      const isImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type);
      if (isImage) {
        const data = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? ""); reader.readAsDataURL(file); });
        accepted.push({ kind: "image", name: file.name, mimeType: file.type, size: file.size, data });
      } else if ((file as File & { path?: string }).path) {
        const path = (file as File & { path: string }).path;
        if (snapshot.workspace) {
          const root = snapshot.workspace.replace(/[\\/]+$/u, "").replaceAll("\\", "/");
          const candidate = path.replaceAll("\\", "/");
          if (!(candidate.toLowerCase().startsWith(`${root.toLowerCase()}/`) && candidate !== root)) { setAttachmentError(`${file.name} 不在当前工作区内`); continue; }
          const relativePath = candidate.slice(root.length + 1);
          if (!relativePath) { setAttachmentError(`${file.name} 不在当前工作区内`); continue; }
          accepted.push({ kind: "file", name: file.name, path: relativePath, relativePath, size: file.size });
          continue;
        }
        setAttachmentError(`${file.name} 不是可读取的工作区文件`);
      } else setAttachmentError(`${file.name} 不是可读取的工作区文件`);
    }
    const keys = new Set(attachments.map((item) => item.kind === "file" ? item.relativePath : `${item.name}:${item.size}`));
    const unique = accepted.filter((item) => { const key = item.kind === "file" ? item.relativePath : `${item.name}:${item.size}`; if (keys.has(key)) return false; keys.add(key); return true; });
    if (unique.length < accepted.length) setAttachmentError("已跳过重复附件");
    setAttachments((current) => [...current, ...unique]);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length) { event.preventDefault(); void addLocalFiles(files); }
  }

  function handleDrop(event: React.DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    void addLocalFiles(event.dataTransfer.files);
  }

  function handleComposerKey(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function selectModel(value: string): Promise<void> {
    const slash = value.indexOf("/");
    if (slash < 1) return;
    await window.piDesktop.send({ type: "model.select", provider: value.slice(0, slash), id: value.slice(slash + 1) });
  }

  if (!ready) return <div className="app-loading"><div className="brand-mark">CA</div><LoaderCircle className="spinning" size={22} /></div>;

  return (
    <div className="desktop-shell">
      <aside className="sidebar">
        <div className="brand-row"><div className="brand-mark">CA</div><div><strong>ChatAnyTime</strong><span>桌面端</span></div></div>
        <div className="sidebar-tabs" role="tablist" aria-label="侧栏视图">
          <button type="button" role="tab" aria-selected={sidebarTab === "agents"} className={sidebarTab === "agents" ? "active" : ""} onClick={() => { setSidebarTab("agents"); setSidebarQuery(""); }}><Users size={14} />助手<span>{settings.agents.filter((agent) => !agent.archived).length}</span></button>
          <button type="button" role="tab" aria-selected={sidebarTab === "topics"} className={sidebarTab === "topics" ? "active" : ""} onClick={() => { setSidebarTab("topics"); setSidebarQuery(""); }}><MessageCircle size={14} />话题<span>{snapshot.sessions.length}</span></button>
        </div>
        <label className="sidebar-search"><Search size={14} /><input value={sidebarQuery} placeholder={sidebarTab === "agents" ? "搜索助手" : "搜索话题"} aria-label={sidebarTab === "agents" ? "搜索助手" : "搜索话题"} onChange={(event) => setSidebarQuery(event.target.value)} /></label>
        <div className="sidebar-section-label">{sidebarTab === "agents" ? "角色" : "最近话题"}</div>
        {sidebarTab === "agents" ? <nav className="agent-list" aria-label="助手列表">
          {visibleAgents.map((agent) => <button className={agent.id === snapshot.agentId ? "active" : ""} type="button" key={agent.id} disabled={snapshot.busy} onClick={() => { useDesktopStore.setState({ settings: { ...settings, currentAgentId: agent.id } }); void window.piDesktop.send({ type: "agent.select", agentId: agent.id }); }}><span className="agent-list-icon"><Bot size={15} /></span><span><strong>{agent.name}</strong><small>{agent.description || "未填写说明"}</small></span></button>)}
        </nav> : <nav className="session-list" aria-label="话题列表">
          {visibleSessions.map((item) => <button className={item.id === snapshot.sessionId ? "active" : ""} type="button" key={item.id} onClick={() => void window.piDesktop.send({ type: "session.open", path: item.path })}><MessageCircle size={14} /><span><strong>{item.title}</strong><small>{new Date(item.modifiedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</small></span></button>)}
        </nav>}
        <button className="new-session-button" type="button" disabled={!snapshot.workspace || snapshot.busy} onClick={() => void window.piDesktop.send({ type: "session.new" })}><MessageSquarePlus size={16} />新建话题</button>
        <div className="sidebar-footer">
          <button type="button" onClick={() => setSettingsOpen(true)}><Settings size={16} />设置</button>
          <span className={`runtime-indicator${snapshot.busy ? " busy" : ""}`}><i />{snapshot.status}</span>
        </div>
      </aside>

      <main className="workspace-main">
        <header className="topbar">
          <div className="project-title"><Folder size={17} /><span><strong>{snapshot.workspace?.split(/[\\/]/u).at(-1) ?? "ChatAnyTime"}</strong><small>{snapshot.agentName} · {snapshot.sessionId ? "当前话题" : "未开始话题"}</small></span></div>
          <div className="runtime-controls">
            <button className="workspace-top-button" type="button" onClick={() => void openWorkspace()}><FolderOpen size={15} /><span>工作区</span><strong>{compactPath(snapshot.workspace)}</strong><ChevronDown size={13} /></button>
            <button className="icon-button panel-toggle" type="button" aria-label={rightPanel ? "关闭活动面板" : "打开活动面板"} title={rightPanel ? "关闭活动面板" : "打开活动面板"} onClick={() => setRightPanel((open) => !open)}>{rightPanel ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
          </div>
        </header>

        <div className={`work-area${rightPanel ? " with-panel" : ""}`}>
          <section className="conversation-pane">
            <div className="timeline" ref={timelineRef}>
              {!snapshot.workspace ? (
                <div className="empty-workspace"><div className="empty-icon"><FolderOpen size={27} /></div><h1>打开一个项目</h1><button className="primary-button" type="button" onClick={() => void openWorkspace()}><FolderOpen size={16} />选择文件夹</button></div>
              ) : snapshot.messages.length === 0 ? (
                <div className="empty-conversation"><div className="empty-icon"><CodeXml size={27} /></div><h1>今天想开发什么？</h1></div>
              ) : groupAssistantMessages(snapshot.messages).map((message) => <MessageView key={message.id} message={message} executions={snapshot.executions} onOpenArtifact={setArtifact} onHtmlAction={handleHtmlAction} onCopy={(item) => void copyMessage(item)} onEdit={editMessage} onRegenerate={(item) => void regenerateMessage(item)} showThinking={settings.appearance.showThinking} busy={snapshot.busy} />)}
            </div>
            <div className="composer-tools"><label title="模型快捷切换"><Bot size={14} /><select value={selectedModel} disabled={snapshot.busy} onChange={(event) => void selectModel(event.target.value)}><option value="">选择模型</option>{Array.from(new Set(availableModels.map((model) => model.provider))).map((providerId) => <optgroup key={providerId} label={providers.find((provider) => provider.id === providerId)?.name ?? providerId}>{availableModels.filter((model) => model.provider === providerId).map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</optgroup>)}</select></label><label title="思考级别"><span>思考</span><select value={snapshot.thinkingLevel} disabled={snapshot.busy} onChange={(event) => void window.piDesktop.send({ type: "thinking.select", level: event.target.value as ThinkingLevel })}>{thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label></div>
            <form className="composer" onSubmit={submit} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              {attachments.length > 0 && <div className="attachment-list">{attachments.map((attachment, index) => <span className="attachment-chip" key={`${attachment.name}-${index}`}>{attachment.kind === "image" ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <FileDiff size={12} />}<span>{attachment.name}</span><button type="button" title="移除附件" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={12} /></button></span>)}</div>}
              {attachmentError && <div className="attachment-error" role="alert">{attachmentError}<button type="button" title="关闭提示" aria-label="关闭附件提示" onClick={() => setAttachmentError(undefined)}><X size={12} /></button></div>}
              <input ref={fileInputRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.css,.html" onChange={(event) => { void addLocalFiles(event.target.files ?? []); event.currentTarget.value = ""; }} />
              <button className="icon-button attach-button" type="button" title="添加附件" aria-label="添加附件" disabled={snapshot.busy || attachments.length >= 5} onClick={() => void addAttachments()}><Paperclip size={17} /></button>
              <textarea
                value={input}
                rows={1}
                disabled={!snapshot.workspace}
                placeholder={snapshot.workspace ? "让 Pi 检查、修改或运行这个项目" : "请先打开一个项目"}
                onKeyDown={handleComposerKey}
                onPaste={handlePaste}
                onChange={(event) => setInput(event.target.value)}
              />
              {snapshot.busy ? (
                <button className="stop-button" type="button" title="停止" aria-label="停止" onClick={() => void window.piDesktop.send({ type: "session.abort" })}><CircleStop size={18} /></button>
              ) : (
                <button className="send-button" type="submit" title="发送" aria-label="发送" disabled={!input.trim() || !snapshot.workspace || !snapshot.model}><Play size={17} fill="currentColor" /></button>
              )}
            </form>
          </section>

          {rightPanel && (
            <aside className="right-panel">
              <div className="panel-tabs">
                <button className={panelTab === "activity" ? "active" : ""} type="button" onClick={() => setPanelTab("activity")}><Wrench size={15} />活动</button>
                <button className={panelTab === "changes" ? "active" : ""} type="button" onClick={() => setPanelTab("changes")}><FileDiff size={15} />变更<span>{snapshot.executions.filter((item) => item.patch).length}</span></button>
              </div>
              {panelTab === "activity" ? <ActivityPanel executions={snapshot.executions} /> : <ChangesPanel executions={snapshot.executions} />}
            </aside>
          )}
        </div>
      </main>

      {settingsOpen && <SettingsDialog settings={settings} models={models} providers={providers} customProvider={customProvider} customProviderKeyConfigured={customProviderKeyConfigured} customModels={customModels} customModelFetchStatus={customModelFetchStatus} customModelFetchError={customModelFetchError} onClose={() => setSettingsOpen(false)} />}
      {permission && <PermissionDialog request={permission} />}
      {artifact && <ArtifactPreview artifact={artifact} onClose={() => setArtifact(undefined)} />}
      {error && <div className="error-toast"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={clearError}><X size={16} /></button></div>}
      {messageActionError && <div className="error-toast"><AlertCircle size={18} /><span>{messageActionError}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setMessageActionError(undefined)}><X size={16} /></button></div>}
    </div>
  );
}
