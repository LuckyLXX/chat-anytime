import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { estimateTokens } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, UserMessage, ImageContent, Model, Context, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  detectSupportedImageMimeTypeFromFile,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BackgroundProcessRegistry, bashCommandsFromMessages, isBackgroundCommand } from "./background-processes.js";
import { alignQueueState, imageAttachmentsFrom, promoteQueueMessage, queuedMessageText, queueSnapshotMessages, removeQueueMessage, replayQueueArgs, type PromoteOutcome } from "./queue-images.js";
import { normalizeMessages, userMessageText } from "./message-normalize.js";
import { applyModelOverrides as applyStoredModelOverrides, buildCatalogModels, imageInputOverride, isModelEnabled, pickFallbackModel, pruneDisabledModelRefs, resolveRestoredSessionModel } from "./model-catalog.js";
import type {
  AccessMode,
  AgentProfile,
  BrowserAutomationRequest,
  BrowserAutomationResult,
  SshAutomationRequest,
  SshAutomationResult,
  ChatMessage,
  ContextUsage,
  ContextUsageBreakdown,
  DesktopSettings,
  DesignSnapshotRequest,
  DesignSnapshotResult,
  HookRule,
  HookSummary,
  McpServerSummary,
  MemoryTopic,
  ModelOption,
  PromptAttachment,
  ProviderModelSettings,
  ProviderOption,
  ProviderSettings,
  RecentWorkspace,
  RuntimeCommand,
  CommandSummary,
  RuntimeMessage,
  RuntimeSnapshot,
  SessionPaneSnapshot,
  SessionRunStatus,
  SessionSummary,
  SkillSummary,
  SpeedStats,
  ThinkingLevel,
  ThinkingLevelMap,
  Todo,
  ToolExecution,
  TurnTiming,
  AutomationTask,
  AutomationRunRecord
} from "../shared/protocol.js";
import { isDelegationProgress } from "../shared/protocol.js";
import { THINKING_LEVELS, clampThinkingLevel, supportedThinkingLevels } from "../shared/thinking-levels.js";
import { toolLabel } from "../shared/locale.js";
import { workspaceRelativeAttachment } from "./attachments.js";
import { downloadDirFor } from "./browser-downloads.js";
import { saveBrowserScreenshot } from "./browser-screenshot.js";
import { autoCompactionFailureNotice, runManualCompaction } from "./compaction-lifecycle.js";
import { isAbortErrorMessage, resolveRunOutcomeStatus, type TerminalRunStatus } from "./run-outcome.js";
import { readGitBranch } from "./git-branch.js";
import { builtinProviderOverlay, inferCustomModelImageInput, resolveBuiltinOverlayAction, resolveCustomProviderRegistration } from "./custom-provider.js";
import { buildDivModePrompt } from "./div-prompt.js";
import { McpClientManager } from "./mcp-client.js";
import { readConfiguredMcpServers, removeMcpServerConfig, setMcpServerDisabled, upsertMcpServerConfig } from "./mcp-config.js";
import { McpOAuthController } from "./mcp-oauth.js";
import { PermissionBroker } from "./permission-broker.js";
import { loadRecentWorkspaces, recordRecentWorkspace, writeRecentWorkspaces } from "./recent-workspaces.js";
import {
  galleryPathFor,
  galleryThumbsDirFor,
  loadGalleryRepairingIds,
  persistGallery,
  pruneGalleryThumbs,
  writeGalleryThumb
} from "./gallery-store.js";
import {
  galleryAbsolutePath,
  galleryRunTarget,
  galleryThumbEligible,
  galleryThumbName,
  normalizeGalleryApp,
  normalizeGalleryEntry,
  removeGalleryApp,
  sortGalleryApps,
  upsertGalleryApp,
  type GalleryApp,
  type GalleryDraft
} from "../shared/gallery.js";
import * as runtimeGallery from "./runtime-gallery.js";
import * as runtimeJev from "./runtime-jev.js";
import { assistantText, createSubagentTools, buildSubagentPromptBlock, type SubagentContext } from "./subagent.js";
import { readSubagents, saveSubagent, deleteSubagent, saveSubagentModelOverride } from "./subagents-store.js";
import type { SubagentDefinition, SubagentScope, DelegationProgress, SlashInvocation } from "../shared/protocol.js";
import { buildSkillsSystemPromptBlock, setSkillEnabled, type DiscoveredSkill } from "./skill-catalog.js";
import * as commandCatalog from "./command-catalog.js";
import { COMMAND_NAME_PATTERN, type DiscoveredCommand } from "./command-catalog.js";
import { createTodoStore, migrateLegacyTodoFile, type TodoStore } from "./todo-store.js";
import { automationPathFor, deleteAutomation, normalizeAutomation, readAllAutomations, recordAutomationRun, resolveAutomationAgent, toggleAutomation, upsertAutomation } from "./automation-store.js";
import { appendAutomationRun, readAutomationRuns } from "./automation-runs.js";
import { createAutomationScheduler, type AutomationScheduler } from "./automation-scheduler.js";
import { buildAutomationTools, type AutomationCreateInput, type AutomationToolContext } from "./automation-tools.js";
import { resolveVisionModel } from "./vision.js";
import { buildResourceCatalog } from "./resource-catalog.js";
import { agentWorkspaceSessionDir, backfillUnpersistedSessions, isSessionPinned, mergeSessionSummary, pruneVanishedSessions, sameSessionDir, sessionFileMatchesId, sessionListReadyFor, sortSessionSummaries, togglePinnedSessionPath } from "./session-scope.js";
import { isDesktopConfiguredProvider } from "./model-catalog.js";
import { defaultTools, ensureDefaultWorkspaceDir, forgetAgentWorkspace, isPositiveInt, mergeProviderModels, recordAgentWorkspace, resolveDefaultWorkspace, resolveInitialWorkspace } from "./settings.js";
import { buildMultiInvocationPrompt, composeInvocationBody, parseInvocationPrompt, sameInvocations, type InvocationSegment } from "./invocation-prompt.js";
import {
  PI_DESKTOP_CONTROL_ENTRY_TYPE,
  restoreControlMessages,
  restoreToolExecutions,
  transcriptMessagesFromEntries,
  type PersistedSessionEntry,
  type PersistedSessionMessage
} from "./session-history.js";
import { changedWorkspaceFile, changedWorkspaceFiles, collectProducedArtifacts, isArtifactProducingTool } from "./workspace-preview.js";
import { createToolAudit } from "./tool-audit.js";
import { collectUsageStats, createUsageStatsCache } from "./usage-stats.js";
import { diffToolNames } from "./tool-delta.js";
import * as runtimeTodoTools from "./runtime-todo-tools.js";
import * as runtimeMemoryTools from "./runtime-memory-tools.js";
import { createMemoryStore, memoryDirFor, type MemoryStore } from "./memory-store.js";
import * as runtimeQuestionTool from "./runtime-question-tool.js";
import * as runtimeSkills from "./runtime-skills.js";
import * as runtimeVision from "./runtime-vision.js";
import * as runtimeBrowser from "./runtime-browser.js";
import * as runtimeSsh from "./runtime-ssh.js";
import * as runtimeComputer from "./runtime-computer.js";
import * as runtimeDesign from "./runtime-design.js";
import { applyDesignOps, createDesignDoc, sanitizeDesignName, type DesignDoc } from "../shared/design-schema.js";
import { exportDesignHtml } from "../shared/design-export.js";
import { designFilePath, exportDesignFile, listDesigns, readDesign, writeDesign, writeExportFile, DESIGN_FILE_SUFFIX } from "./design-store.js";
import * as runtimePermissions from "./runtime-permissions.js";
import * as runtimeMcp from "./runtime-mcp.js";
import * as runtimeContextUsage from "./runtime-context-usage.js";
import { createImageDownsampler } from "./image-downsample.js";
import { budgetedStreamSimple, createImageBudgetGate } from "./budgeted-stream.js";
import * as speedStats from "./speed-stats.js";
import * as contextBreakdown from "./context-breakdown.js";
import * as runtimeHooks from "./runtime-hooks.js";
import * as runtimePlanTools from "./runtime-plan-tools.js";
import * as runtimeShellKill from "./runtime-shell-kill.js";
import { planHeading, readPlanMode, saveApprovedPlan, writePlanMode } from "./plan-store.js";
import { readDesignMode, writeDesignMode } from "./design-mode-store.js";
import { readComputerMode, writeComputerMode } from "./computer-mode-store.js";
import { checkpointPathFor, readCheckpoints, sweepCheckpoints } from "./checkpoint-store.js";
import { createCheckpointExtension, rollbackPlan } from "./runtime-checkpoint.js";
import { hookActionPreview, readConfiguredHooks, removeHookConfig, setHookDisabled, upsertHookConfig, validateHookRule, type ConfiguredHook } from "./hooks-config.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Pi 运行时必须作为 Electron 工具进程启动");

let modelRuntime: ModelRuntime | undefined;
let workspace: string | undefined;
/** 当前工作区的 git 分支；非 git 项目为 undefined，随工作区切换异步刷新。 */
let gitBranch: string | undefined;
let thinkingLevel: ThinkingLevel = "medium";
let accessMode: AccessMode = "ask";
let status = "请选择一个项目开始使用";
let currentSessions: SessionSummary[] = [];
/** `currentSessions` 是按哪个 Agent 的目录拉取的；换过角色的旧列表视为失效。 */
let currentSessionsAgentId: string | undefined;
let recentWorkspaces: RecentWorkspace[] = [];
/** 作品清单（全局跨工作区：一份池子，换工作区也在）；初始化时读盘，变更即写盘 + 推送。 */
let galleryApps: GalleryApp[] = [];
let selectedModel: { provider: string; id: string } | undefined;
let settings: DesktopSettings | undefined;
/** 随安装包分发的内置 Skill 目录（安装目录 resources/skills），由主进程经 initialize 下发。 */
let bundledSkillsDir: string | undefined;
/** 随安装包分发的内置子智能体目录（安装目录 resources/subagents），同由主进程下发；
 * 缺省时该档不参与合并（用户目录里的定义照常生效）。 */
let bundledSubagentsDir: string | undefined;
/** 当前 Agent 的自动化定时任务（设置页列表 + 目录下发）；随 Agent 切换重读。 */
let automationTasks: AutomationTask[] = [];
/** 全角色自动化运行历史（设置页「运行记录」子页 + 目录下发）；runs.jsonl 事件流。 */
let automationRuns: AutomationRunRecord[] = [];
/** 自动化调度器（每分 tick，串行执行）；initialize 创建、utility 进程结束随进程清理。 */
let automationScheduler: AutomationScheduler | undefined;
let apiKeys: Record<string, string> = {};
/** TypeSafe（Jev）密钥在 apiKeys 里的条目名（与 main 侧 credentials.json 的键一致）。 */
const JEV_CREDENTIAL_ID = "typesafe";
let visionModel: Model<Api> | undefined;
let currentAgent: AgentProfile | undefined;
// Transient whole-runtime transition (agent switch / profile apply): overlays
// busy + status on the snapshot until the operation settles.
let transitionStatus: string | undefined;

/** Set a status message on the active record, or the no-session fallback. */
function applyStatusToActive(message: string): void {
  if (activeRuntime) activeRuntime.status = message;
  else status = message;
}

/**
 * Per-session runtime state. Multiple sessions stay live concurrently: the
 * user can start a turn in one session, switch to (or create) another, and the
 * parked session keeps streaming into its own history. `activeRuntime` selects
 * which record feeds the renderer snapshot; all others run in the background
 * and only surface lifecycle changes (sidebar status dot).
 */
interface SessionRuntimeRecord {
  session: AgentSession;
  unsubscribe: () => void;
  workspace: string;
  /** Agent profile captured at creation — background sessions never re-read globals. */
  agent: AgentProfile;
  busy: boolean;
  status: string;
  turnTiming?: TurnTiming;
  executions: Map<string, ToolExecution>;
  controlMessages: ChatMessage[];
  todoStore: TodoStore;
  /** Per-session tool-call pacer backing the todo_write anti-batching reminder. */
  todoPace: runtimeTodoTools.TodoPaceTracker;
  /** 计划模式状态（会话级，磁盘恢复；narrate 驱动一次性 context 注入）。 */
  planState: runtimePlanTools.PlanModeState;
  /**
   * 设计模式（会话级，磁盘恢复）：决定 design_* 工具是否进活动工具集。
   * 冻结在会话维度——用户在设计会话里连续工作时工具集字节不变（前缀缓存），
   * 切到别的会话也不受牵连。
   */
  designMode: { enabled: boolean };
  /**
   * 电脑控制模式（会话级，磁盘恢复）：决定 computer_* 工具是否进活动工具集。
   * 与 designMode 同款纪律——冻结在会话维度，前缀缓存整段有效；新会话默认不开。
   */
  computerMode: { enabled: boolean };
  /** 按助手划分的长期记忆库（跨会话）；工具闭包读它，提示词快照在创建时冻结。 */
  memoryStore: MemoryStore;
  customTools: ToolDefinition[];
  subagentTools: ToolDefinition[];
  todoTools: ToolDefinition[];
  memoryTools: ToolDefinition[];
  questionTools: ToolDefinition[];
  planTools: ToolDefinition[];
  /** 无人值守（后台自动化）会话：不暴露 ask_question，避免提问挂起。 */
  unattended: boolean;
  /** Captured at bindExtensions(); drives MCP hot-reload for this session only. */
  extensionApi: ExtensionAPI | undefined;
  permissionDeps: runtimePermissions.PermissionGateDeps;
  visionTools: ToolDefinition[];
  browserTools: ToolDefinition[];
  sshTools: ToolDefinition[];
  computerTools: ToolDefinition[];
  automationTools: ToolDefinition[];
  designTools: ToolDefinition[];
  /** 作品发布工具（gallery_publish）；单个轻量定义，无条件激活。 */
  galleryTools: ToolDefinition[];
  /** Jev 快速决策通路（browser_jev_run，实验性、缺省关闭）。 */
  jevTools: ToolDefinition[];
  /** Jev 总闸的实时读取（settings.jev?.enabled === true，缺省关闭）；活动集重算时用。 */
  jevGlobalEnabled: () => boolean;
  /** 设计模式总闸的实时读取（settings.design?.enabled !== false）；活动集重算时用。 */
  designGlobalEnabled: () => boolean;
  /** 电脑控制总闸的实时读取（settings.computer?.enabled !== false）；活动集重算时用。 */
  computerGlobalEnabled: () => boolean;
  /** 可单独终止的 bash/powershell 工具（同名覆盖内建定义）；任务面板按命令停止的执行端。 */
  shellKill: runtimeShellKill.KillableShellTools;
  /** 当前会话绑定的设计文档（设计模式画布的数据源；工具与用户命令共用）。 */
  designDoc?: { doc: DesignDoc; fileName: string };
  /**
   * 排队消息的图片镜像：与 Pi 会话 steering/followUp 文本数组 index 严格对齐
   * （无图项 = 空数组）。Pi 队列本体完整保存带图消息，但对外只有纯文本数组；
   * 这块镜像支撑快照展示（imageCount）与整队重建（sendNow/remove）时的图片
   * 重放。Pi 队列只从头部消费，读侧按 queue-images 的 alignQueueState 截断对齐。
   */
  steeringImages: ImageContent[][];
  followUpImages: ImageContent[][];
  runStatus: SessionRunStatus | undefined;
  /** True from session.abort() until the run settles — resolves the dot to red. */
  abortRequested: boolean;
  /**
   * Session-wide cumulative cache-token counters (durable projection, aligned
   * with deepseek-harness): accumulated at each assistant message_end and
   * re-scanned at agent_end as an idempotent backstop (regenerate truncates
   * the transcript). Compaction deliberately does not clear it.
   */
  cacheUsage: runtimeContextUsage.CacheUsageTotals;
  /**
   * dsh 风格性能统计（输入框下方状态行）：时间/轮步字段事件驱动累计，
   * token 计数快照时从 cacheUsage 合入（单一账本）。恢复会话只回填计数。
   */
  speedStats: SpeedStats;
  /** 当前模型调用周期的打点（turn_start 开、message_end 收；turn_end 兜底清）。 */
  speedStep?: speedStats.SpeedStep;
  /** 流式实时读数（token 估算随 message_update 节流刷新；收步/回合结束清）。 */
  speedLive?: { startedAt: number; firstTokenAt?: number; tokens: number };
  /** 上下文三段明细（稳定边界重算，见 refreshContextBreakdown；快照只读）。 */
  contextBreakdown?: ContextUsageBreakdown;
  /** 工具段估算缓存：活动工具集变化才重算（键 = 活动工具名 join）。 */
  toolTokensCache?: { key: string; tokens: number };
  activatedAt: number;
  /** 分屏格子（watched）流式推送的节流定时器；激活会话不走此通道。 */
  paneFlushTimer?: ReturnType<typeof setTimeout>;
}

const liveSessions = new Map<string, SessionRuntimeRecord>();
let activeRuntime: SessionRuntimeRecord | undefined;
// 分屏中正被渲染端展示的会话（session.watch 注册）：parked 也能收到
// session.state 推送、豁免空闲驱逐、不设侧栏终端圆点。激活会话隐含在内
//（它走 state 通道，schedulePaneEmit 对激活记录是 no-op）。
const renderedSessions = new Set<string>();
// 渲染端想 watch 但会话尚未 live（启动恢复逐格打开的间隙）：先挂起，
// createSession 建立记录后自动补注册并推送水合帧。
const pendingWatchSessions = new Set<string>();
// hidden 模式的 watched 格子（最大化时被隐藏）：保留 renderedSessions 成员资格
// （驱逐豁免、无终端圆点），但 schedulePaneEmit 停止推送——避免全量快照流进
// 没有渲染的格子。切回可见时由 watch handler 补推一帧水合。
const hiddenPaneSessions = new Set<string>();
// Idle parked sessions beyond this count are disposed (their history stays on
// disk and is rebuilt on reopen); running sessions are never evicted.
const MAX_PARKED_SESSIONS = 4;

// Mirrors of the active record's todo state: the read-only task panel follows
// the session being viewed (no prompt injection — todo_write args are the only
// model-visible channel).
let todoStore: TodoStore | undefined;
let todos: Todo[] = [];
// 长期记忆镜像（面板治理视图，全量、不经工作区过滤）：跟随激活助手，
// 与 todo 镜像同模式；模型侧走会话创建时的索引快照注入（见 createSession）。
let memoryStore: MemoryStore | undefined;
let memoryTopics: MemoryTopic[] = [];
let resourceOperationBusy = false;
let sessionGeneration = 0;
const customProviderId = "chatanytime-openai-compatible";
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
let nativeSkills: SkillSummary[] = [];
let discoveredSkills: DiscoveredSkill[] = [];
let nativeCommands: CommandSummary[] = [];
let discoveredCommands: DiscoveredCommand[] = [];
let mcpServers: McpServerSummary[] = [];
// 用量统计的按文件扫描缓存（utility 生命周期内存态；键 mtimeMs+size，
// 会话内容不变时零重扫，助手筛选切换只重聚合）。
const usageStatsCache = createUsageStatsCache();
// Set when the user explicitly reloads resources or changes MCP config, so the
// next createSession forces a network sync instead of serving the tool cache.
let forceMcpRefresh = false;
// Detached background processes left by bash executions (dev servers etc.),
// surfaced in the task panel. App-wide: processes outlive session switches.
const backgroundProcesses = new BackgroundProcessRegistry(() => emitState());
let lastBackgroundDiscoveryAt = 0;

// Streaming coalescer: high-frequency partial frames (message_update token
// batches, tool partial output) are throttled to 50ms (20fps) to avoid IPC
// storms. State transitions that change busy/status/executions flush
// immediately so the UI never lags on real lifecycle changes.
const STREAM_FLUSH_INTERVAL_MS = 50;
// 分屏格子（watched 非激活会话）的流式合帧间隔：后台格不是用户注视的主画面，
// 10fps 足够；全量快照过 IPC 的成本随历史长度增长，放宽一倍换一半流量。
// 生命周期转换仍立即 flush（与激活会话同节奏）。
const PANE_STREAM_FLUSH_INTERVAL_MS = 100;
let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;
let hasPendingFlush = false;

function flushState(): void {
  pendingFlushTimer = undefined;
  hasPendingFlush = false;
  post({ type: "state", snapshot: snapshot() });
}

/**
 * Emit the runtime snapshot. Pass `true` for state-changing events that must
 * reach the renderer immediately (busy/status/tool lifecycle); pass `false`
 * for pure streaming accumulation that can safely batch to 20fps.
 */
function scheduleEmit(immediate: boolean): void {
  if (immediate) {
    if (pendingFlushTimer) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = undefined;
    }
    hasPendingFlush = false;
    post({ type: "state", snapshot: snapshot() });
    return;
  }
  if (pendingFlushTimer) {
    hasPendingFlush = true;
    return;
  }
  hasPendingFlush = true;
  pendingFlushTimer = setTimeout(flushState, STREAM_FLUSH_INTERVAL_MS);
}

function post(message: RuntimeMessage): void {
  parentPort.postMessage(message);
}

// Browser automation RPC: the utility process asks the main process to drive
// the visible preview tabs (CDP lives there); results come back as
// browser-automation.result commands handled outside the serial command
// queue so tool executions are never blocked behind unrelated commands.
let browserRequestSequence = 0;
const BROWSER_RPC_TIMEOUT_MS = 120_000;
const pendingBrowserRequests = new Map<string, { resolve: (result: BrowserAutomationResult) => void; timer: ReturnType<typeof setTimeout> }>();

function requestBrowserAutomation(sessionKey: string, request: BrowserAutomationRequest): Promise<BrowserAutomationResult> {
  return new Promise((resolve, reject) => {
    const requestId = `browser-rpc-${++browserRequestSequence}`;
    const timer = setTimeout(() => {
      pendingBrowserRequests.delete(requestId);
      reject(new Error("浏览器操作超时（120 秒无响应），请重试"));
    }, BROWSER_RPC_TIMEOUT_MS);
    pendingBrowserRequests.set(requestId, { resolve, timer });
    post({ type: "browser-automation.request", requestId, sessionKey, request });
  });
}

function resolveBrowserAutomation(requestId: string, result: BrowserAutomationResult): void {
  const pending = pendingBrowserRequests.get(requestId);
  if (!pending) return;
  pendingBrowserRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(result);
}

// SSH RPC（ssh-automation.request / .result）：与 browser RPC 同旁路语义——
// 工具 execute 内 await，绝不能排在串行命令队列后面。ssh_exec 的等待由
// 工具内 timeoutSeconds 控制（短于这里的外层 120s 兜底）。
let sshRequestSequence = 0;
const SSH_RPC_TIMEOUT_MS = 120_000;
const pendingSshRequests = new Map<string, { resolve: (result: SshAutomationResult) => void; timer: ReturnType<typeof setTimeout> }>();

function requestSshAutomation(sessionKey: string, request: SshAutomationRequest, timeoutMs?: number): Promise<SshAutomationResult> {
  return new Promise((resolve, reject) => {
    const requestId = `ssh-rpc-${++sshRequestSequence}`;
    // 外层兜底超时必须**严于**主进程的传输超时：否则 500MB 传输会先被外层掐断，
    // 而主进程仍在跑——工具报了错、文件却还在写，是最糟的组合。
    const outerTimeoutMs = timeoutMs === undefined ? SSH_RPC_TIMEOUT_MS : timeoutMs + 30_000;
    const timer = setTimeout(() => {
      pendingSshRequests.delete(requestId);
      reject(new Error(`SSH 操作超时（${Math.round(outerTimeoutMs / 1000)} 秒无响应），请重试`));
    }, outerTimeoutMs);
    pendingSshRequests.set(requestId, { resolve, timer });
    post({ type: "ssh-automation.request", requestId, sessionKey, request });
  });
}

function resolveSshAutomation(requestId: string, result: SshAutomationResult): void {
  const pending = pendingSshRequests.get(requestId);
  if (!pending) return;
  pendingSshRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(result);
}

// Design export thumbnail RPC (design-snapshot.request / .result): same
// bypass-the-command-queue semantics — the design_export tool execution awaits
// this directly and must not stall behind unrelated serialized commands.
let designSnapshotSequence = 0;
const DESIGN_SNAPSHOT_RPC_TIMEOUT_MS = 60_000;
const pendingDesignSnapshotRequests = new Map<string, { resolve: (result: DesignSnapshotResult) => void; timer: ReturnType<typeof setTimeout> }>();

function requestDesignSnapshot(request: DesignSnapshotRequest): Promise<DesignSnapshotResult> {
  return new Promise((resolve, reject) => {
    const requestId = `design-snapshot-rpc-${++designSnapshotSequence}`;
    const timer = setTimeout(() => {
      pendingDesignSnapshotRequests.delete(requestId);
      reject(new Error("缩略图生成超时（60 秒无响应）"));
    }, DESIGN_SNAPSHOT_RPC_TIMEOUT_MS);
    pendingDesignSnapshotRequests.set(requestId, { resolve, timer });
    post({ type: "design-snapshot.request", requestId, request });
  });
}

function resolveDesignSnapshot(requestId: string, result: DesignSnapshotResult): void {
  const pending = pendingDesignSnapshotRequests.get(requestId);
  if (!pending) return;
  pendingDesignSnapshotRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(result);
}

const permissionBroker = new PermissionBroker(
  (request) => post({ type: "permission", request }),
  (id) => post({ type: "permission.dismiss", id })
);
const questionBroker = new runtimeQuestionTool.QuestionBroker(
  (request) => post({ type: "question", request }),
  (id) => post({ type: "question.dismiss", id })
);
// OAuth：回调服务器与凭据库都在 utility 进程；打开浏览器经 main 进程
// shell.openExternal（open-external 上行消息），授权完成后重连并刷新工具集。
const mcpOAuth = new McpOAuthController({
  storePath: () => join(getAgentDir(), "pidesktop-mcp-auth.json"),
  openExternal: (url) => post({ type: "open-external", url }),
  onAuthorized: async (serverName) => {
    forceMcpRefresh = true;
    if (activeRuntime) await applyMcpToolChanges();
    else {
      await syncMcpServers(true);
      forceMcpRefresh = false;
    }
    // applyMcpToolChanges 的热更新路径（只加不减走 registerTool）不推资源目录，
    // 这里补上——否则授权成功后面板仍显示「等待浏览器授权…」。
    emitResourceCatalog();
    post({ type: "log", level: "info", message: `MCP 服务器 ${serverName} 已完成 OAuth 授权` });
  },
  // 等待超时/回调失败发生在任何命令之外，同样要重推目录让面板离开等待态。
  onAuthStateChanged: () => emitResourceCatalog(),
  log: (message) => post({ type: "log", level: "warn", message })
});
const mcpClient = new McpClientManager({ oauth: mcpOAuth });
let mcpTools: ToolDefinition[] = [];
/** 服务器→Pi 工具名映射（syncMcpServers 同步刷新）：角色级 mcp:<server> overlay 的过滤依据。 */
let mcpServerToolNames = new Map<string, string[]>();

function skillPaths(): ReturnType<typeof runtimeSkills.skillPathsFor> {
  return runtimeSkills.skillPathsFor(workspace, getAgentDir(), bundledSkillsDir);
}

/** 自定义命令双作用域目录：项目 <workspace>/.pidesktop-commands，全局 <agentDir>/pidesktop-commands。 */
function commandPaths(): { globalDir: string; projectDir: string } {
  return {
    globalDir: join(getAgentDir(), "pidesktop-commands"),
    projectDir: workspace ? resolve(workspace, ".pidesktop-commands") : join(getAgentDir(), "pidesktop-commands")
  };
}

/** Scan custom command dirs and refresh the published CommandSummary catalog. */
function syncCommands(): void {
  const { globalDir, projectDir } = commandPaths();
  discoveredCommands = commandCatalog.discoverCommands(globalDir, projectDir);
  nativeCommands = commandCatalog.toCommandSummaries(discoveredCommands);
}

/** Scan skill dirs and refresh the published SkillSummary catalog. */
function syncSkills(): void {
  const scanned = runtimeSkills.scanSkills(skillPaths());
  discoveredSkills = scanned.discovered;
  nativeSkills = scanned.summaries;
}

/**
 * Build the subagent delegation customTools for one session. All context comes
 * from the record (workspace/agent/model captured at creation), so parked
 * background sessions keep delegating against their own configuration. The
 * child flag disables nesting (delegations cannot spawn further delegations).
 * 工具始终注册（注册≠激活的纪律，也让会话内前缀字节稳定），定义清单在 execute
 * 时经 getSubagentCatalog 实读：定义为空时调用只会拿到一条明确的报错。
 */
function buildSubagentTools(record: Pick<SessionRuntimeRecord, "workspace" | "agent" | "permissionDeps">, sessionId: string | undefined, model: { provider: string; id: string } | undefined, isDelegationChild: boolean): ToolDefinition[] {
  if (!modelRuntime) return [];
  const ctx: SubagentContext = {
    modelRuntime,
    workspace: record.workspace,
    agentDir: getAgentDir(),
    agent: record.agent,
    thinkingLevel,
    accessMode,
    model: model ?? { provider: "", id: "" },
    // 读器而非快照：refreshSubagents() 会换掉模块级数组引用，旧会话必须总能看到
    // 最新定义（否则设置页新增子智能体后，已打开的会话引用不到）。
    getSubagentCatalog: () => subagentCatalog,
    // 运行时与设置页模型下拉同口径：被取消勾选的模型不再用于委派。
    isModelEnabled: (providerId, modelId) => isModelEnabled(providerId, modelId, settings?.providers),
    // 子代理与主会话同口径：目录模型交给子代理前套上 token-limit 覆盖。
    transformModel: (candidate) => applyModelOverrides(candidate),
    parentSessionId: sessionId,
    requestPermission: (toolName, args, toolCallId) => runtimePermissions.requestPermission(record.permissionDeps, toolName, args, toolCallId, "subagent"),
    isDelegationChild
  };
  return createSubagentTools(ctx);
}

function mcpConfigPaths(): { project: string; global: string } {
  return runtimeMcp.mcpConfigPathsFor(workspace, getAgentDir());
}

/** 钩子配置双作用域：项目 <workspace>/.pidesktop-hooks.json，全局 <agentDir>/pidesktop-hooks.json。 */
function hooksConfigPaths(): { project: string | undefined; global: string } {
  return {
    project: workspace ? join(workspace, ".pidesktop-hooks.json") : undefined,
    global: join(getAgentDir(), "pidesktop-hooks.json")
  };
}

/**
 * 双作用域合并后的钩子规则缓存。事件 handler 触发时读取（runtime-hooks 的
 * rules getter），因此这里的刷新即“热更新”——规则增删改不需要重建会话。
 */
let hooksRules: ConfiguredHook[] = [];

function refreshHooksConfig(): void {
  const { project, global } = hooksConfigPaths();
  hooksRules = readConfiguredHooks(project, global);
}

