import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  Computer,
  Eye,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  MessageCircle,
  Palette,
  LayoutGrid,
  Search,
  Server,
  SquarePen,
  Zap,
  Users,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Plus,
  RefreshCw,
  Pencil,
  Settings,
  Trash2,
  FolderTree,
  GitBranch,
  ChevronLeft,
  Pin,
  History,
  Brain,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type {
  AccessMode,
  BrowserElementPick,
  AgentProfile,
  BuiltinToolName,
  ModelOption,
  MemoryTopic,
  ProviderOption,
  DivBubbleMode,
  ThinkingLevel,
  DelegationProgress,
  ThemeAssetMap,
  ToolExecution,
  ResourceCatalog,
  RuntimeCommand,
  SessionSummary,
  SshHostSummary
} from "../../shared/protocol";
import type { ReplyChangedFile } from "./lib/changed-files";
import { ArtifactPreview, type PreviewEditorState, type PreviewTab, type PreviewTarget } from "./components/ArtifactPreview";
import { ModelSelect } from "./components/ModelSelect";
import { AgentSettings } from "./AgentSettings";
import type { EditorSaveStatus } from "./components/MarkdownEditor";
import { WorkspaceTree } from "./components/WorkspaceTree";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { ExitWrap, useExitPresence, useExitPresenceValue } from "./components/Presence";
import { PermissionDialog } from "./components/RuntimeDialogs";
import { DelegationTranscript } from "./components/DelegationTranscript";
import { detailTitle } from "./components/QuestionPanel";
import { compactPath, type Artifact } from "./lib/content";
import { composePickMessage } from "./lib/browser-pick";
import { composeGalleryDevMessage, galleryRunTarget, type GalleryApp, type GalleryDraft, type GalleryKind } from "../../shared/gallery";
import { GalleryMenu } from "./components/GalleryMenu";
import { GalleryWall } from "./components/GalleryWall";
import { GalleryPublishDialog, GalleryWallDialog } from "./components/GalleryDialogs";
import { DiffView } from "./components/DiffView";
import { BrandMark } from "./components/BrandMark";
import { clampPreviewSplit, PREVIEW_SPLIT_MAX, PREVIEW_SPLIT_MIN, previewSplitFromKey } from "./lib/preview-split";
import { groupSessionsByWorkspace, workspaceKey } from "./lib/session-groups";
import { resolveThemeAssets } from "./lib/theme-assets";
import { bubbleOpacityCss, collectThemeLayers, panelOpacityCss, scopeCustomThemeCss, themePresetCss, wallpaperOpacityCss } from "./lib/theme-presets";
import { panePermissionRequest, paneQuestionRequest, dropPaneStates, pruneParkedPanels, useDesktopStore } from "./store";
import { DesignStudio } from "./design/DesignStudio";
import { ConversationPane, type PaneComposerApi, type PaneDraftStore } from "./ConversationPane";
import { SplitLayout } from "./SplitLayout";
import {
  MAX_SPLIT_PANES,
  balancedAddPane,
  countLeaves,
  firstLeafId,
  leafIds,
  parseStoredSplitLayout,
  pruneToIds,
  removePane,
  replaceLeaf,
  updateRatio,
  type SplitNode
} from "./lib/split-layout";
import { customCssHasWallpaper, themeAssetsForAppearance, useThemeAssetUrls } from "./lib/theme-runtime";
import { AppearanceSettings } from "./AppearanceSettings";
import { HooksSettings } from "./HooksSettings";
import { selectableCatalogModels } from "./lib/model-list";
import { resourceScopeLabels, sessionRunStatusLabels, toolLabel } from "../../shared/locale";
import { SubagentSettings } from "./SubagentSettings";
import { UsageSettings } from "./UsageSettings";
import { AutomationSettings } from "./AutomationSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ResourceSettings } from "./ResourceSettings";
import { ModelSettings } from "./ModelSettings";

function previewTargetKey(target: PreviewTarget): string {
  switch (target.type) {
    case "artifact": return target.artifact.id;
    case "browser": return target.id ?? "browser";
    case "terminal": return "terminal";
    case "ssh": return "ssh";
    case "ssh-terminal": return target.terminalId;
    case "file": return target.file.relativePath;
    case "plan": return "plan";
    case "memory": return `memory-${target.topicId}`;
    default: return `${target.type}-${target.path ?? target.title}`;
  }
}