function hookSummaries(): HookSummary[] {
  return hooksRules.map(({ name, rule, scope }) => ({
    name,
    event: rule.event,
    ...(rule.matcher ? { matcher: rule.matcher } : {}),
    actionKind: rule.action.kind,
    action: rule.action,
    actionPreview: hookActionPreview(rule.action),
    blocking: rule.action.kind === "block" || (rule.action.kind === "command" && rule.action.blocking === true),
    scope,
    enabled: rule.disabled !== true
  }));
}

/** 双作用域合并后的自定义子智能体定义缓存（delegate_agent 引用 + 渲染端列表）。
 * 三档：内置（随安装包分发，只读）→ 用户全局 → 项目，同名后者覆盖前者。 */
let subagentCatalog: SubagentDefinition[] = [];

function refreshSubagents(): void {
  subagentCatalog = readSubagents(workspace, getAgentDir(), bundledSubagentsDir);
}

/** Connect to all configured MCP servers and refresh tool definitions + catalog status. */
async function syncMcpServers(refresh = false): Promise<void> {
  const synced = await runtimeMcp.syncMcpServers(mcpClient, mcpConfigPaths(), refresh);
  mcpServers = synced.summaries;
  mcpTools = synced.tools;
  mcpServerToolNames = synced.serverToolNames;
}

function emitResourceCatalog(): void {
  post({ type: "resources", resources: buildResourceCatalog({ skills: nativeSkills, commands: nativeCommands, mcpServers, todos, memory: memoryTopics, subagents: subagentCatalog, hooks: hookSummaries(), hooksEnabled: settings?.hooks?.enabled !== false, automation: automationTasks, automationRuns, gallery: galleryApps }) });
}

function emitTodos(): void {
  post({ type: "todos", todos });
}

/** Reload todos from the store and broadcast to the renderer. */
function refreshTodos(): void {
  if (todoStore) todos = todoStore.list();
  emitTodos();
  emitResourceCatalog();
}

function emitMemory(): void {
  post({ type: "memory", memory: memoryTopics });
}

/** Reload memory topics from the active store and broadcast to the renderer. */
function refreshMemory(): void {
  if (memoryStore) memoryTopics = memoryStore.list();
  emitMemory();
  emitResourceCatalog();
}

/** 某 Agent 的自动化任务文件路径。 */
function automationStorePath(agentId: string): string {
  return automationPathFor(getAgentDir(), agentId);
}

/** 广播自动化任务列表（全角色聚合）。 */
function emitAutomation(): void {
  post({ type: "automation", tasks: automationTasks });
}

/** 广播自动化运行历史（全角色聚合，全量替换语义）。 */
function emitAutomationRuns(): void {
  post({ type: "automation-runs", runs: automationRuns });
}

/** 重读全部角色的自动化任务与运行历史并广播（列表/运行记录 + 目录）；任何角色变化都影响聚合列表。 */
function refreshAutomation(): void {
  automationTasks = readAllAutomations(getAgentDir());
  automationRuns = readAutomationRuns(getAgentDir());
  emitAutomation();
  emitAutomationRuns();
  emitResourceCatalog();
}

/** 自动化 store 变化后收口：刷新全角色列表并让调度器重排。 */
function afterAutomationChange(_agentId: string): void {
  refreshAutomation();
  automationScheduler?.refresh();
}

/** 最近一条非空助手文本（运行摘要预览采样）。 */
function lastAssistantText(record: SessionRuntimeRecord): string {
  const messages = record.session.state.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = assistantText(messages[index]);
    if (text) return text;
  }
  return "";
}

function truncatePreview(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** 任务运行完成后把摘要写回 store（若任务仍存在）并让列表/调度器刷新。 */
function afterAutomationRun(taskId: string, agentId: string, run: AutomationTask["lastRun"]): void {
  if (run) recordAutomationRun(automationStorePath(agentId), taskId, run);
  refreshAutomation();
  automationScheduler?.refresh();
}

/**
 * 落一条 skipped 运行记录（「本轮本该运行但没运行」）。
 *
 * 三条纪律（与计划的设计决策一一对应）：
 *  ① **不写 task.lastRun**：lastRun 语义是「上一次实际运行」，被跳过覆盖会让
 *     「上次成功时间」丢失，而调度与用户判断都依赖它；
 *  ② **不发 automation-run 推送**：跳过不该弹 toast 打扰用户（只有运行记录里可查）；
 *  ③ **前置去重**：同一任务同一时间点的「错过」只记一次，且同任务 1 小时内最多
 *     一条 skipped——否则高频跳过会把 MAX_RUNS=200 的环形空间挤满，冲掉有价值的
 *     历史。
 */
const SKIPPED_DEDUPE_WINDOW_MS = 60 * 60_000;

function recordSkippedRun(task: AutomationTask, reason: string, at: number): void {
  // 已有该时间点之后的记录 → 说明已正常运行过（或刚记过），不重复记。
  const existing = automationRuns.some((run) => run.taskId === task.id && run.startedAt >= at);
  if (existing) return;
  // 同任务 1 小时内已有 skipped 记录：合并掉（高频任务不刷屏）。
  const recentSkip = automationRuns.some((run) => run.taskId === task.id && run.status === "skipped" && at - run.startedAt < SKIPPED_DEDUPE_WINDOW_MS);
  if (recentSkip) return;
  const agent = resolveAutomationAgent(settings?.agents ?? [], task.agentId);
  automationRuns = appendAutomationRun(getAgentDir(), {
    id: randomUUID(),
    taskId: task.id,
    taskName: task.name,
    agentId: task.agentId,
    agentName: agent?.name ?? task.agentId,
    startedAt: at,
    durationMs: 0,
    status: "skipped",
    trigger: "cron",
    skipReason: reason
  });
  emitAutomationRuns();
}

/** 后台新建专用会话跑任务提示词（跨角色：按任务自身 agentId 解析角色档案，skipActivate 不抢焦点）。 */
async function runAutomationTask(task: AutomationTask, trigger: "cron" | "manual"): Promise<void> {
  if (!workspace || !modelRuntime) throw new Error("当前没有可用工作区，无法运行定时任务");
  // 快照本回合的工作区：避免与 agent.select/workspace.open 交错时执行主体与数据落位错位。
  const runWorkspace = workspace;
  // 跨角色调度（2026-09-02）：按任务自身 agentId 解析角色档案，不再要求「归属角色
  // 恰好处于激活状态」；归档/未知角色解析失败即跳过（归档=停用其全部任务）。
  let runAgent: AgentProfile;
  if (task.agentId) {
    const resolved = resolveAutomationAgent(settings?.agents ?? [], task.agentId);
    if (!resolved) throw new Error(`定时任务「${task.name}」归属的角色不存在或已归档（${task.agentId}），已跳过`);
    runAgent = resolved;
  } else {
    runAgent = currentAgent ?? activeAgent();
  }
  const modelRef = task.model && modelRuntime.getModel(task.model.provider, task.model.id) && isModelEnabled(task.model.provider, task.model.id, settings?.providers) ? task.model : (runAgent.defaultModel ?? settings?.model);
  // 会话目录按任务归属角色落位（与手动运行同路径）：chatanytime-sessions/<agentId>/<workspaceHash>/
  const sessionDir = agentWorkspaceSessionDir(getAgentDir(), runAgent.id, runWorkspace);
  const manager = SessionManager.create(runWorkspace, sessionDir);
  const sessionId = manager.getSessionId();
  // 无人值守会话：注入任务级权限（默认 full 自动放行）、不暴露提问工具、不参与全局代际竞争；
  // agentOverride 让系统提示/记忆库/审计目录全部按任务归属角色构建，与当前激活角色无关。
  await createSession(manager, {
    skipActivate: true,
    agentOverride: runAgent,
    modelOverride: modelRef,
    accessModeOverride: task.accessMode,
    unattended: true,
    noGenerationGuard: true,
    // 无人值守后台会话不继承设计模式：每次触发都是全新会话，没有界面能开关，
    // 默认不给 design_*（省下约 1.5K tokens/次的前缀成本，已与用户对齐）。
    inheritDesignMode: false
  });
  const record = liveSessions.get(sessionId);
  if (!record) throw new Error("自动化会话创建失败");
  if (!record.session.model) throw new Error("无法为任务解析模型，请检查该任务的模型配置");
  // 运行会话在话题列表中可辨认（查看会话后的体验闭环）：为会话命名；对未持久化
  // 会话（首条助手消息前 JSONL 未落盘）的 appendSessionInfo 行为可能受限，失败只记日志不阻塞。
  try {
    manager.appendSessionInfo(`自动化 · ${task.name}`);
  } catch (error) {
    void post({ type: "log", level: "warn", message: `为自动化会话命名「${task.name}」失败：${errorText(error)}` });
  }
  if (task.accessMode !== "full") {
    post({ type: "log", level: "warn", message: `自动化任务「${task.name}」使用受限权限 ${task.accessMode}，无人值守下遇权限确认会挂起，建议改为完全访问。` });
  }
  record.busy = true;
  record.status = `自动化任务：${task.name}`;
  record.runStatus = "running";
  record.abortRequested = false;
  patchSessionRunStatus(record);
  beginTurn(record);
  emitPaneStateFor(record);
  const startedAt = Date.now();
  // 开始执行即推 running：渲染端据此在运行记录列表顶部显示运行中条目（不带 runId——记录在结束时才落盘）。
  post({ type: "automation-run", id: task.id, status: "running", taskName: task.name });
  // 结算状态：ok / error / aborted。不能用「prompt 是否抛异常」判定——Pi 把
  // provider 的流式错误写进消息列表而非抛出（2026-09-08 那次日报文被截断却
  // 记为 ok），结算一律以末条 assistant 消息为准（run-outcome 同口径）。
  let outcome: "ok" | "error" | "aborted" = "ok";
  try {
    await record.session.prompt(task.prompt);
    const messages = record.session.state.messages;
    const runOutcome = resolveRunOutcomeStatus(false, messages);
    const preview = truncatePreview(lastAssistantText(record));
    // 失败/中止时把末条 assistant 的 errorMessage 落进记录，让失败可诊断。
    const runError = runOutcome === "completed"
      ? undefined
      : [...messages].reverse().find((message) => message.role === "assistant")?.errorMessage;
    outcome = runOutcome === "completed" ? "ok" : runOutcome === "aborted" ? "aborted" : "error";
    const runId = randomUUID();
    automationRuns = appendAutomationRun(getAgentDir(), {
      id: runId,
      taskId: task.id,
      taskName: task.name,
      agentId: runAgent.id,
      agentName: runAgent.name,
      sessionId,
      startedAt,
      durationMs: Date.now() - startedAt,
      status: outcome,
      trigger,
      ...(modelRef ? { modelId: modelRef.id } : {}),
      ...(preview ? { preview } : {}),
      ...(runError ? { error: runError } : {})
    });
    emitAutomationRuns();
    // lastRun 回写（覆盖式，保留不动）与运行历史流并存：afterAutomationRun 内 refreshAutomation 会重读 runs。
    afterAutomationRun(task.id, runAgent.id, { sessionId, startedAt, status: outcome, ...(preview ? { preview } : {}), ...(runError ? { error: runError } : {}) });
    post({ type: "automation-run", id: task.id, status: outcome, taskName: task.name, runId, ...(runError ? { message: runError } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 抛出的是执行层异常（会话创建失败、模型解析失败…）；中止原文也走这里时
    // 仍按中止记，避免把用户停止显示成红色失败。
    outcome = isAbortErrorMessage(message) ? "aborted" : "error";
    const runId = randomUUID();
    automationRuns = appendAutomationRun(getAgentDir(), {
      id: runId,
      taskId: task.id,
      taskName: task.name,
      agentId: runAgent.id,
      agentName: runAgent.name,
      sessionId,
      startedAt,
      durationMs: Date.now() - startedAt,
      status: outcome,
      trigger,
      ...(modelRef ? { modelId: modelRef.id } : {}),
      error: message
    });
    emitAutomationRuns();
    afterAutomationRun(task.id, runAgent.id, { sessionId, startedAt, status: outcome, error: message });
    post({ type: "automation-run", id: task.id, status: outcome, taskName: task.name, runId, message });
  } finally {
    record.busy = false;
    record.runStatus = outcome === "ok" ? "completed" : outcome === "aborted" ? "aborted" : "failed";
    patchSessionRunStatus(record);
    emitState();
    emitPaneStateFor(record);
  }
}

/**
 * 批准并移交：在规划会话所属 Agent + 工作区下新建前台会话，以所选模型按计划
 * 文档开始实施（runAutomationTask 同款纪律）。与自动化后台会话的对照：那是
 * skipActivate + unattended + noGenerationGuard；这里是默认激活 + 有人值守
 * （权限门、ask_question、代际竞争保护照常）。
 */
async function handoffPlanToNewSession(input: {
  source: SessionRuntimeRecord;
  plan: string;
  planPath?: string;
  title: string;
  model: { provider: string; id: string };
}): Promise<{ sessionId: string }> {
  const { source, model } = input;
  if (!modelRuntime || !currentAgent || !workspace) throw new Error("当前没有可用的工作区或 Agent，无法移交");
  // 快照守卫（自动化同款）：createSession 派生自全局 workspace/currentAgent，
  // 若规划会话落位与当前不一致，新建会话会错位——分屏内会话同属当前 Agent，
  // 正常路径必过。
  if (source.agent.id !== currentAgent.id || resolve(source.workspace) !== resolve(workspace)) {
    throw new Error("规划会话与当前 Agent/工作区不一致，无法移交");
  }
  // 模型校验（自动化同款口径）：所选模型必须存在且已勾选，绝不静默回落默认模型。
  if (!modelRuntime.getModel(model.provider, model.id) || !isModelEnabled(model.provider, model.id, settings?.providers)) {
    throw new Error(`所选模型不可用（已删除或未勾选）：${model.provider}/${model.id}`);
  }
  const sessionDir = workspaceSessionDir();
  if (!sessionDir) throw new Error("无法定位会话目录");
  const manager = SessionManager.create(workspace, sessionDir);
  const sessionId = manager.getSessionId();
  // 默认激活：焦点切到实施会话（用户直接看到实施进展）；有人值守不传
  // unattended/noGenerationGuard——权限门与提问工具照常，与其他前台会话一致。
  // 不继承设计模式：实施计划是编码任务，不需要 8 个设计工具的前缀开销。
  await createSession(manager, { modelOverride: model, inheritDesignMode: false });
  const record = liveSessions.get(sessionId);
  if (!record) throw new Error("实施会话创建失败");
  // 以计划标题命名新会话；对未持久化会话（首条助手消息前 JSONL 未落盘）的
  // appendSessionInfo 行为可能受限，命名失败只记日志不阻塞（锦上添花）。
  try {
    manager.appendSessionInfo(input.title);
  } catch (error) {
    void post({ type: "log", level: "warn", message: `为实施会话命名「${input.title}」失败：${errorText(error)}` });
  }
  // 复用完整命令语义：模型就绪/busy 守卫、todo 回合清空（新会话空表无副作用）、
  // busy/runStatus/beginTurn/emitState 与错误兜底全部照常。
  await handleCommand({
    type: "session.prompt",
    text: runtimePlanTools.buildPlanHandoffPrompt({ plan: input.plan, planPath: input.planPath, title: input.title }),
    sessionId
  });
  return { sessionId };
}

/** 绑定到某 Agent 的自动化工具上下文（会话内 automation.* 工具用）。 */
function automationToolContextFor(agentId: string): AutomationToolContext {
  const storePath = () => automationStorePath(agentId);
  return {
    addTask: (input: AutomationCreateInput) => {
      const raw = {
        name: input.name,
        schedule: { cron: input.cron, ...(input.timezone ? { timezone: input.timezone } : {}) },
        prompt: input.prompt,
        agentId,
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.model ? { model: input.model } : {}),
        accessMode: input.accessMode ?? "full",
        ...(input.skillName ? { skillName: input.skillName } : {}),
        ...(input.subagentName ? { subagentName: input.subagentName } : {}),
        enabled: true,
        createdAt: Date.now()
      };
      const task = normalizeAutomation(raw);
      if (!task) throw new Error("任务字段校验失败");
      const tasks = upsertAutomation(storePath(), task);
      afterAutomationChange(agentId);
      return { task, tasks };
    },
    listTasks: () => readAllAutomations(getAgentDir()),
    removeTask: (id) => {
      const all = readAllAutomations(getAgentDir());
      const task = all.find((candidate) => candidate.id === id);
      if (!task) return all;
      deleteAutomation(automationStorePath(task.agentId), id);
      afterAutomationChange(task.agentId);
      return readAllAutomations(getAgentDir());
    },
    setTaskEnabled: (id, enabled) => {
      const all = readAllAutomations(getAgentDir());
      const task = all.find((candidate) => candidate.id === id);
      if (!task) return all;
      toggleAutomation(automationStorePath(task.agentId), id, enabled);
      afterAutomationChange(task.agentId);
      return readAllAutomations(getAgentDir());
    },
    runTaskNow: async (id) => {
      const task = readAllAutomations(getAgentDir()).find((candidate) => candidate.id === id);
      if (!task) return { ok: false, message: `未找到任务 ${id}` };
      try {
        await runAutomationTask(task, "manual");
        return { ok: true, message: `已触发任务 ${id} 运行（结果见侧边栏对应会话）。` };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    modelAvailable: (provider, id) => Boolean(modelRuntime && modelRuntime.getModel(provider, id) && isModelEnabled(provider, id, settings?.providers))
  };
}

/** Session-scoped todo file: `<agentDir>/chatanytime-sessions/<agentId>/todos/<sessionId>.json`. */
function sessionTodosPath(sessionId: string): string {
  const root = agentSessionRoot();
  if (!root) throw new Error("当前没有可用的 Agent，无法定位任务存储");
  return join(root, "todos", `${sessionId}.json`);
}

function sessionPlansPath(agentId: string, sessionId: string): string {
  return join(getAgentDir(), "chatanytime-sessions", agentId, "plans", `${sessionId}.json`);
}

/** 会话级设计模式状态：`<agentDir>/chatanytime-sessions/<agentId>/design-mode/<sessionId>.json`。 */
function sessionDesignModePath(agentId: string, sessionId: string): string {
  return join(getAgentDir(), "chatanytime-sessions", agentId, "design-mode", `${sessionId}.json`);
}

/** 会话级电脑控制模式状态：`<agentDir>/chatanytime-sessions/<agentId>/computer-mode/<sessionId>.json`。 */
function sessionComputerModePath(agentId: string, sessionId: string): string {
  return join(getAgentDir(), "chatanytime-sessions", agentId, "computer-mode", `${sessionId}.json`);
}

/**
 * 切换会话的电脑控制模式：更新 record 状态 → 原子写盘（会话级，重开后恢复）→
 * 重算活动工具集（computer_* 注入/移除）→ 广播快照（渲染端据此置亮顶栏按钮）。
 *
 * 与 setDesignMode 同款纪律：状态未变时幂等早退（同一开关重复到达不白做一次
 * 前缀重算）；写盘 best-effort，失败不影响内存状态。
 */
function setComputerMode(record: SessionRuntimeRecord, enabled: boolean): void {
  if (record.computerMode.enabled === enabled) return;
  record.computerMode = { enabled };
  try {
    writeComputerMode(sessionComputerModePath(record.agent.id, record.session.sessionId), enabled);
  } catch (error) {
    void post({ type: "log", level: "warn", message: `保存电脑控制模式状态失败：${errorText(error)}` });
  }
  reconcileActiveTools(record);
  if (record === activeRuntime) emitState();
  else emitPaneStateFor(record);
}

/**
 * 切换会话的设计模式：更新 record 状态 → 原子写盘（会话级，重开后恢复）→
 * 重算活动工具集（design_* 注入/移除）→ 广播快照（渲染端据此开关画布）。
 *
 * 前缀缓存代价：本次切换使该会话的请求前缀变一次（缓存键失配重算），之后整个
 * 设计会话字节稳定——用户不会在同一会话里反复开关，这正是本设计的成立前提。
 * 状态未变时直接早退（幂等）：同一开关重复到达不会白做一次前缀重算。
 *
 * 写盘是 best-effort，失败不影响内存状态。
 */
function setDesignMode(record: SessionRuntimeRecord, enabled: boolean): void {
  if (record.designMode.enabled === enabled) return;
  record.designMode = { enabled };
  try {
    writeDesignMode(sessionDesignModePath(record.agent.id, record.session.sessionId), enabled);
  } catch (error) {
    void post({ type: "log", level: "warn", message: `保存设计模式状态失败：${errorText(error)}` });
  }
  // 活动集变化：工具清单与系统提示的工具段同步重算。
  reconcileActiveTools(record);
  if (record === activeRuntime) emitState();
  else emitPaneStateFor(record);
}

/**
 * 切换会话的计划模式：更新 record 状态（进入时挂上完整叙事待注入）、原子写盘
 * （会话级，重开后恢复）并广播快照。写入失败不影响内存状态（best-effort）。
 * 路径按 record.agent 计算——后台 parked 会话切换时全局 currentAgent 可能已
 * 指向别的助手，不能用全局算存储目录。
 */
function setPlanMode(record: SessionRuntimeRecord, enabled: boolean): void {
  record.planState = { enabled, narrate: enabled ? "full" : undefined };
  try {
    writePlanMode(sessionPlansPath(record.agent.id, record.session.sessionId), enabled);
  } catch (error) {
    void post({ type: "log", level: "warn", message: `保存计划模式状态失败：${errorText(error)}` });
  }
  if (record === activeRuntime) emitState();
  else emitPaneStateFor(record);
}

/** Build the Todo customTools for a session-scoped store + pace tracker. */
function buildTodoTools(store: TodoStore, pace: runtimeTodoTools.TodoPaceTracker): ToolDefinition[] {
  return runtimeTodoTools.buildTodoTools({ store, pace });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 推送当前设计文档全量状态（渲染端画布数据源；revision 单调递增由调用方保证）。
 *  只画激活会话的画布：携带 sessionId，渲染端丢弃非激活会话的推送。 */
function postDesignState(record: SessionRuntimeRecord, doc: DesignDoc): void {
  post({ type: "design.state", sessionId: record.session.sessionId, revision: doc.revision, docId: doc.id, name: doc.name, canvas: doc.canvas, nodes: doc.nodes, dirty: false });
}

/** 推送「会话未绑定文档」的空状态（design.query 未绑定 / design.close 后），渲染端据此清空画布。 */
function postEmptyDesignState(record: SessionRuntimeRecord): void {
  post({ type: "design.state", sessionId: record.session.sessionId, revision: 0 });
}

/** 快照的上下文占用：Pi 官方估算 + record 上的会话累计缓存命中率 + 三段明细。 */
function snapshotContextUsage(record: SessionRuntimeRecord | undefined): ContextUsage | undefined {
  if (!record) return undefined;
  const base = record.session.getContextUsage();
  if (!base) return undefined;
  return { ...base, cacheHitRate: runtimeContextUsage.cacheHitRateFrom(record.cacheUsage), ...(record.contextBreakdown ? { breakdown: record.contextBreakdown } : {}) };
}

/** 快照的性能统计：时间/轮步来自事件累计，token 计数合入 cacheUsage（单一账本）；流式期间附带实时读数。 */
function snapshotSpeedStats(record: SessionRuntimeRecord | undefined): SpeedStats | undefined {
  if (!record) return undefined;
  return {
    ...record.speedStats,
    promptTokens: record.cacheUsage.promptTokens,
    outputTokens: record.cacheUsage.outputTokens,
    ...(record.speedLive ? { live: record.speedLive } : {})
  };
}

/**
 * 重算上下文三段明细。消息段是 O(transcript) 的估算，只在稳定边界调用
 * （消息完成、压缩、切模型、活动工具集变化），流式期间沿用上一帧——dsh
 * 的环在采样间隙同样不动。工具段按活动集缓存，避免每次 stringify 全部 schema。
 */
function refreshContextBreakdown(record: SessionRuntimeRecord): void {
  const session = record.session;
  const names = session.getActiveToolNames();
  const key = names.join(",");
  if (record.toolTokensCache?.key !== key) {
    const active = new Set(names);
    const tokens = contextBreakdown.estimateToolTokens(session.getAllTools().filter((tool) => active.has(tool.name)));
    record.toolTokensCache = { key, tokens };
  }
  record.contextBreakdown = contextBreakdown.estimateContextBreakdown({
    systemPrompt: session.systemPrompt,
    toolTokens: record.toolTokensCache.tokens,
    messages: session.state.messages
  });
}

function runtimeSkillPrompt(name: string, instructions?: string, record: SessionRuntimeRecord | undefined = activeRuntime): string {
  return runtimeSkills.buildRuntimeSkillPrompt(discoveredSkills, name, instructions, record?.session.getActiveToolNames().includes("read") ?? false);
}

/** 自定义命令发送时展开（重读模板文件，热更新无需重载资源）。 */
function runtimeCommandPrompt(name: string, args?: string): string {
  return commandCatalog.buildRuntimeCommandPrompt(discoveredCommands, name, args);
}

/**
 * 斜杠调用 prompt：invocations 决定展开什么，text 是共享的用户要求/命令参数。
 * 单调用沿用既有 skill/command 展开与 marker（字节与历史版本一致）；≥两个调用
 * 各自取一段正文（不含共享文本）合并，共享文本只在末尾出现一次。
 */
function runtimeInvocationPrompt(invocations: readonly SlashInvocation[], text: string | undefined, record: SessionRuntimeRecord | undefined = activeRuntime): string {
  const shared = text?.trim() ?? "";
  const single = invocations.length === 1 ? invocations[0] : undefined;
  if (single) {
    return single.kind === "skill" ? runtimeSkillPrompt(single.name, shared, record) : runtimeCommandPrompt(single.name, shared);
  }
  const hasReadTool = record?.session.getActiveToolNames().includes("read") ?? false;
  const segments: InvocationSegment[] = invocations.map((item) => {
    if (item.kind === "skill") {
      const resolved = runtimeSkills.buildRuntimeSkillBody(discoveredSkills, item.name, undefined, hasReadTool);
      return { kind: item.kind, name: resolved.name, body: resolved.body };
    }
    return { kind: item.kind, name: item.name, body: commandCatalog.expandRuntimeCommand(discoveredCommands, item.name, undefined) };
  });
  return buildMultiInvocationPrompt(invocations, shared, composeInvocationBody(segments, shared));
}

/**
 * 分屏目标解析：带 sessionId 的命令定位到对应 live record（parked 亦可），
 * 缺省为激活会话。目标不在运行中（被回收/删除）时抛错——渲染端格子随会话
 * 列表修剪，正常流程不会命中。
 */
function resolveTargetRecord(sessionId: string | undefined): SessionRuntimeRecord {
  if (!sessionId) {
    if (!activeRuntime) throw new Error("请先打开工作区，再发送消息");
    return activeRuntime;
  }
  const record = liveSessions.get(sessionId);
  if (!record) throw new Error("该会话不在运行中（可能已被回收），请重新打开");
  return record;
}

/**
 * 传输层 tool 输出字符上限：渲染端只做截断展示（20K/60K 两档），超长输出
 * 不必整份过 IPC——record.executions 保留原文（主进程还要从输出解析产物路径），
 * 仅在构建快照时截断。
 */
const MAX_TRANSFERRED_OUTPUT_CHARS = 60_000;

function truncateTransferredOutput(output: string | undefined): string | undefined {
  if (output === undefined || output.length <= MAX_TRANSFERRED_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_TRANSFERRED_OUTPUT_CHARS)}\n…（输出过长，已截断显示）`;
}

/** 会话级字段构建（snapshot 与分屏 session.state 共用）：全部来自该 record。 */
function paneSnapshotFrom(record: SessionRuntimeRecord): SessionPaneSnapshot {
  const session = record.session;
  const sessionMessages = normalizeMessages(session.state.messages, session.state.streamingMessage);
  const messages = [...sessionMessages, ...(record.controlMessages ?? [])].sort((left, right) => left.timestamp - right.timestamp);
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionManager.getSessionFile(),
    workspace: record.workspace,
    model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
    thinkingLevel: session.thinkingLevel,
    busy: record.busy,
    status: record.status,
    turnTiming: record.turnTiming,
    // 待发送队列实时读取 Pi 会话的 steering/followUp 状态（图片镜像随之按
    // 队列当前长度对齐截断，多出的头部 = 已注入回合的项）；queue_update 事件
    // 走 default 分支立即 flush，渲染端随 emit 同步。
    queuedMessages: queueSnapshotMessages(alignQueueState(
      session.getSteeringMessages(),
      session.getFollowUpMessages(),
      record
    )),
    contextUsage: snapshotContextUsage(record),
    speedStats: snapshotSpeedStats(record),
    planMode: record.planState.enabled,
    computerMode: record.computerMode.enabled,
    designMode: record.designMode.enabled,
    messages,
    executions: [...record.executions.values()].map((execution) => {
      const output = truncateTransferredOutput(execution.output);
      return output === execution.output ? execution : { ...execution, output };
    })
  };
}

function snapshot(): RuntimeSnapshot {
  const record = activeRuntime;
  const pane = record ? paneSnapshotFrom(record) : undefined;
  return {
    workspace: record?.workspace ?? workspace,
    gitBranch,
    agentId: currentAgent?.id ?? "default",
    agentName: currentAgent?.name ?? "默认助手",
    sessionId: pane?.sessionId,
    sessionFile: pane?.sessionFile,
    model: pane?.model ?? selectedModel,
    thinkingLevel: pane?.thinkingLevel ?? thinkingLevel,
    busy: (record?.busy ?? false) || transitionStatus !== undefined,
    status: transitionStatus ?? record?.status ?? status,
    turnTiming: pane?.turnTiming,
    queuedMessages: pane?.queuedMessages ?? [],
    contextUsage: pane?.contextUsage,
    speedStats: pane?.speedStats,
    // 计划模式/电脑控制模式/设计模式都是会话级协作状态（与访问模式独立）：快照只反映激活会话。
    planMode: pane?.planMode ?? false,
    computerMode: pane?.computerMode ?? false,
    designMode: pane?.designMode ?? false,
    messages: pane?.messages ?? [],
    executions: pane?.executions ?? [],
    backgroundProcesses: backgroundProcesses.list(),
    sessions: currentSessions,
    recentWorkspaces
  };
}

/**
 * 推送一个分屏格子（watched 非激活会话）的会话级快照。immediate 生命周期转换
 * 立即 flush，流式 token 批量按 100ms（10fps）合帧（宽于激活会话的 50ms）；
 * 定时器挂在 record 上，各格子互不影响。激活或未 watch 的记录是 no-op
 * （激活会话走 state 通道）。
 */
function schedulePaneEmit(record: SessionRuntimeRecord, immediate: boolean): void {
  if (record === activeRuntime || !renderedSessions.has(record.session.sessionId) || hiddenPaneSessions.has(record.session.sessionId)) return;
  if (immediate) {
    if (record.paneFlushTimer) {
      clearTimeout(record.paneFlushTimer);
      record.paneFlushTimer = undefined;
    }
    post({ type: "session.state", snapshot: paneSnapshotFrom(record) });
    return;
  }
  if (record.paneFlushTimer) return;
  record.paneFlushTimer = setTimeout(() => {
    record.paneFlushTimer = undefined;
    post({ type: "session.state", snapshot: paneSnapshotFrom(record) });
  }, PANE_STREAM_FLUSH_INTERVAL_MS);
}

/**
 * 命令直接改动某 record 后：parked 且 watched 时把该格快照推给渲染端。
 * 激活会话由调用点已有的 emitState() 覆盖（此处 no-op），未 watch 的
 * parked 会话无处渲染（同样 no-op）。
 */
function emitPaneStateFor(record: SessionRuntimeRecord): void {
  schedulePaneEmit(record, true);
}

/** Overlay a session's run status onto the sidebar list. */
function patchSessionRunStatus(record: SessionRuntimeRecord): void {
  currentSessions = currentSessions.map((item) => item.id === record.session.sessionId ? { ...item, runStatus: record.runStatus } : item);
}

/**
 * 新会话（新建话题、删除当前会话后自动补的空白会话）创建后立即合并进侧边栏
 * 列表，无需等全量 refreshSessions 的磁盘扫描：左侧第一时间出现该话题，发送
 * 消息时 runStatus "running" 也能经 patchSessionRunStatus 即时打上「执行中」
 * 圆点。列表作用域不是当前 Agent 时跳过（该场景由 sessionListReadyFor=false
 * 触发重拉建表）；已在列表中的会话保持不动，精确信息仍由 refreshSessions 校正。
 */
function ensureSessionInList(record: SessionRuntimeRecord): void {
  if (currentSessionsAgentId !== record.agent.id) return;
  const manager = record.session.sessionManager;
  // A freshly created session always carries a file; guard the optional for safety.
  const path = manager.getSessionFile();
  if (!path) return;
  const incoming: SessionSummary = {
    id: manager.getSessionId(),
    path,
    workspace: record.workspace,
    title: "新会话",
    modifiedAt: Date.now(),
    messageCount: 0
  };
  const alreadyListed = currentSessions.some((item) => resolve(item.path).toLowerCase() === resolve(incoming.path).toLowerCase());
  if (!alreadyListed) currentSessions = mergeSessionSummary(currentSessions, incoming);
}

/**
 * Resolve a session's dot to a terminal outcome. Terminal dots (green/red) are
 * unread notifications about a turn the user hasn't seen: they only stay on
 * parked sessions, and clear as soon as the session is activated. The active
 * session's outcome is already visible in the conversation, so it gets none.
 */
function setTerminalRunStatus(record: SessionRuntimeRecord, outcome: TerminalRunStatus): void {
  // 分屏中被 watch 的会话与激活会话同待遇：结果直接可见，不设终端圆点。
  const visible = record === activeRuntime || renderedSessions.has(record.session.sessionId);
  record.runStatus = visible ? undefined : outcome;
  patchSessionRunStatus(record);
}

let sessionsRefreshTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced session-list refresh so finished turns update title/order promptly. */
function scheduleSessionsRefresh(): void {
  if (sessionsRefreshTimer) return;
  sessionsRefreshTimer = setTimeout(() => {
    sessionsRefreshTimer = undefined;
    void refreshSessions().then(() => emitState()).catch((error) => {
      post({ type: "log", level: "warn", message: `刷新会话列表失败：${errorText(error)}` });
    });
  }, 500);
}

function disposeRecord(record: SessionRuntimeRecord, options: { keepBrowserTab?: boolean } = {}): void {
  record.unsubscribe();
  try {
    record.session.dispose();
  } catch {
    // dispose is best-effort; the record is dropped regardless
  }
  permissionBroker.reset(record.session.sessionId);
  questionBroker.reset(record.session.sessionId);
  liveSessions.delete(record.session.sessionId);
  renderedSessions.delete(record.session.sessionId);
  pendingWatchSessions.delete(record.session.sessionId);
  hiddenPaneSessions.delete(record.session.sessionId);
  if (record.paneFlushTimer) {
    clearTimeout(record.paneFlushTimer);
    record.paneFlushTimer = undefined;
  }
  record.extensionApi = undefined;
  if (activeRuntime === record) {
    activeRuntime = undefined;
    todoStore = undefined;
    todos = [];
    memoryStore = undefined;
    memoryTopics = [];
    refreshGitBranch();
  }
  // 会话真正消亡时释放其绑定的浏览器自动化标签页（main 侧只关 pi-browser-*
  // 自动化建的标签，用户自有标签不动）；同 id 重建豁免——新记录继承绑定，
  // 关掉会把页面状态丢掉。驻留（parked）会话不经此路径，标签按设计保留。
  if (!options.keepBrowserTab) {
    post({ type: "browser-automation.session-disposed", sessionKey: record.session.sessionId });
  }
}

/** Keep the parked-session set bounded; running and split-rendered sessions are never evicted. */
function evictParkedSessions(): void {
  const parked = [...liveSessions.values()]
    .filter((record) => record !== activeRuntime && !record.busy && !renderedSessions.has(record.session.sessionId))
    .sort((left, right) => right.activatedAt - left.activatedAt);
  for (const record of parked.slice(MAX_PARKED_SESSIONS)) disposeRecord(record);
  pruneVanishedSessionRows();
}

/**
 * 清掉侧边栏里已经没有归宿的「合成空话题」行（只改内存列表，不重扫磁盘）。
 *
 * 未落盘的空话题行完全由 live 记录合成，不写任何持久状态；记录被闲置驱逐后它就
 * 成了死行（文件从未存在，点击必然失败），而下一次全量刷新不一定来——刷新由回合
 * 结束防抖、pin/rename/delete 等驱动，连开一串空话题时一次都不会触发，那几条死行
 * 就会一直留在侧栏（2026-09-16 用户报告的「点了报错」）。列表重建本身会自然丢掉
 * 它们（磁盘 listAll 里没有），但驱逐发生的那一刻必须主动清一次。
 */
function pruneVanishedSessionRows(): void {
  currentSessions = pruneVanishedSessions(
    currentSessions,
    [...liveSessions.values()].map((record) => record.session.sessionManager.getSessionFile()),
    (path) => existsSync(path)
  );
}

// Workspace whose MCP tool cache was last synced; activation only re-syncs
// when the active workspace changes (createSession keeps it fresh otherwise).
let mcpSyncedWorkspace: string | undefined;

/**
 * Make an existing live record the one shown in the renderer. Global mirrors
 * (workspace/model/todos) follow the record; parked sessions keep running
 * untouched. Bumping sessionGeneration invalidates any createSession pipeline
 * still in flight so it cannot steal the active slot on completion.
 */
function activate(record: SessionRuntimeRecord): void {
  const previous = activeRuntime;
  sessionGeneration++;
  activeRuntime = record;
  record.activatedAt = Date.now();
  // Entering the session marks its terminal outcome as seen — drop the
  // green/red dot. A running session keeps its yellow dot (live state).
  if (record.runStatus !== undefined && record.runStatus !== "running") {
    record.runStatus = undefined;
    patchSessionRunStatus(record);
  }
  // 焦点跨工作区切换：记入该助手最后工作区（同工作区切换幂等跳过，避免重复 touch 落盘）。
  if (workspace !== record.workspace) rememberWorkspace(record.workspace);
  workspace = record.workspace;
  thinkingLevel = record.session.thinkingLevel;
  selectedModel = record.session.model ? { provider: record.session.model.provider, id: record.session.model.id } : undefined;
  todoStore = record.todoStore;
  todos = record.todoStore.list();
  emitTodos();
  memoryStore = record.memoryStore;
  memoryTopics = record.memoryStore.list();
  emitMemory();
  syncSkills();
  syncCommands();
  emitResourceCatalog();
  evictParkedSessions();
  // Re-sync the MCP tool cache when the active workspace changed so later
  // hot-reload operations target the right servers. Parked sessions keep the
  // tools captured at their creation.
  if (mcpSyncedWorkspace !== record.workspace) {
    mcpSyncedWorkspace = record.workspace;
    void syncMcpServers().then(() => emitResourceCatalog()).catch((error) => {
      post({ type: "log", level: "warn", message: `同步 MCP 服务器失败：${errorText(error)}` });
    });
  }
  refreshGitBranch();
  // 焦点从格子 A 切到 B：A 变回 parked，此后的更新只走 session.state 通道。
  // 立即推一帧，否则渲染端在 A 的下一个事件到来之前拿不到 paneStates[A]。
  if (previous && previous !== record && renderedSessions.has(previous.session.sessionId)) {
    post({ type: "session.state", snapshot: paneSnapshotFrom(previous) });
  }
}

function workspaceSessionDir(): string | undefined {
  if (!workspace || !currentAgent) return undefined;
  return agentWorkspaceSessionDir(getAgentDir(), currentAgent.id, workspace);
}

function recentWorkspacesPath(): string {
  return join(getAgentDir(), "pidesktop-recent-workspaces.json");
}

// —— 作品（Gallery）：清单在全局 agentDir，跨工作区共用一份池子 ——

function galleryFilePath(): string {
  return galleryPathFor(getAgentDir());
}

function galleryThumbsPath(): string {
  return galleryThumbsDirFor(getAgentDir());
}

/** 全量推送作品清单（发布/删除/更新/记录运行/启动时）。 */
function emitGallery(): void {
  post({ type: "gallery.apps", apps: galleryApps });
}

/**
 * 发布/更新一个作品。draft.path 是工作区相对路径或绝对路径；入口一律归一到
 * 工作区相对路径存清单（相对路径才能跨机器/跨盘符稳定重定位）。
 *
 * 缩略图是增益不是必要条件：失败只回一句降级说明，发布本身照常成功
 * （同 design_export 的“截图失败不得让导出失败”）。
 */
async function publishGalleryApp(draft: GalleryDraft, workspaceRoot: string | undefined): Promise<{ app: GalleryApp; thumbNote: string }> {
  const root = (draft.workspace ?? workspaceRoot ?? "").trim() || workspace;
  if (!root) throw new Error("请先打开一个工作区，再发布作品");
  const absolute = isAbsolute(draft.path) ? resolve(draft.path) : resolve(root, draft.path);
  // 入口必须落在工作区内：越界路径既不可运行（静态服务只服务工作区），
  // 也会把清单变成指向外部目录的跳板。
  const within = pathIsWithin(root, absolute);
  if (!within) throw new Error("作品入口必须位于当前工作区内");
  const entry = normalizeGalleryEntry(isAbsolute(draft.path) ? (relativePath(root, absolute) || ".") : draft.path);

  const app: GalleryApp = {
    id: "",
    title: draft.title,
    kind: draft.kind,
    workspace: resolve(root),
    entry,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  if (draft.description) app.description = draft.description;
  if (draft.kind === "server" && draft.command) app.command = draft.command;
  if (draft.kind === "server" && draft.url) app.url = draft.url;
  if (draft.tags && draft.tags.length > 0) app.tags = draft.tags;

  const upserted = upsertGalleryApp(galleryApps, app);
  galleryApps = upserted.list;

  let thumbNote = "";
  if (galleryThumbEligible({ kind: upserted.app.kind, entry: upserted.app.entry })) {
    const target = galleryAbsolutePath(upserted.app.workspace, upserted.app.entry);
    const fileName = galleryThumbName();
    try {
      const shot = await requestDesignSnapshot({
        htmlPath: target,
        contentWidth: upserted.app.kind === "file" ? 1440 : 1440,
        contentHeight: 900,
        workspace: upserted.app.workspace,
        thumbDir: galleryThumbsPath(),
        thumbPrefix: "gallery",
        // 作品页可能有外链资源，给比 design 导出更宽的预算。
        loadTimeoutMs: 20_000
      });
      if (shot.ok) {
        const bytes = Buffer.from(shot.data, "base64");
        writeGalleryThumb(galleryThumbsPath(), fileName, bytes);
        const withThumb = upsertGalleryApp(galleryApps, { ...upserted.app, thumb: fileName }).list;
        galleryApps = withThumb;
      } else {
        thumbNote = `（缩略图未生成：${shot.error}）`;
      }
    } catch (error) {
      thumbNote = `（缩略图未生成：${errorText(error)}）`;
    }
  }

  galleryApps = persistGallery(galleryFilePath(), galleryApps, galleryThumbsPath());
  emitGallery();
  const published = galleryApps.find((candidate) => candidate.id === upserted.app.id) ?? upserted.app;
  return { app: published, thumbNote };
}

/**
 * 默认工作区路径解析 + 目录确保（内置目录首次落位 mkdir 幂等，不覆盖已有内容）；
 * 失败返回 undefined，调用方据此走 landing 极端兜底（保留现有 landing 代码路径）。
 */
function agentDefaultWorkspace(): string | undefined {
  if (!settings) return undefined;
  try {
    return ensureDefaultWorkspaceDir(getAgentDir(), settings.defaultWorkspace);
  } catch {
    return undefined;
  }
}

/**
 * 把某工作区记为该助手最后使用（内存 agentWorkspaces map + 全局 recents）。
 * 赋值点：workspace.open / session.new / session.open / automation.run.open 直达，
 * activate（分屏聚焦其他工作区格子 = 该助手最后使用的工作区）跨工作区时记入。
 * 主进程 updateSettings 走同一组纯函数持久化（双写对称）；此处只更新 utility 内存镜像。
 */
function rememberWorkspace(path: string): void {
  if (!settings) return;
  settings.agentWorkspaces = recordAgentWorkspace(settings.agentWorkspaces, settings.currentAgentId, path);
  touchRecentWorkspace(path);
}

/** Record a workspace as recently opened and persist the list. */
function touchRecentWorkspace(path: string): void {
  recentWorkspaces = recordRecentWorkspace(recentWorkspaces, path);
  writeRecentWorkspaces(recentWorkspacesPath(), recentWorkspaces);
}

function agentSessionRoot(): string | undefined {
  if (!currentAgent) return undefined;
  return join(getAgentDir(), "chatanytime-sessions", currentAgent.id);
}

function pathIsWithin(root: string, target: string): boolean {
  const relation = relativePath(resolve(root), resolve(target));
  return Boolean(relation) && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

/** 存在性判据（fs.stat，出错一律当不存在）：识别未落盘的会话文件。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve browser_upload file arguments to absolute paths inside the record workspace. */
function resolveWorkspaceUploadFiles(recordWorkspace: string, files: string[]): string[] {
  return files.map((file) => {
    if (isAbsolute(file)) throw new Error(`browser_upload 只接受工作区相对路径：${file}`);
    const target = resolve(recordWorkspace, file);
    if (!pathIsWithin(recordWorkspace, target)) throw new Error(`上传文件必须位于当前工作区内：${file}`);
    return target;
  });
}

async function sessionDirectories(): Promise<string[]> {
  const root = agentSessionRoot();
  if (!root) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    // 排除 delegations 子目录：子会话以 goal 文本为标题混进侧边栏话题列表是噪声
    // （checkpoints/*.jsonl 已被 buildSessionInfo 的首行校验自然过滤，无需处理）。
    return [root, ...entries.filter((entry) => entry.isDirectory() && entry.name !== "delegations").map((entry) => join(root, entry.name))];
  } catch {
    return [root];
  }
}

/**
 * 在会话目录集合里按 sessionId 定位会话文件。
 * 文件名优先（零读盘）：Pi 的 SessionManager 以 `<ISO 时间戳>_<sessionId>.jsonl`
 * 落盘（见 sessionFileMatchesId 注释），故**不能**按 `<sessionId>.jsonl` 拼路径。
 * 命中后仍用首行头部校验一次：会话目录里还躺着 `checkpoints/<sessionId>.jsonl`
 * 这类同名文件（应用自有存储），头部 `type` 不是 `session` 就不会被当成会话。
 * 文件名没命中时退回首行 id 全扫（权威身份，与侧边栏列表同源），
 * 这样 Pi 改命名规则也不会让运行记录回看失效。
 */
async function findSessionFileById(directories: readonly string[], sessionId: string): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const directory of directories) {
    try {
      for (const name of await readdir(directory)) {
        if (name.toLowerCase().endsWith(".jsonl")) candidates.push(join(directory, name));
      }
    } catch {
      // 目录不存在/不可读：跳过，由调用方兜底提示
    }
  }
  const byName = candidates.find((candidate) => sessionFileMatchesId(basename(candidate), sessionId));
  if (byName && readSessionHeaderId(byName) === sessionId) return byName;
  return candidates.find((candidate) => readSessionHeaderId(candidate) === sessionId);
}

/** 读会话文件首行的头部 id（有界读 8KB，不扫整文件）；非会话文件/损坏返回 undefined。 */
function readSessionHeaderId(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(8192);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function activeAgent(): AgentProfile {
  const list = settings?.agents ?? [];
  return list.find((agent) => agent.id === settings?.currentAgentId && !agent.archived) ?? list.find((agent) => agent.id === "default") ?? list[0] ?? { id: "default", name: "默认助手", description: "", systemPrompt: "", divMode: "off", defaultThinkingLevel: "medium", tools: defaultTools() };
}

function defaultModel(): { provider: string; id: string } | undefined {
  return currentAgent?.defaultModel ?? settings?.model;
}

/**
 * 应用侧默认（助手 defaultModel → 全局 settings.model）之后的第三来源：Pi 自己
 * 持久化的默认模型（agentDir settings.json）。我们每次 switchSessionModel 都会
 * 经 Pi 的 setModel 把当前模型写进去，等于「最近一次使用的模型」——新会话在
 * 未设默认的助手下沿用它，是 Pi findInitialModel 的既有行为，这里只是把解析
 * 挪到应用侧以便套覆盖。
 */
function piPersistedDefaultModel(manager: SettingsManager): { provider: string; id: string } | undefined {
  const provider = manager.getDefaultProvider();
  const modelId = manager.getDefaultModel();
  return provider && modelId ? { provider, id: modelId } : undefined;
}

function hasImageInput(model: { provider?: string; id?: string; input?: readonly string[] } | undefined): boolean {
  // 设置里手动标记的图片输入覆盖目录元数据（内置服务商拉取的新模型没有输入类型信息）。
  const override = imageInputOverride(model ?? {}, settings?.providers);
  return override ?? Boolean(model?.input?.includes("image"));
}

/**
 * 某个会话当前模型真实可用的思考等级。Pi 的 getAvailableThinkingLevels 已经做了
 * 这一步，但它读的是**会话里那个模型对象**；模型切换/叠加用户声明后可能滞后，
 * 所以对当前会话模型再跑一次共享纯函数（两者口径逐行对齐，见 shared/thinking-levels）。
 * 无模型时返回全档（无能力信息可判定，不偷藏档位）。
 */
function availableThinkingLevels(record: { session: AgentSession }): ThinkingLevel[] {
  const model = record.session.model as Model<Api> | undefined;
  if (!model) return [...THINKING_LEVELS];
  // 先叠设置里的声明再算能力：会话模型本身可能还是不带声明的旧对象（声明只在
  // 「下一个模型对象」上生效），而请求前 streamSimple 那层会叠——这里必须同源，
  // 否则菜单说「很高」可用、会话层却按未声明把请求钳回 high，又是「点了没反应」。
  const effective = applyModelOverrides(model) as { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap };
  return supportedThinkingLevels(effective.thinkingLevelMap, effective.reasoning);
}

/**
 * 把设置里的 per-model 覆盖（含思考等级声明）落到**会话里那个模型对象**上。
 *
 * 为什么必须做：Pi 的 `setThinkingLevel` / `getAvailableThinkingLevels` 直接读
 * `model.thinkingLevelMap`，而声明只在使用**下一个模型对象**时才生效——用户在设置页
 * 刚声明「支持很高」后，会话模型仍是不带声明的旧对象，`setThinkingLevel("xhigh")`
 * 照样被钳回 high（用户看到的就是「声明了还是切不过去」）。这里做纯元数据纠偏，
 * 与 createSession 的兜底纠偏同一姿势：不走 setModel（那会追加 model_change 条目、
 * 重写 Pi 默认），直接替换 state.model 引用；只在真有覆盖时替换。
 */
function syncSessionModelMetadata(record: SessionRuntimeRecord): void {
  const current = record.session.model as Model<Api> | undefined;
  if (!current) return;
  const corrected = applyModelOverrides(current);
  if (corrected !== current) record.session.agent.state.model = corrected;
}

/**
 * 声明刚落盘后补一次落值：用当前档位在**新能力**下重新钳制，避免「声明了很高但
 * 档位还停在 high」。`setThinkingLevel` 自带 clamp，这里只是把起点交给它。
 */
function applyDeclaredThinkingLevel(record: SessionRuntimeRecord | undefined, model: Model<Api>): void {
  if (!record) return;
  const target = applyModelOverrides(model) as { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap };
  const desired = clampThinkingLevel(supportedThinkingLevels(target.thinkingLevelMap, target.reasoning), record.session.thinkingLevel);
  if (desired !== record.session.thinkingLevel) record.session.setThinkingLevel(desired);
}

/**
 * Apply per-model overrides stored in settings.providers onto the catalog
 * Model — token limits plus the imageInput mark landing on Model.input (why:
 * see model-catalog.applyModelOverrides). Rides every model→session handoff;
 * returns a shallow clone when an override hits — never mutate the shared
 * runtime objects.
 */
function applyModelOverrides<T extends Model<Api>>(model: T): T {
  return applyStoredModelOverrides(model, settings?.providers);
}

/**
 * 图片预算门（413 防护）在请求咽喉处的单例。
 *
 * 压缩器是进程级单例，它的 LRU 缓存跨会话生效：同一张截图被多个会话/多个
 * 请求重发时只压一次。日志只在真实发生裁剪时打（含前后体积与压缩/省略张数），
 * 是这条链路上唯一的可见性来源。
 */
const imageBudgetGate = createImageBudgetGate({
  downsample: createImageDownsampler(),
  warn: (message) => void post({ type: "log", level: "warn", message }),
  log: (message) => void post({ type: "log", level: "info", message })
});

/**
 * Transport guard enforcing the vision invariant at the single choke point
 * every LLM request passes (main sessions and subagents share this runtime): a
 * model without image input never receives image parts. Attached images stay
 * in the session transcript — the renderer shows them in the user's bubble,
 * the JSONL persists them, reopen/regenerate replay them — and the trailing
 * hint tells the model to call recognize_images instead. completeSimple
 * bypasses the guard on purpose: the only caller is the recognize_images tool,
 * whose vision model takes images.
 *
 * Multimodal models get the second guard on the same choke point: an image
 * byte budget (see request-image-budget.ts). Real 413 payload_too_large
 * failures showed history images accumulating to 6.5–7.9MB base64 within
 * minutes (mostly the model re-reading its own screenshots), while Pi's
 * built-in per-image cap (4.5MB) and token-based compaction can never see the
 * total. Budgeting runs in the async setup of lazyStream — the same shape Pi
 * uses internally — so the synchronous "return a stream" contract holds and a
 * budget failure only degrades to sending the original context.
 */
function wrapModelRuntimeForVision(runtime: ModelRuntime): ModelRuntime {
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "streamSimple") {
        // 每次请求前对模型套上 settings.providers 里的覆盖值（图片输入标记落到
        // model.input、token 限额同样生效），让 hasImageInput 与实际发给 Pi 的
        // 模型对象同源。否则会分叉：hasImageInput 逐请求读覆盖值（判定能收图
        // → 不剥离上下文），但传给 streamSimple 的还是未刷新的会话模型，Pi 的
        // transformMessages 按 model.input 判断又把图片降级成占位符——「图片输入
        // 勾选不生效」。applyModelOverrides 只在命中覆盖时返回浅克隆，绝不改动
        // 共享的会话模型对象。
        return (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => {
          const effectiveModel = applyModelOverrides(model);
          if (!hasImageInput(effectiveModel)) return target.streamSimple(effectiveModel, runtimeVision.stripContextImages(context), options);
          return budgetedStreamSimple((effective, ctx, opts) => target.streamSimple(effective, ctx, opts), imageBudgetGate)(effectiveModel, context, options);
        };
      }
      if (property === "completeSimple") {
        // 视觉兜底模型同样套覆盖：识别工具的模型可能被用户在目录里手动标记了
        // 「支持图片输入」（目录元数据滞后），否则 completeSimple 按未刷新的
        // model.input 又把图片降级，视觉识别拿不到图。
        return (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) =>
          target.completeSimple(applyModelOverrides(model), context, options);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
}

/**
 * Rebuild the full registered customTool set for a record (MCP + app-owned).
 * customTools arrays are held by reference inside Pi, so hot-path updates
 * rebuild in place (`length = 0` + push) instead of swapping the array.
 */
function buildRecordTools(record: Pick<SessionRuntimeRecord, "subagentTools" | "todoTools" | "memoryTools" | "questionTools" | "planTools" | "visionTools" | "browserTools" | "sshTools" | "computerTools" | "automationTools" | "designTools" | "galleryTools" | "jevTools">): ToolDefinition[] {
  return [...mcpTools, ...record.subagentTools, ...record.todoTools, ...record.memoryTools, ...record.questionTools, ...record.planTools, ...record.visionTools, ...record.browserTools, ...record.sshTools, ...record.computerTools, ...record.automationTools, ...record.designTools, ...record.galleryTools, ...record.jevTools];
}

/**
 * Active tool names for a record. Vision tools are registered for every
 * session (byte-stable definition) but active only for text-only conversation
 * models — multimodal models see the same tool set as before, so the request
 * prefix stays stable within each session/model configuration (cache discipline).
 *
 * Design tools are the same discipline with a different trigger: their 8
 * definitions cost ≈1.5K tokens, so they are active only for sessions that
 * opted into design mode (record.designMode + the global master switch). The
 * design flag is fixed per session, so the prefix stays byte-stable for the
 * whole design session; a plain coding chat never pays for the canvas.
 *
 * Computer tools (5 definitions, ≈580 tokens measured) follow the design
 * discipline: a desktop-driving capability nobody asked for in a
 * coding/document chat is pure prefix waste, and its global switch is a
 * capability toggle (下架), not a per-call gate. Browser/SSH families use the
 * same capability-toggle semantics (master switch AND agent-level overlay).
 */
function toolNamesFor(record: Pick<SessionRuntimeRecord, "agent" | "subagentTools" | "todoTools" | "memoryTools" | "questionTools" | "planTools" | "visionTools" | "browserTools" | "sshTools" | "computerTools" | "automationTools" | "designTools" | "galleryTools" | "jevTools" | "designMode" | "computerMode" | "designGlobalEnabled" | "computerGlobalEnabled" | "jevGlobalEnabled" | "unattended">, includeVision: boolean): string[] {
  const builtin = Object.entries(record.agent.tools ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
  // 浏览器/SSH 整族开关：全局总闸 AND 角色级 overlay（agent.toolOverrides），任一关闭
  // 即整族从活动集摘除（schema 不进请求前缀）；execute 内的 enabled 闭包仅作在途回合
  // 兑底。jev 工具叠加 browser 判据：它驱动的就是内置浏览器。
  const browserActive = runtimeBrowser.shouldActivateBrowserTools({ globalEnabled: settings?.browser?.enabled !== false, agentEnabled: record.agent.toolOverrides?.browser !== false });
  const sshActive = runtimeSsh.shouldActivateSshTools({ globalEnabled: settings?.ssh?.enabled !== false, agentEnabled: record.agent.toolOverrides?.ssh !== false });
  const disabledMcp = disabledMcpToolNamesFor(record);
  return [
    ...builtin,
    // 角色级 mcp:<server> overlay：被禁服务器的全部工具不进活动集（前缀省下整段 schema）。
    ...mcpTools.filter((tool) => !disabledMcp.has(tool.name)).map((tool) => tool.name),
    ...record.subagentTools.map((tool) => tool.name),
    ...record.todoTools.map((tool) => tool.name),
    ...record.memoryTools.map((tool) => tool.name),
    // 无人值守会话不暴露提问工具：ask_question 会走 questionBroker 挂起且不可见。
    ...(record.unattended ? [] : record.questionTools.map((tool) => tool.name)),
    ...record.planTools.map((tool) => tool.name),
    ...(includeVision ? record.visionTools.map((tool) => tool.name) : []),
    // 浏览器/SSH 整族按总闸+角色开关注入（见上方 browserActive/sshActive）；总闸翻转由
    // settings.save 遍历 liveSessions reconcile，角色开关随 agent.save 重建会话生效。
    ...(browserActive ? record.browserTools.map((tool) => tool.name) : []),
    ...(sshActive ? record.sshTools.map((tool) => tool.name) : []),
    // 电脑控制工具与 design 同策略：仅在本会话开了电脑控制模式且总闸开着时
    // 注入（五个定义实测 ≈580 tokens/请求）；无人值守后台会话天然不满足。
    ...(runtimeComputer.shouldActivateComputerTools({ sessionEnabled: record.computerMode.enabled, globalEnabled: record.computerGlobalEnabled() })
      ? record.computerTools.map((tool) => tool.name)
      : []),
    ...record.automationTools.map((tool) => tool.name),
    // 设计工具仅在设计模式会话里激活（≈1.5K tokens/请求的前缀成本）；总闸
    // settings.design.enabled 关闭时任何会话都不注入。会话内开关不变，因此
    // 前缀缓存整段有效（区别于 browser 的常驻激活策略）。
    ...(runtimeDesign.shouldActivateDesignTools({ sessionEnabled: record.designMode.enabled, globalEnabled: record.designGlobalEnabled() })
      ? record.designTools.map((tool) => tool.name)
      : []),
    // 作品发布工具只有一个且很轻（≈200 tokens/请求），因此**无条件激活**
    // （同 automation 策略）——它服务的是「做完就发布」这个随时可能发生的动作，
    // 做成开关只会让用户/模型多用一次才能找到它。
    ...record.galleryTools.map((tool) => tool.name),
    // Jev 工具同样按开关注入（而不是 browser 那种常驻激活）：它的描述与内部指令块
    // 远大于普通工具，而绝大多数部署（内网）根本连不到 TypeSafe——不该替它们付这份
    // 前缀成本。开关 = settings.jev.enabled（缺省关闭），会话内不变则前缀整段有效。
    ...(record.jevGlobalEnabled() && browserActive ? record.jevTools.map((tool) => tool.name) : [])
  ];
}

/**
 * 角色级 mcp:<server> overlay 展开成被禁工具名集合：键为配置原始服务器名，
 * 与 mcpServerToolNames（syncMcpServers 由 bindings 派生）同源匹配。服务器改名/
 * 删除后残留键无工具可匹配，自然无副作用。
 */
function disabledMcpToolNamesFor(record: Pick<SessionRuntimeRecord, "agent">): Set<string> {
  const overrides = record.agent.toolOverrides;
  if (!overrides) return new Set<string>();
  const disabled = new Set<string>();
  for (const [key, enabled] of Object.entries(overrides)) {
    if (enabled || !key.startsWith("mcp:")) continue;
    const names = mcpServerToolNames.get(key.slice("mcp:".length));
    if (names) for (const name of names) disabled.add(name);
  }
  return disabled;
}

/**
 * Append the model-directed hint to a prompt whose images the conversation
 * model cannot see. The images themselves stay in the payload: they live in
 * the session transcript (rendered in the user's bubble, persisted to the
 * JSONL) and are stripped per-request by the wrapped ModelRuntime, so they
 * never reach a text-only model. The dynamic image count lives in the
 * trailing user text (conversation tail), never in the tool schema or system
 * prompt — the provider prefix cache is untouched.
 */
function appendVisionHint(payload: { text: string; images: ImageContent[] }): void {
  payload.text += runtimeVision.visionHintText(payload.images.length);
}

/**
 * Re-align the live session's active tool set after a model switch: the
 * recognize_images tool is activated only when the conversation model cannot
 * take image input itself. Registered-but-inactive tools are never offered to
 * multimodal models, so their request prefix stays identical to the pre-tool
 * era.
 */
function reconcileVisionTool(record: SessionRuntimeRecord | undefined): void {
  if (!record || record.visionTools.length === 0) return;
  reconcileActiveTools(record);
}

/**
 * 重算会话的活动工具集（模型切换、设计模式切换、MCP 热更新共用）。活动集变化
 * 即请求前缀变化（缓存键失配自动重算），因此只在真实状态切换时调用——不要在
 * 每回合调用。
 */
function reconcileActiveTools(record: SessionRuntimeRecord): void {
  const includeVision = !hasImageInput(record.session.model);
  record.session.setActiveToolsByName(toolNamesFor(record, includeVision));
  // 活动集变化：上下文三段明细的工具段跟随（缓存键失配自动重算）。
  refreshContextBreakdown(record);
}

/**
 * Switch a live record's conversation model and re-align the active tool set.
 * Every setModel call site must go through here: a bare setModel keeps the
 * recognize_images activation computed for the previous model — e.g. a session
 * created under a multimodal model never offers the tool after switching to a
 * text-only one, so staged images could never be recognized.
 */
async function switchSessionModel(record: SessionRuntimeRecord | undefined, model: Model<Api>): Promise<void> {
  if (!record) return;
  // Token-limit overrides ride along on every model handoff to a session.
  await record.session.setModel(applyModelOverrides(model));
  reconcileVisionTool(record);
}

function emitState(): void {
  // Default callers (commands, lifecycle hooks) flush immediately.
  scheduleEmit(true);
}

/**
 * 异步刷新当前工作区的 git 分支。工作区在读取期间切换时丢弃过期结果
 * （分支属于工作区级别，跟随激活会话/全局 workspace，不做常驻监听）。
 */
function refreshGitBranch(): void {
  const target = activeRuntime?.workspace ?? workspace;
  if (!target) {
    gitBranch = undefined;
    return;
  }
  void readGitBranch(target)
    .then((branch) => {
      if ((activeRuntime?.workspace ?? workspace) !== target) return;
      if (gitBranch === branch) return;
      gitBranch = branch;
      emitState();
    })
    .catch(() => {
      // 读取失败按非 git 项目处理；只在工作区仍为当前目标时才落值。
      if ((activeRuntime?.workspace ?? workspace) !== target) return;
      if (gitBranch === undefined) return;
      gitBranch = undefined;
      emitState();
    });
}

function beginTurn(record: SessionRuntimeRecord): void {
  record.turnTiming = { startedAt: Date.now() };
  record.speedStats = speedStats.beginSpeedTurn(record.speedStats);
}

function markAnswerStarted(record: SessionRuntimeRecord): void {
  if (!record.turnTiming || record.turnTiming.answerStartedAt !== undefined) return;
  record.turnTiming = { ...record.turnTiming, answerStartedAt: Date.now() };
}

function completeTurn(record: SessionRuntimeRecord): void {
  if (!record.turnTiming || record.turnTiming.completedAt !== undefined) return;
  record.turnTiming = { ...record.turnTiming, completedAt: Date.now() };
}

// Permission gate wiring: one deps object per session record so background
// sessions gate tool calls against their own workspace/agent/session, never
// against whatever is currently active.
function permissionDepsFor(holder: { session: AgentSession | undefined }, recordWorkspace: string, recordAgent: AgentProfile, accessModeOverride?: () => AccessMode): runtimePermissions.PermissionGateDeps {
  return {
    broker: permissionBroker,
    workspace: () => recordWorkspace,
    // 后台自动化会话用任务级 accessMode（默认 full 自动放行，避免无人值守时遇权限确认挂死）；
    // 普通会话沿用全局 accessMode。
    accessMode: () => accessModeOverride?.() ?? accessMode,
    session: () => holder.session,
    agent: () => recordAgent
  };
}

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return result == null ? "" : String(result);
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result, null, 2);
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function patchFromToolResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const patch = (details as { patch?: unknown }).patch;
  return typeof patch === "string" ? patch : undefined;
}

/**
 * 从工具结果（partial/最终）的 details 提取 delegate_agent 进度快照；形状不符返回
 * undefined。两种形态都兼容：onUpdate 转发的 partial details 是嵌套的
 * `{ delegation }`，最终 toolResult 的 details 是顶层扁平展开的 DelegationProgress
 * （runDelegation 返回值，也是持久化进父会话 JSONL 的形态）。
 */
function delegationFromToolResult(result: unknown): DelegationProgress | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  if (isDelegationProgress(details)) return details;
  const delegation = (details as { delegation?: unknown }).delegation;
  return isDelegationProgress(delegation) ? delegation : undefined;
}

/**
 * Resolve the sidebar dot at the end of a run: aborted（用户中止）/ failed
 * （真实错误）/ completed。判定口径见 run-outcome.ts——中止不靠英文文案识别。
 * 激活会话不设终端圆点（见 setTerminalRunStatus）。
 */
function resolveRunOutcome(record: SessionRuntimeRecord, messages: readonly AgentMessage[]): void {
  const outcome = resolveRunOutcomeStatus(record.abortRequested, messages);
  record.abortRequested = false;
  setTerminalRunStatus(record, outcome);
}

function handleSessionEvent(record: SessionRuntimeRecord, event: AgentSessionEvent): void {
  // Pure streaming accumulation can safely batch at 20fps; everything that
  // changes busy/status/executions must flush immediately so the UI never
  // lags on lifecycle transitions.
  let immediate = true;
  // Lifecycle transitions (busy/runStatus) must also reach the renderer when
  // they happen on a parked background session — they drive the sidebar dot.
  let lifecycle = false;
  switch (event.type) {
    case "agent_start":
      record.busy = true;
      record.status = "Pi 正在工作";
      record.abortRequested = false;
      record.runStatus = "running";
      // 新回合开始：若计划模式仍开启且无待注入叙事，安排一段短提醒（完整
      // 指引只在进入时注入一次；regenerate/截断重放不携带注入，需重新提示）。
      if (record.planState.enabled && record.planState.narrate === undefined) {
        record.planState = { ...record.planState, narrate: "reminder" };
      }
      lifecycle = true;
      break;
    case "agent_end":
      if (event.willRetry) {
        record.busy = true;
        record.status = "正在重试";
      } else {
        completeTurn(record);
        record.busy = false;
        record.status = "就绪";
        resolveRunOutcome(record, event.messages);
        // Idempotent backstop: regenerate/navigateTree truncates the transcript,
        // so re-derive the counters from what actually remains.
        record.cacheUsage = runtimeContextUsage.scanCacheUsage(record.session.state.messages);
        record.speedStats = speedStats.syncSpeedCounters(record.speedStats, record.session.state.messages);
        record.speedStep = undefined;
        record.speedLive = undefined;
        lifecycle = true;
      }
      break;
    case "agent_settled":
      record.busy = false;
      record.status = "就绪";
      // Settlement without a preceding agent_end (e.g. an aborted run) still
      // needs the dot resolved; late settlements after agent_end are no-ops.
      if (record.runStatus === "running") {
        resolveRunOutcome(record, record.session.state.messages);
        record.cacheUsage = runtimeContextUsage.scanCacheUsage(record.session.state.messages);
        record.speedStats = speedStats.syncSpeedCounters(record.speedStats, record.session.state.messages);
        record.speedStep = undefined;
        record.speedLive = undefined;
        lifecycle = true;
      }
      break;
    case "turn_start":
      // 一次模型调用周期开始（步起点 ≈ 请求发出）：开新打点，覆盖残留的旧步。
      record.speedStep = { startedAt: Date.now() };
      record.speedLive = { startedAt: record.speedStep.startedAt, tokens: 0 };
      break;
    case "turn_end":
      // 步收尾兜底：message_end 已收步，这里只清可能的残留（无消息完成的周期）。
      record.speedStep = undefined;
      record.speedLive = undefined;
      break;
    case "message_start":
      if (event.message.role === "assistant") {
        markAnswerStarted(record);
        const firstTokenAt = Date.now();
        if (record.speedStep && record.speedStep.firstTokenAt === undefined) {
          record.speedStep = { ...record.speedStep, firstTokenAt };
        }
        if (record.speedLive && record.speedLive.firstTokenAt === undefined) {
          record.speedLive = { ...record.speedLive, firstTokenAt };
        }
      }
      break;
    case "message_update":
      // Token-batch partial; high frequency — throttle. 实时速度读数随节流帧
      // 刷新（当前步部分消息的本地 token 估算，收步后被 usage 口径接管）。
      if (event.message.role === "assistant" && record.speedLive?.firstTokenAt !== undefined) {
        record.speedLive = { ...record.speedLive, tokens: estimateTokens(event.message) };
      }
      immediate = false;
      break;
    case "message_end":
      // Final frame carries the completed message; flush immediately so the
      // streaming flag clears without a 50ms gap. Accumulate its usage into
      // the session-wide cache counters.
      record.cacheUsage = runtimeContextUsage.addMessageToCacheUsage(record.cacheUsage, event.message);
      if (event.message.role === "assistant" && record.speedStep) {
        const usage = runtimeContextUsage.validAssistantUsage(event.message);
        record.speedStats = speedStats.closeSpeedStep(record.speedStats, record.speedStep, Date.now(), usage ? { output: usage.output } : undefined);
        record.speedStep = undefined;
        record.speedLive = undefined;
      }
      // 消息落定 = 上下文构成变化的稳定边界（assistant 步 / 工具结果 / 排队
      // 注入），重算三段明细；流式期间沿用上一帧。
      refreshContextBreakdown(record);
      // 会话文件直到第一条 assistant 消息完成才落盘（SDK hasAssistant 门槛），
      // 侧栏标题（firstMessage）随之才可读。此前只在 agent_end 等生命周期事件
      // 才重扫列表，新会话要等整个回合结束才从「新会话」变成真实标题；这里在
      // 每条 assistant 消息完成时立即调度（500ms 防抖合并），让名字在首条回复
      // 完成时就出现，无需等回合收官。
      if (event.message.role === "assistant") scheduleSessionsRefresh();
      break;
    case "tool_execution_start":
      record.executions.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: "running",
        startedAt: Date.now(),
        changedFile: changedWorkspaceFile(record.workspace, event.toolName, event.args),
        changedFiles: changedWorkspaceFiles(record.workspace, event.toolName, event.args)
      });
      record.status = `正在${toolLabel(event.toolName)}`;
      break;
    case "tool_execution_update": {
      // Partial tool output; high frequency — throttle.
      const current = record.executions.get(event.toolCallId);
      if (current) {
        current.output = textFromToolResult(event.partialResult);
        const delegation = delegationFromToolResult(event.partialResult);
        if (delegation) {
          current.delegation = delegation;
          // 状态栏同步最后一步（事件本就经 50ms 节流推送）。
          const lastStep = delegation.steps.at(-1);
          record.status = lastStep ? `子代理·${lastStep.label}` : "子代理·正在启动";
        }
      }
      immediate = false;
      break;
    }
    case "tool_execution_end": {
      const current = record.executions.get(event.toolCallId);
      const output = textFromToolResult(event.result);
      const completedAt = Date.now();
      const startedAt = current?.startedAt ?? completedAt;
      // 中止保持：session.abort 已把运行中的执行标为 aborted，但 Pi 随后的
      // tool_execution_end（被 kill 的工具返回错误结果）不能把它改回「失败」。
      // 只认 execution 自身的标记，不用 record.abortRequested 兜底——后者会
      // 误标中止前已正常完成、但 end 事件延迟到达的其它工具。
      const aborted = current?.status === "aborted";
      // 工具耗时累计（dsh 口径：单次调用 end − start；与 LLM 耗时互斥配对）。
      record.speedStats = speedStats.addSpeedToolMs(record.speedStats, completedAt - startedAt);
      const changedFiles = current?.changedFiles
        ?? (current?.changedFile
          ? [current.changedFile]
          : changedWorkspaceFiles(record.workspace, event.toolName, current?.args));
      const delegation = delegationFromToolResult(event.result) ?? current?.delegation;
      record.executions.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: current?.args ?? {},
        startedAt,
        completedAt,
        status: aborted ? "aborted" : event.isError ? "error" : "completed",
        output,
        patch: patchFromToolResult(event.result),
        changedFile: current?.changedFile ?? changedWorkspaceFile(record.workspace, event.toolName, current?.args),
        changedFiles,
        ...(delegation ? { delegation } : {})
      });
      // 产出型工具（bash 落盘、MCP 生图、扩展工具等）可能生成工作区文件：
      // bash 优先从命令参数（-o/重定向/cp/mv）解析显式输出路径，再补扫描结果
      // 文本中的路径；输出扫描候选经 mtime 门槛（本次执行窗口内写出的才算）+
      // 异步 stat 存在性校验后回填。
      if (!event.isError && current && record.workspace && isArtifactProducingTool(event.toolName)) {
        void collectProducedArtifacts(record.workspace, event.toolName, current.args, output, current.startedAt)
          .then((artifacts) => applyArtifactBackfill(record, event.toolCallId, artifacts));
      }
      // Bash commands with background patterns (`nohup ... &`, `( ... & )`)
      // leave detached descendants running after the shell exits. Scan for
      // survivors so the task panel can show and kill them.
      if (current?.name === "bash") {
        const command = (current.args as { command?: unknown } | undefined)?.command;
        if (typeof command === "string" && isBackgroundCommand(command)) {
          void backgroundProcesses.scanForCommand(command, current.startedAt);
        }
      }
      break;
    }
    case "compaction_start":
      record.status = "正在压缩上下文";
      break;
    case "compaction_end": {
      // 手动 /compact 的失败已由 runManualCompaction 的控制消息兜底；这里只暴露
      // 自动压缩（阈值触发/溢出恢复，0.84.4 起可发生在工具执行与下次请求之间）
      // 的失败——此前完全静默，用户只会看到上下文用量没有下降。中止（用户停止）
      // 不带 errorMessage，不会误报。
      const failureNotice = autoCompactionFailureNotice(event);
      if (failureNotice) {
        post({ type: "error", message: `话题「${record.session.sessionManager.getSessionName()}」${failureNotice}` });
      }
      // 压缩把消息替换为摘要：构成明细立即跟随缩小（占用总量要等下一次
      // usage 采样才更新，明细不受此限制）。
      refreshContextBreakdown(record);
      break;
    }
    case "auto_retry_start":
      record.status = `正在重试（${event.attempt}/${event.maxAttempts}）`;
      break;
    default:
      // Unknown event types also flush immediately to be safe.
      break;
  }
  if (record !== activeRuntime) {
    // Parked session: lifecycle changes drive the sidebar dot + list freshness;
    // streaming content is dropped unless the session is rendered in a split
    // pane (watched), which keeps streaming over its own session.state channel.
    if (lifecycle) {
      patchSessionRunStatus(record);
      emitState();
      scheduleSessionsRefresh();
    }
    if (renderedSessions.has(record.session.sessionId)) schedulePaneEmit(record, immediate);
    return;
  }
  if (lifecycle) scheduleSessionsRefresh();
  scheduleEmit(immediate);
}

/** 把存在性校验通过的产物合并进执行记录并推送刷新（活动会话全量推，分屏格走 pane 通道）。 */
function applyArtifactBackfill(record: SessionRuntimeRecord, executionId: string, artifacts: { relativePath: string }[]): void {
  if (artifacts.length === 0) return;
  const execution = record.executions.get(executionId);
  if (!execution || execution.status !== "completed") return;
  const merged = new Map<string, { relativePath: string }>();
  for (const item of [...(execution.changedFiles ?? []), ...(execution.changedFile ? [execution.changedFile] : []), ...artifacts]) {
    merged.set(item.relativePath.toLowerCase(), item);
  }
  execution.changedFiles = [...merged.values()];
  if (record === activeRuntime) {
    emitState();
  } else if (renderedSessions.has(record.session.sessionId)) {
    schedulePaneEmit(record, true);
  }
}

/**
 * 历史会话恢复时重建的执行记录只带 edit/write 的 changedFile：bash/MCP 产出型
 * 工具的交付产物（技能脚本生成的 png/pdf 等）在此异步回填——扫描持久化的输出
 * 文本 + mtime 门槛（文件修改时间须落在该次执行窗口内）+ 存在性校验。只看最近
 * 一段产出型执行，防止超长会话拖慢打开。
 */
function backfillRestoredArtifacts(record: SessionRuntimeRecord): void {
  const workspace = record.workspace;
  if (!workspace) return;
  const producing = [...record.executions.values()]
    .filter((execution) => execution.status === "completed" && isArtifactProducingTool(execution.name))
    .slice(-30);
  for (const execution of producing) {
    void collectProducedArtifacts(workspace, execution.name, execution.args, execution.output, execution.startedAt)
      .then((artifacts) => applyArtifactBackfill(record, execution.id, artifacts));
  }
}

function appendCompactControlMessage(record: SessionRuntimeRecord, kind: "compact-command" | "compact-result", text: string): void {
  const entryId = record.session.sessionManager.appendCustomEntry(PI_DESKTOP_CONTROL_ENTRY_TYPE, { kind, text });
  const entry = record.session.sessionManager.getEntry(entryId);
  if (!entry || entry.type !== "custom") return;
  record.controlMessages = [...record.controlMessages, ...restoreControlMessages([entry as unknown as PersistedSessionEntry])];
}

/** 服务商是否有已配置鉴权（会话模型回退用，口径同 provider.delete 旧实现）。 */
function providerConfigured(providerId: string): boolean {
  return Boolean(modelRuntime?.getProviderAuthStatus(providerId)?.configured);
}

async function refreshCatalog(): Promise<void> {
  const runtime = modelRuntime;
  if (!runtime) return;
  let available = runtime.getAvailableSnapshot();
  try {
    available = await runtime.getAvailable();
  } catch (error) {
    post({ type: "log", level: "warn", message: `检查模型可用性失败：${errorText(error)}` });
  }
  const providerAuth = new Map(runtime.getProviders().map((provider) => [
    provider.id,
    runtime.getProviderAuthStatus(provider.id)
  ] as const));
  const configured = new Set(available
    .filter((model) => isDesktopConfiguredProvider(providerAuth.get(model.provider)))
    .map((model) => model.provider));
  const providers: ProviderOption[] = runtime.getProviders().map((provider) => {
    const auth = providerAuth.get(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      configured: isDesktopConfiguredProvider(auth),
      authSource: auth?.source,
      // 手动添加模型只对 PiDesktop 直连管理覆盖层的内置渠道开放（radius 等
      // 远程目录渠道的覆盖键归 SDK 管，写入会破坏其刷新门控）。
      ...(provider.id in BUILTIN_MODELS_ENDPOINTS ? { manualModels: true } : {})
    };
  });
  if (!providers.some((provider) => provider.id === customProviderId)) {
    providers.push({ id: customProviderId, name: settings?.providers.find((item) => item.id === customProviderId)?.name ?? "自定义 OpenAI 兼容服务", configured: false, manualModels: true });
  }
  const models: ModelOption[] = buildCatalogModels(runtime.getModels(), settings?.providers, configured);
  post({ type: "catalog", models, providers });
}

function registerCustomProvider(config: ProviderSettings): void {
  const registration = resolveCustomProviderRegistration(config);
  // null = built-in visibility marker entry (`custom: false`): the catalog
  // already defines the provider, and built-in overrides (baseUrl/api) ride
  // the models-store overlay via syncBuiltinProviderOverlays.
  if (!registration) return;
  modelRuntime?.registerProvider(config.id, {
    name: registration.name,
    baseUrl: registration.baseUrl,
    // 服务商级 API 模式（响应式调用 /v1/responses 等）：缺省按 OpenAI 兼容
    // chat/completions 解析，保持无配置时的历史行为。
    api: registration.api ?? "openai-completions",
    models: registration.models
  });
}

/**
 * 把设置里内置服务商（custom: false）的接口地址/API 模式覆盖同步进
 * models-store 覆盖层（~/.pi/agent/models-store.json）。
 *
 * 为什么走覆盖层而非 registerProvider：applyExtension 的 models 数组是整体
 * 替换语义，对内置服务商传部分模型会丢掉目录其余模型；覆盖层模型带完整元数据，
 * 只改 api/baseUrl 不丢失流式所需字段（refreshBuiltinModelsFallback 同通道）。
 *
 * 只处理 BUILTIN_MODELS_ENDPOINTS 中 PiDesktop 直连管理的内置渠道：这些键由
 * refreshBuiltinModelsFallback / 本函数写入，可安全删写；远程目录渠道（radius）
 * 的键由 SDK 管理，不在设置覆盖能力范围内。规则：有覆盖的条目写 entry，无覆盖
 * （或条目已删）的条目删除残留键还原目录；不产生任何变更时不写文件。
 */
async function syncBuiltinProviderOverlays(): Promise<void> {
  const runtime = modelRuntime;
  if (!runtime || !settings) return;
  const storePath = join(getAgentDir(), "models-store.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as unknown;
    // 畸形内容（数组/标量）按空对象处理，避免属性写入异常；不抛错放行后续覆盖。
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    } else if (parsed !== undefined && parsed !== null) {
      post({ type: "log", level: "warn", message: "models-store.json 内容异常（非对象），已忽略旧覆盖层" });
    }
  } catch {
    // 文件不存在或损坏：从空对象开始（与 writeRemoteCatalogOverlay 同口径）。
  }
  let changed = false;
  for (const providerId of Object.keys(BUILTIN_MODELS_ENDPOINTS)) {
    const entry = settings.providers.find((provider) => provider.id === providerId && provider.custom === false);
    const existing = current[providerId] as { _overlaySource?: "settings" | "pull" } | undefined;
    const action = resolveBuiltinOverlayAction(entry, runtime.getModels(providerId), existing?._overlaySource);
    if (!action) continue;
    if (action === "drop") {
      // 该覆盖层是设置覆盖残留：用户已清空接口地址/API 覆盖，删键还原目录
      // （拉取目录与 SDK 远程目录不带 settings 标记，不会被误删——审查 P1-1）。
      delete current[providerId];
      changed = true;
      continue;
    }
    current[providerId] = {
      models: action.models,
      checkedAt: Date.now(),
      // 时间戳取当前时间，保证 SDK 的 lastModified 门控（> 本地目录生成时间）放行。
      lastModified: Date.now(),
      etag: undefined,
      _overlaySource: action.source
    };
    changed = true;
  }
  if (!changed) return;
  await writeFile(storePath, JSON.stringify(current, null, 2), "utf8");
  // 重新加载覆盖层（allowNetwork:false 只应用已持久化的目录，不再访问网络）。
  await runtime.refresh({ allowNetwork: false, force: true });
  await refreshCatalog();
}

async function fetchCustomProviderModels(baseUrlInput: string, apiKey: string): Promise<ProviderModelSettings[]> {
  const baseUrl = baseUrlInput.trim().replace(/\/+$/u, "");
  if (!baseUrl || !apiKey.trim()) throw new Error("拉取模型需要填写接口地址和 API Key");
  try {
    new URL(baseUrl);
  } catch {
    throw new Error("接口地址必须是有效的 URL，例如 https://api.example.com/v1");
  }
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey.trim()}` }
  });
  if (!response.ok) throw new Error(`拉取模型失败：上游返回 HTTP ${response.status}`);
  const payload = await response.json() as { data?: unknown } | unknown[];
  const items = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(items)) throw new Error("拉取模型失败：返回内容不是模型列表");
  const models = items
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as { id?: unknown; name?: unknown };
      if (typeof record.id !== "string" || !record.id.trim()) return undefined;
      const id = record.id.trim();
      const lower = id.toLowerCase();
      return { id, name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id, imageInput: inferCustomModelImageInput(lower) } satisfies ProviderModelSettings;
    })
    .filter(Boolean) as ProviderModelSettings[];
  if (!models.length) throw new Error("拉取模型失败：上游没有返回可用模型");
  return [...new Map(models.map((model) => [model.id, model])).values()].sort((left, right) => left!.id.localeCompare(right!.id));
}