interface PreviewState {
  tabs: PreviewTab[];
  activeTabId: string;
}
// powershell 为 opt-in：新建 Agent 默认关闭（与 settings.defaultToolEnabled 对齐）。
const agentTools: BuiltinToolName[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

type SlashCommandBase = {
  trigger: string;
  label: string;
  description: string;
};

type SlashCommand = SlashCommandBase & (
  | { kind: "skill"; skillName: string }
  | { kind: "command"; command: RuntimeCommand }
);

function readStoredPreviewSplit(): number {
  try {
    const value = window.localStorage.getItem("pidesktop.preview-split");
    return value === null ? 50 : clampPreviewSplit(Number(value));
  } catch {
    return 50;
  }
}

/** 设计模式下画布区占比（%），可拖分隔条调整；窄窗断点 900px 由 CSS 断行。 */
function readStoredDesignSplit(): number {
  try {
    const value = Number(window.localStorage.getItem("pidesktop.design-split"));
    return Number.isFinite(value) && value > 0 ? clampDesignSplit(value) : 62;
  } catch {
    return 62;
  }
}

const DESIGN_SPLIT_MIN = 25;
const DESIGN_SPLIT_MAX = 75;

function clampDesignSplit(value: number): number {
  return Math.min(DESIGN_SPLIT_MAX, Math.max(DESIGN_SPLIT_MIN, Math.round(value * 10) / 10));
}

/** 启动时恢复上次的分屏布局（会话列表就绪后逐格激活；失效格子被修剪）。
 *  单叶布局归一化为 null（单格不该走分屏渲染分支）。 */
function readStoredSplitState(): { tree: SplitNode | null; focusedPane?: string } {
  try {
    const parsed = parseStoredSplitLayout(window.localStorage.getItem("pidesktop.split-layout"));
    if (!parsed || parsed.tree.kind === "leaf") return { tree: null };
    return parsed;
  } catch {
    return { tree: null };
  }
}

function PreviewDivider({ split, dragging, onStart, onMove, onEnd, onCancel, onKeyDown, onReset }: {
  split: number;
  dragging: boolean;
  onStart(event: ReactPointerEvent<HTMLDivElement>): void;
  onMove(event: ReactPointerEvent<HTMLDivElement>): void;
  onEnd(event: ReactPointerEvent<HTMLDivElement>): void;
  onCancel(event: ReactPointerEvent<HTMLDivElement>): void;
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
  onReset(): void;
}): ReactNode {
  const [stacked, setStacked] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = (): void => setStacked(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <div
      className={`preview-divider${dragging ? " dragging" : ""}`}
      role="separator"
      aria-label="调整聊天和预览宽度"
      aria-orientation={stacked ? "horizontal" : "vertical"}
      aria-valuemin={PREVIEW_SPLIT_MIN}
      aria-valuemax={PREVIEW_SPLIT_MAX}
      aria-valuenow={Math.round(split)}
      aria-valuetext={`${Math.round(split)}% 聊天区域`}
      title="拖动调整分屏，双击恢复均分"
      tabIndex={0}
      onPointerDown={onStart}
      onPointerMove={onMove}
      onPointerUp={onEnd}
      onPointerCancel={onCancel}
      onLostPointerCapture={onCancel}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
function SettingsDialog({ settings, models, providers, resources, workspaceOpen, initialTab, jevKeyConfigured, onClose, onCreateInSession }: { settings: import("../../shared/protocol").DesktopSettings; jevKeyConfigured: boolean; models: ModelOption[]; providers: ProviderOption[]; resources: ResourceCatalog; workspaceOpen: boolean; initialTab?: string; onClose(): void; onCreateInSession(): void }): ReactNode {
  const [tab, setTab] = useState<"general" | "models" | "agents" | "subagents" | "appearance" | "resources" | "hooks" | "usage" | "automation">(initialTab === "automation" ? "automation" : "general");
  // toast 直达/侧栏入口：设置页已打开（初始 tab 已固定）时也能切到「自动化」tab。
  useEffect(() => {
    if (initialTab === "automation") setTab("automation");
  }, [initialTab]);
  const initialSettingsRef = useRef<import("../../shared/protocol").DesktopSettings>(structuredClone(settings));
  const [agentList, setAgentList] = useState<AgentProfile[]>(settings.agents);
  const [selectedAgentId, setSelectedAgentId] = useState(settings.currentAgentId);
  // 列表「使用中」徽标读快照的 agentId（运行时真值），而不是 settings.currentAgentId
  // ——后者只在 agent.select/save 时同步，切角色后可能落后一拍。
  const activeAgentId = useDesktopStore((state) => state.snapshot.agentId);
  const selectedAgent = agentList.find((agent) => agent.id === selectedAgentId) ?? agentList[0];
  const configuredModels = selectableCatalogModels(models).filter((model) => model.configured);
  function closeSettings(): void { useDesktopStore.setState({ settings: structuredClone(initialSettingsRef.current) }); onClose(); }
  function markSettingsSaved(nextSettings: import("../../shared/protocol").DesktopSettings): void {
    const saved = structuredClone(nextSettings);
    initialSettingsRef.current = saved;
    useDesktopStore.setState({ settings: saved });
  }


  function newAgent(): void {
    const id = `agent-${Date.now()}`;
    const agent: AgentProfile = { id, name: "新 Agent", description: "", systemPrompt: "", divMode: "auto", defaultThinkingLevel: "medium", tools: Object.fromEntries(agentTools.map((tool) => [tool, tool !== "powershell"])) as Record<BuiltinToolName, boolean> };
    setAgentList((current) => [...current, agent]);
    setSelectedAgentId(id);
  }

  function updateAgent(patch: Partial<AgentProfile>): void {
    if (!selectedAgent) return;
    setAgentList((current) => current.map((agent) => agent.id === selectedAgent.id ? { ...agent, ...patch } : agent));
  }

  /**
   * 单键 Skill overlay 写回：必须用函数式 setState 从 current 里取最新
   * skillOverrides 再合并——从闭包里的 selectedAgent 取会拿到本次渲染的
   * 旧值，同一事件里连续多次调用（批量场景）会互相覆盖只剩最后一次。
   */
  function updateAgentSkillOverride(skillId: string, enabled: boolean): void {
    if (!selectedAgent) return;
    setAgentList((current) => current.map((agent) => agent.id === selectedAgent.id
      ? { ...agent, skillOverrides: { ...agent.skillOverrides, [skillId]: enabled } }
      : agent));
  }

  /** 能力工具 overlay 写回：启用即删键（配置只存显式禁用，与迁移层 normalizeToolOverrides 对齐）。 */
  function updateAgentToolOverride(key: string, enabled: boolean): void {
    if (!selectedAgent) return;
    const overrides = { ...selectedAgent.toolOverrides };
    if (enabled) delete overrides[key];
    else overrides[key] = false;
    updateAgent({ toolOverrides: Object.keys(overrides).length > 0 ? overrides : undefined });
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
    const copy: AgentProfile = { ...selectedAgent, id: `agent-${Date.now()}`, name: `${selectedAgent.name} 副本`, tools: { ...selectedAgent.tools }, ...(selectedAgent.skillOverrides ? { skillOverrides: { ...selectedAgent.skillOverrides } } : {}), ...(selectedAgent.toolOverrides ? { toolOverrides: { ...selectedAgent.toolOverrides } } : {}) };
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
      <section className={tab === "agents" || tab === "general" || tab === "models" || tab === "appearance" ? "settings-dialog settings-center settings-wide" : "settings-dialog settings-center"} data-pane="settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><Settings size={19} /><div><h2>ChatAnyTime 设置</h2><p>模型服务和 Agent 角色配置保存在本机。</p></div></div><button className="icon-button" type="button" title="关闭设置" aria-label="关闭设置" onClick={closeSettings}><X size={18} /></button></header>
        <div className="settings-body"><nav className="settings-tabs"><button type="button" className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>通用</button><button type="button" className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>模型服务</button><button type="button" className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>Agent 角色</button><button type="button" className={tab === "subagents" ? "active" : ""} onClick={() => setTab("subagents")}>子智能体</button><button type="button" className={tab === "resources" ? "active" : ""} onClick={() => setTab("resources")}>技能与工具</button><button type="button" className={tab === "hooks" ? "active" : ""} onClick={() => setTab("hooks")}>钩子</button><button type="button" className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}>外观</button><button type="button" className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>用量统计</button><button type="button" className={tab === "automation" ? "active" : ""} onClick={() => setTab("automation")}>自动化任务</button></nav><div className="settings-content">{tab === "general" ? <GeneralSettings settings={settings} models={models} providers={providers} jevKeyConfigured={jevKeyConfigured} onSaved={(nextSettings) => { markSettingsSaved(nextSettings); onClose(); }} onDraftCommitted={markSettingsSaved} onCancel={closeSettings} /> : tab === "models" ? <ModelSettings settings={settings} models={models} providers={providers} onSaved={(nextSettings) => { markSettingsSaved(nextSettings); onClose(); }} onDraftCommitted={markSettingsSaved} onCancel={closeSettings} /> : tab === "agents" ? <AgentSettings agents={agentList} activeAgentId={activeAgentId} selectedAgentId={selectedAgent?.id ?? ""} models={configuredModels} providers={providers} resources={resources} onSelect={setSelectedAgentId} onCreate={newAgent} onUpdate={updateAgent} onUpdateSkillOverride={updateAgentSkillOverride} onUpdateToolOverride={updateAgentToolOverride} onSave={() => void saveAgent()} onDuplicate={duplicateAgent} onArchive={() => void archiveAgent()} /> : tab === "subagents" ? <SubagentSettings resources={resources} workspaceOpen={workspaceOpen} models={models} providers={providers} /> : tab === "resources" ? <ResourceSettings resources={resources} /> : tab === "hooks" ? <HooksSettings resources={resources} workspaceOpen={workspaceOpen} /> : tab === "usage" ? <UsageSettings /> : tab === "automation" ? <AutomationSettings models={models} providers={providers} settings={settings} workspaceConfigured={workspaceOpen} workspaceName={settings.workspace ? settings.workspace.split(/[\\/]/u).at(-1) : undefined} onCreateInSession={() => { closeSettings(); onCreateInSession(); }} onOpenRunSession={closeSettings} /> : <AppearanceSettings settings={settings} onSaved={(nextSettings) => { markSettingsSaved(nextSettings); onClose(); }} onCancel={closeSettings} />}</div></div>
      </section>
    </div>
  );
}

export function App(): ReactNode {
  // 细粒度订阅：流式期间 store 每 50ms 收到一帧新 snapshot，全量解构会让 App
  // 整棵子树（侧栏、标题栏、预览面板）每帧重渲染。这里只订阅真正被消费的
  // 字段；messages/executions 整体不进入 App（消息流由 ConversationPane 自行
  // 订阅），App 仅取派生原始值（布尔/数字）或引用稳定的数组。
  const ready = useDesktopStore((state) => state.ready);
  const models = useDesktopStore((state) => state.models);
  const providers = useDesktopStore((state) => state.providers);
  const resources = useDesktopStore((state) => state.resources);
  const jevKeyConfigured = useDesktopStore((state) => state.jevKeyConfigured);
  const permissions = useDesktopStore((state) => state.permissions);
  const questions = useDesktopStore((state) => state.questions);
  const error = useDesktopStore((state) => state.error);
  const checkpointResult = useDesktopStore((state) => state.checkpointResult);
  const automationRun = useDesktopStore((state) => state.automationRun);
  const initialize = useDesktopStore((state) => state.initialize);
  const clearError = useDesktopStore((state) => state.clearError);
  // snapshot 字段级订阅。sessions/recentWorkspaces/executions 在 store 合并层
  // 做了身份保留（内容不变则复用旧引用），流式帧不会触发这些选择器。
  const activeSessionId = useDesktopStore((state) => state.snapshot.sessionId);
  const activeWorkspace = useDesktopStore((state) => state.snapshot.workspace);
  const sessionSummaries = useDesktopStore((state) => state.snapshot.sessions);
  const recentWorkspaces = useDesktopStore((state) => state.snapshot.recentWorkspaces);
  const activeAgentId = useDesktopStore((state) => state.snapshot.agentId);
  const activeAgentName = useDesktopStore((state) => state.snapshot.agentName);
  const gitBranch = useDesktopStore((state) => state.snapshot.gitBranch);
  const runtimeBusy = useDesktopStore((state) => state.snapshot.busy);
  const runtimeStatus = useDesktopStore((state) => state.snapshot.status);
  const executions = useDesktopStore((state) => state.snapshot.executions);
  // 派生布尔选择器：返回原始值，Object.is 比较，仅状态真正翻转时重渲染。
  // 主题根属性（data-ui-*）反映焦点格（分屏下即激活会话）的状态。
  const isGenerating = useDesktopStore((state) => Boolean(state.snapshot.busy && state.snapshot.turnTiming && state.snapshot.turnTiming.completedAt === undefined));
  const isChatEmpty = useDesktopStore((state) => !state.snapshot.workspace || (state.snapshot.messages.length === 0 && !(state.snapshot.busy && state.snapshot.turnTiming && state.snapshot.turnTiming.completedAt === undefined)));
  // 分屏布局：tree 为递归二叉分割树，focusedPane 是焦点格（= 激活会话）。
  // 权限/提问按格子集合过滤（焦点格优先），store 的数组跨会话累积，直接取
  // [0] 会把后台会话待决的弹窗冒到别的格子视图里；单窗口退化为 [激活会话]，
  // 与旧的“按当前激活会话过滤”行为一致。
  const [splitState, setSplitState] = useState(readStoredSplitState);
  const splitTree = splitState.tree;
  const focusedPaneId = splitState.focusedPane;
  const [maximizedPaneId, setMaximizedPaneId] = useState<string>();
  const paneIds = useMemo(() => (splitTree ? leafIds(splitTree) : []), [splitTree]);
  const paneFocusOrder = useMemo(() => {
    const active = focusedPaneId ?? activeSessionId;
    return [active, ...paneIds.filter((id) => id !== active)].filter((id): id is string => Boolean(id));
  }, [paneIds, focusedPaneId, activeSessionId]);
  const permission = panePermissionRequest(permissions, paneFocusOrder);
  const question = paneQuestionRequest(questions, paneFocusOrder);
  const settings = useDesktopStore((state) => state.settings);
  const galleryApps = useDesktopStore((state) => state.galleryApps);
  const themeAssetUrls = useThemeAssetUrls(themeAssetsForAppearance(settings.appearance));
  const [messageActionError, setMessageActionError] = useState<string>();
  const setActionError = useCallback((message?: string): void => {
    setMessageActionError(message);
  }, []);
  /** 打开单文件回滚确认框：产物行自带该文件的 toolCallIds，无产物不弹。 */
  const openRollbackConfirm = useCallback((file: ReplyChangedFile, sessionId: string | undefined): void => {
    if (!sessionId || file.toolCallIds.length === 0) return;
    setRollbackTarget({ file, sessionId });
  }, []);
  // 主格 onRollback 的稳定身份：内联箭头每次渲染都是新函数，会击穿
  // ConversationPane 的 memo（流式期间 App 因 permissions/status 等低频
  // 订阅仍会重渲染）。经 ref 读最新激活会话 id，回调身份恒定。
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const mainPaneRollback = useCallback((file: ReplyChangedFile): void => {
    openRollbackConfirm(file, activeSessionIdRef.current);
  }, [openRollbackConfirm]);
  const [sidebarTab, setSidebarTab] = useState<"agents" | "topics">("topics");
  const [sidebarQuery, setSidebarQuery] = useState("");
  // 启动时所有工作区分组默认折叠（空表 = 无展开项）；用户展开后保持到退出。
  const [expandedWorkspaceGroups, setExpandedWorkspaceGroups] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<"automation" | undefined>(undefined);
  function openSettingsOn(tab: "automation"): void { setSettingsInitialTab(tab); setSettingsOpen(true); }
  const [previewOpened, setPreviewOpened] = useState(false);
  const [preview, setPreview] = useState<PreviewState>();
  const [previewAddMenuOpen, setPreviewAddMenuOpen] = useState(false);
  const previewRef = useRef<PreviewState | undefined>(preview);
  previewRef.current = preview;
  const [previewEditorStates, setPreviewEditorStates] = useState<Record<string, PreviewEditorState>>({});
  const [sidebarView, setSidebarView] = useState<"topics" | "files">("topics");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarFlyoutOpen, setSidebarFlyoutOpen] = useState(false);
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const [browsingWorkspace, setBrowsingWorkspace] = useState("");
  const [treeRefreshSignal, setTreeRefreshSignal] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [renameSession, setRenameSession] = useState<{ path: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteSession, setDeleteSession] = useState<{ path: string; title: string } | null>(null);
  const [removeWorkspace, setRemoveWorkspace] = useState<{ workspace: string; name: string; count: number } | null>(null);
  // —— checkpoint 回滚：单文件确认对话框目标 + 完成后的 toast ——
  const [rollbackTarget, setRollbackTarget] = useState<{ file: ReplyChangedFile; sessionId: string } | null>(null);
  const [checkpointToast, setCheckpointToast] = useState<string>();
  // —— 自动化任务运行结束 toast（带任务名 + 查看结果直达）——
  const [automationToast, setAutomationToast] = useState<{ message: string; runId?: string }>();
  const lastAutomationRunAtRef = useRef(0);
  useEffect(() => {
    if (!automationRun || automationRun.at === lastAutomationRunAtRef.current) return;
    lastAutomationRunAtRef.current = automationRun.at;
    // 运行中不弹 toast（运行记录面板顶部有运行中条目）；终态才提示。
    if (automationRun.status === "running") return;
    const name = automationRun.taskName ? `「${automationRun.taskName}」` : "";
    // 中止不是失败：单独给一句中性文案，不套「运行失败」。
    const message = automationRun.status === "ok"
      ? (name ? `${name}运行完成` : "定时任务已运行")
      : automationRun.status === "aborted"
        ? (name ? `${name}运行已中止` : "定时任务运行已中止")
        : `${name}运行失败${automationRun.message ? `：${automationRun.message.length > 120 ? `${automationRun.message.slice(0, 120)}…` : automationRun.message}` : ""}`;
    setAutomationToast({ message, runId: automationRun.runId });
  }, [automationRun]);
  // 「查看结果」直达：打开设置页自动化 tab，写入信号让 AutomationSettings 切「运行记录」子页并高亮该条。
  function viewAutomationRun(runId: string): void {
    setAutomationToast(undefined);
    openSettingsOn("automation");
    useDesktopStore.setState({ automationRunsSignal: { runId, at: Date.now() } });
  }
  // —— 子代理完整记录（只读弹窗目标）；App 层开关，DelegationTranscript 挂在这里 ——
  const [transcriptTarget, setTranscriptTarget] = useState<DelegationProgress>();
  const lastCheckpointAtRef = useRef(0);
  useEffect(() => {
    if (!checkpointResult || checkpointResult.at === lastCheckpointAtRef.current) return;
    lastCheckpointAtRef.current = checkpointResult.at;
    setCheckpointToast(checkpointResult.message ?? "回滚完成");
    // 回滚改了盘上文件：文件树重新拉取（预览重开时自然读到新内容）。
    setTreeRefreshSignal((value) => value + 1);
  }, [checkpointResult]);
  // —— 界面动效：模态/面板的退出动画窗口（useExitPresence 延迟卸载 + styles.css
  // 退场动画；时长与 styles.css「界面动效基建」注释的对照表一致）——
  const settingsPresence = useExitPresence(settingsOpen, 160);
  const permissionPresence = useExitPresenceValue(permission, 130);
  const transcriptPresence = useExitPresenceValue(transcriptTarget, 160);
  const renamePresence = useExitPresenceValue(renameSession, 160);
  const deletePresence = useExitPresenceValue(deleteSession, 160);
  const rollbackPresence = useExitPresenceValue(rollbackTarget, 160);
  const removeWorkspacePresence = useExitPresenceValue(removeWorkspace, 160);
  const flyoutPresence = useExitPresence(sidebarFlyoutOpen, 160);
  // 预览面板：rendered 驱动 work-area 布局 class/分割条，退场期间布局不塌缩；
  // 退场时挂起 native 浏览器视图（browserSuspended），淡出的始终是 DOM 层。
  const previewPresence = useExitPresence(previewOpened, 180);
  const previewVisible = previewPresence.rendered;
  const [previewSplit, setPreviewSplit] = useState(readStoredPreviewSplit);
  const [previewDragging, setPreviewDragging] = useState(false);
  // 预览面板全屏（覆盖整个窗口）：面板关闭或标签清空即退出，不留残留状态。
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  useEffect(() => {
    if (!previewOpened || !preview || preview.tabs.length === 0) setPreviewFullscreen(false);
  }, [previewOpened, preview]);
  const previewDragPointerRef = useRef<number | undefined>(undefined);
  const workAreaRef = useRef<HTMLDivElement>(null);
  // —— 设计模式（Design Studio）：画布占主体、AI 对话收窄为侧栏；与分屏/预览互斥 ——
  //
  // 状态源是会话（快照的 designMode）而不是本地开关：设计模式决定 design_* 工具
  // 是否进本会话的活动工具集（≈1.5K tokens 的每请求前缀成本），所以它必须跟着会话
  // 落盘、跟着会话恢复；画布只是它的投影——切回一个设计会话画布自动打开，切到普通
  // 会话自动收起，重启后也会回到设计会话的画布（不再用 localStorage，否则会和会话
  // 真实状态各说各话）。顶栏按钮与设置页总闸都发命令，由 utility 统一裁决。
  const designMode = useDesktopStore((state) => state.snapshot.designMode === true);
  // —— 电脑控制模式：会话级开关，决定 computer_* 是否进本会话的活动工具集 ——
  //
  // 与 designMode 同款纪律：状态源是会话快照（不是本地 state），开关跟着会话落盘
  // 与恢复；且**默认关闭**——五个 computer_* 定义实测 ≈580 tokens/请求的前缀成本，
  // 绝大多数会话（写代码/查资料/整理文档）不会操作桌面窗口，不该替它付这份钱。
  // 全局总闸（设置页「通用」）关掉即任何会话都不注入。
  const computerMode = useDesktopStore((state) => state.snapshot.computerMode === true);
  const [designSplit, setDesignSplit] = useState(readStoredDesignSplit);
  const [designDragging, setDesignDragging] = useState(false);
  const designDragPointerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    try { window.localStorage.setItem("pidesktop.design-split", String(designSplit)); } catch { /* storage 可能不可用 */ }
  }, [designSplit]);
  // 设计导出完成 toast（design.exported 推送）+ 文件树刷新。
  const designExported = useDesktopStore((state) => state.designExported);
  const [designExportToast, setDesignExportToast] = useState<string>();
  const lastDesignExportAtRef = useRef(0);
  useEffect(() => {
    if (!designExported || designExported.at === lastDesignExportAtRef.current) return;
    lastDesignExportAtRef.current = designExported.at;
    setDesignExportToast(`设计已导出到 ${designExported.relativePath}`);
    setTreeRefreshSignal((value) => value + 1);
  }, [designExported]);
  // 作品发布结果 toast（gallery.notice）：成功也提示（用户需要知道发到哪了），
  // 缩略图降级/失败走 warn 文案。
  const galleryNotice = useDesktopStore((state) => state.galleryNotice);
  const [galleryToast, setGalleryToast] = useState<string>();
  const lastGalleryNoticeAtRef = useRef(0);
  useEffect(() => {
    if (!galleryNotice || galleryNotice.at === lastGalleryNoticeAtRef.current) return;
    lastGalleryNoticeAtRef.current = galleryNotice.at;
    setGalleryToast(galleryNotice.message);
    setTreeRefreshSignal((value) => value + 1);
  }, [galleryNotice]);
  // —— 分屏支撑：会话草稿（格子 remount 恢复）与 composer 主动写入桥 ——
  const draftsRef = useRef(new Map<string, string>());
  const draftStore = useMemo<PaneDraftStore>(() => ({
    load: (sessionId) => draftsRef.current.get(sessionId),
    save: (sessionId, text) => {
      if (text) draftsRef.current.set(sessionId, text);
      else draftsRef.current.delete(sessionId);
    }
  }), []);
  const composerBridge = useRef(new Map<string, PaneComposerApi>());
  const registerComposerApi = useCallback((api: PaneComposerApi | undefined, sessionId: string | undefined): void => {
    if (sessionId === undefined) return;
    if (api) composerBridge.current.set(sessionId, api);
    else composerBridge.current.delete(sessionId);
  }, []);
  // 已 watch 的格子集合（effect 维护）；session.new 在分屏中替换某格时记录待替换格。
  const watchedPaneIdsRef = useRef(new Set<string>());
  // 当前处于 hidden 模式（最大化中被隐藏、主进程停推）的格子集合。
  const hiddenPaneIdsRef = useRef(new Set<string>());
  const pendingPaneReplaceRef = useRef<string | undefined>(undefined);
  // 浏览器元素选择「发送到聊天框」：元素块写入焦点格输入框并聚焦——用户可
  // 继续编辑，随下一条消息一起发出。
  const sendPickedElement = useCallback((pick: BrowserElementPick, note: string): void => {
    const block = composePickMessage(pick, note);
    const targetId = focusedPaneId ?? activeSessionId;
    if (!targetId) return;
    composerBridge.current.get(targetId)?.insertText(block);
  }, [focusedPaneId, activeSessionId]);
  // 设计画布「发给 AI」：选中节点摘要写入焦点格输入框（browser-pick 同模式）。
  const sendDesignSelection = useCallback((text: string): void => {
    const targetId = focusedPaneId ?? activeSessionId;
    if (!targetId) {
      setMessageActionError("请先创建或打开一个会话，再与 AI 协作设计");
      return;
    }
    composerBridge.current.get(targetId)?.insertText(text);
  }, [focusedPaneId, activeSessionId]);
  // —— 作品（Gallery）：运行分流 / 继续开发 / 发布 ——
  //
  // 运行一律走内置浏览器 + 本地静态服务（单文件多文件、console/网络/相对资源
  // 全可用）；绝不用沙箱 iframe——它永不同时给 allow-scripts 与 allow-same-origin，
  // 窗口内的作品会静默丢 localStorage / 相对路径 fetch。
  //
  // 标签页打开走 openPreviewTarget（定义在本块之后，且需要稳定身份给 memo 用），
  // 所以用 ref 间接引用：runGalleryApp 只在事件回调里运行，那时 ref 必已就位。
  const openPreviewTargetRef = useRef<(target: PreviewTarget, id?: string) => void>(() => {});
  /** 打开终端标签页（服务型作品降级路径用它），同样后定义。 */
  const openTerminalPreviewRef = useRef<() => void>(() => {});
  const runGalleryApp = useCallback(async (app: GalleryApp): Promise<void> => {
    try {
      const target = galleryRunTarget(app);
      // 每次「运行」都重开标签页：旧标签可能已被用户改过地址或处于错误页，
      // 重开才能保证「运行」= 进到作品的初始页。
      const existing = previewRef.current?.tabs.find((tab) => tab.target.type === "browser" && tab.target.galleryId === app.id);
      if (existing) void window.piDesktop.browserPreview({ type: "close", tabId: existing.id });
      if (target.kind === "server" && !target.url) {
        // 服务型且未登记地址：本期不自动拉起进程（无可靠的就绪判定），降级为
        // 「开终端 + 把命令复制到剪贴板」，让用户回车即可。
        openTerminalPreviewRef.current();
        if (target.command) {
          await navigator.clipboard.writeText(target.command).catch(() => undefined);
          setMessageActionError(`已打开终端并复制启动命令：${target.command}（回车执行后，再点一次「运行」）`);
        } else {
          setMessageActionError("该作品是服务型，但还没登记启动命令或地址；先在作品上点「继续开发」让 AI 补全。");
        }
        return;
      }
      const url = target.kind === "server" ? target.url! : await window.piDesktop.galleryFileUrl(target.absolutePath, app.workspace);
      const tabId = `gallery-tab-${crypto.randomUUID()}`;
      // 先把 tab-meta 写进主进程（initialUrl 由 BrowserPreview 消费一次），
      // 再开标签——避免标签挂载早于元信息到达而错过首次导航。
      await window.piDesktop.browserPreview({ type: "tab-meta", tabId, initialUrl: url, galleryId: app.id });
      openPreviewTargetRef.current({ type: "browser", id: tabId, title: app.title, galleryId: app.id }, tabId);
      void window.piDesktop.send({ type: "gallery.run", id: app.id }).catch(() => undefined);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "运行作品失败");
    }
  }, []);
  const developGalleryApp = useCallback((app: GalleryApp): void => {
    const targetId = focusedPaneId ?? activeSessionId;
    if (!targetId) {
      setMessageActionError("请先创建或打开一个会话，再继续开发作品");
      return;
    }
    composerBridge.current.get(targetId)?.insertText(composeGalleryDevMessage(app));
  }, [focusedPaneId, activeSessionId]);
  const publishGalleryDraft = useCallback(async (draft: GalleryDraft): Promise<void> => {
    await window.piDesktop.send({ type: "gallery.publish", draft });
  }, []);
  const removeGalleryApp = useCallback(async (app: GalleryApp): Promise<void> => {
    await window.piDesktop.send({ type: "gallery.remove", id: app.id }).catch((error) => {
      setMessageActionError(error instanceof Error ? error.message : "移除作品失败");
    });
  }, []);
  /** 「登记新作品」对话框的开合（顶栏下拉 / 作品墙 / 空态三处入口共用）。 */
  const [galleryDraftOpen, setGalleryDraftOpen] = useState(false);
  /** 登记对话框的预填（文件树/预览面板发起时带上入口路径与名称）。 */
  const [galleryDraftInitial, setGalleryDraftInitial] = useState<{ path?: string; title?: string; kind?: GalleryKind } | undefined>(undefined);
  const openGalleryDraft = useCallback((initial?: { path?: string; title?: string; kind?: GalleryKind }): void => {
    setGalleryDraftInitial(initial);
    setGalleryDraftOpen(true);
  }, []);
  /** 作品墙弹窗：有会话历史时空态不再出现，作品墙必须另外可达（顶栏下拉「打开作品墙」）。 */
  const [galleryWallOpen, setGalleryWallOpen] = useState(false);
  /** 空态作品墙（landing）：与弹窗共用同一份渲染，只是容器不同。 */
  const renderGalleryLanding = useCallback((): ReactNode => (
    <GalleryWall
      apps={galleryApps}
      workspace={activeWorkspace}
      onRun={(app) => void runGalleryApp(app)}
      onDevelop={developGalleryApp}
      onPublish={openGalleryDraft}
      onRemove={(app) => void removeGalleryApp(app)}
    />
  ), [galleryApps, activeWorkspace, runGalleryApp, developGalleryApp, removeGalleryApp, openGalleryDraft]);
  // 会话激活/创建后拉取设计状态：画布跟随焦点会话（utility 推 design.state + design.docs）。
  const designQuerySessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!ready || !activeWorkspace || !activeSessionId) return;
    if (designQuerySessionRef.current === activeSessionId) return;
    designQuerySessionRef.current = activeSessionId;
    void window.piDesktop.send({ type: "design.query" }).catch(() => undefined);
  }, [ready, activeWorkspace, activeSessionId]);
  // 文件树「添加到聊天」：工作区文件作为附件注入焦点格附件条——随下一条消息一起
  // 发给模型（运行时按相对路径读取并生成引用块；体积/存在性校验走 statWorkspaceFile）。
  const addFileToChat = useCallback(async (relativePath: string, workspace: string): Promise<void> => {
    const targetId = focusedPaneId ?? activeSessionId;
    if (!targetId) { setMessageActionError("请先创建或打开一个会话"); return; }
    let stat;
    try {
      stat = await window.piDesktop.statWorkspaceFile(workspace, relativePath);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "读取文件信息失败");
      return;
    }
    const api = composerBridge.current.get(targetId);
    if (!api) { setMessageActionError("请先创建或打开一个会话"); return; }
    api.addAttachments([{ kind: "file", name: stat.name, path: stat.relativePath, relativePath: stat.relativePath, size: stat.size }]);
  }, [focusedPaneId, activeSessionId]);
  // 浏览器标签页状态回流：用页面标题/加载态更新预览标签的元数据。
  const handleBrowserStateChange = useCallback((tabId: string, state: import("../../shared/protocol").BrowserPreviewState): void => {
    setPreview((current) => current ? {
      ...current,
      tabs: current.tabs.map((tab) => tab.id === tabId && tab.target.type === "browser" && (tab.target.title !== state.title || tab.target.loading !== state.loading)
        ? { ...tab, target: { ...tab.target, title: state.title || tab.target.title, loading: state.loading } }
        : tab)
    } : current);
  }, []);
  const visibleAgents = useMemo(() => settings.agents.filter((agent) => !agent.archived && `${agent.name} ${agent.description}`.toLowerCase().includes(sidebarQuery.trim().toLowerCase())), [settings.agents, sidebarQuery]);
  const sessionGroups = useMemo(() => groupSessionsByWorkspace(sessionSummaries, sidebarQuery, recentWorkspaces, activeWorkspace), [sessionSummaries, recentWorkspaces, activeWorkspace, sidebarQuery]);
  const themeLayers = useMemo(() => collectThemeLayers(settings.appearance.customCss), [settings.appearance.customCss]);
  const activePreviewTab = preview?.tabs.find((tab) => tab.id === preview.activeTabId);

  // Race-safe subscription: if the component unmounts before initialize()
  // resolves (e.g. React.StrictMode's mount-unmount-mount in dev), the cleanup
  // runs with unsubscribe still pending. The cancelled flag makes the late
  // resolution tear down the listener immediately instead of leaking it.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void initialize().then((fn) => {
      if (cancelled) fn?.();
      else unsubscribe = fn;
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [initialize]);

  useEffect(() => {
    document.title = "ChatAnyTime";
  }, []);


  useEffect(() => {
    try { window.localStorage.setItem("pidesktop.preview-split", String(previewSplit)); } catch { /* storage may be unavailable in browser demo */ }
  }, [previewSplit]);

  useEffect(() => {
    if (preview) return;
    previewDragPointerRef.current = undefined;
    setPreviewDragging(false);
  }, [preview]);

  useEffect(() => {
    if (!preview) return;
    // 会话切换不收回右侧边栏：只清理会话级标签（artifact/diff），面板保持
    // 展开；跨会话标签（browser/terminal/file）全部保留。浏览器视图由
    // BrowserPreview 组件在失活时隐藏、激活时恢复，无需销毁——销毁只发生在
    // 用户显式关标签或关闭预览面板时（closePreviewTab/closePreview）。
    const keepTabs = preview.tabs.filter((tab) => tab.target.type !== "artifact" && tab.target.type !== "diff");
    if (keepTabs.length > 0) {
      const activeStillThere = keepTabs.some((tab) => tab.id === preview.activeTabId);
      setPreview({ tabs: keepTabs, activeTabId: activeStillThere ? preview.activeTabId : keepTabs[0]!.id });
    } else {
      setPreview(undefined);
    }
  }, [activeSessionId]);

  const previousWorkspaceRef = useRef(activeWorkspace);
  useEffect(() => {
    if (previousWorkspaceRef.current === activeWorkspace) return;
    previousWorkspaceRef.current = activeWorkspace;
    // Terminals spawn with the old workspace as cwd; retire them all when it
    // changes instead of leaving shells pointing at a stale directory.
    const terminalTabs = (preview?.tabs ?? []).filter((tab) => tab.target.type === "terminal");
    for (const tab of terminalTabs) void window.piDesktop.terminal({ type: "kill", terminalId: tab.id });
    if (terminalTabs.length === 0) return;
    setPreview((current) => {
      if (!current) return current;
      const tabs = current.tabs.filter((tab) => tab.target.type !== "terminal");
      if (tabs.length === 0) return undefined;
      const activeTabId = tabs.some((tab) => tab.id === current.activeTabId) ? current.activeTabId : tabs[0]!.id;
      return { tabs, activeTabId };
    });
  }, [activeWorkspace, preview]);


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
    root.dataset.themeCustom = "true";
    if (customCssHasWallpaper(settings.appearance.customCss)) root.dataset.themeWallpaper = "true";
    else delete root.dataset.themeWallpaper;
    const styleId = "pi-desktop-custom-theme";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    const customCss = resolveThemeAssets(settings.appearance.customCss, themeAssetUrls);
    style.textContent = `${themePresetCss(settings.appearance.themePreset)}\n${scopeCustomThemeCss(customCss)}\n${wallpaperOpacityCss(settings.appearance.wallpaperOpacity, ":root[data-theme-custom]")}\n${bubbleOpacityCss(settings.appearance.bubbleOpacity, ":root[data-theme-custom]")}\n${panelOpacityCss(settings.appearance.panelOpacity, ":root[data-theme-custom]")}`;
    return () => {
      style?.remove();
      delete root.dataset.themePreset;
      delete root.dataset.themeCustom;
      delete root.dataset.themeWallpaper;
    };
  }, [settings.appearance.themePreset, settings.appearance.wallpaperOpacity, settings.appearance.bubbleOpacity, settings.appearance.panelOpacity, settings.appearance.customCss, settings.appearance.customCssAssets, settings.appearance.customThemes, themeAssetUrls]);

  // Project UI state onto the document root so custom themes can react to
  // settings/preview/chat state without observing the DOM. Attribute presence
  // means true; these names are part of the stable theme-hook contract.
  // 分屏语义：generating/chat-empty/attachments 反映焦点格（= 激活会话）；
  // permission/question 是“任一格有待决”的聚合。
  useEffect(() => {
    const root = document.documentElement;
    const states: readonly [string, boolean][] = [
      ["data-ui-settings-open", settingsOpen],
      ["data-ui-workspace-open", Boolean(activeWorkspace)],
      ["data-ui-chat-empty", isChatEmpty],
      ["data-ui-generating", isGenerating],
      ["data-ui-preview-open", previewOpened],
      ["data-ui-preview-fullscreen", previewFullscreen],
      ["data-ui-permission-pending", Boolean(permission)],
      ["data-ui-question-pending", Boolean(question)],
      ["data-ui-split-open", paneIds.length > 1],
      ["data-ui-design-open", designMode]
    ];
    const valueStates: readonly [string, string | undefined][] = [
      ["data-ui-sidebar-view", sidebarView],
      ["data-ui-density", settings.appearance.tune?.density],
      ["data-ui-radius", settings.appearance.tune?.radius],
      // 界面动效总开关：关闭时 styles.css 关停块停用全部过渡/动画，
      // Presence 同步立即卸载（不保留退场窗口）。
      ["data-ui-motion", settings.appearance.motion === false ? "off" : undefined]
    ];
    for (const [name, active] of states) {
      if (active) root.setAttribute(name, "");
      else root.removeAttribute(name);
    }
    for (const [name, value] of valueStates) {
      if (value) root.setAttribute(name, value);
      else root.removeAttribute(name);
    }
    return () => {
      for (const [name] of states) root.removeAttribute(name);
      for (const [name] of valueStates) root.removeAttribute(name);
    };
  }, [settingsOpen, activeWorkspace, isChatEmpty, isGenerating, previewOpened, previewFullscreen, permission, question, paneIds.length, sidebarView, settings.appearance.tune, settings.appearance.motion, designMode]);

  async function openWorkspace(): Promise<void> {
    const path = await window.piDesktop.chooseWorkspace();
    if (path) await window.piDesktop.send({ type: "workspace.open", path });
  }

  /**
   * 新建话题：分屏中替换 paneSessionId 指定的格子（缺省焦点格）。新会话 id
   * 要等主进程激活后才知道，先记 pending，activeSessionId 变化时落位。
   */
  async function createNewSession(workspace?: string, paneSessionId?: string): Promise<void> {
    try {
      if (splitTree) {
        const target = paneSessionId ?? focusedPaneId ?? activeSessionId;
        if (target) pendingPaneReplaceRef.current = target;
      }
      await window.piDesktop.send({ type: "session.new", workspace });
      // 分组默认折叠，新建后展开目标工作区，让新话题立即可见。
      const key = workspaceKey(workspace ?? activeWorkspace ?? "");
      if (key) setExpandedWorkspaceGroups((current) => ({ ...current, [key]: true }));
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "新建话题失败");
    }
  }

  async function openSession(path: string, sessionWorkspace: string, sessionId?: string): Promise<void> {
    try {
      // 分屏中：已在格子里的会话只聚焦；不在的替换焦点格（草稿/焦点随之迁移）。
      if (splitTree && sessionId) {
        if (leafIds(splitTree).includes(sessionId)) {
          focusPane(sessionId);
          return;
        }
        const target = focusedPaneId ?? activeSessionId;
        if (target && sessionId) setSplitState((current) => current.tree ? { tree: replaceLeaf(current.tree, target, { kind: "leaf", sessionId }), focusedPane: sessionId } : current);
      }
      await window.piDesktop.send({ type: "session.open", path, workspace: sessionWorkspace });
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "打开话题失败");
    }
  }

  // —— 分屏：焦点 / 增删格 / 最大化 ——

  /** 聚焦某格 = 激活该会话（live 快路径），全局镜像（topbar/任务面板）随焦点切换。 */
  function focusPane(sessionId: string): void {
    if (sessionId === focusedPaneId && sessionId === activeSessionId) return;
    setSplitState((current) => ({ tree: current.tree, focusedPane: sessionId }));
    setMaximizedPaneId((current) => (current !== undefined && current !== sessionId ? undefined : current));
    if (sessionId === activeSessionId) return;
    const item = sessionSummaries.find((summary) => summary.id === sessionId);
    if (item) {
      void window.piDesktop.send({ type: "session.open", path: item.path, workspace: item.workspace }).catch((error) => {
        setMessageActionError(error instanceof Error ? error.message : "切换分屏失败");
      });
    }
  }

  /** 侧栏右键「分屏」：自动把新会话插入到最接近方形的格子（方向由算法决定），新格成为焦点并被激活。 */
  function addSplitPane(item: SessionSummary): void {
    if (designMode) return; // 设计模式与分屏互斥（侧栏右键入口同步置灰）
    if (!activeSessionId) return;
    if (splitTree && leafIds(splitTree).includes(item.id)) {
      focusPane(item.id);
      return;
    }
    if (splitTree && countLeaves(splitTree) >= MAX_SPLIT_PANES) return;
    // 自动均衡：不再固定「从焦点格链式分裂」，而是选最接近方形的格子落位、方向自动。
    setSplitState((current) => ({ tree: balancedAddPane(current.tree, activeSessionId, item.id), focusedPane: item.id }));
    void window.piDesktop.send({ type: "session.open", path: item.path, workspace: item.workspace }).catch((error) => {
      setMessageActionError(error instanceof Error ? error.message : "分屏打开会话失败");
    });
  }

  /** 关闭一格：剪叶塌缩；只剩一格退出分屏（该会话保持运行，回到单窗口视图）。
   *  关闭的是焦点格时激活接替格（首叶），否则激活会话仍指向刚被移出屏幕的
   *  那个会话，全局镜像（topbar/任务面板/权限过滤）会跟着一个看不见的会话走。 */
  function removeSplitPane(sessionId: string): void {
    if (!splitTree) return;
    let successor: string | undefined;
    setSplitState((current) => {
      if (!current.tree) return current;
      const collapsed = removePane(current.tree, sessionId);
      // 单叶 = 退出分屏：树置 null，渲染条件回到单窗口分支。
      const next = collapsed?.kind === "leaf" ? null : collapsed;
      const focusedGone = current.focusedPane === sessionId;
      if (focusedGone && next) successor = firstLeafId(next);
      const focusedPane = focusedGone ? (next ? firstLeafId(next) : activeSessionId) : current.focusedPane;
      return { tree: next, focusedPane };
    });
    setMaximizedPaneId((current) => (current === sessionId ? undefined : current));
    if (successor !== undefined) focusPane(successor);
  }

  function toggleMaximizePane(sessionId: string): void {
    setMaximizedPaneId((current) => (current === sessionId ? undefined : sessionId));
  }

  // —— 分屏格子回调的稳定身份 ——
  // 上面四个分屏函数每次渲染都重建；直接内联进格子 props 会让 memo 化的
  // ConversationPane 在布局树任何变化（拖分隔条每帧）时全体重渲染。这里持有
  // 最新函数版本的 ref + 按 sessionId 缓存的回调（闭包只捕获 leafSessionId，
  // 行为经 ref 永远取到当次渲染的函数），格子 props 身份跨渲染恒定。
  const paneActionsRef = useRef({ focusPane, removeSplitPane, toggleMaximizePane, createNewSession, openRollbackConfirm });
  paneActionsRef.current = { focusPane, removeSplitPane, toggleMaximizePane, createNewSession, openRollbackConfirm };
  const paneCallbacksRef = useRef(new Map<string, { onFocus(): void; onClose(): void; onToggleMaximize(): void; onNewSession(): Promise<void>; onRollback(file: ReplyChangedFile): void }>());
  const getPaneCallbacks = useCallback((leafSessionId: string) => {
    let callbacks = paneCallbacksRef.current.get(leafSessionId);
    if (!callbacks) {
      callbacks = {
        onFocus: () => paneActionsRef.current.focusPane(leafSessionId),
        onClose: () => paneActionsRef.current.removeSplitPane(leafSessionId),
        onToggleMaximize: () => paneActionsRef.current.toggleMaximizePane(leafSessionId),
        onNewSession: () => paneActionsRef.current.createNewSession(undefined, leafSessionId),
        onRollback: (file) => paneActionsRef.current.openRollbackConfirm(file, leafSessionId)
      };
      paneCallbacksRef.current.set(leafSessionId, callbacks);
    }
    return callbacks;
  }, []);
  /** 单窗口 /new：与格子回调同模式走 ref，保持稳定身份。 */
  const defaultNewSession = useCallback((): Promise<void> => paneActionsRef.current.createNewSession(), []);

  // —— 分屏 effects ——

  /** 格子集合/可见性变化时同步 session.watch：非激活格子注册推送（主进程豁免
   *  驱逐、不设终端圆点、streaming 走 session.state 通道）；移出的格子注销并清
   *  缓存。最大化时其余格子转 hidden 模式（保留 watch 与驱逐豁免，只停推送），
   *  恢复可见时主进程补推水合帧。登记簿只收“真正发送过 watch 的 id”：格子首次
   *  成为焦点（激活）时被跳过、后来失焦的，会在本 effect 随 activeSessionId
   *  变化重跑时补发——主进程幂等接受并立即回推一帧全量水合。 */
  useEffect(() => {
    if (!ready) return;
    const registered = watchedPaneIdsRef.current;
    const hiddenRegistered = hiddenPaneIdsRef.current;
    const panes = new Set(paneIds);
    const activeId = activeSessionId;
    const visible = maximizedPaneId !== undefined && panes.has(maximizedPaneId)
      ? new Set([maximizedPaneId])
      : panes;
    // 可见性切换：visible → hidden 停推，hidden → visible 恢复（主进程补水合帧）。
    // 激活会话走 state 通道，不参与 hidden（即便瞬时不可见）。
    for (const id of panes) {
      const wantHidden = !visible.has(id) && id !== activeId;
      if (wantHidden === hiddenRegistered.has(id)) continue;
      if (wantHidden) {
        hiddenRegistered.add(id);
        void window.piDesktop.send({ type: "session.watch", sessionId: id, watch: true, hidden: true }).catch(() => {
          hiddenRegistered.delete(id);
        });
      } else {
        hiddenRegistered.delete(id);
        if (id !== activeId) {
          void window.piDesktop.send({ type: "session.watch", sessionId: id, watch: true }).catch(() => undefined);
        }
      }
    }
    for (const id of visible) {
      if (id === activeId || registered.has(id)) continue;
      registered.add(id);
      void window.piDesktop.send({ type: "session.watch", sessionId: id, watch: true }).catch(() => {
        registered.delete(id);
      });
    }
    const removed: string[] = [];
    for (const id of registered) {
      if (panes.has(id)) continue;
      removed.push(id);
      void window.piDesktop.send({ type: "session.watch", sessionId: id, watch: false }).catch(() => undefined);
    }
    for (const id of removed) {
      registered.delete(id);
      hiddenRegistered.delete(id);
    }
    if (removed.length > 0) {
      dropPaneStates(removed);
      // 回调缓存随格子一并释放（Map 不随会话消失自动清理）。
      for (const id of removed) paneCallbacksRef.current.delete(id);
    }
    // 单窗口（无格子）下 state 通道每次切会话都会写 parkedPanels 留档，而这些
    // 条目永远不会被读取——按当前格子集合修剪，防止内存无界增长。
    pruneParkedPanels(panes);
  }, [paneIds, activeSessionId, ready, maximizedPaneId]);

  /** 分屏布局持久化（localStorage，重启恢复；失效格子由修剪 effect 清理）。
   *  尾随防抖：拖动分隔条时布局树每个 pointermove 帧都在变，同步写盘既卡主线程
   *  又磨损存储；停留 400ms 后落一次最终值。 */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (splitTree && focusedPaneId) window.localStorage.setItem("pidesktop.split-layout", JSON.stringify({ tree: splitTree, focusedPane: focusedPaneId }));
        else window.localStorage.removeItem("pidesktop.split-layout");
      } catch { /* storage 可能不可用 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [splitTree, focusedPaneId]);

  /** 会话消失（删除/工作区移除）时修剪格子；焦点格被剪则回退到首个叶子。 */
  useEffect(() => {
    if (!splitTree || sessionSummaries.length === 0) return;
    const valid = new Set(sessionSummaries.map((item) => item.id));
    if (activeSessionId) valid.add(activeSessionId);
    setSplitState((current) => {
      if (!current.tree) return current;
      const { tree, removed } = pruneToIds(current.tree, valid);
      if (removed.length === 0) return current;
      const focusedGone = current.focusedPane !== undefined && removed.includes(current.focusedPane);
      const focusedPane = focusedGone ? (tree ? firstLeafId(tree) : activeSessionId) : current.focusedPane;
      return { tree, focusedPane };
    });
  }, [sessionSummaries, activeSessionId, splitTree]);

  /**
   * 激活会话落位（按“激活 id 迁移”触发，树变化不触发）：维持「焦点格 =
   * 激活会话」不变量。三条路径——
   * ① 激活会话在格子集合里：聚焦跟随（focusPane / 侧栏打开 / 启动恢复的常规落位）；
   * ② 激活的会话在格子外且 pending 指定了目标格（/new 来自非焦点格）：替换该格；
   * ③ 其余格子外激活（session.new 默认、workspace.open、删除会话后的补空白等
   *   外部路径）：替换焦点格——否则激活会话不在任何格子里，分屏视图与全局
   *   镜像（topbar/任务面板/权限过滤）会指向一个看不见的会话。
   */
  const previousActiveIdRef = useRef<string | undefined>(activeSessionId);
  useEffect(() => {
    const activeId = activeSessionId;
    if (previousActiveIdRef.current === activeId) return;
    previousActiveIdRef.current = activeId;
    if (!splitTree || !activeId) return;
    if (paneIds.includes(activeId)) {
      setSplitState((current) => current.focusedPane === activeId ? current : { tree: current.tree, focusedPane: activeId });
      return;
    }
    const pending = pendingPaneReplaceRef.current;
    pendingPaneReplaceRef.current = undefined;
    const target = pending !== undefined && paneIds.includes(pending)
      ? pending
      : focusedPaneId ?? (splitTree ? firstLeafId(splitTree) : undefined);
    if (!target) return;
    setSplitState((current) => current.tree
      ? { tree: replaceLeaf(current.tree, target, { kind: "leaf", sessionId: activeId }), focusedPane: activeId }
      : current);
  }, [activeSessionId, splitTree, paneIds, focusedPaneId]);

  /** 切换助手清空分屏（会话列表按助手划分，旧格子全部失效）。 */
  const agentIdRef = useRef(activeAgentId);
  useEffect(() => {
    if (agentIdRef.current === activeAgentId) return;
    agentIdRef.current = activeAgentId;
    setSplitState({ tree: null });
    setMaximizedPaneId(undefined);
    draftsRef.current.clear();
  }, [activeAgentId]);

  /** 启动恢复分屏：会话列表就绪后先打开焦点格（用户注视的画面最先出现，不排
   *  在 N-1 个背景会话构建之后），再逐个以 activate:false 打开背景格（创建
   *  record 但不激活，全局镜像保持焦点格）。背景格的 session.watch 已由 watch
   *  effect 先行发出（主进程 pendingWatchSessions 排队，创建即补水合帧）。 */
  const splitRestoreDoneRef = useRef(false);
  useEffect(() => {
    if (splitRestoreDoneRef.current || !ready || !splitTree || sessionSummaries.length === 0) return;
    splitRestoreDoneRef.current = true;
    const focused = focusedPaneId && paneIds.includes(focusedPaneId) ? focusedPaneId : paneIds[0];
    const background = paneIds.filter((id) => id !== focused);
    void (async () => {
      const focusedItem = sessionSummaries.find((summary) => summary.id === focused);
      if (focusedItem) {
        try {
          await window.piDesktop.send({ type: "session.open", path: focusedItem.path, workspace: focusedItem.workspace });
        } catch {
          /* 焦点格失败不阻断背景格恢复 */
        }
      }
      for (const id of background) {
        const item = sessionSummaries.find((summary) => summary.id === id);
        if (!item) continue;
        try {
          await window.piDesktop.send({ type: "session.open", path: item.path, workspace: item.workspace, activate: false });
        } catch {
          /* 单格失败不阻断其余格子 */
        }
      }
    })();
  }, [ready, splitTree, paneIds, focusedPaneId, sessionSummaries]);

  /** 最大化目标格子被剪/退出分屏时清除最大化态。 */
  useEffect(() => {
    if (maximizedPaneId && (!splitTree || !leafIds(splitTree).includes(maximizedPaneId))) setMaximizedPaneId(undefined);
  }, [splitTree, maximizedPaneId]);

  function updatePreviewSplitFromPointer(clientX: number, clientY: number): void {
    const bounds = workAreaRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const stacked = window.matchMedia("(max-width: 760px)").matches;
    const value = stacked
      ? ((clientY - bounds.top) / bounds.height) * 100
      : ((clientX - bounds.left) / bounds.width) * 100;
    setPreviewSplit(Math.round(clampPreviewSplit(value) * 10) / 10);
  }

  function startPreviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    previewDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    setPreviewDragging(true);
    updatePreviewSplitFromPointer(event.clientX, event.clientY);
  }

  function movePreviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (previewDragPointerRef.current !== event.pointerId) return;
    updatePreviewSplitFromPointer(event.clientX, event.clientY);
  }

  function endPreviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (previewDragPointerRef.current !== event.pointerId) return;
    updatePreviewSplitFromPointer(event.clientX, event.clientY);
    previewDragPointerRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPreviewDragging(false);
  }

  function cancelPreviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (previewDragPointerRef.current !== event.pointerId) return;
    previewDragPointerRef.current = undefined;
    setPreviewDragging(false);
  }

  function resizePreviewWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
    const next = previewSplitFromKey(event.key, previewSplit);
    if (next === undefined) return;
    event.preventDefault();
    setPreviewSplit(next);
  }

  // —— 设计模式分隔条：调整画布区与 AI 侧栏的宽度占比 ——
  function updateDesignSplitFromPointer(clientX: number, clientY: number): void {
    const bounds = workAreaRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const stacked = window.matchMedia("(max-width: 900px)").matches;
    const value = stacked
      ? ((clientY - bounds.top) / bounds.height) * 100
      : ((clientX - bounds.left) / bounds.width) * 100;
    setDesignSplit(clampDesignSplit(value));
  }

  function startDesignResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    designDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDesignDragging(true);
    updateDesignSplitFromPointer(event.clientX, event.clientY);
  }

  function moveDesignResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (designDragPointerRef.current !== event.pointerId) return;
    updateDesignSplitFromPointer(event.clientX, event.clientY);
  }

  function endDesignResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (designDragPointerRef.current !== event.pointerId) return;
    updateDesignSplitFromPointer(event.clientX, event.clientY);
    designDragPointerRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDesignDragging(false);
  }

  // 预览面板开合：只走 setState 函数式更新，不读渲染作用域，可安全 useCallback
  // 稳定身份——下游 openArtifactPreview/openFilePreview/openPlanPreview 等
  // memo 化回调全部依赖它，不稳定会级联击穿 ConversationPane 的 memo。
  const openPreviewTarget = useCallback((target: PreviewTarget, id: string = previewTargetKey(target)): void => {
    setPreviewOpened(true);
    setPreview((current) => {
      if (current?.tabs.some((tab) => tab.id === id)) return { ...current, activeTabId: id };
      const tab: PreviewTab = { id, target };
      return current ? { tabs: [...current.tabs, tab], activeTabId: id } : { tabs: [tab], activeTabId: id };
    });
  }, []);

  const updatePreviewTarget = useCallback((id: string, target: PreviewTarget): void => {
    setPreview((current) => (current ? { ...current, tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, target } : tab)) } : current));
  }, []);

  function selectPreviewTab(id: string): void {
    setPreview((current) => (current ? { ...current, activeTabId: id } : current));
  }

  function closePreviewTab(id: string): void {
    // Real removal of a browser tab must destroy its native view; mere tab
    // switching only hides it (see BrowserPreview unmount behavior). Terminal
    // tabs are the same: closing kills the PTY, switching keeps it alive.
    const closing = preview?.tabs.find((tab) => tab.id === id);
    if (closing?.target.type === "browser") {
      void window.piDesktop.browserPreview({ type: "close", tabId: id });
    }
    if (closing?.target.type === "terminal") {
      void window.piDesktop.terminal({ type: "kill", terminalId: id });
    }
    if (closing?.target.type === "ssh-terminal") {
      void window.piDesktop.ssh({ type: "kill", terminalId: closing.target.terminalId });
    }
    setPreview((current) => {
      if (!current) return undefined;
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      if (tabs.length === 0) return undefined;
      const activeTabId = current.activeTabId === id ? tabs[Math.min(index, tabs.length - 1)]!.id : current.activeTabId;
      return { tabs, activeTabId };
    });
  }

  const openArtifactPreview = useCallback((artifact: Artifact): void => {
    openPreviewTarget({ type: "artifact", artifact });
  }, []);

  function openBrowserPreview(): void {
    openPreviewTarget({ type: "browser", id: `browser-${crypto.randomUUID()}` });
  }

  /** 打开计划全文预览（内存 markdown，不落盘），供审查面板「查看完整」跳转。 */
  const openPlanPreview = useCallback((detail: string): void => {
    openPreviewTarget({ type: "plan", title: detailTitle(detail), content: detail });
  }, [openPreviewTarget]);

  /** 记忆面板点击主题：右侧预览窗口打开该主题正文（查看/编辑/源码，保存走 memory.update）。 */
  const openMemoryTopic = useCallback((topic: MemoryTopic): void => {
    openPreviewTarget({ type: "memory", topicId: topic.id, title: topic.title });
  }, []);

  function openTerminalPreview(): void {
    openPreviewTarget({ type: "terminal" }, `terminal-${crypto.randomUUID()}`);
  }

  // 把后定义的两个入口回填给 runGalleryApp（作品运行的分流与开标签都靠它们）；
  // 在每次提交后同步一次，事件回调触发时必为最新实现。
  useEffect(() => {
    openPreviewTargetRef.current = openPreviewTarget;
    openTerminalPreviewRef.current = openTerminalPreview;
  });

  /** 侧边栏 SSH 入口：打开主机管理 tab（固定 id 复用同一 tab，不叠加）。 */
  function openSshPanel(): void {
    openPreviewTarget({ type: "ssh" }, "ssh");
  }

  /** 主机面板点「连接」：新开一个远程终端 tab（连接由 SshTerminalPanel 发起）。 */
  function openSshTerminalHost(host: SshHostSummary): void {
    const terminalId = `ssh-${crypto.randomUUID()}`;
    openPreviewTarget({ type: "ssh-terminal", terminalId, hostId: host.id, hostName: host.name }, terminalId);
  }

  async function openManualFilePreview(): Promise<void> {
    try {
      const file = await window.piDesktop.choosePreviewFile();
      if (!file) return;
      openPreviewTarget({ type: "file", file, workspace: file.workspace });
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "无法打开预览文件");
    }
  }

  const openFilePreview = useCallback(async (relativePath: string, workspace?: string): Promise<void> => {
    const id = workspace ? `${workspace}::${relativePath}` : relativePath;
    setPreviewOpened(true);
    if (previewRef.current?.tabs.some((tab) => tab.id === id)) {
      setPreview((current) => (current ? { ...current, activeTabId: id } : current));
      return;
    }
    const title = relativePath.split("/").at(-1) ?? relativePath;
    openPreviewTarget({ type: "loading", title, path: relativePath }, id);
    try {
      const file = await window.piDesktop.readWorkspaceFile(relativePath, workspace);
      // 记下文件所属工作区：编辑后必须写回该工作区，而不是当前会话工作区。
      updatePreviewTarget(id, { type: "file", file, workspace: file.workspace ?? workspace });
    } catch (error) {
      updatePreviewTarget(id, { type: "error", title, path: relativePath, message: error instanceof Error ? error.message : "读取文件失败" });
    }
  }, []);

  const openDiffPreview = useCallback((execution: ToolExecution): void => {
    if (!execution.patch) return;
    const path = execution.changedFile?.relativePath;
    openPreviewTarget({ type: "diff", title: path?.split("/").at(-1) ?? `${toolLabel(execution.name)}变更`, path, patch: execution.patch });
  }, []);

  const latestReviewExecution = [...executions].reverse().find((execution) => Boolean(execution.patch));
  const openLatestReview = useCallback((): void => {
    if (latestReviewExecution) openDiffPreview(latestReviewExecution);
  }, [latestReviewExecution, openDiffPreview]);

  /** 分屏格子的渲染器：头部信息来自会话列表摘要，交互回调全部绑定本格 sessionId。 */
  const renderSplitLeaf = useCallback((leafSessionId: string): ReactNode => {
    const summary = sessionSummaries.find((item) => item.id === leafSessionId);
    const { onFocus, onClose, onToggleMaximize, onNewSession, onRollback } = getPaneCallbacks(leafSessionId);
    return (
      <div className="split-pane" key={leafSessionId} data-pane-active={leafSessionId === focusedPaneId || undefined}>
        <ConversationPane
          sessionId={leafSessionId}
          compact
          focused={leafSessionId === focusedPaneId}
          maximized={leafSessionId === maximizedPaneId}
          title={summary?.title}
          runStatus={summary?.runStatus}
          showDock={leafSessionId === focusedPaneId}
          onFocus={onFocus}
          onClose={onClose}
          onToggleMaximize={onToggleMaximize}
          onNewSession={onNewSession}
          registerComposerApi={registerComposerApi}
          draftStore={draftStore}
          onOpenArtifact={openArtifactPreview}
          onOpenFile={openFilePreview}
          onOpenDiff={openDiffPreview}
          onOpenPlanDetail={openPlanPreview}
          onOpenMemoryTopic={openMemoryTopic}
          onOpenTranscript={setTranscriptTarget}
          onActionError={setActionError}
          onRollback={onRollback}
        />
      </div>
    );
  }, [sessionSummaries, focusedPaneId, maximizedPaneId, openArtifactPreview, openFilePreview, openDiffPreview, openPlanPreview, openMemoryTopic, registerComposerApi, draftStore, setActionError, getPaneCallbacks]);

  /** 分隔条拖动：按 split 节点路径更新比例（夹取在 SplitDivider 内完成）。 */
  const handleSplitRatioChange = useCallback((path: readonly number[], ratio: number): void => {
    setSplitState((current) => current.tree ? { ...current, tree: updateRatio(current.tree, path, ratio) } : current);
  }, []);

  // —— Markdown 编辑器状态与 AI 变更智能合并 ——
  const previewEditorStatesRef = useRef(previewEditorStates);
  previewEditorStatesRef.current = previewEditorStates;
  const editorSyncedExecutionsRef = useRef<Record<string, string>>({});
  // 预览标签默认预览态（markdown 文件与记忆主题一致：点开先读，工具栏铅笔进入编辑）。
  const defaultEditorState = (): PreviewEditorState => ({ editing: false, dirty: false, externalConflict: false });
  function getEditorState(tabId: string): PreviewEditorState {
    return previewEditorStates[tabId] ?? defaultEditorState();
  }
  function patchEditorState(tabId: string, patch: Partial<PreviewEditorState>): void {
    setPreviewEditorStates((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? defaultEditorState()), ...patch } }));
  }
  // —— Markdown 编辑器保存管线（乐观快照 + 右上角状态指示器） ——
  // 每次输入即时同步 tab 快照：切 tab/切预览立即显示最新内容，不会短暂回退成旧内容。
  function handleActiveEditorContentChange(tabId: string, content: string): void {
    const tab = previewRef.current?.tabs.find((t) => t.id === tabId);
    if (tab?.target.type !== "file" || tab.target.file.content === content) return;
    updatePreviewTarget(tabId, { type: "file", file: { ...tab.target.file, content }, workspace: tab.target.workspace });
  }
  // 落盘成功后同步快照（内容已乐观同步过，这里补上精确字节数）。
  function handleActiveEditorSaved(tabId: string, content: string): void {
    const tab = previewRef.current?.tabs.find((t) => t.id === tabId);
    if (tab?.target.type !== "file") return;
    updatePreviewTarget(tabId, { type: "file", file: { ...tab.target.file, content, size: new Blob([content]).size }, workspace: tab.target.workspace });
  }
  // 保存状态 → 右上角指示器；“已保存”2.5s 后自动收起，期间重新输入则不收起。
  function handleActiveEditorStatusChange(tabId: string, status: EditorSaveStatus): void {
    patchEditorState(tabId, { saveStatus: status });
    if (status !== "saved") return;
    window.setTimeout(() => {
      setPreviewEditorStates((prev) => {
        const current = prev[tabId];
        if (!current || current.saveStatus !== "saved") return prev;
        return { ...prev, [tabId]: { ...current, saveStatus: "idle" } };
      });
    }, 2500);
  }
  async function reloadEditorFromDisk(tabId: string, relativePath: string): Promise<void> {
    try {
      const tab = previewRef.current?.tabs.find((t) => t.id === tabId);
      const fileWorkspace = tab?.target.type === "file" ? tab.target.workspace : undefined;
      const file = await window.piDesktop.readWorkspaceFile(relativePath, fileWorkspace ?? activeWorkspace);
      updatePreviewTarget(tabId, { type: "file", file, workspace: fileWorkspace ?? file.workspace });
      setPreviewEditorStates((prev) => {
        const prior = prev[tabId] ?? defaultEditorState();
        return { ...prev, [tabId]: { ...prior, remoteReload: { content: file.content ?? "", nonce: (prior.remoteReload?.nonce ?? 0) + 1 }, externalConflict: false, dirty: false } };
      });
    } catch {
      /* 读取失败则保留当前编辑器内容 */
    }
  }
  function handleEditorResolveConflict(tabId: string, choice: "keep-local" | "load-remote"): void {
    const tab = previewRef.current?.tabs.find((t) => t.id === tabId);
    const relativePath = tab?.target.type === "file" ? tab.target.file.relativePath : undefined;
    const exec = relativePath
      ? [...executions].reverse().find((e) => e.status === "completed" && e.changedFile && e.changedFile.relativePath.toLowerCase() === relativePath.toLowerCase())
      : undefined;
    if (tab && exec) editorSyncedExecutionsRef.current[tab.id] = exec.id;
    if (choice === "load-remote" && relativePath) {
      void reloadEditorFromDisk(tabId, relativePath);
    } else {
      setPreviewEditorStates((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? defaultEditorState()), externalConflict: false } }));
    }
  }
  // 当 edit/write 工具改动了正在编辑的 markdown 文件：本地无未保存改动→自动刷新；
  // 有未保存改动→置冲突提示，等用户在编辑器内选择保留本地或加载 AI 版本。
  useEffect(() => {
    if (!preview) return;
    for (const tab of preview.tabs) {
      if (tab.target.type !== "file" || tab.target.file.kind !== "markdown") continue;
      const relativePath = tab.target.file.relativePath.toLowerCase();
      const exec = [...executions].reverse().find((e) => e.status === "completed" && e.changedFile && e.changedFile.relativePath.toLowerCase() === relativePath);
      if (!exec || editorSyncedExecutionsRef.current[tab.id] === exec.id) continue;
      const state = previewEditorStatesRef.current[tab.id] ?? defaultEditorState();
      if (state.dirty) {
        if (!state.externalConflict) patchEditorState(tab.id, { externalConflict: true });
      } else {
        editorSyncedExecutionsRef.current[tab.id] = exec.id;
        void reloadEditorFromDisk(tab.id, tab.target.file.relativePath);
      }
    }
  }, [executions, preview]);

  // AI 浏览器自动化与预览面板同步：created 把新标签加进面板并激活；
  // automation-started 展开面板并切到 AI 正在操作的标签（面板未打开时
  // 自动打开，用户能看到 AI 的操作过程）；closed 移除面板标签（native
  // view 已在主进程销毁）。用户手动开/关标签触发同一事件，openPreviewTarget
  // 的去重逻辑保证幂等。
  useEffect(() => window.piDesktop.onBrowserTabsChanged((event) => {
    if (event.action === "created" || event.action === "automation-started") {
      openPreviewTarget({ type: "browser", id: event.tabId }, event.tabId);
      return;
    }
    setPreview((current) => {
      if (!current) return undefined;
      const tabs = current.tabs.filter((tab) => tab.id !== event.tabId);
      if (tabs.length === 0) return undefined;
      const activeTabId = current.activeTabId === event.tabId ? tabs[0]!.id : current.activeTabId;
      return { tabs, activeTabId };
    });
  }), []);

  // AI 发起的 SSH 连接：主进程推 reveal，渲染端自动开/激活对应终端 tab
  //（同 id 重连会重放 scrollback——与人工切回 tab 同一条路径）。命令回显
  // 对用户可见是需求核心，所以 AI 连接必须揭示面板。
  useEffect(() => window.piDesktop.onSshReveal((event) => {
    openPreviewTarget({ type: "ssh-terminal", terminalId: event.terminalId, hostId: event.hostId, hostName: event.hostName }, event.terminalId);
  }), []);

  const sidebarInner = (
    <>
      {sidebarView === "files" ? (
        <>
          <div className="workspace-tree-header">
            <button type="button" className="workspace-tree-back" onClick={() => setSidebarView("topics")}><ChevronLeft size={14} />返回</button>
            <span title={browsingWorkspace}>{browsingWorkspace ? (browsingWorkspace.split(/[\\/]/u).at(-1) ?? browsingWorkspace) : "工作区文件"}</span>
            <button type="button" className="workspace-tree-refresh" title="刷新文件列表" aria-label="刷新文件列表" onClick={() => setTreeRefreshSignal((signal) => signal + 1)}><RefreshCw size={13} /></button>
          </div>
          {browsingWorkspace
            ? <WorkspaceTree key={browsingWorkspace} workspace={browsingWorkspace} onOpenFile={(relativePath) => openFilePreview(relativePath, browsingWorkspace)} onAddToChat={(relativePath) => void addFileToChat(relativePath, browsingWorkspace)} onPublish={(relativePath, name, kind) => openGalleryDraft({ path: relativePath, title: name, kind: kind === "directory" ? "server" : "file" })} onError={(message) => setMessageActionError(message)} refreshSignal={treeRefreshSignal} />
            : <div className="session-list-empty">请从话题列表选择工作区</div>}
        </>
      ) : (
        <>
          <div className="sidebar-tabs" role="tablist" aria-label="侧栏视图">
            <button type="button" role="tab" aria-selected={sidebarTab === "agents"} className={sidebarTab === "agents" ? "active" : ""} onClick={() => { setSidebarTab("agents"); setSidebarQuery(""); }}><Users size={14} />助手<span>{settings.agents.filter((agent) => !agent.archived).length}</span></button>
            <button type="button" role="tab" aria-selected={sidebarTab === "topics"} className={sidebarTab === "topics" ? "active" : ""} onClick={() => { setSidebarTab("topics"); setSidebarQuery(""); }}><MessageCircle size={14} />话题<span>{sessionSummaries.length}</span></button>
          </div>
          <label className="sidebar-search"><Search size={14} /><input ref={sidebarSearchRef} value={sidebarQuery} placeholder={sidebarTab === "agents" ? "搜索助手" : "搜索话题"} aria-label={sidebarTab === "agents" ? "搜索助手" : "搜索话题"} onChange={(event) => setSidebarQuery(event.target.value)} /></label>
          <div className="sidebar-section-label">{sidebarTab === "agents" ? "角色" : "最近话题"}</div>
          {sidebarTab === "agents" ? <nav className="agent-list" aria-label="助手列表">
            {visibleAgents.map((agent) => <button className={agent.id === activeAgentId ? "active" : ""} type="button" key={agent.id} data-row-kind="agent" data-row-active={agent.id === activeAgentId || undefined} onClick={() => { useDesktopStore.setState({ settings: { ...settings, currentAgentId: agent.id } }); void window.piDesktop.send({ type: "agent.select", agentId: agent.id }); }}><span className="agent-list-icon"><Bot size={15} /></span><span><strong>{agent.name}</strong><small>{agent.description || "未填写说明"}</small></span></button>)}
          </nav> : <nav className="session-list" aria-label="话题列表">
            {sessionGroups.length === 0 ? <div className="session-list-empty">暂无匹配话题</div> : sessionGroups.map((group) => {
              const collapsed = expandedWorkspaceGroups[group.key] !== true;
              const workspaceName = group.workspace.split(/[\\/]/u).at(-1) || group.workspace;
              return (
                <section className="session-workspace-group" key={group.key}>
                  <div className="session-workspace-heading" data-row-kind="workspace" data-row-expanded={!collapsed || undefined} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, items: [{ label: "打开文件目录", onClick: () => { setBrowsingWorkspace(group.workspace); setTreeRefreshSignal(0); setSidebarView("files"); } }, { label: "移除工作区", danger: true, onClick: () => setRemoveWorkspace({ workspace: group.workspace, name: workspaceName, count: group.sessions.length }) }] }); }}>
                    <button
                      className="session-workspace-toggle"
                      type="button"
                      title={group.workspace}
                      aria-expanded={!collapsed}
                      onClick={() => setExpandedWorkspaceGroups((current) => ({ ...current, [group.key]: collapsed }))}
                    >
                      <Folder size={15} />
                      <span><strong>{workspaceName}</strong></span>
                      <em>{group.sessions.length}</em>
                      <ChevronDown size={14} className={collapsed ? "collapsed" : ""} />
                    </button>
                    <button
                      className="session-workspace-files-button"
                      type="button"
                      title={`查看 ${workspaceName} 文件`}
                      aria-label={`查看 ${workspaceName} 文件`}
                      onClick={() => { setBrowsingWorkspace(group.workspace); setTreeRefreshSignal(0); setSidebarView("files"); }}
                    >
                      <FolderTree size={14} />
                    </button>
                    <button
                      className="session-workspace-new-button"
                      type="button"
                      title={`在 ${workspaceName} 中新建话题`}
                      aria-label={`在 ${workspaceName} 中新建话题`}
                      onClick={() => void createNewSession(group.workspace)}
                    >
                      <SquarePen size={14} />
                    </button>
                  </div>
                  {/* 分组子项常驻 DOM（collapsed 只切 class），展开/折叠由
                      styles.css 的 grid-template-rows 过渡驱动（内层 wrapper
                      负责剪裁），hidden 类同时阻断 Tab 焦点。 */}
                  <div className={`session-workspace-items${collapsed ? " collapsed" : ""}`}>
                    <div className="session-workspace-items-inner">
                    {group.sessions.length === 0
                      ? <div className="session-workspace-empty">暂无话题，点击右上角新建</div>
                      : group.sessions.map((item) => <button className={item.id === activeSessionId || (splitTree ? paneIds.includes(item.id) : false) ? "active" : ""} type="button" key={item.path} title={item.title} data-row-kind="session" data-row-active={item.id === activeSessionId || (splitTree ? paneIds.includes(item.id) : false) || undefined} onClick={() => void openSession(item.path, item.workspace, item.id)} onContextMenu={(event) => { event.preventDefault(); const splitDisabled = !activeSessionId || designMode || (splitTree ? countLeaves(splitTree) >= MAX_SPLIT_PANES : false); const inPane = splitTree ? leafIds(splitTree).includes(item.id) : false; setContextMenu({ x: event.clientX, y: event.clientY, items: [{ label: "重命名", onClick: () => { setRenameSession({ path: item.path, title: item.title }); setRenameValue(item.title); } }, { label: item.pinned ? "取消置顶" : "置顶", onClick: () => { void window.piDesktop.send({ type: "session.pin", path: item.path, pinned: !item.pinned }); } }, { label: inPane ? "已分屏，切换到该格" : "分屏", disabled: !inPane && splitDisabled, onClick: () => addSplitPane(item) }, { label: "删除会话", danger: true, onClick: () => setDeleteSession({ path: item.path, title: item.title }) }] }); }}><MessageCircle size={14} /><span><strong>{item.title}</strong><small>{new Date(item.modifiedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</small></span>{(item.runStatus || item.pinned) && <div className="session-item-meta">{item.runStatus && <i className={`session-status-dot ${item.runStatus}`} title={sessionRunStatusLabels[item.runStatus]} aria-label={sessionRunStatusLabels[item.runStatus]!} />}{item.pinned && <Pin size={11} className="session-pin-indicator" />}</div>}</button>)}
                    </div>
                  </div>
                </section>
              );
            })}
          </nav>}
        </>
      )}
      <button className="new-session-button" data-control="new-session" type="button" disabled={!activeWorkspace} onClick={() => void createNewSession()}><MessageSquarePlus size={16} />新建话题</button>
      <button className="automation-nav-button" data-control="automation-open" type="button" title="自动化任务" aria-label="自动化任务" onClick={() => openSettingsOn("automation")}><Zap size={15} /><span>自动化</span></button>
      <button className="automation-nav-button" data-control="ssh-open" type="button" title="SSH 远程终端" aria-label="SSH 远程终端" onClick={() => openSshPanel()}><Server size={15} /><span>SSH</span></button>
      <div className="sidebar-footer">
        <button type="button" data-control="settings" onClick={() => setSettingsOpen(true)}><Settings size={16} />设置</button>
        <span className={`runtime-indicator${runtimeBusy ? " busy" : ""}`}><i />{runtimeStatus}</span>
      </div>
    </>
  );

  if (!ready) return <div className="app-loading"><div className="brand-mark">CA</div><LoaderCircle className="spinning" size={22} /></div>;

  return (
    <div className={`desktop-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      {themeLayers.map(({ kind, name }) => (
        <div key={`${kind}-${name}`} className="theme-layer" data-theme-layer={name} data-layer-kind={kind} style={{ background: `var(--pi-${kind}-${name}, none)` }} />
      ))}
      {sidebarCollapsed ? (
        <div className="sidebar-rail" data-pane="sidebar" data-ui-sidebar-collapsed>
          <button type="button" className="rail-brand" data-control="sidebar-expand" title="展开侧边栏" aria-label="展开侧边栏" onClick={() => { if (sidebarFlyoutOpen) { setSidebarFlyoutOpen(false); } else { setSidebarCollapsed(false); } }}><span className="rail-brand-mark"><BrandMark size={20} /></span><PanelLeftOpen className="rail-brand-expand" size={18} /></button>
          <div className="sidebar-rail-items">
            <button type="button" className="rail-new-session" data-control="new-session" title="在当前工作区新建话题" aria-label="在当前工作区新建话题" disabled={!activeWorkspace} onClick={() => void createNewSession()}><Plus size={18} /></button>
            <button type="button" className="rail-icon" data-control="automation-open" title="自动化任务" aria-label="自动化任务" onClick={() => openSettingsOn("automation")}><Zap size={18} /></button>
            <button type="button" className="rail-icon" data-control="ssh-open" title="SSH 远程终端" aria-label="SSH 远程终端" onClick={() => openSshPanel()}><Server size={18} /></button>
            <button type="button" className="rail-icon" data-control="rail-topics" title="话题列表" aria-label="话题列表" onClick={() => { setSidebarView("topics"); setSidebarTab("topics"); setSidebarFlyoutOpen(true); }}><MessageCircle size={18} /></button>
            <button type="button" className="rail-icon" data-control="rail-search" title="搜索" aria-label="搜索" onClick={() => { setSidebarView("topics"); setSidebarFlyoutOpen(true); window.setTimeout(() => sidebarSearchRef.current?.focus(), 30); }}><Search size={18} /></button>
            <button type="button" className="rail-icon" data-control="rail-agents" title="助手" aria-label="助手" onClick={() => { setSidebarView("topics"); setSidebarTab("agents"); setSidebarFlyoutOpen(true); }}><Users size={18} /></button>
          </div>
          {flyoutPresence.rendered && (
            <ExitWrap exiting={flyoutPresence.exiting}>
              <aside className="sidebar sidebar-flyout" data-pane="sidebar">
                <div className="brand-row"><BrandMark size={29} /><div><strong>ChatAnyTime</strong><span>桌面端</span></div></div>
                {sidebarInner}
              </aside>
            </ExitWrap>
          )}
        </div>
      ) : (
        <aside className="sidebar" data-pane="sidebar">
          <div className="brand-row">
            <div className="brand-mark">CA</div>
            <div><strong>ChatAnyTime</strong><span>桌面端</span></div>
            <button type="button" className="brand-collapse-button" data-control="sidebar-collapse" title="折叠侧边栏" aria-label="折叠侧边栏" onClick={() => setSidebarCollapsed(true)}><PanelLeftClose size={16} /></button>
          </div>
          {sidebarInner}
        </aside>
      )}


      <main className="workspace-main" data-pane="workspace">
        <header className="topbar" data-pane="topbar">
          <div className="project-title"><Folder size={17} /><span><strong>{activeWorkspace?.split(/[\\/]/u).at(-1) ?? "ChatAnyTime"}</strong><small>{activeAgentName} · {activeSessionId ? "当前话题" : "未开始话题"}</small></span>{gitBranch && <span className="git-branch-badge" title={`当前 Git 分支：${gitBranch}`}><GitBranch size={13} />{gitBranch}</span>}</div>
          <div className="runtime-controls">
            <button className="workspace-top-button" data-control="workspace-open" type="button" onClick={() => void openWorkspace()}><FolderOpen size={15} /><span>工作区</span><strong>{compactPath(activeWorkspace)}</strong><ChevronDown size={13} /></button>
            <button className={`icon-button computer-toggle${computerMode ? " active" : ""}`} data-control="computer-toggle" type="button" disabled={!activeSessionId} aria-label={computerMode ? "关闭电脑控制" : "开启电脑控制"} aria-pressed={computerMode} title={!activeSessionId ? "请先创建或打开一个话题" : computerMode ? "关闭电脑控制（本会话将撤下 computer_* 工具）" : "电脑控制（AI 可枚举/截图/点击/输入本机窗口；本会话注入 computer_* 工具，约 580 tokens/请求）"} onClick={() => void window.piDesktop.send({ type: "session.computerMode", enabled: !computerMode }).catch((error) => setMessageActionError(error instanceof Error ? error.message : "电脑控制切换失败"))}><Computer size={18} /></button>
            <button className={`icon-button design-toggle${designMode ? " active" : ""}`} data-control="design-toggle" type="button" disabled={!activeSessionId} aria-label={designMode ? "退出设计模式" : "进入设计模式"} aria-pressed={designMode} title={!activeSessionId ? "请先创建或打开一个话题" : designMode ? "退出设计模式（本会话将不再注入设计工具）" : "设计模式（AI 设计工作台；本会话注入 design_* 工具）"} onClick={() => void window.piDesktop.send({ type: "session.designMode", enabled: !designMode }).catch((error) => setMessageActionError(error instanceof Error ? error.message : "设计模式切换失败"))}><Palette size={18} /></button>
            <GalleryMenu apps={galleryApps} onRun={(app) => void runGalleryApp(app)} onDevelop={developGalleryApp} onOpenWall={() => setGalleryWallOpen(true)} onPublish={() => openGalleryDraft()} />
            <button className="icon-button preview-panel-toggle" data-control="preview-toggle" type="button" aria-label={previewOpened ? "关闭预览" : "打开预览"} title={previewOpened ? "关闭预览" : "打开预览"} onClick={() => {              // 顶部按钮始终完全关闭/打开预览面板：即使已有标签页也不会
              // 折叠成残留一列栏+展开按钮的中间态。
              if (previewOpened) {
                setPreviewOpened(false);
              } else {
                setPreviewOpened(true);
              }
            }}>{previewOpened ? <PanelRightClose size={18} /> : <Eye size={18} />}</button>
          </div>
        </header>

          <div
            ref={workAreaRef}
            data-pane="work-area"
            className={`work-area${designMode ? " design-mode" : previewVisible && preview && preview.tabs.length > 0 ? " with-preview" : previewVisible ? " with-preview-empty" : ""}${designDragging ? " is-design-dragging" : !designMode && previewDragging ? " is-preview-dragging" : ""}`}
            style={designMode ? { "--design-split": `${designSplit}%` } as CSSProperties : previewVisible ? { "--preview-split": `${previewSplit}%` } as CSSProperties : undefined}
          >
          {/* 设计模式：画布工作台占主体 + AI 对话侧栏（ConversationPane 完整复用）；
              分屏树保留但不渲染，退出设计模式即恢复；预览面板不挂载（互斥）。 */}
          {designMode ? (
            <>
              <DesignStudio onSendToAi={sendDesignSelection} />
              <div
                className={`design-divider${designDragging ? " dragging" : ""}`}
                role="separator"
                aria-label="调整画布与对话宽度"
                title="拖动调整画布与对话宽度，双击恢复"
                tabIndex={0}
                onPointerDown={startDesignResize}
                onPointerMove={moveDesignResize}
                onPointerUp={endDesignResize}
                onLostPointerCapture={endDesignResize}
                onDoubleClick={() => setDesignSplit(62)}
              />
              <div className="design-chat-pane">
                <ConversationPane
                  sessionId={activeSessionId}
                  showDock
                  focused
                  onNewSession={defaultNewSession}
                  registerComposerApi={registerComposerApi}
                  draftStore={draftStore}
                  onOpenArtifact={openArtifactPreview}
                  onOpenFile={openFilePreview}
                  onOpenDiff={openDiffPreview}
                  onOpenPlanDetail={openPlanPreview}
                  onOpenMemoryTopic={openMemoryTopic}
                  onOpenTranscript={setTranscriptTarget}
                  onActionError={setActionError}
                  onRollback={mainPaneRollback}
                  renderLanding={renderGalleryLanding}
                />
              </div>
            </>
          ) : (<>
          {/* 会话槽位：单窗口 = 一个 ConversationPane；分屏 = 布局树递归渲染，
              最大化时只渲染目标格（树保留，还原即恢复）。预览面板/终端是全局
              标签页，与会话槽位并存于 work-area 网格。 */}
          {splitTree && paneIds.length > 0 ? (
            <div className={`split-view${maximizedPaneId ? " maximized" : ""}`}>
              {maximizedPaneId && paneIds.includes(maximizedPaneId)
                ? renderSplitLeaf(maximizedPaneId)
                : <SplitLayout node={splitTree} renderLeaf={renderSplitLeaf} onRatioChange={handleSplitRatioChange} />}
            </div>
          ) : (
            <ConversationPane
              sessionId={activeSessionId}
              showDock
              focused
              onNewSession={defaultNewSession}
              registerComposerApi={registerComposerApi}
              draftStore={draftStore}
              onOpenArtifact={openArtifactPreview}
              onOpenFile={openFilePreview}
              onOpenDiff={openDiffPreview}
              onOpenPlanDetail={openPlanPreview}
              onOpenMemoryTopic={openMemoryTopic}
              onOpenTranscript={setTranscriptTarget}
              onActionError={setActionError}
              onRollback={mainPaneRollback}
              renderLanding={renderGalleryLanding}
            />
          )}

          {previewVisible && preview && <PreviewDivider split={previewSplit} dragging={previewDragging} onStart={startPreviewResize} onMove={movePreviewResize} onEnd={endPreviewResize} onCancel={cancelPreviewResize} onKeyDown={resizePreviewWithKeyboard} onReset={() => setPreviewSplit(50)} />}

          {previewVisible && <ExitWrap exiting={previewPresence.exiting}>{preview && preview.tabs.length > 0 ? (
            <ArtifactPreview tabs={preview.tabs} activeTabId={preview.activeTabId} browserSuspended={previewDragging || settingsOpen || Boolean(permission) || Boolean(messageActionError) || previewAddMenuOpen || previewPresence.exiting} fullscreen={previewFullscreen} onFullscreenChange={setPreviewFullscreen} onSelectTab={selectPreviewTab} onCloseTab={closePreviewTab} onOpenArtifact={openArtifactPreview} onAddBrowser={openBrowserPreview} onAddTerminal={openTerminalPreview} onAddSsh={openSshPanel} onSshConnect={openSshTerminalHost} onAddFile={() => void openManualFilePreview()} onAddReview={openLatestReview} onAddMenuOpenChange={setPreviewAddMenuOpen} reviewAvailable={Boolean(latestReviewExecution)} workspace={activeWorkspace} activeEditorState={activePreviewTab && ((activePreviewTab.target.type === "file" && activePreviewTab.target.file.kind === "markdown") || activePreviewTab.target.type === "memory") ? getEditorState(activePreviewTab.id) : undefined} onActiveEditorChange={(patch) => { if (activePreviewTab) patchEditorState(activePreviewTab.id, patch); }} onActiveEditorContentChange={handleActiveEditorContentChange} onActiveEditorSaved={handleActiveEditorSaved} onActiveEditorStatusChange={handleActiveEditorStatusChange} onActiveEditorSaveError={(message) => setMessageActionError(`保存 ${activePreviewTab?.target.type === "file" ? activePreviewTab.target.file.name : activePreviewTab?.target.type === "memory" ? "记忆主题" : "Markdown"} 失败：${message}`)} onActiveEditorResolveConflict={(choice) => { if (activePreviewTab) handleEditorResolveConflict(activePreviewTab.id, choice); }} onToggleEditing={() => { if (activePreviewTab) patchEditorState(activePreviewTab.id, { editing: !getEditorState(activePreviewTab.id).editing }); }} onBrowserStateChange={handleBrowserStateChange} onBrowserPickSend={sendPickedElement} onPublishFile={(relativePath, name) => openGalleryDraft({ path: relativePath, title: name, kind: "file" })} />
          ) : (
            <ArtifactPreview key="empty-state" tabs={[]} activeTabId="" onSelectTab={selectPreviewTab} onCloseTab={closePreviewTab} onOpenArtifact={openArtifactPreview} onAddBrowser={openBrowserPreview} onAddTerminal={openTerminalPreview} onAddSsh={openSshPanel} onSshConnect={openSshTerminalHost} onAddFile={() => void openManualFilePreview()} onBrowserPickSend={sendPickedElement} />
          )}</ExitWrap>}
          </>)}
        </div>
      </main>

      {settingsPresence.rendered && <ExitWrap exiting={settingsPresence.exiting}><SettingsDialog settings={settings} models={models} providers={providers} resources={resources} workspaceOpen={Boolean(activeWorkspace)} initialTab={settingsInitialTab} jevKeyConfigured={jevKeyConfigured} onClose={() => { setSettingsOpen(false); setSettingsInitialTab(undefined); }} onCreateInSession={() => void createNewSession()} /></ExitWrap>}
      {permissionPresence.rendered && (() => { const permission = permissionPresence.value; return permission ? <ExitWrap exiting={permissionPresence.exiting}><PermissionDialog request={permission} sessionTitle={sessionSummaries.find((item) => item.id === permission.principal.sessionId)?.title} /></ExitWrap> : null; })()}
      {transcriptPresence.rendered && (() => { const transcriptTarget = transcriptPresence.value; return transcriptTarget ? <ExitWrap exiting={transcriptPresence.exiting}><DelegationTranscript delegation={transcriptTarget} onClose={() => setTranscriptTarget(undefined)} onOpenArtifact={openArtifactPreview} /></ExitWrap> : null; })()}
      {galleryWallOpen && (
        <GalleryWallDialog
          apps={galleryApps}
          workspace={activeWorkspace}
          onRun={(app) => { setGalleryWallOpen(false); void runGalleryApp(app); }}
          onDevelop={(app) => { setGalleryWallOpen(false); developGalleryApp(app); }}
          onRemove={(app) => void removeGalleryApp(app)}
          onPublish={() => { setGalleryWallOpen(false); openGalleryDraft(); }}
          onClose={() => setGalleryWallOpen(false)}
        />
      )}
      {galleryDraftOpen && (
        <GalleryPublishDialog
          initial={galleryDraftInitial}
          workspace={activeWorkspace}
          onSubmit={(draft) => { void publishGalleryDraft(draft).catch((error) => setMessageActionError(error instanceof Error ? error.message : "发布失败")); }}
          onClose={() => { setGalleryDraftOpen(false); setGalleryDraftInitial(undefined); }}
        />
      )}
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      {renamePresence.rendered && (() => { const renameSession = renamePresence.value; if (!renameSession) return null; return (
        <ExitWrap exiting={renamePresence.exiting}>
        <div className="modal-backdrop permission-backdrop" onClick={() => setRenameSession(null)}>
          <div className="permission-dialog extension-ui-dialog" role="dialog" aria-modal="true" aria-label="重命名会话" onClick={(event) => event.stopPropagation()}>
            <header><div className="risk-icon command"><Pencil size={20} /></div><div><h2>重命名会话</h2></div></header>
            <form onSubmit={(event) => { event.preventDefault(); const title = renameValue.trim(); if (title) { void window.piDesktop.send({ type: "session.rename", path: renameSession.path, title }); setRenameSession(null); } }}>
              <div className="field"><label>会话名称</label><input value={renameValue} placeholder="输入会话名称" autoFocus onChange={(event) => setRenameValue(event.target.value)} /></div>
              <footer><button className="secondary-button" type="button" onClick={() => setRenameSession(null)}>取消</button><button className="primary-button" type="submit" disabled={!renameValue.trim()}>确定</button></footer>
            </form>
          </div>
        </div>
        </ExitWrap>
      ); })()}
      {deletePresence.rendered && (() => { const deleteSession = deletePresence.value; if (!deleteSession) return null; return (
        <ExitWrap exiting={deletePresence.exiting}>
        <div className="modal-backdrop permission-backdrop" onClick={() => setDeleteSession(null)}>
          <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label="删除会话" onClick={(event) => event.stopPropagation()}>
            <header><div className="risk-icon outside-workspace"><Trash2 size={20} /></div><div><h2>删除会话「{deleteSession.title}」？</h2><p>将永久删除该会话及其关联的任务清单，此操作不可恢复。</p></div></header>
            <footer><button className="secondary-button" type="button" onClick={() => setDeleteSession(null)}>取消</button><button className="danger-button" type="button" onClick={() => { void window.piDesktop.send({ type: "session.delete", path: deleteSession.path }); setDeleteSession(null); }}>删除</button></footer>
          </div>
        </div>
        </ExitWrap>
      ); })()}
      {rollbackPresence.rendered && (() => { const rollbackTarget = rollbackPresence.value; if (!rollbackTarget) return null; return (
        <ExitWrap exiting={rollbackPresence.exiting}>
        <div className="modal-backdrop permission-backdrop" onClick={() => setRollbackTarget(null)}>
          <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label="回滚文件" onClick={(event) => event.stopPropagation()}>
            <header><div className="risk-icon write"><History size={20} /></div><div><h2>回滚文件「{rollbackTarget.file.relativePath.split("/").at(-1)}」？</h2><p>{rollbackTarget.file.relativePath}</p><p>该文件将恢复到本次改动前的状态；若它是本次新建的文件则会被删除，当前内容会被覆盖。</p></div></header>
            <footer>
              <button className="secondary-button" type="button" onClick={() => setRollbackTarget(null)}>取消</button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  void window.piDesktop.send({
                    type: "checkpoint.rollback",
                    sessionId: rollbackTarget.sessionId,
                    targets: [{ relativePath: rollbackTarget.file.relativePath, toolCallIds: rollbackTarget.file.toolCallIds }]
                  });
                  setRollbackTarget(null);
                }}
              >回滚</button>
            </footer>
          </div>
        </div>
        </ExitWrap>
      ); })()}
      {checkpointToast && (
        <div className="error-toast checkpoint-toast"><History size={18} /><span>{checkpointToast}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setCheckpointToast(undefined)}><X size={16} /></button></div>
      )}
      {designExportToast && (
        <div className="error-toast checkpoint-toast"><Palette size={18} /><span>{designExportToast}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setDesignExportToast(undefined)}><X size={16} /></button></div>
      )}
      {galleryToast && (
        <div className="error-toast checkpoint-toast"><LayoutGrid size={18} /><span>{galleryToast}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setGalleryToast(undefined)}><X size={16} /></button></div>
      )}
      {automationToast && (
        <div className={`error-toast checkpoint-toast${automationToast.runId ? " with-action" : ""}`}><Zap size={18} /><span>{automationToast.message}</span>{automationToast.runId && <button className="toast-action" type="button" title="打开运行记录" aria-label="查看运行结果" onClick={() => viewAutomationRun(automationToast.runId!)}>查看结果</button>}<button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setAutomationToast(undefined)}><X size={16} /></button></div>
      )}
      {removeWorkspacePresence.rendered && (() => { const removeWorkspace = removeWorkspacePresence.value; if (!removeWorkspace) return null; return (
        <ExitWrap exiting={removeWorkspacePresence.exiting}>
        <div className="modal-backdrop permission-backdrop" onClick={() => setRemoveWorkspace(null)}>
          <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label="移除工作区" onClick={(event) => event.stopPropagation()}>
            <header><div className="risk-icon outside-workspace"><Trash2 size={20} /></div><div><h2>移除工作区「{removeWorkspace.name}」？</h2><p>{removeWorkspace.count > 0 ? `将永久删除当前助手在该工作区下的 ${removeWorkspace.count} 个会话，其他助手不受影响，此操作不可恢复。` : "该工作区暂无会话，将从当前助手的话题栏移除，其他助手不受影响。"}</p></div></header>
            <footer><button className="secondary-button" type="button" onClick={() => setRemoveWorkspace(null)}>取消</button><button className="danger-button" type="button" onClick={() => { void window.piDesktop.send({ type: "workspace.remove", workspace: removeWorkspace.workspace }); setRemoveWorkspace(null); }}>移除</button></footer>
          </div>
        </div>
        </ExitWrap>
      ); })()}
      {error && <div className="error-toast"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={clearError}><X size={16} /></button></div>}
      {messageActionError && <div className="error-toast"><AlertCircle size={18} /><span>{messageActionError}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setMessageActionError(undefined)}><X size={16} /></button></div>}
    </div>
  );
}