/** 内置服务商模型列表直连接口（pi.dev 远程目录不可达时的兜底）。 */
interface BuiltinModelsEndpoint {
  url: string;
  /** 认证方式：Bearer 头 / x-api-key 头 / URL query 参数 / 无需认证。 */
  auth: "bearer" | "x-api-key" | "query" | "none";
  keyParam?: string;
  headers?: Record<string, string>;
}

const BUILTIN_MODELS_ENDPOINTS: Readonly<Record<string, BuiltinModelsEndpoint>> = {
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer" },
  anthropic: { url: "https://api.anthropic.com/v1/models", auth: "x-api-key", headers: { "anthropic-version": "2023-06-01" } },
  deepseek: { url: "https://api.deepseek.com/models", auth: "bearer" },
  moonshotai: { url: "https://api.moonshot.ai/v1/models", auth: "bearer" },
  "moonshotai-cn": { url: "https://api.moonshot.cn/v1/models", auth: "bearer" },
  groq: { url: "https://api.groq.com/openai/v1/models", auth: "bearer" },
  mistral: { url: "https://api.mistral.ai/v1/models", auth: "bearer" },
  xai: { url: "https://api.x.ai/v1/models", auth: "bearer" },
  nvidia: { url: "https://integrate.api.nvidia.com/v1/models", auth: "bearer" },
  together: { url: "https://api.together.ai/v1/models", auth: "bearer" },
  cerebras: { url: "https://api.cerebras.ai/v1/models", auth: "bearer" },
  fireworks: { url: "https://api.fireworks.ai/inference/v1/models", auth: "bearer" },
  huggingface: { url: "https://router.huggingface.co/v1/models", auth: "bearer" },
  "qwen-token-plan": { url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models", auth: "bearer" },
  "qwen-token-plan-cn": { url: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models", auth: "bearer" },
  xiaomi: { url: "https://api.xiaomimimo.com/v1/models", auth: "bearer" },
  "xiaomi-token-plan-cn": { url: "https://token-plan-cn.xiaomimimo.com/v1/models", auth: "bearer" },
  "xiaomi-token-plan-ams": { url: "https://token-plan-ams.xiaomimimo.com/v1/models", auth: "bearer" },
  "xiaomi-token-plan-sgp": { url: "https://token-plan-sgp.xiaomimimo.com/v1/models", auth: "bearer" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models", auth: "query", keyParam: "key" },
  openrouter: { url: "https://openrouter.ai/api/v1/models", auth: "none" },
  // —— 以下为 SDK 内置静态模型表渠道：官方均提供 OpenAI 兼容 /models 列表接口，
  // 点“拉取最新模型”只能通过这里直连获取最新目录 ——
  "opencode-go": { url: "https://opencode.ai/zen/go/v1/models", auth: "none" },
  opencode: { url: "https://opencode.ai/zen/v1/models", auth: "none" },
  "zai-coding-cn": { url: "https://open.bigmodel.cn/api/coding/paas/v4/models", auth: "bearer" },
  minimax: { url: "https://api.minimax.io/v1/models", auth: "bearer" },
  "minimax-cn": { url: "https://api.minimaxi.com/v1/models", auth: "bearer" }
};

/** 解析服务商已保存/环境提供的 API Key（供直连拉取使用）。 */
async function resolveProviderApiKey(runtime: ModelRuntime, providerId: string): Promise<string> {
  try {
    const auth = await runtime.getAuth(providerId);
    const key = (auth?.auth as { apiKey?: unknown } | undefined)?.apiKey;
    return typeof key === "string" && key.trim() ? key.trim() : "";
  } catch {
    return "";
  }
}

/** 直连内置服务商的模型列表接口（15 秒超时），返回 id/name。 */
async function fetchBuiltinProviderModels(providerId: string, apiKey: string): Promise<{ id: string; name: string }[]> {
  const endpoint = BUILTIN_MODELS_ENDPOINTS[providerId];
  if (!endpoint) throw new Error(`暂不支持直连拉取 ${providerId} 的模型列表`);
  const url = new URL(endpoint.url);
  const headers: Record<string, string> = { Accept: "application/json", ...endpoint.headers };
  switch (endpoint.auth) {
    case "bearer":
      if (!apiKey) throw new Error("需要 API 密钥才能拉取模型列表");
      headers.Authorization = `Bearer ${apiKey}`;
      break;
    case "x-api-key":
      if (!apiKey) throw new Error("需要 API 密钥才能拉取模型列表");
      headers["x-api-key"] = apiKey;
      break;
    case "query":
      if (!apiKey) throw new Error("需要 API 密钥才能拉取模型列表");
      url.searchParams.set(endpoint.keyParam ?? "key", apiKey);
      break;
    case "none":
      break;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`服务商模型接口返回 HTTP ${response.status}`);
    const payload = await response.json() as { data?: unknown; models?: unknown } | unknown[];
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : Array.isArray((payload as { models?: unknown }).models)
          ? (payload as { models: unknown[] }).models
          : undefined;
    if (!items) throw new Error("服务商返回内容不是模型列表");
    const models = items
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const record = item as { id?: unknown; name?: unknown; display_name?: unknown; displayName?: unknown };
        let id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
        if (!id) {
          // Google 的列表项 name 形如 "models/gemini-2.5-pro"。
          const name = typeof record.name === "string" ? record.name : "";
          if (name.startsWith("models/")) id = name.slice("models/".length);
        }
        if (!id) return undefined;
        const display = record.display_name ?? record.displayName ?? record.name;
        return { id, name: typeof display === "string" && display.trim() ? display.trim() : id };
      })
      .filter((model): model is { id: string; name: string } => Boolean(model));
    if (!models.length) throw new Error("服务商没有返回可用模型");
    return [...new Map(models.map((model) => [model.id, model])).values()].sort((left, right) => left!.id.localeCompare(right!.id));
  } finally {
    clearTimeout(timer);
  }
}

/** 把直连拉取的模型写入 SDK 的 models-store 覆盖层（与远程目录同格式）。 */
async function writeRemoteCatalogOverlay(providerId: string, models: unknown[]): Promise<void> {
  const storePath = join(getAgentDir(), "models-store.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>;
  } catch {
    // 文件不存在或损坏：从空对象开始。
  }
  current[providerId] = {
    models,
    checkedAt: Date.now(),
    // 时间戳取当前时间，保证 SDK 的 lastModified 门控（> 本地目录生成时间）放行。
    lastModified: Date.now(),
    etag: undefined,
    // 来源标记（拉取目录）：syncBuiltinProviderOverlays 据此区分设置覆盖残留，
    // 无覆盖时不会误删本次拉取结果（审查 P1-1）。
    _overlaySource: "pull"
  };
  await writeFile(storePath, JSON.stringify(current, null, 2), "utf8");
}

/** 兜底：pi.dev 远程目录不可用时，直连服务商接口并注入 SDK 目录覆盖层。 */
async function refreshBuiltinModelsFallback(providerId: string): Promise<void> {
  const runtime = modelRuntime;
  if (!runtime) return;
  try {
    const apiKey = await resolveProviderApiKey(runtime, providerId);
    const fetched = await fetchBuiltinProviderModels(providerId, apiKey);
    const baseline = runtime.getModels(providerId);
    const baselineById = new Map(baseline.map((model) => [model.id, model]));
    const template = baseline[0];
    // 已知模型保留本地完整元数据（api/baseUrl/价格/输入类型等），新模型克隆
    // 模板元数据，只覆盖 id/name，避免覆盖层丢失流式所需字段。注意不覆盖
    // 已知模型的显示名——不少官方 /models 列表项只有 id 没有 name（如
    // opencode/minimax），若强行覆盖会把内置的 “MiniMax-M3” 退化成
    // “minimax-m3”。
    const overlay = fetched.map((model) => {
      const base = baselineById.get(model.id);
      if (base) return base;
      if (template) return { ...template, id: model.id, name: model.name };
      return { id: model.id, name: model.name, provider: providerId };
    });
    await writeRemoteCatalogOverlay(providerId, overlay);
    // 重新加载覆盖层（allowNetwork:false 只应用已持久化的目录，不再访问网络）。
    await runtime.refresh({ allowNetwork: false, force: true });
    // 拉取后重新叠加设置里的接口地址/API 模式覆盖（拉取结果保留，覆盖只改字段）。
    await syncBuiltinProviderOverlays();
    post({ type: "models-refreshed", providerId });
  } catch (error) {
    post({ type: "models-refresh-error", providerId, message: `拉取模型列表失败：${errorText(error)}` });
  }
}

async function refreshSessions(): Promise<void> {
  // Stamp the scope the listing actually runs against: currentAgent can change
  // while the awaits below run (agent switch mid-refresh).
  const listAgentId = currentAgent?.id;
  const previousSessions = currentSessions;
  const directories = await sessionDirectories();
  if (directories.length === 0) {
    currentSessions = [];
    currentSessionsAgentId = listAgentId;
    return;
  }

  const lists = await Promise.all(directories.map((directory) => SessionManager.listAll(directory)));
  const items = [...new Map(lists.flat().map((item) => [resolve(item.path).toLowerCase(), item])).values()];
  const pinnedPaths = settings?.pinnedSessionPaths ?? [];
  currentSessions = sortSessionSummaries(items.map((item) => {
    // Live sessions carry their execution state (sidebar dot) across refreshes.
    const runStatus = liveSessions.get(item.id)?.runStatus;
    return {
      id: item.id,
      path: item.path,
      workspace: item.cwd || "未知工作区",
      title: item.name || item.firstMessage || "新会话",
      modifiedAt: item.modified.getTime(),
      messageCount: item.messageCount,
      pinned: isSessionPinned(pinnedPaths, item.path) || undefined,
      ...(runStatus ? { runStatus } : {})
    };
  }));
  currentSessionsAgentId = listAgentId;
  // 会话文件直到首条 assistant 消息才落盘（Pi _persist 的 hasAssistant 门槛），
  // 新建的空会话只存在于 liveSessions——防抖刷新/后台回合结束触发的全量重建若
  // 不回填，会把刚建的新话题从侧边栏抹掉（见 backfillUnpersistedSessions）。
  currentSessions = backfillUnpersistedSessions(
    currentSessions,
    previousSessions,
    [...liveSessions.values()].map((record) => ({
      sessionId: record.session.sessionId,
      path: record.session.sessionManager.getSessionFile(),
      workspace: record.workspace,
      agentId: record.agent.id,
      activatedAt: record.activatedAt,
      title: record.session.sessionManager.getSessionName(),
      runStatus: record.runStatus
    })),
    listAgentId
  );
  // 注意：这里不需要 pruneVanishedSessions——列表刚由磁盘 listAll 重建，无文件且无 live
  // 伪死行根本进不了入参；真正需要清的时刻是「记录被驱逐而列表没重建」（见
  // pruneVanishedSessionRows）。
}

function sessionReadyStatus(hasModel: boolean, usedFallback: boolean): string {
  if (usedFallback) return "已自动切换到可用模型";
  if (hasModel) return "就绪";
  return "请先配置模型";
}

/**
 * Build a session and make it the active one. The previously active session is
 * parked, not disposed: it keeps running in the background and can be
 * reactivated later. When the resolved session is already live:
 * - implicit resolution (continueRecent, i.e. no explicit sessionManager) with
 *   `reactivate: true` reactivates the existing record instead of double-
 *   opening the JSONL — this is what lets a parked/running session survive an
 *   agent switch away and back, or a workspace reopen;
 * - otherwise (explicit sessionManager, or agent.save's config-apply rebuild)
 *   the record is rebuilt over the same history.
 */
async function createSession(sessionManager?: SessionManager, options: { reactivate?: boolean; skipActivate?: boolean; modelOverride?: { provider: string; id: string }; accessModeOverride?: AccessMode; unattended?: boolean; noGenerationGuard?: boolean; agentOverride?: AgentProfile; inheritDesignMode?: boolean; inheritComputerMode?: boolean } = {}): Promise<void> {
  if (!workspace || !modelRuntime) return;
  // 工作区可能已切换（workspace.open / session.*）：先重读双作用域钩子配置。
  refreshHooksConfig();
  // 工作区切换会改变项目级子智能体定义，一并重读。
  refreshSubagents();
  // noGenerationGuard（后台自动化会话）：不参与全局代际竞争，避免与用户
  // 的新建/切会话管线互相作废（reviewer P1-2）；它捕获自己的 record 上下文。
  const generation = options.noGenerationGuard ? sessionGeneration : ++sessionGeneration;
  // Drop any pending throttled emit so a stale streaming flush from the
  // previous session cannot fire against the freshly reset state below.
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer);
    pendingFlushTimer = undefined;
    hasPendingFlush = false;
  }

  const recordWorkspace = workspace;
  // agentOverride（跨角色自动化会话）：record 全链路按任务归属角色构建——系统提示、
  // 记忆库、技能开关、审计/checkpoint 目录、会话目录全部跟随任务 agent，而非当前激活角色。
  const recordAgent = options.agentOverride ?? currentAgent;
  if (!recordAgent) return;
  const activeSessionManager = sessionManager ?? SessionManager.continueRecent(recordWorkspace, workspaceSessionDir());
  const existing = liveSessions.get(activeSessionManager.getSessionId());
  if (existing && !sessionManager && options.reactivate) {
    activate(existing);
    void refreshSessions().then(() => emitState()).catch((error) => {
      post({ type: "log", level: "warn", message: `刷新会话列表失败：${errorText(error)}` });
    });
    emitState();
    return;
  }
  if (existing) disposeRecord(existing, { keepBrowserTab: true });

  const settingsManager = SettingsManager.create(recordWorkspace, getAgentDir());
  // Pi's own discovery is fully disabled: no extensions, no skills, no themes,
  // no ambient context files. The app injects its own system prompt, skills,
  // AGENTS.md instructions, MCP/subagent/todo tools explicitly (built in later
  // phases). Only app-owned inline extensions remain: the permission hook and
  // the tool audit logger.
  const sessionHolder: { session: AgentSession | undefined } = { session: undefined };
  let recordBox: SessionRuntimeRecord | undefined;
  const permissionDeps = permissionDepsFor(sessionHolder, recordWorkspace, recordAgent, options.accessModeOverride ? () => options.accessModeOverride! : undefined);
  // 长期记忆：按助手划分、跨会话（pidesktop-memory/<agentId>/）。治理块与
  // 索引快照在此一次性冻结、整个会话字节不变（dsh 缓存纪律：系统提示词只含
  // 会话级常量，后续记忆变化全部经 memory_* 工具调用出现在对话尾部）。
  // enabled 开关从下一个会话起改变注入；工具 execute 则按实时开关判断。
  const recordMemoryStore = createMemoryStore(memoryDirFor(getAgentDir(), recordAgent.id), refreshMemory);
  const memoryPromptBlock = settings?.memory?.enabled === false
    ? undefined
    : [runtimeMemoryTools.buildMemorySystemPromptBlock(), runtimeMemoryTools.buildMemorySnapshotBlock(recordMemoryStore.indexMarkdown(recordWorkspace))].filter(Boolean).join("\n\n");
  const resourceLoader = new DefaultResourceLoader({
    cwd: recordWorkspace,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      runtimePermissions.createPermissionExtension(permissionDeps, (api) => {
        // Rebound on every session creation; the captured API drives the MCP
        // hot-reload path (registerTool rebuilds Pi's registry on a live session).
        if (recordBox) recordBox.extensionApi = api;
      }),
      // 用户钩子（第三内联扩展）：事件触发时读 hooksRules 缓存，配置增删改
      // 只需 refreshHooksConfig()，无需重建会话。命令是用户自写配置，等同
      // 终端输入，不经 agent 权限门；输出只走 stdin/通知/日志，不进提示词。
      runtimeHooks.createHooksExtension({
        rules: () => hooksRules,
        enabled: () => settings?.hooks?.enabled !== false,
        workspace: () => recordWorkspace,
        agentName: () => recordAgent.name,
        sessionId: () => sessionHolder.session?.sessionId ?? activeSessionManager.getSessionId(),
        sessionTitle: () => {
          const sessionId = sessionHolder.session?.sessionId ?? activeSessionManager.getSessionId();
          return currentSessions.find((item) => item.id === sessionId)?.title ?? sessionId;
        },
        // 通知免打扰：该会话当前是否正被渲染（激活或分屏格子）——可见时主
        // 进程在窗口聚焦的情况下抑制系统通知。
        isSessionRendered: (sessionId) => Boolean(sessionId && (sessionId === activeRuntime?.session.sessionId || renderedSessions.has(sessionId))),
        post
      }),
      // Tool executions land in chatanytime-sessions/<agentId>/tool-audit.jsonl
      // for post-hoc debugging; write failures never affect the turn. The start
      // hook also feeds the per-session todo pace tracker (anti-batching nudge).
      createToolAudit({
        // 按闭包 recordAgent 落位（跨角色后台会话不得随全局 currentAgent 写错目录；
        // 手动切角色后的 parked 会话同理）。
        auditDir: () => join(getAgentDir(), "chatanytime-sessions", recordAgent.id),
        sessionId: () => sessionHolder.session?.sessionId ?? activeSessionManager.getSessionId(),
        warn: (message) => void post({ type: "log", level: "warn", message }),
        onToolStart: () => recordBox?.todoPace.record()
      }).extension,
      // checkpoint 快照（第五个内联扩展）：write/edit 与 bash 显式输出路径动手前
      // 把目标文件「改之前」的内容存进会话级 JSONL，供渲染端按消息一键回滚。Pi
      // 会 await tool_execution_start handler，快照完成后工具才开始执行，无竞态；
      // 路径按 record.agent.id 计算（parked 会话切助手不写错目录），best-effort。
      createCheckpointExtension({
        workspace: () => recordWorkspace,
        sessionId: () => sessionHolder.session?.sessionId ?? activeSessionManager.getSessionId(),
        agentSessionRoot: () => join(getAgentDir(), "chatanytime-sessions", recordAgent.id),
        enabled: () => settings?.checkpoint?.enabled !== false,
        warn: (message) => void post({ type: "log", level: "warn", message })
      }),
      // 计划模式叙事注入（第四个内联扩展）：只改「有叙事待注入的那一次」LLM
      // 请求的消息尾部，其余请求原样放行（保前缀缓存）；叙事不进 transcript。
      runtimePlanTools.createPlanModeExtension({
        state: () => recordBox?.planState
      })
    ],
    systemPromptOverride: (base) => [base, recordAgent.systemPrompt, buildDivModePrompt(recordAgent.divMode), buildSkillsSystemPromptBlock(runtimeSkills.activeSkillsFor(nativeSkills, recordAgent)), buildSubagentPromptBlock(subagentCatalog), memoryPromptBlock].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();
  syncSkills();
  syncCommands();
  // Connect to configured MCP servers and rebuild the customTool set. Runs
  // concurrently with session manager setup since neither depends on the other.
  // Steady-state switches are served from the MCP tool cache (no network);
  // only explicit resource reloads / MCP config changes force a roundtrip.
  const mcpPromise = syncMcpServers(forceMcpRefresh).catch((error) => {
    post({ type: "log", level: "warn", message: `同步 MCP 服务器失败：${errorText(error)}` });
  });
  mcpSyncedWorkspace = recordWorkspace;
  forceMcpRefresh = false;
  // Todos are session-scoped: each session id gets its own store so the task
  // panel follows the opened session. The first session opened after the
  // upgrade inherits the legacy global todo file exactly once.
  const todosPath = sessionTodosPath(activeSessionManager.getSessionId());
  migrateLegacyTodoFile(todosPath, join(getAgentDir(), "pidesktop-todos.json"));
  const recordTodoStore = createTodoStore(todosPath, refreshTodos);
  const sessionContext = activeSessionManager.buildSessionContext();
  const hasExistingMessages = sessionContext.messages.length > 0;
  // 恢复路径的模型必须在应用侧解析并套覆盖：Pi 的缺省恢复分支从注册表裸取
  // 模型，绕过 applyModelOverrides——「拉取模型」注入覆盖层的新模型只带模板
  // 克隆的限额（glm-5.3-flash 落了模板 glm-4.5 的 204800），重启后 settings
  // 修正全部丢失。注册表没有该模型或未配置鉴权时保持 undefined，沿用 Pi 恢复
  // 分支的门槛，保留其 findInitialModel 回退与 modelFallbackMessage。
  const persistedModel = hasExistingMessages && sessionContext.model
    ? modelRuntime.getModel(sessionContext.model.provider, sessionContext.model.modelId)
    : undefined;
  const restoredModel = resolveRestoredSessionModel(
    persistedModel,
    Boolean(persistedModel && modelRuntime.hasConfiguredAuth(persistedModel.provider)),
    settings?.providers
  );
  // modelOverride（自动化后台会话用）优先于默认模型；正常新建/恢复仍走 defaultModel。
  const requested = hasExistingMessages ? undefined : (options.modelOverride ?? defaultModel());
  // 新会话且应用侧无默认（助手未设、全局 settings.model 未设）时，Pi 会走
  // findInitialModel 的 settings-default 分支——用它自己持久化的默认模型裸取
  // 注册表（我们每次 switchSessionModel 都会写进去），同样绕过覆盖。这里镜像
  // 该分支自行解析并套覆盖；鉴权不通过或解析不出时保持 undefined，交给 Pi 的
  // 后续兜底（首个可用模型），行为与之前一致。
  const piDefault = requested ? undefined : piPersistedDefaultModel(settingsManager);
  const piDefaultModel = piDefault ? modelRuntime.getModel(piDefault.provider, piDefault.id) : undefined;
  const requestedModel = restoredModel
    ?? (requested ? modelRuntime.getModel(requested.provider, requested.id) : undefined)
    ?? resolveRestoredSessionModel(
      piDefaultModel,
      Boolean(piDefaultModel && modelRuntime.hasConfiguredAuth(piDefaultModel.provider)),
      settings?.providers
    );
  const resolvedModel = requestedModel ? applyModelOverrides(requestedModel) : undefined;
  // refreshSessions re-reads every session file from disk (line-by-line), which
  // is slow with many/large sessions. It only needs to be fresh for the sidebar,
  // so on switches with a known list it runs in the background instead of
  // delaying the state emit; the follow-up emit is generation-guarded.
  const hasSessionList = sessionListReadyFor(currentSessions.length, currentSessionsAgentId, recordAgent.id);
  const sessionsPromise = hasSessionList ? undefined : refreshSessions();
  await mcpPromise;
  emitResourceCatalog();
  const sessionRecordSeed: Pick<SessionRuntimeRecord, "workspace" | "agent" | "permissionDeps"> = { workspace: recordWorkspace, agent: recordAgent, permissionDeps };
  const subagentTools = buildSubagentTools(sessionRecordSeed, activeSessionManager.getSessionId(), requested ?? selectedModel, false);
  const recordTodoPace = runtimeTodoTools.createTodoPaceTracker();
  const todoTools = buildTodoTools(recordTodoStore, recordTodoPace);
  const memoryTools = runtimeMemoryTools.buildMemoryTools({
    store: recordMemoryStore,
    workspace: recordWorkspace,
    enabled: () => settings?.memory?.enabled !== false
  });
  // 计划模式：会话级状态从磁盘恢复（enabled 保留，narrate 从空开始——
  // 完整指引仅在新进入时注入，恢复的会话由 agent_start 安排短提醒）。
  const recordPlanState: runtimePlanTools.PlanModeState = {
    enabled: readPlanMode(sessionPlansPath(recordAgent.id, activeSessionManager.getSessionId())),
    narrate: undefined
  };
  // 设计模式：同上从磁盘恢复（会话内不再变动，前缀缓存整段有效）。新建会话
  // 默认不继承——只有 session.new（用户在设计模式里点「新建话题」）显式传
  // inheritDesignMode，避免工作区/角色切换时意外把设计模式带过去。
  const inheritDesignMode = !hasExistingMessages && options.inheritDesignMode === true;
  const recordDesignMode: { enabled: boolean } = {
    enabled: inheritDesignMode || readDesignMode(sessionDesignModePath(recordAgent.id, activeSessionManager.getSessionId()))
  };
  if (inheritDesignMode) {
    try {
      writeDesignMode(sessionDesignModePath(recordAgent.id, activeSessionManager.getSessionId()), true);
    } catch (error) {
      void post({ type: "log", level: "warn", message: `继承设计模式状态失败：${errorText(error)}` });
    }
  }
  // 电脑控制模式：与 designMode 完全同构（会话级开关 + 总闸，两者都满足才注入
  // computer_*，省下 ≈580 tokens/请求）；同样只在 session.new 显式继承，工作区/
  // 角色切换与自动化后台会话都不带过去。
  const inheritComputerMode = !hasExistingMessages && options.inheritComputerMode === true;
  const recordComputerMode: { enabled: boolean } = {
    enabled: inheritComputerMode || readComputerMode(sessionComputerModePath(recordAgent.id, activeSessionManager.getSessionId()))
  };
  if (inheritComputerMode) {
    try {
      writeComputerMode(sessionComputerModePath(recordAgent.id, activeSessionManager.getSessionId()), true);
    } catch (error) {
      void post({ type: "log", level: "warn", message: `继承电脑控制模式状态失败：${errorText(error)}` });
    }
  }
  const planTools = runtimePlanTools.buildPlanTools({
    getSessionId: () => recordSessionId,
    getEnabled: () => recordBox?.planState.enabled ?? false,
    setEnabled: (enabled) => {
      if (recordBox) setPlanMode(recordBox, enabled);
    },
    broker: questionBroker,
    workspace: () => recordWorkspace,
    // 批准落盘：主进程侧直接写 docs/plans/（不经过模型工具，无权限门语义）。
    savePlan: (plan) => saveApprovedPlan(recordWorkspace, plan),
    // 批准移交：闭包捕获规划会话自身的 record（不是 activeRuntime——用户可能在
    // 规划进行中把焦点切到了别的会话/格子），由编排函数在 utility 内新建前台会话。
    handoff: (input) => {
      const source = recordBox;
      if (!source) throw new Error("规划会话运行记录不可用");
      return handoffPlanToNewSession({ source, ...input });
    }
  });
  // ask_question 的挂起按会话清理（disposeRecord → broker.reset），而新会话的
  // sessionId 在 createAgentSession 之后才确定，因此以 getter 延迟读取。
  let recordSessionId = activeSessionManager.getSessionId();
  const questionTools = runtimeQuestionTool.buildQuestionTools({
    getSessionId: () => recordSessionId,
    broker: questionBroker
  });
  // recognize_images 始终注册（定义字节恒定），是否激活由会话模型是否支持
  // 图片决定（见 reconcileVisionTool / createSession 的 setActiveToolsByName）。
  // execute 闭包运行时读取全局 visionModel，vision.save 后无需重注册；待识别
  // 图片不暂存——每次调用实时扫描会话消息中当前轮的用户附图（见
  // currentTurnUserImages），传输层由包装后的 ModelRuntime 剥离图片部分。
  const visionTools = runtimeVision.buildVisionTools({
    resolve: () => {
      if (!visionModel || !modelRuntime) throw new Error("当前模型不支持图片输入，请先切换多模态模型，或在设置的模型服务中启用视觉识别");
      return { runtime: modelRuntime, model: visionModel, prompt: settings?.vision?.prompt };
    },
    pendingUserImages: () => runtimeVision.currentTurnUserImages(recordBox?.session.state.messages ?? []),
    readImageFile: (path) => readImageFile(recordWorkspace, path),
    errorText
  });
  // 浏览器自动化工具：操作经 RPC 转发到 main 进程的 CDP 控制器（复用可见
  // 预览标签页）。sessionKey 与 ask_question 同模式——createAgentSession 之后
  // 才确定 sessionId，因此 request 闭包延迟读取 recordSessionId。权限上
  // browser_navigate / write 型 browser_eval 经 toolRisk 标记 browse 风险走
  // permission gate，其余页面内操作放行；总开关 settings.browser.enabled
  // 在 execute 内实时读取（关闭时工具保留注册、返回停用提示，无需重建会话）。
  const browserTools = runtimeBrowser.buildBrowserTools({
    request: (op) => requestBrowserAutomation(recordSessionId, op),
    enabled: () => settings?.browser?.enabled !== false,
    // 本地文件导航（file:// → 静态预览服务）需要知道记录工作区，作为挂载根。
    workspace: () => recordWorkspace || undefined,
      resolveUploadFiles: (files) => Promise.resolve(resolveWorkspaceUploadFiles(recordWorkspace, files)),
    // 把截图落盘到本记录工作区的 .pidesktop/screenshots/，返回可交给
    // recognize_images 的工作区相对路径；走 recordWorkspace 而非全局
    // workspace，parked 背景会话仍写自己的目录。
    saveScreenshot: (data, mimeType) => saveBrowserScreenshot(recordWorkspace, data, mimeType)
  });
  // SSH 远程终端工具：操作经 RPC 转发到 main 进程的连接管理器（人工与 AI
  // 共享同一 shell 流，命令实时回显在用户终端 tab——主进程 reveal 揭示）。
  // 权限上 ssh_connect/exec/write/close 标记 ssh 风险走 permission gate
  //（read-only 拒、workspace 问、full 放）；总开关 settings.ssh.enabled 在
  // execute 内实时读取，工具常驻激活（browser 同款策略，不重建会话）。
  const sshTools = runtimeSsh.buildSshTools({
    request: (request, timeoutMs) => requestSshAutomation(recordSessionId, request, timeoutMs),
    enabled: () => settings?.ssh?.enabled !== false,
    // AI 上传本地文件锁在工作区内（与 browser_upload 同口径）；下载落到本记录
    // 工作区的 .pidesktop/downloads/（与浏览器下载同一落点，便于模型统一 ls 找产物）。
    // 走 recordWorkspace 而非全局 workspace：parked 背景会话仍写自己的目录。
    resolveUploadFile: (relativePath) => resolveWorkspaceUploadFiles(recordWorkspace, [relativePath])[0]!,
    downloadDir: () => downloadDirFor(recordWorkspace),
    relativeDownloadPath: (absolutePath) => workspaceRelativeAttachment(recordWorkspace, absolutePath)
  });
  // 自动化定时任务工具（每会话注册，绑定本记录所属 Agent 的 store）。
  const automationTools = buildAutomationTools(automationToolContextFor(recordAgent.id));
  // 电脑控制工具：高频「感知→行动」循环结构化（computer_windows/screenshot/
  // click/type/press），执行层 spawn Python 复用 computer-use skill 的
  // ljqCtrl.py（工具与 skill 共享同一份实现；skill 保留长尾操作如 UIA/找图）。
  // 权限：click/type/press 走 desktop 风险门（read-only 拒/ask 逐次确认/
  // workspace+ 放行）；enabled 实时读总闸是第二道防线（总闸刚关、活动集尚未
  // 重算时的在途调用不得落盘）；是否进活动工具集由 shouldActivateComputerTools
  // 判定（会话级 computerMode + 总闸），注册常驻（注册 ≠ 激活）。
  const computerTools = runtimeComputer.buildComputerTools({
    enabled: () => settings?.computer?.enabled !== false,
    workspace: () => recordWorkspace || undefined,
    locateScriptDir: () => runtimeComputer.locateLjqCtrlDir(getAgentDir(), recordWorkspace || undefined, bundledSkillsDir),
    saveScreenshot: (data, mimeType) => saveBrowserScreenshot(recordWorkspace, data, mimeType, "computer"),
    // 屏幕悬浮提示条（main 进程 ComputerOverlayController）：操作前告知用户
    // 「AI 正在操作 XX」；fire-and-forget，失败静默（纯增益不阻塞工具）。
    notify: (text) => post({ type: "computer-overlay.request", kind: "show", text })
  });
  // 设计模式工具（每会话注册；当前文档绑定在本 record 上，工具闭包经 recordBox 读写）。
  // 注册常驻（注册 ≠ 激活），是否进活动工具集由 shouldActivateDesignTools 判定
  // （会话级 designMode + 全局总闸）；enabled 实时读总闸，双保险防总闸刚关时
  // 已有调用继续写盘。写盘与推送统一走 persistDoc/bindDoc。
  const designTools = runtimeDesign.buildDesignTools({
    enabled: () => settings?.design?.enabled !== false,
    workspace: () => recordWorkspace || undefined,
    renderSnapshot: async (request) => {
      try {
        return await requestDesignSnapshot(request);
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
    getDoc: () => recordBox?.designDoc?.doc,
    getDocFileName: () => recordBox?.designDoc?.fileName,
    bindDoc: (doc, fileName) => {
      if (recordBox) {
        recordBox.designDoc = { doc, fileName };
        postDesignState(recordBox, doc);
        post({ type: "design.docs", docs: listDesigns(recordWorkspace) });
      }
    },
    persistDoc: (doc, previousFileName) => {
      const fileName = writeDesign(recordWorkspace, doc, previousFileName);
      if (recordBox) {
        recordBox.designDoc = { doc, fileName };
        postDesignState(recordBox, doc);
      }
      return fileName;
    }
  });
  // 作品发布工具（每会话注册，无条件激活）：把完成的成果登记到全局作品墙。
  // 发布是写入动作，权限走 write 风险轴（已加进 toolRisk 白名单）。
  const galleryTools = runtimeGallery.buildGalleryTools({
    publish: (draft) => publishGalleryApp(draft, recordWorkspace || undefined),
    list: () => galleryApps
  });
  // Jev 快速决策通路（实验性，缺省关闭）：循环在工具层，每一步通过既有 browser RPC
  // 落到主进程的 CDP 控制器（jevObserve/jevAct/jevReset），因此不碰任何现有 browser_* 行为。
  // 文本助手从**本记录可见的已配置模型**里解析（settings.jev.textProvider/textModel），
  // 走同一个 ModelRuntime.completeSimple 通道（视觉识别同款）；apiKey 走 credentials.json
  // 下发的内存镜像，永不落进 settings。
  const jevTools = runtimeJev.buildJevTools({
    request: (op) => requestBrowserAutomation(recordSessionId, op),
    enabled: () => settings?.jev?.enabled === true,
    settings: () => settings?.jev,
    apiKey: () => apiKeys[JEV_CREDENTIAL_ID]?.trim() || undefined,
    callJev: (query) => {
      const jev = settings?.jev;
      const key = apiKeys[JEV_CREDENTIAL_ID]?.trim();
      if (!jev || !key) throw new Error("Jev 未配置（缺少接口地址或 TypeSafe API Key）");
      return runtimeJev.makeJevCaller({ baseUrl: jev.baseUrl, apiKey: key })(query);
    },
    writeFieldText: async (request) => {
      const jev = settings?.jev;
      const target = jev && modelRuntime ? modelRuntime.getModel(jev.textProvider, jev.textModel) : undefined;
      if (!target || !modelRuntime) throw new Error(`Jev 的文本助手模型不可用：${jev?.textProvider ?? ""}/${jev?.textModel ?? ""}（请在设置的模型服务里配置后重选）`);
      const result = await runtimeVision.writeFieldTextOnce(modelRuntime, target, {
        systemPrompt: runtimeJev.TEXT_VALUE_PROMPT,
        context: {
          goal: request.goal,
          field: request.action,
          page: { title: request.page.title, text: request.page.text.slice(0, 6000) },
          recent_actions: request.recentActions.slice(-6)
        }
      });
      return result.text;
    }
  });
  // 可单独终止的 shell 工具：同名 customTools 覆盖内建 bash/powershell（工厂与
  // 选项同 Pi 内部构造，schema/description 字节不变、不影响前缀缓存）。任务面板
  // 「按命令停止」经 record.shellKill 只杀该调用的进程树，会话继续本轮。
  const shellKill = runtimeShellKill.buildKillableShellTools({
    cwd: recordWorkspace,
    commandPrefix: settingsManager.getShellCommandPrefix() ?? undefined,
    shellPath: settingsManager.getShellPath() ?? undefined
  });
  // Each record owns its customTools array: Pi stores it by reference and
  // re-reads it on every tool-registry refresh, so per-record arrays let parked
  // sessions keep their tool set while the active one hot-swaps MCP tools.
  const recordCustomTools: ToolDefinition[] = [shellKill.tools[0]!, shellKill.tools[1]!, ...mcpTools, ...subagentTools, ...todoTools, ...memoryTools, ...questionTools, ...planTools, ...visionTools, ...browserTools, ...sshTools, ...computerTools, ...automationTools, ...designTools, ...galleryTools, ...jevTools];
  const result = await createAgentSession({
    cwd: recordWorkspace,
    modelRuntime,
    model: resolvedModel,
    thinkingLevel: hasExistingMessages ? undefined : (recordAgent.defaultThinkingLevel ?? settings?.thinkingLevel ?? "medium"),
    sessionManager: activeSessionManager,
    settingsManager,
    resourceLoader,
    customTools: recordCustomTools
  });
  if (!options.noGenerationGuard && generation !== sessionGeneration) {
    result.session.dispose();
    if (sessionsPromise) await sessionsPromise;
    return;
  }
  // 交给 Pi 兜底落位的模型（首个可用模型等更深的 findInitialModel 分支）同样
  // 可能命中用户修正。这里做纯元数据纠偏——不走 setModel（会追加 model_change
  // 条目、重写 Pi 默认），直接替换 state.model 引用，与 Pi 自身的
  // _refreshCurrentModelFromRegistry 同一姿势；覆盖只动 contextWindow/maxTokens/
  // input，不影响 setModel 时已按模型能力钳过的思考档位。
  if (!resolvedModel && result.session.model) {
    const corrected = applyModelOverrides(result.session.model);
    if (corrected !== result.session.model) result.session.agent.state.model = corrected;
  }
  // 早水合（分屏）：历史已由 createAgentSession 装载，而扩展绑定/工具激活/
  // activate 还要一小会儿。若该会话已被渲染端 watch（或等待 watch），先推一
  // 帧会话级快照让格子显示历史，随后的 activate/emitState 与常规推送接管。
  const earlyPaneId = result.session.sessionId;
  if (pendingWatchSessions.has(earlyPaneId) || renderedSessions.has(earlyPaneId)) {
    const earlySession = result.session;
    post({
      type: "session.state",
      snapshot: {
        sessionId: earlyPaneId,
        sessionFile: activeSessionManager.getSessionFile(),
        workspace: recordWorkspace,
        model: earlySession.model ? { provider: earlySession.model.provider, id: earlySession.model.id } : undefined,
        thinkingLevel: earlySession.thinkingLevel,
        busy: false,
        status: "",
        queuedMessages: [],
        planMode: recordPlanState.enabled,
        computerMode: recordComputerMode.enabled,
        designMode: recordDesignMode.enabled,
        messages: normalizeMessages(earlySession.state.messages, earlySession.state.streamingMessage),
        executions: []
      }
    });
  }
  const record: SessionRuntimeRecord = {
    session: result.session,
    unsubscribe: () => undefined,
    workspace: recordWorkspace,
    agent: recordAgent,
    busy: false,
    status: "",
    turnTiming: undefined,
    executions: new Map(),
    controlMessages: restoreControlMessages(activeSessionManager.getBranch() as unknown as PersistedSessionEntry[]),
    todoStore: recordTodoStore,
    todoPace: recordTodoPace,
    planState: recordPlanState,
    computerMode: recordComputerMode,
    designMode: recordDesignMode,
    memoryStore: recordMemoryStore,
    customTools: recordCustomTools,
    subagentTools,
    todoTools,
    memoryTools,
    questionTools,
    planTools,
    extensionApi: undefined,
    permissionDeps,
    visionTools,
    browserTools,
    sshTools,
    computerTools,
    automationTools,
    designTools,
    galleryTools,
    jevTools,
    jevGlobalEnabled: () => settings?.jev?.enabled === true,
    designGlobalEnabled: () => settings?.design?.enabled !== false,
    computerGlobalEnabled: () => settings?.computer?.enabled !== false,
    shellKill,
    steeringImages: [],
    followUpImages: [],
    unattended: Boolean(options.unattended),
    runStatus: undefined,
    abortRequested: false,
    cacheUsage: runtimeContextUsage.scanCacheUsage(result.session.state.messages),
    // 恢复会话只回填轮步计数（时间打点不落盘，重启后从零累计）。
    speedStats: speedStats.seedSpeedStats(result.session.state.messages),
    activatedAt: Date.now()
  };
  recordBox = record;
  sessionHolder.session = result.session;
  recordSessionId = result.session.sessionId;
  // Activate the app-owned inline extension(s) only. The permission hook lives
  // in the permission extension factory and gates risky tool calls; no
  // third-party extension code is ever loaded.
  await result.session.bindExtensions({
    onError: (error) => {
      post({ type: "log", level: "warn", message: `权限拦截扩展错误：${error.error}` });
    }
  });
  // Re-check after the awaits: a session switch that started mid-creation must
  // win, so a superseded pipeline drops its freshly built session instead of
  // stealing the active slot back.
  if (!options.noGenerationGuard && generation !== sessionGeneration) {
    result.session.dispose();
    if (sessionsPromise) await sessionsPromise;
    return;
  }
  // Activate the agent's enabled built-in tools plus every customTool (MCP,
  // subagent delegation, todo, memory, question, vision). customTools are
  // registered but not active unless explicitly enabled here; the vision tool
  // is activated only for text-only conversation models (toolNamesFor).
  result.session.setActiveToolsByName(toolNamesFor(record, !hasImageInput(result.session.model)));
  // 工具活动集在此定型：三段明细的工具段按它缓存，首次重算放在激活之后。
  refreshContextBreakdown(record);
  record.executions = new Map(restoreToolExecutions(result.session.state.messages as unknown as PersistedSessionMessage[], recordWorkspace).map((execution) => [execution.id, execution]));
  backfillRestoredArtifacts(record);
  // Background processes launched by earlier sessions keep running across
  // restarts; rediscover them from the session's bash history (throttled).
  const discoveryNow = Date.now();
  if (discoveryNow - lastBackgroundDiscoveryAt > 30_000) {
    lastBackgroundDiscoveryAt = discoveryNow;
    void backgroundProcesses.discoverFromHistory(bashCommandsFromMessages(result.session.state.messages as unknown as readonly unknown[])).catch(() => { /* discovery is best-effort */ });
  }
  record.unsubscribe = result.session.subscribe((event) => handleSessionEvent(record, event));
  record.status = sessionReadyStatus(Boolean(result.session.model), Boolean(result.modelFallbackMessage));
  liveSessions.set(result.session.sessionId, record);
  // 启动恢复的分屏格子：watch 先于会话 live 到达（pendingWatchSessions），
  // 记录建立后补注册并立即推送水合帧。该记录随即被 activate，激活期间的
  // 更新走 state 通道，失焦后自然切回 session.state。
  if (pendingWatchSessions.delete(result.session.sessionId)) {
    renderedSessions.add(result.session.sessionId);
  }
  // 背景格（skipActivate，session.open activate:false）：不激活、不动全局
  // 镜像（workspace/model/todo/memory 保持焦点格），watch 排队已在上面补挂，
  // 立即推一帧水合让格子显示历史。
  if (options.skipActivate) {
    emitPaneStateFor(record);
    if (sessionsPromise) await sessionsPromise;
    ensureSessionInList(record);
    emitState();
    return;
  }
  activate(record);
  if (sessionsPromise) {
    // First list (app start): wait so the sidebar is populated on the first emit.
    await sessionsPromise;
  }
  // Newly created sessions are not on disk (or not yet) and refreshSessions is
  // intentionally skipped on switches with a known list — merge it into the
  // sidebar list in memory right now so it shows up immediately, and the
  // "running" dot can be patched on instantly once a turn starts.
  ensureSessionInList(record);
  // Note: emitResourceCatalog()/emitTodos() are intentionally NOT re-called
  // here. Todos were published right after the session-scoped store was built,
  // the resource catalog right after the MCP sync completed, and none of the
  // native capability sources change between then and now.
  emitState();
}

async function initialize(command: Extract<RuntimeCommand, { type: "initialize" }>): Promise<void> {
  settings = command.settings;
  apiKeys = command.apiKeys;
  bundledSkillsDir = command.bundledSkillsDir;
  bundledSubagentsDir = command.bundledSubagentsDir;
  refreshHooksConfig();
  refreshSubagents();
  recentWorkspaces = loadRecentWorkspaces(recentWorkspacesPath());
  // 作品清单：全局一份池子（跨工作区），读盘 + 清掉孤儿缩略图。
  // 读盘 + 顺手修复「缺 id」的历史条目（首版发布路径写过 id:""，见 gallery-store 注释）。
  galleryApps = loadGalleryRepairingIds(galleryFilePath());
  void pruneGalleryThumbs(galleryThumbsPath(), galleryApps);
  emitGallery();
  // 工作区按助手记忆恢复（2026-09-03 方案 B）：agentWorkspaces[活跃助手] → 老配置
  // settings.workspace（仅迁移期一次性兜底）→ 默认工作区。settings.workspace 此后
  // 冻结不再写。默认档仅当真落到默认时才 mkdir（map/legacy 命中不产生副作用），
  // mkdir 失败回 undefined 保留 landing 极端兜底。
  const mappedWorkspace = settings.agentWorkspaces?.[settings.currentAgentId];
  const legacyWorkspace = settings.workspace ? resolve(settings.workspace) : undefined;
  workspace = resolveInitialWorkspace(
    settings.agentWorkspaces,
    settings.currentAgentId,
    legacyWorkspace,
    mappedWorkspace || legacyWorkspace
      ? resolveDefaultWorkspace(getAgentDir(), settings.defaultWorkspace)
      : agentDefaultWorkspace()
  );
  if (workspace) {
    // legacy 命中（map 无当前助手条目且老配置存在）时提升进内存 map：本会话内
    // agent.select 切走再切回仍能恢复老工作区，不必等下次重启落盘。
    if (legacyWorkspace && !mappedWorkspace) {
      settings.agentWorkspaces = recordAgentWorkspace(settings.agentWorkspaces, settings.currentAgentId, legacyWorkspace);
    }
    touchRecentWorkspace(workspace);
  }
  currentAgent = activeAgent();
  thinkingLevel = settings.thinkingLevel ?? "medium";
  accessMode = settings.accessMode ?? "ask";
  selectedModel = settings.model;
  modelRuntime = wrapModelRuntimeForVision(await ModelRuntime.create());
  const initializedProviderIds = new Set<string>();
  for (const provider of settings.providers) {
    registerCustomProvider(provider);
    initializedProviderIds.add(provider.id);
    const key = apiKeys[provider.id];
    if (key) await modelRuntime.setRuntimeApiKey(provider.id, key);
  }
  // 内置服务商覆盖层（baseUrl/api 覆盖）在自定义注册后统一同步一次；
  // 拉取造成的覆盖层变更在 refreshBuiltinModelsFallback 内再叠加设置覆盖。
  await syncBuiltinProviderOverlays();
  // `auth.set` stores built-in provider keys separately from provider settings.
  // Rehydrate those keys after restart so explicit app configuration remains
  // distinguishable from inherited environment credentials.
  for (const [providerId, key] of Object.entries(apiKeys)) {
    if (initializedProviderIds.has(providerId) || !key || !modelRuntime.getProvider(providerId)) continue;
    await modelRuntime.setRuntimeApiKey(providerId, key);
  }
  visionModel = resolveVisionModel(settings.vision, modelRuntime, (model) => hasImageInput(model));
  await refreshCatalog();
  // 自动化定时任务调度器：每分 tick，跨角色扫描全部任务（2026-09-02 起不再
  // 限定当前激活角色）；执行侧按任务自身 agentId 解析角色（runAutomationTask）。
  automationScheduler = createAutomationScheduler({
    getTasks: () => readAllAutomations(getAgentDir()),
    runTask: (task) => runAutomationTask(task, "cron"),
    onError: (message) => void post({ type: "log", level: "warn", message: `自动化任务错误：${message}` }),
    // 跳过只写运行记录（不写 lastRun、不弹 toast）：调度器保持零存储依赖，
    // 「是否已跑过 / 要不要落盘」的判据都在这一侧。
    onSkip: (task, reason, at) => recordSkippedRun(task, reason, at),
    hasRunSince: (taskId, since) => automationRuns.some((run) => run.taskId === taskId && run.status !== "skipped" && run.startedAt >= since)
  });
  automationScheduler.start();
  // 启动错过扫描：一次性的可观测性补位（「昨天没跑」现在能在运行记录里看到原因）。
  automationScheduler.reportMissed();
  refreshAutomation();
  // checkpoint 快照的全局清扫（mtime 过期/总量超限）：异步不阻塞启动。
  void sweepCheckpoints(getAgentDir(), Date.now(), (message) => void post({ type: "log", level: "warn", message }));
  if (workspace) await createSession();
  else {
    refreshTodos();
    emitResourceCatalog();
    emitState();
  }
}

async function runResourceOperation(label: string, operation: () => Promise<void>): Promise<void> {
  const record = activeRuntime;
  if (!record) throw new Error("请先打开工作区，再管理能力");
  // Only the active session is rebuilt by resource operations; parked sessions
  // are never touched, so their busy state is irrelevant here.
  if (record.busy || resourceOperationBusy) throw new Error("当前会话正在运行，请等待完成后再管理能力");
  resourceOperationBusy = true;
  // The rebuild disposes the active record midway, so the busy overlay rides on
  // transitionStatus instead of the record (which is replaced before the end).
  transitionStatus = label;
  emitState();
  try {
    await operation();
    emitResourceCatalog();
  } finally {
    resourceOperationBusy = false;
    transitionStatus = undefined;
    const current = activeRuntime;
    if (current) current.status = "就绪";
    emitResourceCatalog();
    emitState();
  }
}

async function reloadRuntimeResources(): Promise<void> {
  const record = activeRuntime;
  if (!record) throw new Error("请先打开工作区，再重载资源");
  // customTools are fixed at AgentSession creation and Pi has no tool-removal
  // API, so removals (server deleted/disabled) still require recreating the
  // session while keeping the same SessionManager (JSONL history preserved).
  await createSession(record.session.sessionManager);
}

/**
 * 保存子智能体定义后重建活动会话：定义本身在 execute 时实读（新增即可引用），但
 * 系统提示里的「可用子智能体」清单是创建会话时写入的——新增与修改描述（两者都要
 * 被模型看到）不重建就不生效。与 skill.toggle 同款纪律：忙时不打断（只记日志，回退
 * 到「已保存，下次重建生效」），失败不阻断保存。空闲时重建代价可忽略。
 */
async function refreshActiveSessionForSubagents(): Promise<void> {
  const record = activeRuntime;
  if (!record || !record.extensionApi) return;
  if (record.busy || record.session.isStreaming) {
    // 与 skill.toggle 同款纪律：不打断进行中的回合；渲染端的 log 通道只转 warn，
    // 所以这里用 warn 级别（info 会被静默丢掉）。
    void post({ type: "log", level: "warn", message: "子智能体已保存；当前会话正在运行，新定义将在下次重建会话后出现在可用清单里。" });
    return;
  }
  try {
    await createSession(record.session.sessionManager);
  } catch (error) {
    void post({ type: "log", level: "warn", message: `子智能体已保存，但刷新会话失败（新定义将在下次重建会话后生效）：${errorText(error)}` });
  }
}

/**
 * Apply MCP config changes to the live (active) session. Tool additions and
 * same-name replacements take the hot path: the record's stable customTools
 * array is swapped in place and registerTool() makes Pi rebuild the registry
 * and prompt snippets — the message flow and session state stay intact. Any
 * removal (or a missing extension handle) falls back to a full session
 * rebuild. Parked background sessions keep the tools captured at creation.
 */
async function applyMcpToolChanges(): Promise<void> {
  const record = activeRuntime;
  if (!record) throw new Error("请先打开工作区，再管理 MCP Server");
  const previousNames = mcpTools.map((tool) => tool.name);
  await syncMcpServers(forceMcpRefresh);
  forceMcpRefresh = false;
  const { added, removed } = diffToolNames(previousNames, mcpTools.map((tool) => tool.name));
  if (added.length === 0 && removed.length === 0) return;
  if (removed.length > 0 || !record.extensionApi) {
    await reloadRuntimeResources();
    return;
  }
  try {
    const subagentTools = buildSubagentTools(record, record.session.sessionId, selectedModel, false);
    record.subagentTools = subagentTools;
    record.customTools.length = 0;
    record.customTools.push(...buildRecordTools(record));
    // Re-registering every MCP tool covers additions and same-name schema
    // changes alike, and triggers the registry refresh that re-reads the
    // record's customTools.
    for (const tool of mcpTools) record.extensionApi.registerTool(tool);
    record.session.setActiveToolsByName(toolNamesFor(record, !hasImageInput(record.session.model)));
    // 热更新改变了请求前缀里的工具清单：三段明细的工具段跟随重算。
    refreshContextBreakdown(record);
  } catch (error) {
    // A stale extension handle (session swapped mid-operation) or any registry
    // hiccup: recover via the rebuild path.
    post({ type: "log", level: "warn", message: `MCP 工具热更新失败，回退到会话重建：${errorText(error)}` });
    await reloadRuntimeResources();
  }
}

async function preparePromptPayload(text: string, attachments: PromptAttachment[] = []): Promise<{ text: string; images: ImageContent[] }> {
  if (attachments.length > 5) throw new Error("最多同时发送 5 个附件");
  if (!workspace) throw new Error("请先打开工作区，再发送消息");
  const images: ImageContent[] = [];
  const fileRefs: string[] = [];
  let rootReal: string | undefined;
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      if (!imageMimeTypes.has(attachment.mimeType) || !attachment.data || !/^[A-Za-z0-9+/]+=*$/u.test(attachment.data)) throw new Error(`图片附件无效：${attachment.name}`);
      if (Math.ceil((attachment.data.length * 3) / 4) > 20 * 1024 * 1024) throw new Error(`附件超过 20 MB 限制：${attachment.name}`);
      images.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
      continue;
    }
    const rel = attachment.relativePath || attachment.path;
    if (!rel || isAbsolute(rel) || rel.split(/[\\/]/u).includes("..")) throw new Error(`附件路径无效：${attachment.name}`);
    const candidateReal = await realpath(resolve(workspace, rel));
    rootReal ??= await realpath(workspace);
    const relativeReal = workspaceRelativeAttachment(rootReal, candidateReal);
    if (!relativeReal || relativeReal === ".." || relativeReal.startsWith(`..${sep}`)) throw new Error(`附件必须位于当前工作区内：${attachment.name}`);
    const info = await stat(candidateReal);
    if (!info.isFile()) throw new Error(`附件不是普通文件：${attachment.name}`);
    if (info.size > 20 * 1024 * 1024) throw new Error(`附件超过 20 MB 限制：${attachment.name}`);
    fileRefs.push(relativeReal);
  }
  const attachmentsBlock = fileRefs.length
    ? `项目文件附件（请使用 read 工具按需读取）：\n${fileRefs.map((path) => `- ${path}`).join("\n")}`
    : undefined;
  // 注意：当前任务清单不再进入任何提示词位置。dsh 式单一所有者语义下
  // 清单状态只通过 todo_write 的调用参数出现在对话尾部（纯追加）。
  return {
    text: attachmentsBlock ? `${text}\n\n${attachmentsBlock}` : text,
    images
  };
}

/**
 * Read an image file for the recognize_images tool: workspace-bounded via
 * realpath + workspaceRelativeAttachment (mirrors the attachment import
 * checks), size and MIME whitelisted. Model-supplied paths are its own
 * screenshots/artifacts inside the workspace. The root is the record's own
 * workspace, not the global one, so a parked background session keeps reading
 * its own files after the user switches workspaces.
 */
async function readImageFile(root: string, imagePath: string): Promise<ImageContent> {
  const mimeType = runtimeVision.imageMimeForPath(imagePath);
  if (!mimeType) throw new Error("不支持的图片格式（支持 png/jpg/jpeg/webp/gif/bmp）");
  const candidate = resolve(root, imagePath);
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error("不是普通文件");
  if (info.size > runtimeVision.MAX_VISION_FILE_BYTES) throw new Error(`图片文件超过 20 MB 限制：${imagePath}`);
  const rootReal = await realpath(resolve(root));
  const targetReal = await realpath(candidate);
  workspaceRelativeAttachment(rootReal, targetReal); // 越界抛错
  // 扩展名只是快速预门：真实格式按字节嗅探（Pi 0.84.4 公开导出，含 PNG 结构/
  // 动图与 BMP 头校验），防改名文件把垃圾喂给视觉模型；嗅探结果即权威 MIME
  // （jpg 扩展名的 png 会按 image/png 上送）。
  const sniffed = await detectSupportedImageMimeTypeFromFile(targetReal);
  if (!sniffed) throw new Error("文件内容不是有效的图片（png/jpg/webp/gif/bmp）");
  const data = await readFile(targetReal);
  return { type: "image", data: data.toString("base64"), mimeType: sniffed };
}

async function handleCommand(command: RuntimeCommand): Promise<void> {
  switch (command.type) {
    case "initialize":
      await initialize(command);
      break;
    case "workspace.open":
      workspace = resolve(command.path);
      rememberWorkspace(workspace);
      await createSession(undefined, { reactivate: true });
      break;
    case "session.new":
      if (command.workspace) {
        workspace = resolve(command.workspace);
        rememberWorkspace(workspace);
      }
      // Always a fresh session id: the previously active session is parked and
      // keeps running, so a busy turn never blocks starting a new topic.
      // 设计模式下新建话题继承设计模式：用户在连续做设计，新话题不该丢掉画布
      // 与 design_* 工具（继承结果同步落盘，重启后恢复一致）。
      if (workspace) await createSession(SessionManager.create(workspace, workspaceSessionDir()), { inheritDesignMode: activeRuntime?.designMode.enabled === true, inheritComputerMode: activeRuntime?.computerMode.enabled === true });
      break;
    case "session.open": {
      const root = agentSessionRoot();
      const target = resolve(command.path);
      if (!root || !pathIsWithin(root, target) || !target.toLowerCase().endsWith(".jsonl")) throw new Error("只能打开当前 Agent 的会话");
      // 未落盘的会话（新建话题在首条 assistant 消息前不写文件）只能按 live 记录打开：
      // SessionManager.open 对不存在的文件会**另生成一个新 sessionId**，cwd 回退到
      // process.cwd()（utility 进程的 cwd 是安装目录）——随后既查不到 live 记录、
      // 目录校验也必失败，点侧边栏那条「新会话」就是在这里报「会话路径与工作区不匹配」
      // 并把安装目录写进助手最后工作区的（2026-09-16 根因）。判据是**文件是否存在**，
      // 不是目录是否匹配：后者取决于全局 workspace 镜像，而分屏背景格与跨工作区打开
      // 都要求它与镜像无关。
      const fileLive = [...liveSessions.values()].find((candidate) => {
        const liveFile = candidate.session.sessionManager.getSessionFile();
        return Boolean(liveFile) && resolve(liveFile!).toLowerCase() === target.toLowerCase();
      });
      if (fileLive && !(await pathExists(target))) {
        if (command.activate === false) break; // 分屏已完成前把无效格留着，无需重建
        activate(fileLive);
        emitState();
        break;
      }
      const discovered = SessionManager.open(target);
      const sessionWorkspace = discovered.getCwd();
      if (!sessionWorkspace) throw new Error("会话缺少工作区信息");
      const recordWorkspace = resolve(sessionWorkspace);
      // sessionRoot 按 record 自己的工作区计算（不经过全局 workspace），且校验必须在
      // 任何全局镜像改写之前：失败路径不允许脏写助手最后工作区。
      const recordRoot = currentAgent ? agentWorkspaceSessionDir(getAgentDir(), currentAgent.id, recordWorkspace) : undefined;
      if (!recordRoot || (!sameSessionDir(recordRoot, dirname(target)) && !sameSessionDir(root, dirname(target)))) {
        throw new Error("会话路径与工作区不匹配");
      }
      // 文件不存在：这行不是「路径不匹配」，而是没有任何工作区信息可依的废行（header 缺失
      // ⇒ cwd 回退 process.cwd() = 安装目录）。必须挡在镜像改写**之前**——根目录兜底
      // （sameSessionDir(root, ...)）会让这类行的目录校验通过，否则又会把安装目录写进
      // 助手最后工作区，再 /new 就在那里建会话（与本次修的 bug 同类）。绝不拿它去建一个
      // cwd 是安装目录的空会话。
      if (!(await pathExists(target))) throw new Error("该会话文件不存在（未发过消息的空话题或已被移除）");
      if (command.activate === false) {
        const live = liveSessions.get(discovered.getSessionId());
        if (live) break; // 已 live：无需重建，也不激活
        await createSession(SessionManager.open(target, recordRoot, recordWorkspace), { skipActivate: true });
        break;
      }
      workspace = recordWorkspace;
      rememberWorkspace(workspace);
      // A live record (e.g. a session still running in the background) is
      // reactivated in place — never rebuilt — so its in-flight turn survives.
      const live = liveSessions.get(discovered.getSessionId());
      if (live) {
        activate(live);
        emitState();
        break;
      }
      // 此处不再重做存在性校验：上面已挡（live-by-id 命中隐含文件存在，重建分支直走）。
      await createSession(SessionManager.open(target, recordRoot, workspace));
      break;
    }
    case "session.rename": {
      const renameRoot = agentSessionRoot();
      const renameTarget = resolve(command.path);
      if (!renameRoot || !pathIsWithin(renameRoot, renameTarget) || !renameTarget.toLowerCase().endsWith(".jsonl")) throw new Error("只能重命名当前 Agent 的会话");
      const activeFile = activeRuntime?.session.sessionManager.getSessionFile();
      if (activeFile && resolve(activeFile).toLowerCase() === renameTarget.toLowerCase()) activeRuntime?.session.sessionManager.appendSessionInfo(command.title);
      else SessionManager.open(renameTarget).appendSessionInfo(command.title);
      await refreshSessions();
      emitState();
      break;
    }
    case "session.pin": {
      if (settings) {
        // 集合更新走匹配键（分隔符/大小写归一）：旧实现按字面量 includes 判断，
        // 列表里回来的路径写法与落盘时的写法只要不一致，就会置顶出两条同义记录、
        // 取消置顶又删不掉。
        settings = { ...settings, pinnedSessionPaths: togglePinnedSessionPath(settings.pinnedSessionPaths, command.path, command.pinned) };
      }
      await refreshSessions();
      emitState();
      break;
    }
    case "session.delete": {
      const deleteRoot = agentSessionRoot();
      const deleteTarget = resolve(command.path);
      if (!deleteRoot || !pathIsWithin(deleteRoot, deleteTarget) || !deleteTarget.toLowerCase().endsWith(".jsonl")) throw new Error("只能删除当前 Agent 的会话");
      // 会话 id 与 todos 文件名同源（JSONL 文件名），以列表中的 id 为准。
      const listItem = currentSessions.find((candidate) => resolve(candidate.path).toLowerCase() === deleteTarget.toLowerCase());
      const sessionId = listItem?.id ?? deleteTarget.slice(deleteTarget.lastIndexOf(sep) + 1).replace(/\.jsonl$/iu, "");
      // 若目标会话仍在运行（live record），一并销毁——与移除整个工作区的语义一致。
      const live = [...liveSessions.values()].find((record) => {
        const liveFile = record.session.sessionManager.getSessionFile();
        return Boolean(liveFile) && resolve(liveFile!).toLowerCase() === deleteTarget.toLowerCase();
      });
      const wasActive = live === activeRuntime;
      if (live) disposeRecord(live);
      try { await unlink(deleteTarget); } catch { /* 会话文件可能已不存在 */ }
      try { await unlink(join(deleteRoot, "todos", `${sessionId}.json`)); } catch { /* 任务文件可能不存在 */ }
      try { await unlink(join(deleteRoot, "plans", `${sessionId}.json`)); } catch { /* 计划模式状态文件可能不存在 */ }
      try { await unlink(join(deleteRoot, "design-mode", `${sessionId}.json`)); } catch { /* 设计模式状态文件可能不存在 */ }
      try { await unlink(join(deleteRoot, "computer-mode", `${sessionId}.json`)); } catch { /* 电脑控制模式状态文件可能不存在 */ }
      try { await unlink(join(deleteRoot, "checkpoints", `${sessionId}.jsonl`)); } catch { /* 快照文件可能不存在 */ }
      // 删除当前在用的会话后立即补一个空白会话，保持「当前话题」可用。
      if (wasActive && workspace) {
        const sessionDir = workspaceSessionDir();
        if (sessionDir) await createSession(SessionManager.create(workspace, sessionDir));
      }
      await refreshSessions();
      emitState();
      break;
    }
    case "workspace.remove": {
      // 助手级移除（2026-09-03 方案 B，e42c139 回退重做）：只删当前助手的会话与
      // map 键，不动全局 recents——话题栏分组由当前助手会话 + 激活工作区驱动，
      // 同工作区其他助手的会话/后台运行记录/空分组历史一概不受影响。
      const removeKey = resolve(command.workspace).toLowerCase();
      const removeRoot = agentSessionRoot();
      if (removeRoot) {
        const removed = currentSessions.filter((item) => resolve(item.workspace).toLowerCase() === removeKey);
        // 只销毁当前助手在该工作区的活记录（B 助手同工作区的后台会话不随 A 的移除销毁）。
        for (const record of [...liveSessions.values()]) {
          if (record.agent.id === currentAgent?.id && resolve(record.workspace).toLowerCase() === removeKey) disposeRecord(record);
        }
        for (const item of removed) {
          if (!pathIsWithin(removeRoot, item.path) || !item.path.toLowerCase().endsWith(".jsonl")) continue;
          try { await unlink(item.path); } catch { /* 会话文件可能已释放或不存在 */ }
          // Session-scoped todo file lives next to the session list under todos/.
          try { await unlink(join(removeRoot, "todos", `${item.id}.json`)); } catch { /* 任务文件可能不存在 */ }
          try { await unlink(join(removeRoot, "plans", `${item.id}.json`)); } catch { /* 计划模式状态文件可能不存在 */ }
          try { await unlink(join(removeRoot, "design-mode", `${item.id}.json`)); } catch { /* 设计模式状态文件可能不存在 */ }
          try { await unlink(join(removeRoot, "computer-mode", `${item.id}.json`)); } catch { /* 电脑控制模式状态文件可能不存在 */ }
          try { await unlink(join(removeRoot, "checkpoints", `${item.id}.jsonl`)); } catch { /* 快照文件可能不存在 */ }
        }
      }
      // 内存 map：移除当前助手对目标工作区的记忆（键不匹配不动；其他助手键不动）。
      if (settings) {
        settings.agentWorkspaces = forgetAgentWorkspace(settings.agentWorkspaces, settings.currentAgentId, command.workspace);
        // 与主进程对称：legacy settings.workspace 同路径时一并清，防重启 initialize 回潮。
        if (settings.workspace && resolve(settings.workspace).toLowerCase() === removeKey) settings.workspace = undefined;
      }
      // 移除的是运行时工作区：回落默认工作区（目标本身是默认则保持）——不再回
      // landing；激活会话已被销毁，补一个空白会话保持「直接可聊」。
      const removingActive = workspace !== undefined && resolve(workspace).toLowerCase() === removeKey;
      if (removingActive) {
        const removedIsDefault = resolve(resolveDefaultWorkspace(getAgentDir(), settings?.defaultWorkspace)).toLowerCase() === removeKey;
        if (!removedIsDefault) {
          const fallback = agentDefaultWorkspace();
          if (fallback) {
            workspace = fallback;
            touchRecentWorkspace(fallback);
          }
        }
        if (workspace) {
          const sessionDir = workspaceSessionDir();
          if (sessionDir) await createSession(SessionManager.create(workspace, sessionDir));
        }
      }
      await refreshSessions();
      emitState();
      break;
    }
    case "session.watch": {
      if (!command.watch) {
        renderedSessions.delete(command.sessionId);
        pendingWatchSessions.delete(command.sessionId);
        hiddenPaneSessions.delete(command.sessionId);
        const watched = liveSessions.get(command.sessionId);
        if (watched?.paneFlushTimer) {
          clearTimeout(watched.paneFlushTimer);
          watched.paneFlushTimer = undefined;
        }
        break;
      }
      const record = liveSessions.get(command.sessionId);
      renderedSessions.add(command.sessionId);
      if (command.hidden) {
        // 隐藏格：只登记模式，不推帧（渲染端仍有旧 paneStates，恢复可见时补水合）。
        hiddenPaneSessions.add(command.sessionId);
        if (record?.paneFlushTimer) {
          clearTimeout(record.paneFlushTimer);
          record.paneFlushTimer = undefined;
        }
        break;
      }
      if (hiddenPaneSessions.delete(command.sessionId) && record) {
        // 从隐藏切回可见：补推一帧，补上隐藏期间错过的更新。
        post({ type: "session.state", snapshot: paneSnapshotFrom(record) });
        break;
      }
      if (record) {
        // 立即推一帧全量，格子无需等该会话的下一个事件即可水合。
        post({ type: "session.state", snapshot: paneSnapshotFrom(record) });
      } else {
        // 会话还没 live（启动恢复逐格打开中）：挂起，createSession 后补挂。
        pendingWatchSessions.add(command.sessionId);
      }
      break;
    }
    case "session.invoke": {
      const prompt = runtimeInvocationPrompt(command.invocations, command.text, resolveTargetRecord(command.sessionId));
      await handleCommand({ type: "session.prompt", text: prompt, attachments: command.attachments, sessionId: command.sessionId });
      break;
    }
    case "session.prompt": {
      const record = resolveTargetRecord(command.sessionId);
      if (!record.session.model) throw new Error("请先配置并选择模型，再发送消息");
      if (record.busy) throw new Error("当前话题正在执行，请等待完成或停止后再发送");
      const prompt = await preparePromptPayload(command.text, command.attachments);
      if (prompt.images.length && !hasImageInput(record.session.model)) {
        if (!visionModel) throw new Error("当前模型不支持图片输入，请先切换多模态模型，或在设置的模型服务中启用视觉识别");
        appendVisionHint(prompt);
      }
      // dsh 式回合边界寿命（todo-plan-clears-on-next-turn）：显式发起新消息 =
      // 新任务周期，上一单的待办清单翻篇清空（写盘 + 广播），避免陈旧清单跨
      // 回合悬挂误导「本轮在做什么」。排队注入（followUp/steering，同一 agent
      // run 的延续）与 regenerate（重跑当前任务）不算边界、不清。
      if (record.todoStore.list().length > 0) record.todoStore.replaceAll([]);
      record.busy = true;
      record.status = "Pi 正在工作";
      record.abortRequested = false;
      record.runStatus = "running";
      patchSessionRunStatus(record);
      beginTurn(record);
      emitState();
      emitPaneStateFor(record);
      void record.session.prompt(prompt.text, prompt.images.length ? { images: prompt.images } : undefined).catch((error) => {
        // The record may have been parked (still live — update it so the dot
        // resolves) or torn down (workspace removal — nothing left to update).
        if (!liveSessions.has(record.session.sessionId)) return;
        completeTurn(record);
        record.busy = false;
        record.status = "请求失败";
        setTerminalRunStatus(record, "failed");
        post({ type: "error", message: errorText(error) });
        emitState();
        emitPaneStateFor(record);
        scheduleSessionsRefresh();
      });
      break;
    }
    case "session.queue.add": {
      const record = resolveTargetRecord(command.sessionId);
      if (!record.session.model) throw new Error("请先配置并选择模型，再发送消息");
      const queueText = command.invocations?.length
        ? runtimeInvocationPrompt(command.invocations, command.text, record)
        : command.text;
      const prompt = await preparePromptPayload(queueText, command.attachments);
      // Pi 的队列显示数组按非空文本寻址移除：空串会残留成幽灵队列项，之后任何
      // 整队重建还会把它（含图片）重新入队重复投递。纯图片排队没有正文时补一个
      // 占位文本（与文件附件折叠为路径清单同理，正文只进显示/注入，图仍完整）。
      const queueMessage = queuedMessageText(prompt.text, prompt.images.length);
      // 图片排队与直接发送同口径：模型不支持图片输入时给 recognize_images 提示
      // （不入队列拒绝——Pi 的 followUp 队列原生保存带图消息）。
      if (prompt.images.length && !hasImageInput(record.session.model)) {
        if (!visionModel) throw new Error("当前模型不支持图片输入，请先切换多模态模型，或在设置的模型服务中启用视觉识别");
        appendVisionHint(prompt);
      }
      if (record.busy || record.session.isStreaming) {
        // followUp 语义：本轮回复自然结束后，该消息（含图片）作为下一轮 user
        // 消息注入。Pi 队列本体完整保存带图消息；record.followUpImages 镜像与
        // Pi 的文本数组 index 对齐，供快照展示与整队重建时图片重放。
        await record.session.prompt(queueMessage, { streamingBehavior: "followUp", ...(prompt.images.length ? { images: prompt.images } : {}) });
        if (prompt.images.length) record.followUpImages.push(prompt.images);
      } else {
        // 排队瞬间回合恰好结束：直接按普通消息发送，避免消息滞留队列。文件附件
        // 已折叠进 prompt.text，只回传图片附件，防第二次折叠；hint 先剥一次让
        // session.prompt 管线重新追加，避免重复拼接。
        await handleCommand({
          type: "session.prompt",
          text: runtimeVision.stripVisionHint(queueMessage),
          attachments: prompt.images.length ? imageAttachmentsFrom(prompt.images) : undefined,
          sessionId: command.sessionId
        });
      }
      emitState();
      emitPaneStateFor(record);
      break;
    }
    case "session.queue.sendNow":
    case "session.queue.remove": {
      const record = command.sessionId ? liveSessions.get(command.sessionId) : activeRuntime;
      if (!record) break;
      const sendNow = command.type === "session.queue.sendNow";
      const state = alignQueueState(record.session.getSteeringMessages(), record.session.getFollowUpMessages(), record);
      // 快照与点击之间队列可能已投递/变动：text 校验失败即拒绝，防止误伤相邻消息。
      const outcome: PromoteOutcome = sendNow
        ? promoteQueueMessage(state, command.kind, command.index, command.text, record.busy || record.session.isStreaming)
        : { state: removeQueueMessage(state, command.kind, command.index, command.text), target: undefined };
      // 图片镜像跟随新队列（Pi 队列由 clearQueue + 重放重建；无图项为空数组）。
      record.steeringImages = outcome.state.steeringImages;
      record.followUpImages = outcome.state.followUpImages;
      // Pi 队列没有单项编辑 API：整队清空后按原顺序重建（sendNow 把目标提升为
      // steering，在当前回合下一次模型调用前插入，无需中断工具执行）。
      record.session.clearQueue();
      for (const item of replayQueueArgs(outcome.state)) {
        if (item.images.length) {
          await record.session[item.kind === "steering" ? "steer" : "followUp"](item.text, item.images);
        } else {
          await record.session[item.kind === "steering" ? "steer" : "followUp"](item.text);
        }
      }
      if (sendNow && !(record.busy || record.session.isStreaming) && outcome.target) {
        // 回合已结束（如失败收尾后队列仍在）：立即发送退化为直接开新回合，
        // 目标带图时还原为附件载荷走完整发送管线（hint 剥一次让管线重新
        // 追加，避免与排队时已拼入的提示重复）。
        await handleCommand({
          type: "session.prompt",
          text: runtimeVision.stripVisionHint(outcome.target.text),
          attachments: outcome.target.images.length ? imageAttachmentsFrom(outcome.target.images) : undefined,
          sessionId: command.sessionId
        });
      }
      emitState();
      emitPaneStateFor(record);
      break;
    }
    case "session.regenerate": {
      const record = resolveTargetRecord(command.sessionId);
      if (!record.session.model) throw new Error("请先配置并选择模型，再重新生成");
      if (record.busy) throw new Error("当前话题正在执行，请等待完成或停止后再重新生成");
      if (!command.text.trim() && !command.invocations?.length) throw new Error("没有可重新生成的用户消息");
      const regeneratedText = command.invocations?.length
        ? runtimeInvocationPrompt(command.invocations, command.text, record)
        : command.text.trim();
      const regeneratedPrompt = await preparePromptPayload(regeneratedText, command.attachments);
      if (regeneratedPrompt.images.length && !hasImageInput(record.session.model)) {
        if (!visionModel) throw new Error("当前模型不支持图片输入，请先切换多模态模型，或在设置的模型服务中启用视觉识别");
        appendVisionHint(regeneratedPrompt);
      }
      const regenerateSession = record.session;
      record.busy = true;
      record.status = "Pi 正在重新生成";
      record.abortRequested = false;
      record.runStatus = "running";
      patchSessionRunStatus(record);
      beginTurn(record);
      emitState();
      emitPaneStateFor(record);
      void (async () => {
        const branch = regenerateSession.sessionManager.getBranch();
        const target = branch.filter((entry) => {
          if (entry.type !== "message" || entry.message.role !== "user") return false;
          if (command.timestamp !== undefined) return entry.message.timestamp === command.timestamp;
          const text = userMessageText(entry.message);
          if (!command.invocations?.length) return text === command.text.trim();
          // 斜杠调用消息本体是展开后的 prompt：按展示 marker 还原调用清单与共享文本
          // 再比对（skill/命令单调用走 legacy marker，多调用走 invoke marker，同一入口）。
          const display = parseInvocationPrompt(text);
          return sameInvocations(display?.invocations, command.invocations) && display?.text === command.text.trim();
        }).at(-1);
        if (!target || target.type !== "message") throw new Error("找不到要重新生成的用户消息");
        await regenerateSession.navigateTree(target.id);
        await regenerateSession.prompt(regeneratedPrompt.text, regeneratedPrompt.images.length ? { images: regeneratedPrompt.images } : undefined);
      })().catch((error) => {
        if (!liveSessions.has(record.session.sessionId)) return;
        completeTurn(record);
        record.busy = false;
        record.status = "请求失败";
        setTerminalRunStatus(record, "failed");
        post({ type: "error", message: errorText(error) });
        emitState();
        emitPaneStateFor(record);
        scheduleSessionsRefresh();
      });
      break;
    }
    case "session.abort": {
      const record = command.sessionId ? liveSessions.get(command.sessionId) : activeRuntime;
      if (!record) break;
      // Aborts resolve the status dot to red: the run did not complete.
      record.abortRequested = true;
      record.session.abortCompaction();
      // 中断即放弃排队消息（Pi CLI 同款语义）：渲染端在点停止时把队列文本
      // 回填输入框供编辑重发；不清空的话滞留消息会混进下一次运行。
      record.session.clearQueue();
      record.steeringImages = [];
      record.followUpImages = [];
      void record.session.abort();
      // Make the task panel reflect the abort immediately: mark every running
      // tool execution as aborted so its card disappears without waiting for
      // the SDK's tool_execution_end (which may be delayed or never arrive
      // if the killed process tree hangs the tool promise). 中止不是失败：
      // 状态单列 aborted，渲染端转中性「已中止」而非红色失败。
      {
        let changed = false;
        for (const execution of record.executions.values()) {
          if (execution.status !== "running") continue;
          execution.status = "aborted";
          execution.completedAt = Date.now();
          execution.output = `${execution.output ?? ""}${execution.output ? "\n\n" : ""}（已中止）`;
          // 委派卡内的步骤同步封口：父执行中止后子代理的后续回报不再可信，
          // 残留的 running 步骤会在卡里无限转圈（与 subagent 的封口语义一致）。
          if (execution.delegation) {
            const delegation = execution.delegation;
            execution.delegation = {
              ...delegation,
              steps: delegation.steps.map((step) => step.status === "running" ? { ...step, status: "aborted" as const, completedAt: execution.completedAt } : step)
            };
          }
          changed = true;
        }
        if (changed) emitState();
        emitPaneStateFor(record);
      }
      break;
    }
    case "session.killExecution": {
      // 任务面板按命令停止：只杀这一条 shell 调用的进程树，会话不中止。
      // 工具会以错误结果收场（模型收到用户终止说明后继续本轮）；先标记
      // aborted 让面板卡片立即消失，tool_execution_end 的「中止保持」检查
      // 保证延迟到达的 end 事件不会把它翻回失败。
      const record = resolveTargetRecord(command.sessionId);
      if (!record.shellKill.kill(command.executionId)) throw new Error("该命令已结束，无需停止");
      const execution = record.executions.get(command.executionId);
      if (execution && execution.status === "running") {
        execution.status = "aborted";
        execution.completedAt = Date.now();
        emitState();
        emitPaneStateFor(record);
      }
      break;
    }
    case "session.planMode": {
      setPlanMode(resolveTargetRecord(command.sessionId), command.enabled);
      break;
    }
    case "session.designMode": {
      setDesignMode(resolveTargetRecord(command.sessionId), command.enabled);
      break;
    }
    case "session.computerMode": {
      setComputerMode(resolveTargetRecord(command.sessionId), command.enabled);
      break;
    }
    case "checkpoint.rollback": {
      const record = resolveTargetRecord(command.sessionId);
      const sessionId = record.session.sessionId;
      // 快照文件按 record.agent.id 算目录（同 plan-store 的教训：parked 会话
      // 切助手后不能用全局 currentAgent，否则写错目录）。
      const filePath = checkpointPathFor(join(getAgentDir(), "chatanytime-sessions", record.agent.id), sessionId);
      const entries = await readCheckpoints(filePath);
      const results = await rollbackPlan(record.workspace, command.targets, entries);
      // 给每个成功结果回填它的调用 id：渲染端据此把对应产物行标记为已回滚。
      const callIdsByPath = new Map(command.targets.map((target) => [target.relativePath, target.toolCallIds]));
      const annotated = results.map((result) => result.action === "skipped" ? result : { ...result, toolCallIds: callIdsByPath.get(result.relativePath) ?? [] });
      const restored = annotated.filter((item) => item.action === "restored").length;
      const deleted = annotated.filter((item) => item.action === "deleted").length;
      const skipped = annotated.filter((item) => item.action === "skipped").length;
      const message = annotated.length === 0
        ? "该文件没有可回滚的快照（可能早于该功能上线，或改动不经 write/edit/显式输出路径）"
        : `已回滚：恢复 ${restored} 个文件、删除 ${deleted} 个新建文件${skipped ? `、跳过 ${skipped} 个（详见结果）` : ""}`;
      post({ type: "checkpoint-result", sessionId, results: annotated, message });
      // 回滚改了盘上文件：重拉会话标题等不受影响，但需要刷新激活快照让渲染端
      // 重新读取预览索引（writeWorkspaceFile 内部已失效索引缓存）。
      emitState();
      emitPaneStateFor(record);
      break;
    }
    case "usage.stats.request": {
      // 跨助手扫会话 JSONL 聚合用量（按需拉取，不进快照）；按文件缓存命中时
      // 只重聚合，毫秒级返回。扫盘在 utility 进程，不阻塞主进程/渲染端。
      const filterAgentId = command.agentId;
      void collectUsageStats(join(getAgentDir(), "chatanytime-sessions"), usageStatsCache, filterAgentId)
        .then((stats) => post({ type: "usage-stats-result", stats }))
        .catch((error: unknown) => {
          post({ type: "error", message: `用量统计失败：${error instanceof Error ? error.message : String(error)}` });
        });
      break;
    }
    case "automation.save": {
      if (!currentAgent) throw new Error("当前没有可用 Agent");
      const task = normalizeAutomation(command.task);
      if (!task) throw new Error("自动化任务字段校验失败");
      // 按任务自身归属落位（设置页聚合列表可能编辑其他角色的任务）。
      upsertAutomation(automationStorePath(task.agentId), { ...task, agentId: task.agentId });
      afterAutomationChange(task.agentId);
      break;
    }
    case "automation.delete": {
      if (!currentAgent) throw new Error("当前没有可用 Agent");
      const deleteAgentId = command.agentId || currentAgent.id;
      deleteAutomation(automationStorePath(deleteAgentId), command.id);
      afterAutomationChange(deleteAgentId);
      break;
    }
    case "automation.toggle": {
      if (!currentAgent) throw new Error("当前没有可用 Agent");
      const toggleAgentId = command.agentId || currentAgent.id;
      toggleAutomation(automationStorePath(toggleAgentId), command.id, command.enabled);
      afterAutomationChange(toggleAgentId);
      break;
    }
    case "automation.run": {
      const runTask = readAllAutomations(getAgentDir()).find((candidate) => candidate.id === command.id);
      if (!runTask) throw new Error(`未找到任务 ${command.id}`);
      void runAutomationTask(runTask, "manual").catch((error: unknown) => {
        post({ type: "automation-run", id: command.id, status: "error", taskName: runTask.name, message: error instanceof Error ? error.message : String(error) });
      });
      break;
    }
    case "automation.run.open": {
      const run = automationRuns.find((candidate) => candidate.id === command.runId);
      if (!run) {
        post({ type: "error", message: "运行记录不存在（可能已被裁剪或尚未落盘）" });
        break;
      }
      // skipped 记录没有会话（跳过不是一次运行）：入口显式拒绝，给中性提示而不是
      // 让下游按 sessionId 去扫一个不存在的文件。
      if (run.status === "skipped" || !run.sessionId) {
        post({ type: "log", level: "info", message: `该条目是「已跳过」记录（${run.skipReason ?? "本轮未运行"}）：没有可回看的会话。` });
        break;
      }
      const runSessionId = run.sessionId;
      // 跨角色回看：运行会话归属任务的角色。同角色直接打开；跨角色先切换角色再打开
      // （点击前用户已知晓会发生切换，不做隐式切换）——复用 agent.select 完整管线
      // （含会话列表重拉），串行 await 后当前角色即任务归属角色。
      if (run.agentId !== settings?.currentAgentId) {
        try {
          await handleCommand({ type: "agent.select", agentId: run.agentId });
        } catch (error) {
          post({ type: "error", message: `切换到角色「${run.agentName}」失败：${errorText(error)}` });
          break;
        }
      }
      // 定位会话：liveSessions 命中（仍在本进程存活）→ 原位激活；未命中 → 按 sessionId
      // 在该角色的会话目录下扫描 JSONL 文件，走 session.open 相同的恢复逻辑。
      const live = liveSessions.get(runSessionId);
      if (live) {
        activate(live);
        emitState();
        break;
      }
      // 运行记录未存 workspace（历史事件流不快照运行上下文），按 sessionId 扫描任务角色的
      // 全部工作区会话目录（<agentDir>/chatanytime-sessions/<agentId>/**）。
      if (!agentSessionRoot()) {
        post({ type: "error", message: "当前没有可用 Agent，无法打开会话" });
        break;
      }
      const target = await findSessionFileById(await sessionDirectories(), runSessionId);
      if (!target) {
        post({ type: "error", message: "该运行的会话不存在（可能未持久化或已删除）" });
        break;
      }
      const discovered = SessionManager.open(target);
      const recordWorkspace = resolve(discovered.getCwd() ?? "");
      if (!recordWorkspace) {
        post({ type: "error", message: "会话缺少工作区信息，无法打开" });
        break;
      }
      // 校验用 record 自己的工作区目录（不经过全局 workspace 镜像），且在任何全局
      // 镜像改写之前：失败路径不写脏助手最后工作区（与 session.open 同纪律）。
      const recordRoot = currentAgent ? agentWorkspaceSessionDir(getAgentDir(), currentAgent.id, recordWorkspace) : undefined;
      if (!recordRoot || !sameSessionDir(recordRoot, dirname(target))) {
        post({ type: "error", message: "会话路径与工作区不匹配" });
        break;
      }
      const runRecordLive = liveSessions.get(discovered.getSessionId());
      if (runRecordLive) {
        activate(runRecordLive);
      } else {
        workspace = recordWorkspace;
        rememberWorkspace(workspace);
        await createSession(SessionManager.open(target, recordRoot, recordWorkspace));
      }
      emitState();
      break;
    }
    case "session.compact": {
      const record = resolveTargetRecord(command.sessionId);
      if (!record.session.model) throw new Error("请先配置并选择模型，再压缩上下文");
      if (record.busy) throw new Error("当前话题正在执行，请等待完成后再压缩上下文");
      record.busy = true;
      record.status = "Pi 正在压缩上下文";
      record.runStatus = "running";
      patchSessionRunStatus(record);
      beginTurn(record);
      appendCompactControlMessage(record, "compact-command", command.instructions ? `/compact ${command.instructions}` : "/compact");
      emitState();
      emitPaneStateFor(record);
      void runManualCompaction(() => record.session.compact(command.instructions)).then((outcome) => {
        if (!liveSessions.has(record.session.sessionId)) return;
        appendCompactControlMessage(record, "compact-result", outcome.message);
        completeTurn(record);
        record.busy = false;
        record.status = outcome.status;
        setTerminalRunStatus(record, outcome.type === "failed" ? "failed" : outcome.type === "cancelled" ? "aborted" : "completed");
        if (outcome.type === "failed") post({ type: "error", message: errorText(outcome.error) });
        emitState();
        emitPaneStateFor(record);
      });
      break;
    }
    case "model.select": {
      if (!modelRuntime) break;
      const model = modelRuntime.getModel(command.provider, command.id);
      if (!model) throw new Error(`无法识别模型 ${command.provider}/${command.id}`);
      const record = command.sessionId ? liveSessions.get(command.sessionId) : activeRuntime;
      if (record) {
        await switchSessionModel(record, model);
        // 全局镜像（新建会话的默认模型）只跟随激活会话的选择。
        if (record === activeRuntime) {
          selectedModel = { provider: command.provider, id: command.id };
          emitState();
        } else {
          emitPaneStateFor(record);
        }
      } else {
        selectedModel = { provider: command.provider, id: command.id };
        emitState();
      }
      break;
    }
    case "thinking.select": {
      const record = command.sessionId ? liveSessions.get(command.sessionId) : activeRuntime;
      if (record) {
        // 先算出该会话当前模型真实可用的档位再落值：Pi 的 setThinkingLevel 对不支持
        // 的档位会**静默 clamp**（比如请求 xhigh 而模型未声明映射 → 落回 high），
        // 用户看到的是「点了没反应」。这里把降级结果如实回报，菜单也有据可依。
        // 先把设置里的声明落到会话模型对象上：否则 Pi 会按「未声明」把很高/最高
        // 静默钳回 high，用户看到的就是「声明了还是选不中」。
        syncSessionModelMetadata(record);
        const available = availableThinkingLevels(record);
        const effective = clampThinkingLevel(available, command.level);
        record.session.setThinkingLevel(effective);
        if (effective !== command.level) {
          post({ type: "log", level: "warn", message: `思考等级 ${command.level} 在该模型上不可用，已使用 ${effective}（可选：${available.join("/") || "无"}）` });
        }
        if (record === activeRuntime) {
          thinkingLevel = record.session.thinkingLevel;
          emitState();
        } else {
          emitPaneStateFor(record);
        }
      } else {
        // 无活动会话（落地页）：只记全局默认，七档全开（无模型可判定）。
        thinkingLevel = command.level;
        emitState();
      }
      break;
    }
    case "auth.set":
      if (!modelRuntime) break;
      // 空 key = 沿用已保存的 key：不要用空串覆盖运行中的凭据。否则覆盖后
      // checkAuth 立即失败，配置页“仅勾选模型、留空 key”保存时会误报
      // “No API key for …”（自定义服务商 provider.save 已有此保护）。
      if (command.apiKey.trim()) await modelRuntime.setRuntimeApiKey(command.provider, command.apiKey.trim());
      await refreshCatalog();
      if (!activeRuntime?.session.model || activeRuntime.session.model.provider === command.provider) {
        const enabledModels = new Set(settings?.providers.flatMap((provider) => provider.models.filter((item) => item.enabled !== false).map((item) => `${provider.id}/${item.id}`)) ?? []);
        const first = modelRuntime.getModels(command.provider).find((model) => !settings?.providers.some((provider) => provider.id === command.provider) || enabledModels.has(`${command.provider}/${model.id}`))
          ?? modelRuntime.getModels(command.provider)[0];
        if (first) {
          selectedModel = { provider: first.provider, id: first.id };
          await switchSessionModel(activeRuntime, first);
        }
      }
      emitState();
      break;
    case "provider.save":
      if (!modelRuntime) break;
      registerCustomProvider(command.provider);
      await syncBuiltinProviderOverlays();
      if (settings) {
        settings.providers = settings.providers.some((provider) => provider.id === command.provider.id) ? settings.providers.map((provider) => provider.id === command.provider.id ? command.provider : provider) : [...settings.providers, command.provider];
        // 取消全部模型（清空自定义服务）是合法操作：默认模型/助手默认/视觉模型
        // 不能再指向已移除的模型（与 provider.models.save 的落位一致）。
        settings = pruneDisabledModelRefs(settings, command.provider.id, command.provider.models);
      }
      if (command.apiKey?.trim()) {
        apiKeys[command.provider.id] = command.apiKey.trim();
        await modelRuntime.setRuntimeApiKey(command.provider.id, command.apiKey.trim());
      }
      await refreshCatalog();
      {
        const first = modelRuntime.getModels(command.provider.id)[0];
        if (first) {
          selectedModel = { provider: first.provider, id: first.id };
          await switchSessionModel(activeRuntime, first);
          // 思考等级声明顺带落值（原因见 applyDeclaredThinkingLevel）。
          applyDeclaredThinkingLevel(activeRuntime, first);
        } else if (selectedModel?.provider === command.provider.id) {
          const fallback = pickFallbackModel(modelRuntime.getModels(), settings?.providers, providerConfigured, command.provider.id);
          selectedModel = fallback ? { provider: fallback.provider, id: fallback.id } : undefined;
          if (fallback) await switchSessionModel(activeRuntime, fallback);
          applyStatusToActive(fallback ? `当前服务没有启用模型，已切换到 ${fallback.name}` : "当前服务没有启用模型，请在设置中勾选模型");
        }
      }
      emitState();
      break;
    case "provider.models.save": {
      if (!modelRuntime) break;
      if (settings) settings.providers = settings.providers.some((provider) => provider.id === command.provider.id) ? settings.providers.map((provider) => provider.id === command.provider.id ? command.provider : provider) : [...settings.providers, command.provider];
      await syncBuiltinProviderOverlays();
      await refreshCatalog();
      const enabledIds = new Set(command.provider.models.filter((model) => model.enabled !== false).map((model) => model.id));
      // 取消勾选的模型不能继续留在会话上（2026-09 修复：现在允许保存「零启用
      // 模型」以清空某服务商）：空闲会话就地切到本服务剩余启用模型，没有则
      // 退回任意已配置且启用的模型；运行中的会话不动，等下一次手动切换。
      for (const record of liveSessions.values()) {
        const current = record.session.model;
        if (!current || current.provider !== command.provider.id) continue;
        if (record.busy) {
          // 运行中的会话不中途换模型（与既有取舍一致），但被取消勾选至少要有感知：
          // 提示用户本轮结束后手动切换（2026-09-02 审查）。
          if (record === activeRuntime && !enabledIds.has(current.id)) {
            applyStatusToActive(`当前会话正在使用已取消勾选的模型 ${current.name}，本轮结束后请在顶栏切换`);
          }
          continue;
        }
        if (enabledIds.has(current.id)) {
          // Token 限额/图片标记/思考等级声明手动修正后立即对正使用该服务商模型的空闲
          // 会话生效（switchSessionModel 内部走 applyModelOverrides）。
          const refreshed = modelRuntime.getModel(current.provider, current.id) ?? current;
          await switchSessionModel(record, refreshed);
          applyDeclaredThinkingLevel(record, refreshed);
          continue;
        }
        const next = modelRuntime.getModels(command.provider.id).find((model) => enabledIds.has(model.id))
          ?? pickFallbackModel(modelRuntime.getModels(), settings?.providers, providerConfigured, command.provider.id);
        if (record === activeRuntime) selectedModel = next ? { provider: next.provider, id: next.id } : undefined;
        if (next) {
          await switchSessionModel(record, next);
          if (record === activeRuntime) applyStatusToActive(`${current.name} 已取消勾选，已切换到 ${next.name}`);
        } else if (record === activeRuntime) {
          applyStatusToActive("当前服务没有启用模型，请在设置中勾选模型");
        }
      }
      if (settings) {
        // 默认模型/助手默认模型/视觉模型指向已取消勾选的模型时同步失效（与
        // provider.delete 同款落位，保存后重建会话不会又拉起被移除的模型）。
        settings = pruneDisabledModelRefs(settings, command.provider.id, command.provider.models);
      }
      emitState();
      break;
    }
    case "provider.delete":
      modelRuntime?.unregisterProvider(command.providerId);
      // 删除条目时清掉该服务商残留的 models-store 覆盖键，还原目录（幂等）。
      await syncBuiltinProviderOverlays();
      await refreshCatalog();
      if (settings) {
        settings.providers = settings.providers.filter((provider) => provider.id !== command.providerId);
        settings.model = settings.model?.provider === command.providerId ? undefined : settings.model;
        settings.agents = settings.agents.map((agent) => agent.defaultModel?.provider === command.providerId ? { ...agent, defaultModel: undefined } : agent);
        // 视觉模型引用一并失效（2026-09-02 审查：与模型清理同口径）。
        if (settings.vision?.provider === command.providerId) settings.vision = { ...settings.vision, enabled: false };
        if (selectedModel?.provider === command.providerId) {
          const fallbackModel = modelRuntime ? pickFallbackModel(modelRuntime.getModels(), settings?.providers, providerConfigured, command.providerId) : undefined;
          selectedModel = fallbackModel ? { provider: fallbackModel.provider, id: fallbackModel.id } : undefined;
          if (fallbackModel) await switchSessionModel(activeRuntime, fallbackModel);
          applyStatusToActive(fallbackModel ? `原模型已删除，已切换到 ${fallbackModel.name}` : "原模型已删除，请先配置模型");
          emitState();
        }
      }
      break;
    case "provider.models.fetch":
      try {
        const fetched = await fetchCustomProviderModels(command.baseUrl, command.apiKey ?? apiKeys[command.providerId] ?? "");
        const current = settings?.providers.find((provider) => provider.id === command.providerId)?.models ?? [];
        post({ type: "custom-models", providerId: command.providerId, models: mergeProviderModels(current, fetched) });
      } catch (error) {
        post({ type: "custom-model-error", providerId: command.providerId, message: errorText(error) });
      }
      break;
    case "provider.models.refresh": {
      // 内置服务商拉取最新模型。SDK 的目录刷新仅覆盖 Radius 网关等实现了
      // refreshModels 的渠道；大多数内置渠道（opencode-go/zai-coding-cn/minimax/
      // deepseek 等）的模型表是随应用版本打包的静态表，主路径 refresh 对它们
      // 无操作且不报错——若按“errors 为空即成功”判定会误报刷新完成而模型
      // 一个都没更新。这里改为：目标渠道有官方 /models 接口（直连表）就一律
      // 直连拉最新并注入覆盖层；只有 Radius 类远程目录渠道走 SDK 远程刷新；
      // 其余无官方列表接口的渠道给出明确提示，不假装成功。
      if (!modelRuntime) break;
      const refreshProviderId = command.providerId;
      if (refreshProviderId in BUILTIN_MODELS_ENDPOINTS) {
        await refreshBuiltinModelsFallback(refreshProviderId);
        break;
      }
      if (refreshProviderId !== "radius") {
        post({ type: "models-refresh-error", providerId: refreshProviderId, message: "该服务商暂未开放官方模型列表接口，模型目录随应用版本更新" });
        break;
      }
      // Radius 网关：走 SDK 远程目录刷新（带 30 秒超时，失败给出可读错误）。
      const refreshController = new AbortController();
      const refreshTimeout = setTimeout(() => refreshController.abort(), 30_000);
      try {
        const auth = modelRuntime.getProviderAuthStatus(refreshProviderId);
        if (!auth?.configured) {
          post({ type: "models-refresh-error", providerId: refreshProviderId, message: "请先填写并保存该服务商的 API 密钥，再拉取最新模型列表" });
          break;
        }
        post({ type: "log", level: "info", message: `开始拉取 ${refreshProviderId} 模型列表` });
        const result = await modelRuntime.refresh({ allowNetwork: true, force: true, signal: refreshController.signal });
        // 无论结果如何都重新发布目录，反映已应用的部分刷新。
        await refreshCatalog();
        // 网络刷新（pi.dev 远程目录）会整体覆写各渠道的持久化条目；重放设置里的
        // 接口地址/API 覆盖，避免 UI 显示的覆盖值与实际请求端点分叉（审查 P1-2）。
        await syncBuiltinProviderOverlays();
        const relevantErrors = [...result.errors].filter(([providerId]) => providerId === refreshProviderId);
        for (const [providerId, error] of [...result.errors]) {
          if (providerId !== refreshProviderId) {
            post({ type: "log", level: "warn", message: `刷新服务商 ${providerId} 模型列表失败：${errorText(error)}` });
          }
        }
        if (!refreshController.signal.aborted && relevantErrors.length === 0) {
          post({ type: "models-refreshed", providerId: refreshProviderId });
        } else {
          post({ type: "models-refresh-error", providerId: refreshProviderId, message: refreshController.signal.aborted ? "拉取模型列表超时" : (relevantErrors.map(([, error]) => errorText(error)).join("；") || "拉取模型列表失败") });
        }
      } catch (error) {
        post({ type: "models-refresh-error", providerId: refreshProviderId, message: errorText(error) });
      } finally {
        clearTimeout(refreshTimeout);
      }
      break;
    }
    case "vision.save": {
      if (settings) settings.vision = command.vision;
      visionModel = modelRuntime ? resolveVisionModel(command.vision, modelRuntime, (model) => hasImageInput(model)) : undefined;
      break;
    }
    // Jev 配置镜像与密钥写入（utility 侧）。密钥只进 apiKeys 内存表：它随 initialize
    // 整包下发（main 侧 credentialsCache），所以这里写入后同一进程内立即生效；
    // 下一次启动仍由 initialize 重放。总闸翻转要重算活动集（browser_jev_run 的注入
    // 与否 = 前缀是否变化），否则已开会话要等重启才能拿到/丢掉工具。
    case "jev.save": {
      const switchChanged = (settings?.jev?.enabled === true) !== (command.jev?.enabled === true);
      if (settings) settings.jev = command.jev;
      if (command.apiKey?.trim()) apiKeys[JEV_CREDENTIAL_ID] = command.apiKey.trim();
      if (switchChanged) for (const record of liveSessions.values()) reconcileActiveTools(record);
      break;
    }
    case "jev.clearKey":
      delete apiKeys[JEV_CREDENTIAL_ID];
      break;
    // 「测试连接」：拿设置页的草稿值（未保存的也必须能测）发一次真实探测请求。
    // 刻意不看 `settings.jev.enabled`、也不写任何配置——否则用户会卡在「不启用不能测、不测不敢启用」。
    // 草稿全空时用已保存值兵底（用户已经配好、只想确认一下时不必重填）。
    case "jev.test": {
      const saved = settings?.jev;
      const baseUrl = command.baseUrl?.trim() || saved?.baseUrl || "";
      const model = command.model?.trim() || saved?.model || "jev-latest";
      const key = command.apiKey?.trim() || apiKeys[JEV_CREDENTIAL_ID]?.trim() || "";
      const result = await runtimeJev.probeJev({ baseUrl, model, apiKey: key });
      post({ type: "jev-test-result", ok: result.ok, message: result.message, ...(result.model ? { model: result.model } : {}), ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}) });
      break;
    }
    case "memory.save": {
      // 快照/治理块按会话冻结，开关自下一个会话生效；工具 execute 实时判断。
      if (settings) settings.memory = command.memory;
      break;
    }
    case "agent.select": {
      if (!settings?.agents.some((agent) => agent.id === command.agentId && !agent.archived)) throw new Error("Agent 不存在或已归档");
      // A running session is parked, not killed: switching agents while a turn
      // is executing keeps that turn running in the background.
      const previousAgentId = settings.currentAgentId;
      const previousModel = selectedModel;
      const previousWorkspace = workspace;
      // 目标助手的工作区记忆：显式使用过 → 恢复各自最后工作区；从未用过 → 默认工作区（开箱直接可聊）。
      const mappedWorkspace = settings.agentWorkspaces?.[command.agentId]
        ? resolve(settings.agentWorkspaces[command.agentId]!)
        : agentDefaultWorkspace();
      settings.currentAgentId = command.agentId;
      currentAgent = activeAgent();
      workspace = mappedWorkspace;
      if (workspace) touchRecentWorkspace(workspace);
      selectedModel = currentAgent.defaultModel ?? settings.model;
      // 自动化任务是 Agent 级：切换后列表与调度器的 getTasks 随之读新 Agent。
      refreshAutomation();
      automationScheduler?.refresh();
      transitionStatus = `正在切换到 ${currentAgent.name}`;
      emitState();
      try {
        if (workspace) await createSession(undefined, { reactivate: true });
        else status = "就绪";
      } catch (error) {
        settings.currentAgentId = previousAgentId;
        currentAgent = activeAgent();
        selectedModel = previousModel;
        // 失败回滚：workspace 不许残留目标目录（切角色失败时仍在原工作区可聊）。
        workspace = previousWorkspace;
        status = "Agent 切换失败";
        // createSession 可能已按切换目标重拉过会话列表，回滚后需按原角色再刷。
        void refreshSessions().then(() => emitState()).catch((refreshError) => {
          post({ type: "log", level: "warn", message: `刷新会话列表失败：${errorText(refreshError)}` });
        });
        emitState();
        throw error;
      } finally {
        transitionStatus = undefined;
        emitState();
      }
      break;
    }
    case "agent.save":
      if (settings) {
        if (activeRuntime?.busy && settings.currentAgentId === command.agent.id) throw new Error("当前会话正在运行，请等待完成后再保存当前 Agent");
        const isCurrent = settings.currentAgentId === command.agent.id;
        settings.agents = settings.agents.some((item) => item.id === command.agent.id) ? settings.agents.map((item) => item.id === command.agent.id ? command.agent : item) : [...settings.agents, command.agent];
        currentAgent = activeAgent();
        if (isCurrent && workspace) {
          transitionStatus = `正在应用 ${currentAgent.name} 配置`;
          emitState();
          try {
            // No reactivate here: applying an agent profile must rebuild the
            // active session even when its session id is already live.
            await createSession();
          } catch (error) {
            status = "Agent 配置应用失败";
            emitState();
            throw error;
          } finally {
            transitionStatus = undefined;
            emitState();
          }
        } else emitState();
      }
      break;
    case "settings.save": {
      if (!settings) break;
      // 同步默认工作区前先记住旧值：当前正落在旧默认上时下面要即时切到新默认。
      const previousDefaultPath = resolveDefaultWorkspace(getAgentDir(), settings.defaultWorkspace);
      // 总闸是否真的翻转：只有翻转才需要重算活动集（design_* / computer_* 注入与否）。
      // 无关保存（只改模型/外观等）不碰活动集，避免白做一次前缀重算。
      const designSwitchChanged = (settings.design?.enabled !== false) !== (command.settings.design?.enabled !== false);
      // 电脑控制总闸同理：它同时是能力下架开关与会话级注入的总闸。
      const computerSwitchChanged = (settings.computer?.enabled !== false) !== (command.settings.computer?.enabled !== false);
      // Jev 总闸同理（缺省关闭：=== true 才算开）：它决定 browser_jev_run 是否注入
      // 本次请求的活动工具集，所以翻转必须重算，否则已开的会话要等重启才生效。
      const jevSwitchChanged = (settings.jev?.enabled === true) !== (command.settings.jev?.enabled === true);
      // 浏览器/SSH 总闸同理：它们现在决定整族工具是否注入活动集（不再是「常驻激活 +
      // execute 拒绝」），翻转要重算——且遍历全部 live 会话（含 parked 后台会话），与
      // jev.save 同款。
      const browserSwitchChanged = (settings.browser?.enabled !== false) !== (command.settings.browser?.enabled !== false);
      const sshSwitchChanged = (settings.ssh?.enabled !== false) !== (command.settings.ssh?.enabled !== false);
      settings.model = command.settings.model;
      settings.thinkingLevel = command.settings.thinkingLevel;
      settings.accessMode = command.settings.accessMode;
      settings.appearance = command.settings.appearance;
      // browser/computer/design 总开关镜像补齐（若内存镜像滞后，保存后开关不生效直至重启）。
      // browser/ssh 总闸兼作活动集摘除开关（翻转在下方遍历 liveSessions 重算）；
      // computer/design 总闸重算活动集（决定 computer_* / design_* 是否注入前缀）。
      settings.browser = command.settings.browser;
      settings.jev = command.settings.jev;
      settings.computer = command.settings.computer;
      settings.design = command.settings.design;
      settings.ssh = command.settings.ssh;
      settings.defaultWorkspace = command.settings.defaultWorkspace;
      thinkingLevel = command.settings.thinkingLevel;
      accessMode = command.settings.accessMode;
      selectedModel = command.settings.model;
      if (activeRuntime) {
        activeRuntime.session.setThinkingLevel(thinkingLevel);
        if (selectedModel) {
          const model = modelRuntime?.getModel(selectedModel.provider, selectedModel.id);
          if (model) await switchSessionModel(activeRuntime, model);
        }
        // 总闸刚被切换（settings.design.enabled / settings.computer.enabled）：工具的注入
        // 由它们把关，重算活动集——已开的会话内关总闸立即撤工具，不必重建会话。放在模型
        // 切换之后，保证最终活动集以最新镜像为准。
        if (designSwitchChanged || computerSwitchChanged || jevSwitchChanged) reconcileActiveTools(activeRuntime);
      }
      // 浏览器/SSH 总闸翻转：整族注入与否变化，遍历全部 live 会话（含 parked 后台
      // 会话）重算活动集；无关保存不碰，避免白做前缀重算。放在镜像赋值之后，以最新镜像为准。
      if (browserSwitchChanged || sshSwitchChanged) for (const record of liveSessions.values()) reconcileActiveTools(record);
      // 更换默认工作区：当前 workspace 恰为旧默认 → 即时切到新默认（新会话继承刚
      // 保存的模型/思考等级）；否则下次落位（新建/切换/移除回落）自然生效。
      const nextDefaultPath = resolveDefaultWorkspace(getAgentDir(), settings.defaultWorkspace);
      const currentKey = workspace ? resolve(workspace).toLowerCase() : undefined;
      if (currentKey && currentKey === previousDefaultPath.toLowerCase() && currentKey !== nextDefaultPath.toLowerCase()) {
        workspace = agentDefaultWorkspace();
        if (workspace) {
          touchRecentWorkspace(workspace);
          const sessionDir = workspaceSessionDir();
          if (sessionDir) await createSession(SessionManager.create(workspace, sessionDir));
        }
      }
      emitState();
      break;
    }
    case "agent.archive":
      if (settings && command.agentId !== "default") { settings.agents = settings.agents.map((item) => item.id === command.agentId ? { ...item, archived: command.archived } : item); if (settings.currentAgentId === command.agentId) { settings.currentAgentId = "default"; currentAgent = activeAgent(); } if (workspace) await createSession(undefined, { reactivate: true }); }
      break;
    case "appearance.save":
      break;
    case "resources.reload":
      forceMcpRefresh = true;
      await runResourceOperation("正在重载能力资源", reloadRuntimeResources);
      break;
    case "mcp.server.save": {
      const server = command.server;
      const name = server.name.trim();
      if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new Error("MCP Server 名称只能包含字母、数字、点、下划线和短横线");
      const paths = mcpConfigPaths();
      const original = command.original;
      await runResourceOperation("正在保存 MCP Server", async () => {
        // 计划里带「原位置删除」：编辑时切换写入范围 = 迁移条目，而不是在两个
        // 文件里各留一份（同名时项目配置优先，残留副本会静默遮蔽这次修改）。
        const plan = runtimeMcp.planMcpServerSave(paths, { ...server, name }, original);
        if (plan.remove) removeMcpServerConfig(plan.remove.path, plan.remove.name);
        upsertMcpServerConfig(plan.targetPath, name, plan.entry);
        forceMcpRefresh = true;
        await applyMcpToolChanges();
      });
      break;
    }
    case "mcp.server.auth": {
      if (!/^[A-Za-z0-9._-]+$/u.test(command.name)) throw new Error("MCP Server 名称无效");
      const { project, global } = mcpConfigPaths();
      const target = readConfiguredMcpServers(project, global).find((server) => server.name === command.name);
      if (!target) throw new Error("找不到要认证的 MCP Server");
      if (!mcpOAuth.supports(target)) throw new Error("仅 HTTP（且未使用 Bearer 环境变量）的 MCP Server 支持 OAuth 认证");
      await runResourceOperation("正在准备 MCP 授权", async () => {
        // 已开过授权页（等待回调中）→ 重新打开，不重走发现/注册。
        if (await mcpOAuth.reopenAuthorization(command.name)) return;
        // 显式选了 OAuth 的 server 不等 401：直接走 SDK 的授权编排（无凭据时
        // 打开浏览器；已有/刚刷新的 token 则直接重连）。
        if (target.entry.auth === "oauth") {
          // 用户主动点「认证」：允许把上一次被判失效、但仍保留着的 refresh_token
          // 再试一次（成功即免去浏览器往返）。
          const outcome = await mcpOAuth.authorizeInteractive(target);
          // 已开授权页等回调：不要再强制重连一次。重连会再走一遍 SDK auth()，把凭据库里的
          // state/codeVerifier 覆写成新流程的，用户浏览器里那个授权页回来就成了废页。
          // 授权成功的重连由 onAuthorized 兜底。
          if (outcome === "pending") return;
          forceMcpRefresh = true;
          await syncMcpServers(true);
          forceMcpRefresh = false;
          post({ type: "log", level: "info", message: outcome === "authorized" ? `${command.name} 已使用已保存的凭据完成授权` : `${command.name} 已在浏览器中打开授权页` });
          return;
        }
        // 未显式声明的 server：强制重连，401 时由 SDK 触发授权。同样借用用户主动
        // 意图的闸门，让保留的凭据有机会重试一次。
        forceMcpRefresh = true;
        await mcpOAuth.runUserInitiated(command.name, () => syncMcpServers(true));
        forceMcpRefresh = false;
        if (!mcpOAuth.hasPending(command.name)) {
          post({ type: "log", level: "info", message: `${command.name} 未要求 OAuth 认证，已直接连接` });
        }
      });
      break;
    }
    case "mcp.server.auth.clear": {
      if (!/^[A-Za-z0-9._-]+$/u.test(command.name)) throw new Error("MCP Server 名称无效");
      await runResourceOperation("正在清除 MCP 凭据", async () => {
        await mcpOAuth.clear(command.name);
        forceMcpRefresh = true;
        await syncMcpServers(true);
        forceMcpRefresh = false;
      });
      break;
    }
    case "mcp.server.toggle": {
      if (!/^[A-Za-z0-9._-]+$/u.test(command.name)) throw new Error("MCP Server 名称无效");
      await runResourceOperation(command.enabled ? "正在启用 MCP Server" : "正在停用 MCP Server", async () => {
        const { project, global } = mcpConfigPaths();
        if (!setMcpServerDisabled(project, command.name, !command.enabled) && !setMcpServerDisabled(global, command.name, !command.enabled)) {
          throw new Error("找不到要切换的 MCP Server");
        }
        forceMcpRefresh = true;
        await applyMcpToolChanges();
      });
      break;
    }
    case "mcp.server.delete": {
      if (!/^[A-Za-z0-9._-]+$/u.test(command.name)) throw new Error("MCP Server 名称无效");
      await runResourceOperation("正在删除 MCP Server", async () => {
        const { project, global } = mcpConfigPaths();
        const target = command.scope === "project" ? project : global;
        const other = command.scope === "project" ? global : project;
        // 作用域提示可能过期（条目已被迁移到另一个文件）：先按声明的位置删，
        // 找不到再尝试另一个文件，避免「明明看得见却删不掉」。
        if (!removeMcpServerConfig(target, command.name) && !removeMcpServerConfig(other, command.name)) throw new Error("找不到要删除的 MCP Server");
        forceMcpRefresh = true;
        // Deletion always removes tools → applyMcpToolChanges falls back to a
        // session rebuild (Pi has no tool-removal API).
        await applyMcpToolChanges();
      });
      break;
    }
    case "command.save": {
      // 与 hooks.save 同款轻量模式：只写文件 + 刷目录，不重建会话、不拒绝
      // 运行中的会话（发送时重读文件，下一次发送自然生效）。
      const draft = commandCatalog.validateCommandDraft(command.command);
      const { globalDir, projectDir } = commandPaths();
      if (command.command.scope === "project" && !workspace) throw new Error("请先打开工作区，再保存项目级命令");
      commandCatalog.writeCommandFile(command.command.scope === "project" ? projectDir : globalDir, draft.name, draft.description, draft.template);
      syncCommands();
      emitResourceCatalog();
      break;
    }
    case "command.delete": {
      if (!COMMAND_NAME_PATTERN.test(command.name)) throw new Error("命令名无效");
      const { globalDir, projectDir } = commandPaths();
      if (command.scope === "project" && !workspace) throw new Error("请先打开工作区，再删除项目级命令");
      if (!commandCatalog.deleteCommandFile(command.scope === "project" ? projectDir : globalDir, command.name)) throw new Error("找不到要删除的命令文件");
      syncCommands();
      emitResourceCatalog();
      break;
    }
    case "hooks.save": {
      const draft = command.hook;
      const rule: HookRule = {
        name: draft.name.trim(),
        event: draft.event,
        ...(draft.matcher?.trim() ? { matcher: draft.matcher.trim() } : {}),
        ...(draft.timeoutMs ? { timeoutMs: draft.timeoutMs } : {}),
        action: draft.action
      };
      validateHookRule(rule);
      const { project, global } = hooksConfigPaths();
      const target = draft.scope === "project" ? project : global;
      if (!target) throw new Error("请先打开工作区，再保存项目级钩子");
      // 钩子规则是事件触发时读取的缓存，不重建会话；也无需像 MCP 一样拒绝
      // 运行中的会话——用户可能正想在中途停用某条危险钩子。
      upsertHookConfig(target, rule);
      refreshHooksConfig();
      emitResourceCatalog();
      break;
    }
    case "hooks.toggle": {
      const { project, global } = hooksConfigPaths();
      const toggled = (project ? setHookDisabled(project, command.name, !command.enabled) : false) || setHookDisabled(global, command.name, !command.enabled);
      if (!toggled) throw new Error("找不到要切换的钩子");
      refreshHooksConfig();
      emitResourceCatalog();
      break;
    }
    case "hooks.delete": {
      const { project, global } = hooksConfigPaths();
      const target = command.scope === "project" ? project : global;
      if (!target || !removeHookConfig(target, command.name)) throw new Error("找不到要删除的钩子");
      refreshHooksConfig();
      emitResourceCatalog();
      break;
    }
    case "hooks.settings": {
      if (settings) settings.hooks = command.hooks;
      emitResourceCatalog();
      break;
    }
    case "hooks.run": {
      const entry = hooksRules.find((item) => item.name === command.name && item.scope === command.scope);
      if (!entry) throw new Error("找不到要测试的钩子");
      const outcome = await runtimeHooks.testHook(entry.rule, command.sample, {
        agentName: () => currentAgent?.name ?? "",
        workspace: () => workspace,
        post
      });
      post({ type: "hook-run", name: command.name, scope: command.scope, ok: outcome.ok, ...(outcome.blocked ? { blocked: outcome.blocked } : {}), detail: outcome.detail, durationMs: outcome.durationMs });
      break;
    }
    case "skill.toggle": {
      await runResourceOperation(command.enabled ? "正在启用 Skill" : "正在停用 Skill", async () => {
        setSkillEnabled(skillPaths().statePath, command.id, command.enabled);
        await reloadRuntimeResources();
      });
      break;
    }
    case "subagent.save": {
      // 子智能体定义写入目标作用域文件（项目级用当前工作区）；刷新渲染端列表。
      // 保存后重建活动会话：按名委派靠 execute 实读的定义已即时可用，但系统提示里
      // 的可用清单与会话内新增的参考文本是创建会话时写入的，不重建就看不到改动。
      saveSubagent(workspace, getAgentDir(), command.subagent);
      refreshSubagents();
      emitResourceCatalog();
      await refreshActiveSessionForSubagents();
      break;
    }
    case "subagent.delete": {
      const scope = command.scope as SubagentScope;
      if (!deleteSubagent(workspace, getAgentDir(), command.id, scope)) throw new Error("找不到要删除的子智能体");
      refreshSubagents();
      emitResourceCatalog();
      break;
    }
    case "subagent.model": {
      // 内置定义只读，用户能改的只有「执行模型」：写覆盖表 → 重读目录 → 刷新列表。
      saveSubagentModelOverride(getAgentDir(), command.id, command.model);
      refreshSubagents();
      emitResourceCatalog();
      break;
    }
    case "subagent.transcript": {
      // 只读子代理完整记录：校验路径落在当前 Agent 的 delegations/ 内（防目录逃逸，
      // pathIsWithin 现成），逐行 parse JSONL 的 message entries，经 normalizeMessages
      // 归一化为 ChatMessage[] 推送回渲染端；文件不存在（子代理尚无 assistant 输出，
      // Pi _persist 的 hasAssistant 门槛）或校验失败时走专用错误消息（弹窗内展示），
      // 不走全局 toast——否则弹窗会一直停在「正在读取」spinner。
      const root = agentSessionRoot();
      const delegationsRoot = root ? join(root, "delegations") : undefined;
      const target = resolve(command.path);
      if (!delegationsRoot || !pathIsWithin(delegationsRoot, target) || !target.toLowerCase().endsWith(".jsonl")) {
        post({ type: "subagent.transcript-error", childSessionId: command.childSessionId, message: "只能读取当前 Agent 的委派子代理记录。" });
        break;
      }
      let content: string;
      try {
        content = await readFile(target, "utf8");
      } catch {
        post({ type: "subagent.transcript-error", childSessionId: command.childSessionId, message: "子代理尚未产生输出，无法查看完整记录。" });
        break;
      }
      const rows = content.split(/\r?\n/u).filter(Boolean).map((line) => {
        try { return JSON.parse(line) as PersistedSessionEntry; } catch { return undefined; }
      }).filter((entry): entry is PersistedSessionEntry => Boolean(entry));
      post({ type: "subagent.transcript-result", childSessionId: command.childSessionId, messages: transcriptMessagesFromEntries(rows) });
      break;
    }
    case "memory.create": {
      if (!memoryStore) throw new Error("当前没有可用的记忆存储，请先打开一个会话");
      memoryStore.save({
        title: command.topic,
        description: command.description,
        content: command.content,
        ...(command.workspaceScoped && workspace ? { bindWorkspace: workspace } : {})
      });
      break;
    }
    case "memory.update": {
      if (!memoryStore) throw new Error("当前没有可用的记忆存储，请先打开一个会话");
      if (!memoryStore.read(command.topic)) throw new Error(`未找到记忆主题「${command.topic}」`);
      // 不传 bindWorkspace：面板编辑保留既有工作区绑定（store upsert 语义）。
      memoryStore.save({ title: command.topic, description: command.description, content: command.content });
      break;
    }
    case "memory.delete": {
      if (!memoryStore) throw new Error("当前没有可用的记忆存储，请先打开一个会话");
      if (!memoryStore.remove(command.topic)) throw new Error(`未找到记忆主题「${command.topic}」`);
      break;
    }
    case "background.kill":
      if (!backgroundProcesses.kill(command.id)) throw new Error("找不到该后台进程");
      break;
    case "permission.resolve": {
      permissionBroker.resolve(command.id, command.decision);
      break;
    }
    case "question.resolve": {
      questionBroker.resolve(command.id, command.answers, command.model);
      break;
    }
    // —— 设计模式：画布命令（与 design_* 工具共用同一存储/推送管线）——
    case "design.list": {
      const record = resolveTargetRecord(command.sessionId);
      post({ type: "design.docs", docs: listDesigns(record.workspace) });
      break;
    }
    case "design.new": {
      const record = resolveTargetRecord(command.sessionId);
      const name = sanitizeDesignName(command.name);
      if (!name) throw new Error("请提供有效的文档名");
      // 同名文档已存在则直接打开（与 design_create 幂等语义一致）。
      const existing = readDesign(designFilePath(record.workspace, name));
      const doc = existing ?? createDesignDoc(name, command.width, command.height);
      if (!existing) writeDesign(record.workspace, doc);
      record.designDoc = { doc, fileName: `${name}${DESIGN_FILE_SUFFIX}` };
      postDesignState(record, doc);
      post({ type: "design.docs", docs: listDesigns(record.workspace) });
      break;
    }
    case "design.open": {
      const record = resolveTargetRecord(command.sessionId);
      const name = sanitizeDesignName(command.name);
      const doc = readDesign(designFilePath(record.workspace, name));
      if (!doc) throw new Error(`找不到设计文档「${name}」`);
      record.designDoc = { doc, fileName: `${name}${DESIGN_FILE_SUFFIX}` };
      postDesignState(record, doc);
      break;
    }
    case "design.edit": {
      const record = resolveTargetRecord(command.sessionId);
      const bound = record.designDoc;
      if (!bound) throw new Error("当前会话没有打开的设计文档");
      const applied = applyDesignOps(bound.doc, command.ops);
      if (!applied.ok) throw new Error(applied.error);
      const next: DesignDoc = { ...applied.doc, revision: applied.doc.revision + 1 };
      const fileName = writeDesign(record.workspace, next, bound.fileName);
      record.designDoc = { doc: next, fileName };
      postDesignState(record, next);
      break;
    }
    case "design.save": {
      const record = resolveTargetRecord(command.sessionId);
      const bound = record.designDoc;
      if (!bound) throw new Error("当前会话没有打开的设计文档");
      const fileName = writeDesign(record.workspace, bound.doc, bound.fileName);
      record.designDoc = { doc: bound.doc, fileName };
      postDesignState(record, bound.doc);
      break;
    }
    case "design.export": {
      const record = resolveTargetRecord(command.sessionId);
      const bound = record.designDoc;
      if (!bound) throw new Error("当前会话没有打开的设计文档");
      const html = exportDesignHtml(bound.doc);
      const customPath = command.path?.trim() ?? "";
      const relativePath = customPath ? writeExportFile(record.workspace, html, customPath) : exportDesignFile(record.workspace, bound.doc, html);
      post({ type: "design.exported", relativePath });
      break;
    }
    case "design.close": {
      const record = resolveTargetRecord(command.sessionId);
      record.designDoc = undefined;
      // 推空状态同步所有窗口的画布（渲染端只采纳激活会话的推送）。
      postEmptyDesignState(record);
      break;
    }
    case "design.query": {
      const record = resolveTargetRecord(command.sessionId);
      if (record.designDoc) postDesignState(record, record.designDoc.doc);
      else postEmptyDesignState(record); // 未绑定也要推：切会话后画布随焦点清空
      post({ type: "design.docs", docs: listDesigns(record.workspace) });
      break;
    }
    // —— 作品（Gallery）：全局清单命令（与 gallery_publish 工具共用同一实现）——
    case "gallery.publish": {
      // 实体按钮路径：人操作，不过权限门；工作区缺省用当前会话的，缩略图同工具路径。
      const record = liveSessions.get(activeRuntime?.session.sessionId ?? "") ?? activeRuntime;
      const { app, thumbNote } = await publishGalleryApp(command.draft, record?.workspace ?? workspace);
      if (thumbNote) post({ type: "gallery.notice", kind: "warn", message: `已发布「${app.title}」${thumbNote}` });
      else post({ type: "gallery.notice", kind: "ok", message: `已发布作品「${app.title}」` });
      break;
    }
    case "gallery.remove": {
      const { list, removed } = removeGalleryApp(galleryApps, command.id);
      if (!removed) throw new Error("找不到该作品");
      galleryApps = persistGallery(galleryFilePath(), list, galleryThumbsPath());
      emitGallery();
      break;
    }
    case "gallery.update": {
      const app = galleryApps.find((candidate) => candidate.id === command.id);
      if (!app) throw new Error("找不到该作品");
      // patch 走同一套读侧归一化：非法字段被丢掉，绝不会把坏数据写进文件。
      const merged = normalizeGalleryApp({ ...app, ...command.patch, id: app.id, kind: app.kind, workspace: app.workspace, createdAt: app.createdAt, updatedAt: Date.now() });
      if (!merged) throw new Error("作品字段校验失败");
      galleryApps = persistGallery(galleryFilePath(), upsertGalleryApp(galleryApps, merged).list, galleryThumbsPath());
      emitGallery();
      break;
    }
    case "gallery.run": {
      // 记录一次运行（lastRunAt + 重排）；真正的开标签在渲染端。
      const app = galleryApps.find((candidate) => candidate.id === command.id);
      if (!app) throw new Error("找不到该作品");
      const { list } = upsertGalleryApp(galleryApps, { ...app, lastRunAt: Date.now() });
      galleryApps = persistGallery(galleryFilePath(), list, galleryThumbsPath());
      emitGallery();
      break;
    }
  }
}

let commandQueue = Promise.resolve();
// 主进程关掉通道（退出/重建运行时）时尽力释放 OAuth 回调服务器；监听已
// unref，进程被 kill 时由操作系统回收，这里的 dispose 只是优雅路径。
// （Electron 类型只声明了 message 事件，close 需按通用 EventEmitter 挂。）
(parentPort as unknown as NodeJS.EventEmitter).on("close", () => {
  void mcpOAuth.dispose();
});
parentPort.on("message", (event: { data: RuntimeCommand }) => {
  // Browser RPC results resolve tool executions directly — queueing them
  // behind serialized commands would stall the run for no reason.
  if (event.data.type === "browser-automation.result") {
    resolveBrowserAutomation(event.data.requestId, event.data.result);
    return;
  }
  if (event.data.type === "ssh-automation.result") {
    resolveSshAutomation(event.data.requestId, event.data.result);
    return;
  }
  if (event.data.type === "design-snapshot.result") {
    resolveDesignSnapshot(event.data.requestId, event.data.result);
    return;
  }
  commandQueue = commandQueue
    .then(() => handleCommand(event.data))
    .catch((error) => {
      post({ type: "error", message: errorText(error) });
    });
});
