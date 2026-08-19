import { readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, UserMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BackgroundProcessRegistry, bashCommandsFromMessages, isBackgroundCommand } from "./background-processes.js";
import type {
  AccessMode,
  AgentProfile,
  ChatMessage,
  ContextUsage,
  DesktopSettings,
  McpServerSummary,
  MessageBlock,
  ModelOption,
  PromptAttachment,
  ProviderModelSettings,
  ProviderOption,
  ProviderSettings,
  RecentWorkspace,
  RuntimeCommand,
  RuntimeMessage,
  RuntimeSnapshot,
  SessionRunStatus,
  SessionSummary,
  SkillSummary,
  ThinkingLevel,
  Todo,
  ToolExecution,
  TurnTiming
} from "../shared/protocol.js";
import { toolLabel } from "../shared/locale.js";
import { workspaceRelativeAttachment } from "./attachments.js";
import { runManualCompaction } from "./compaction-lifecycle.js";
import { customProviderModelDefinition, inferCustomModelImageInput } from "./custom-provider.js";
import { buildDivModePrompt } from "./div-prompt.js";
import { McpClientManager } from "./mcp-client.js";
import { removeMcpServerConfig, setMcpServerDisabled, upsertMcpServerConfig } from "./mcp-config.js";
import { PermissionBroker } from "./permission-broker.js";
import { loadRecentWorkspaces, recordRecentWorkspace, removeRecentWorkspace, writeRecentWorkspaces } from "./recent-workspaces.js";
import { createSubagentTools, type SubagentContext } from "./subagent.js";
import { buildSkillsSystemPromptBlock, setSkillEnabled, type DiscoveredSkill } from "./skill-catalog.js";
import { createTodoStore, migrateLegacyTodoFile, type TodoStore } from "./todo-store.js";
import { resolveVisionModel } from "./vision.js";
import { buildResourceCatalog } from "./resource-catalog.js";
import { agentWorkspaceSessionDir } from "./session-scope.js";
import { isDesktopConfiguredProvider } from "./model-catalog.js";
import { mergeProviderModels } from "./settings.js";
import { buildSkillPrompt, parseSkillPrompt, type SkillPromptDisplay } from "./skill-prompt.js";
import {
  PI_DESKTOP_CONTROL_ENTRY_TYPE,
  restoreControlMessages,
  restoreToolExecutions,
  type PersistedSessionEntry,
  type PersistedSessionMessage
} from "./session-history.js";
import { changedWorkspaceFile } from "./workspace-preview.js";
import { createToolAudit } from "./tool-audit.js";
import { diffToolNames } from "./tool-delta.js";
import * as runtimeTodoTools from "./runtime-todo-tools.js";
import * as runtimeQuestionTool from "./runtime-question-tool.js";
import * as runtimeSkills from "./runtime-skills.js";
import * as runtimeVision from "./runtime-vision.js";
import * as runtimePermissions from "./runtime-permissions.js";
import * as runtimeMcp from "./runtime-mcp.js";
import * as runtimeContextUsage from "./runtime-context-usage.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Pi 运行时必须作为 Electron 工具进程启动");

let modelRuntime: ModelRuntime | undefined;
let workspace: string | undefined;
let thinkingLevel: ThinkingLevel = "medium";
let accessMode: AccessMode = "ask";
let status = "请选择一个项目开始使用";
let currentSessions: SessionSummary[] = [];
let recentWorkspaces: RecentWorkspace[] = [];
let selectedModel: { provider: string; id: string } | undefined;
let settings: DesktopSettings | undefined;
let apiKeys: Record<string, string> = {};
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
  customTools: ToolDefinition[];
  subagentTools: ToolDefinition[];
  todoTools: ToolDefinition[];
  questionTools: ToolDefinition[];
  /** Captured at bindExtensions(); drives MCP hot-reload for this session only. */
  extensionApi: ExtensionAPI | undefined;
  permissionDeps: runtimePermissions.PermissionGateDeps;
  pendingVisionMessage: ChatMessage | undefined;
  pendingVisionSince: number | undefined;
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
  activatedAt: number;
}

const liveSessions = new Map<string, SessionRuntimeRecord>();
let activeRuntime: SessionRuntimeRecord | undefined;
// Idle parked sessions beyond this count are disposed (their history stays on
// disk and is rebuilt on reopen); running sessions are never evicted.
const MAX_PARKED_SESSIONS = 4;

// Mirrors of the active record's todo state: the read-only task panel follows
// the session being viewed (no prompt injection — todo_write args are the only
// model-visible channel).
let todoStore: TodoStore | undefined;
let todos: Todo[] = [];
let resourceOperationBusy = false;
let sessionGeneration = 0;
const customProviderId = "chatanytime-openai-compatible";
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
let nativeSkills: SkillSummary[] = [];
let discoveredSkills: DiscoveredSkill[] = [];
let mcpServers: McpServerSummary[] = [];
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
let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;
let hasPendingFlush = false;

interface RuntimeCustomMessage {
  role: "custom";
  customType: string;
  content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

function cloneProtocolValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

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

const permissionBroker = new PermissionBroker(
  (request) => post({ type: "permission", request }),
  (id) => post({ type: "permission.dismiss", id })
);
const questionBroker = new runtimeQuestionTool.QuestionBroker(
  (request) => post({ type: "question", request }),
  (id) => post({ type: "question.dismiss", id })
);
const mcpClient = new McpClientManager();
let mcpTools: ToolDefinition[] = [];

function skillPaths(): ReturnType<typeof runtimeSkills.skillPathsFor> {
  return runtimeSkills.skillPathsFor(workspace, getAgentDir());
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
    parentSessionId: sessionId,
    requestPermission: (toolName, args, toolCallId) => runtimePermissions.requestPermission(record.permissionDeps, toolName, args, toolCallId, "subagent"),
    isDelegationChild
  };
  return createSubagentTools(ctx);
}

function mcpConfigPaths(): { project: string; global: string } {
  return runtimeMcp.mcpConfigPathsFor(workspace, getAgentDir());
}

/** Connect to all configured MCP servers and refresh tool definitions + catalog status. */
async function syncMcpServers(refresh = false): Promise<void> {
  const synced = await runtimeMcp.syncMcpServers(mcpClient, mcpConfigPaths(), refresh);
  mcpServers = synced.summaries;
  mcpTools = synced.tools;
}

function emitResourceCatalog(): void {
  post({ type: "resources", resources: buildResourceCatalog({ skills: nativeSkills, mcpServers, todos }) });
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

/** Session-scoped todo file: `<agentDir>/chatanytime-sessions/<agentId>/todos/<sessionId>.json`. */
function sessionTodosPath(sessionId: string): string {
  const root = agentSessionRoot();
  if (!root) throw new Error("当前没有可用的 Agent，无法定位任务存储");
  return join(root, "todos", `${sessionId}.json`);
}

/** Build the Todo customTools for a session-scoped store. */
function buildTodoTools(store: TodoStore): ToolDefinition[] {
  return runtimeTodoTools.buildTodoTools({ store });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function blocksFromMessage(message: AgentMessage, skillPrompt?: SkillPromptDisplay): MessageBlock[] {
  if (message.role === "user") {
    const user = message as UserMessage;
    if (skillPrompt) {
      const blocks: MessageBlock[] = skillPrompt.instructions ? [{ type: "text", text: skillPrompt.instructions }] : [];
      if (typeof user.content !== "string") {
        blocks.push(...user.content.filter((content) => content.type === "image").map((content) => ({ type: "image" as const, data: content.data, mimeType: content.mimeType })));
      }
      return blocks;
    }
    if (typeof user.content === "string") return [{ type: "text", text: user.content }];
    return user.content.map((content) =>
      content.type === "text"
        ? { type: "text" as const, text: content.text }
        : { type: "image" as const, data: content.data, mimeType: content.mimeType }
    );
  }

  if (message.role === "custom") {
    const custom = message as unknown as RuntimeCustomMessage;
    if (typeof custom.content === "string") return [{ type: "text", text: custom.content }];
    return custom.content.map((content) => content.type === "text"
      ? { type: "text" as const, text: content.text }
      : { type: "image" as const, data: content.data, mimeType: content.mimeType });
  }

  if (message.role !== "assistant") return [];
  return (message as AssistantMessage).content.map((content) => {
    if (content.type === "text") return { type: "text" as const, text: content.text };
    if (content.type === "thinking") return { type: "thinking" as const, text: content.thinking };
    return {
      type: "tool-call" as const,
      id: content.id,
      name: content.name,
      arguments: content.arguments
    };
  });
}

// Maps each Pi AgentMessage object to a stable uuid so a message keeps its
// identity across the partial (streamingMessage) and final (committed into
// session.state.messages) frames. Fall-back key handles the rare case of two
// messages sharing a timestamp (counter appended within timestamp bucket).
const messageUuids = new WeakMap<AgentMessage, string>();
let uuidSequence = 0;

function messageUuid(message: AgentMessage, index: number): string {
  const cached = messageUuids.get(message);
  if (cached) return cached;
  const uuid = `${message.timestamp ?? 0}-${message.role}-${index}-${++uuidSequence}`;
  messageUuids.set(message, uuid);
  return uuid;
}

function normalizeMessages(messages: AgentMessage[], streamingMessage?: AgentMessage): ChatMessage[] {
  const visible = messages.filter((message) => message.role === "user" || message.role === "assistant" || (message.role === "custom" && (message as unknown as RuntimeCustomMessage).display));
  if (streamingMessage && streamingMessage.role === "assistant") {
    const last = visible.at(-1);
    if (last !== streamingMessage) visible.push(streamingMessage);
  }
  return visible.map((message, index) => {
    const skillPrompt = message.role === "user" ? parseSkillPrompt(userMessageText(message)) : undefined;
    return {
      id: `${message.timestamp ?? 0}-${index}-${message.role}`,
      uuid: messageUuid(message, index),
      role: message.role === "custom" ? "extension" : message.role as "user" | "assistant",
      timestamp: message.timestamp ?? Date.now(),
      blocks: blocksFromMessage(message, skillPrompt),
      extension: message.role === "custom" ? { customType: (message as unknown as RuntimeCustomMessage).customType, details: cloneProtocolValue((message as unknown as RuntimeCustomMessage).details) } : undefined,
      skill: skillPrompt ? { name: skillPrompt.name } : undefined,
      streaming: message === streamingMessage,
      error: message.role === "assistant" ? (message as AssistantMessage).errorMessage : undefined
    };
  });
}

/** 快照的上下文占用：Pi 官方估算 + record 上的会话累计缓存命中率。 */
function snapshotContextUsage(record: SessionRuntimeRecord | undefined): ContextUsage | undefined {
  if (!record) return undefined;
  const base = record.session.getContextUsage();
  if (!base) return undefined;
  return { ...base, cacheHitRate: runtimeContextUsage.cacheHitRateFrom(record.cacheUsage) };
}

function runtimeSkillPrompt(name: string, instructions?: string): string {
  return runtimeSkills.buildRuntimeSkillPrompt(discoveredSkills, name, instructions, activeRuntime?.session.getActiveToolNames().includes("read") ?? false);
}

function snapshot(): RuntimeSnapshot {
  const record = activeRuntime;
  const activeSession = record?.session;
  const sessionMessages = record && activeSession
    ? normalizeMessages(activeSession.state.messages, activeSession.state.streamingMessage)
    : [];
  // Swap the transient recognition bubble for the committed user message in
  // the same frame the latter appears, so neither a gap nor a duplicate shows.
  const pendingSince = record?.pendingVisionSince;
  if (record && pendingSince !== undefined && sessionMessages.some((message) => message.role === "user" && message.timestamp >= pendingSince)) clearRecordPendingVision(record);
  const messages = [...(record?.pendingVisionMessage ? [record.pendingVisionMessage] : []), ...sessionMessages, ...(record?.controlMessages ?? [])].sort((left, right) => left.timestamp - right.timestamp);
  return {
    workspace: record?.workspace ?? workspace,
    agentId: currentAgent?.id ?? "default",
    agentName: currentAgent?.name ?? "默认助手",
    sessionId: activeSession?.sessionId,
    sessionFile: activeSession?.sessionManager.getSessionFile(),
    model: activeSession?.model ? { provider: activeSession.model.provider, id: activeSession.model.id } : selectedModel,
    thinkingLevel: activeSession?.thinkingLevel ?? thinkingLevel,
    busy: (record?.busy ?? false) || transitionStatus !== undefined,
    status: transitionStatus ?? record?.status ?? status,
    turnTiming: record?.turnTiming,
    // 待发送队列实时读取 Pi 会话的 steering/followUp 状态；queue_update 事件
    // 走 default 分支立即 flush，渲染端随 emitState 同步。
    queuedMessages: record ? [
      ...record.session.getSteeringMessages().map((text, index) => ({ kind: "steering" as const, index, text })),
      ...record.session.getFollowUpMessages().map((text, index) => ({ kind: "followUp" as const, index, text }))
    ] : [],
    contextUsage: snapshotContextUsage(record),
    messages,
    executions: record ? [...record.executions.values()] : [],
    backgroundProcesses: backgroundProcesses.list(),
    sessions: currentSessions,
    recentWorkspaces
  };
}

function clearRecordPendingVision(record: SessionRuntimeRecord): void {
  record.pendingVisionMessage = undefined;
  record.pendingVisionSince = undefined;
}

/** Overlay a session's run status onto the sidebar list. */
function patchSessionRunStatus(record: SessionRuntimeRecord): void {
  currentSessions = currentSessions.map((item) => item.id === record.session.sessionId ? { ...item, runStatus: record.runStatus } : item);
}

/**
 * Resolve a session's dot to a terminal outcome. Terminal dots (green/red) are
 * unread notifications about a turn the user hasn't seen: they only stay on
 * parked sessions, and clear as soon as the session is activated. The active
 * session's outcome is already visible in the conversation, so it gets none.
 */
function setTerminalRunStatus(record: SessionRuntimeRecord, failed: boolean): void {
  record.runStatus = record === activeRuntime ? undefined : failed ? "failed" : "completed";
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

function disposeRecord(record: SessionRuntimeRecord): void {
  record.unsubscribe();
  try {
    record.session.dispose();
  } catch {
    // dispose is best-effort; the record is dropped regardless
  }
  permissionBroker.reset(record.session.sessionId);
  questionBroker.reset(record.session.sessionId);
  liveSessions.delete(record.session.sessionId);
  record.extensionApi = undefined;
  if (activeRuntime === record) {
    activeRuntime = undefined;
    todoStore = undefined;
    todos = [];
  }
}

/** Keep the parked-session set bounded; running sessions are never evicted. */
function evictParkedSessions(): void {
  const parked = [...liveSessions.values()]
    .filter((record) => record !== activeRuntime && !record.busy)
    .sort((left, right) => right.activatedAt - left.activatedAt);
  for (const record of parked.slice(MAX_PARKED_SESSIONS)) disposeRecord(record);
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
  sessionGeneration++;
  activeRuntime = record;
  record.activatedAt = Date.now();
  // Entering the session marks its terminal outcome as seen — drop the
  // green/red dot. A running session keeps its yellow dot (live state).
  if (record.runStatus !== undefined && record.runStatus !== "running") {
    record.runStatus = undefined;
    patchSessionRunStatus(record);
  }
  workspace = record.workspace;
  thinkingLevel = record.session.thinkingLevel;
  selectedModel = record.session.model ? { provider: record.session.model.provider, id: record.session.model.id } : undefined;
  todoStore = record.todoStore;
  todos = record.todoStore.list();
  emitTodos();
  syncSkills();
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
}

function workspaceSessionDir(): string | undefined {
  if (!workspace || !currentAgent) return undefined;
  return agentWorkspaceSessionDir(getAgentDir(), currentAgent.id, workspace);
}

function recentWorkspacesPath(): string {
  return join(getAgentDir(), "pidesktop-recent-workspaces.json");
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

async function sessionDirectories(): Promise<string[]> {
  const root = agentSessionRoot();
  if (!root) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return [root, ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))];
  } catch {
    return [root];
  }
}

function activeAgent(): AgentProfile {
  const list = settings?.agents ?? [];
  return list.find((agent) => agent.id === settings?.currentAgentId && !agent.archived) ?? list.find((agent) => agent.id === "default") ?? list[0] ?? { id: "default", name: "默认助手", description: "", systemPrompt: "", divMode: false, defaultThinkingLevel: "medium", tools: { read: true, bash: true, edit: true, write: true, grep: true, find: true, ls: true } };
}

function defaultModel(): { provider: string; id: string } | undefined {
  return currentAgent?.defaultModel ?? settings?.model;
}

function hasImageInput(model: { input?: readonly string[] } | undefined): boolean { return Boolean(model?.input?.includes("image")); }

function emitState(): void {
  // Default callers (commands, lifecycle hooks) flush immediately.
  scheduleEmit(true);
}

function beginTurn(record: SessionRuntimeRecord): void {
  record.turnTiming = { startedAt: Date.now() };
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
function permissionDepsFor(holder: { session: AgentSession | undefined }, recordWorkspace: string, recordAgent: AgentProfile): runtimePermissions.PermissionGateDeps {
  return {
    broker: permissionBroker,
    workspace: () => recordWorkspace,
    accessMode: () => accessMode,
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
 * Resolve the sidebar dot at the end of a run: red when the turn was aborted
 * or ended with an assistant error message, green otherwise. Active sessions
 * get no terminal dot (see setTerminalRunStatus).
 */
function resolveRunOutcome(record: SessionRuntimeRecord, messages: readonly AgentMessage[]): void {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant") as AssistantMessage | undefined;
  const failed = record.abortRequested || Boolean(lastAssistant?.errorMessage);
  record.abortRequested = false;
  setTerminalRunStatus(record, failed);
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
        lifecycle = true;
      }
      break;
    case "message_start":
      if (event.message.role === "assistant") markAnswerStarted(record);
      break;
    case "message_update":
      // Token-batch partial; high frequency — throttle.
      immediate = false;
      break;
    case "message_end":
      // Final frame carries the completed message; flush immediately so the
      // streaming flag clears without a 50ms gap. Accumulate its usage into
      // the session-wide cache counters.
      record.cacheUsage = runtimeContextUsage.addMessageToCacheUsage(record.cacheUsage, event.message);
      break;
    case "tool_execution_start":
      record.executions.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: "running",
        startedAt: Date.now(),
        changedFile: changedWorkspaceFile(record.workspace, event.toolName, event.args)
      });
      record.status = `正在${toolLabel(event.toolName)}`;
      break;
    case "tool_execution_update": {
      // Partial tool output; high frequency — throttle.
      const current = record.executions.get(event.toolCallId);
      if (current) current.output = textFromToolResult(event.partialResult);
      immediate = false;
      break;
    }
    case "tool_execution_end": {
      const current = record.executions.get(event.toolCallId);
      record.executions.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: current?.args ?? {},
        startedAt: current?.startedAt ?? Date.now(),
        completedAt: Date.now(),
        status: event.isError ? "error" : "completed",
        output: textFromToolResult(event.result),
        patch: patchFromToolResult(event.result),
        changedFile: current?.changedFile ?? changedWorkspaceFile(record.workspace, event.toolName, current?.args)
      });
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
    case "auto_retry_start":
      record.status = `正在重试（${event.attempt}/${event.maxAttempts}）`;
      break;
    default:
      // Unknown event types also flush immediately to be safe.
      break;
  }
  if (record !== activeRuntime) {
    // Parked session: only lifecycle changes matter (sidebar dot + list
    // freshness); streaming content is not rendered anywhere.
    if (lifecycle) {
      patchSessionRunStatus(record);
      emitState();
      scheduleSessionsRefresh();
    }
    return;
  }
  if (lifecycle) scheduleSessionsRefresh();
  scheduleEmit(immediate);
}

function appendCompactControlMessage(record: SessionRuntimeRecord, kind: "compact-command" | "compact-result", text: string): void {
  const entryId = record.session.sessionManager.appendCustomEntry(PI_DESKTOP_CONTROL_ENTRY_TYPE, { kind, text });
  const entry = record.session.sessionManager.getEntry(entryId);
  if (!entry || entry.type !== "custom") return;
  record.controlMessages = [...record.controlMessages, ...restoreControlMessages([entry as unknown as PersistedSessionEntry])];
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
      authSource: auth?.source
    };
  });
  if (!providers.some((provider) => provider.id === customProviderId)) {
    providers.push({ id: customProviderId, name: settings?.providers.find((item) => item.id === customProviderId)?.name ?? "自定义 OpenAI 兼容服务", configured: false });
  }
  const models: ModelOption[] = runtime.getModels().filter((model) => {
    const providerSettings = settings?.providers.find((provider) => provider.id === model.provider);
    if (!providerSettings) return true;
    const stored = providerSettings.models.find((item) => item.id === model.id);
    return stored ? stored.enabled !== false : true;
  }).map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    configured: configured.has(model.provider),
    input: model.input,
    imageInput: model.input.includes("image")
  }));
  post({ type: "catalog", models, providers });
}

function registerCustomProvider(config: ProviderSettings): void {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/u, "");
  const name = config.name.trim();
  if (!name || !baseUrl) throw new Error("自定义服务商需要填写名称和接口地址");
  try {
    new URL(baseUrl);
  } catch {
    throw new Error("接口地址必须是有效的 URL，例如 https://api.example.com/v1");
  }
  const configuredModels = (config.models?.length ? config.models : [])
    .filter((model) => model.id.trim())
    .filter((model) => model.enabled !== false)
    .map((model) => ({ id: model.id.trim(), name: model.name.trim() || model.id.trim(), imageInput: model.imageInput, enabled: true }));
  modelRuntime?.registerProvider(config.id, {
    name,
    baseUrl,
    api: "openai-completions",
    models: configuredModels.map((model) => customProviderModelDefinition(model))
  });
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
  openrouter: { url: "https://openrouter.ai/api/v1/models", auth: "none" }
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
    etag: undefined
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
    // 模板元数据，只覆盖 id/name，避免覆盖层丢失流式所需字段。
    const overlay = fetched.map((model) => {
      const base = baselineById.get(model.id);
      if (base) return { ...base, name: model.name };
      if (template) return { ...template, id: model.id, name: model.name };
      return { id: model.id, name: model.name, provider: providerId };
    });
    await writeRemoteCatalogOverlay(providerId, overlay);
    // 重新加载覆盖层（allowNetwork:false 只应用已持久化的目录，不再访问网络）。
    await runtime.refresh({ allowNetwork: false, force: true });
    await refreshCatalog();
    post({ type: "models-refreshed", providerId });
  } catch (error) {
    post({ type: "models-refresh-error", providerId, message: `拉取模型列表失败：${errorText(error)}` });
  }
}

async function refreshSessions(): Promise<void> {
  const directories = await sessionDirectories();
  if (directories.length === 0) {
    currentSessions = [];
    return;
  }

  const lists = await Promise.all(directories.map((directory) => SessionManager.listAll(directory)));
  const items = [...new Map(lists.flat().map((item) => [resolve(item.path).toLowerCase(), item])).values()];
  const pinnedPaths = settings?.pinnedSessionPaths ?? [];
  currentSessions = items.sort((left, right) => right.modified.getTime() - left.modified.getTime()).map((item) => {
    // Live sessions carry their execution state (sidebar dot) across refreshes.
    const runStatus = liveSessions.get(item.id)?.runStatus;
    return {
      id: item.id,
      path: item.path,
      workspace: item.cwd || "未知工作区",
      title: item.name || item.firstMessage || "新会话",
      modifiedAt: item.modified.getTime(),
      messageCount: item.messageCount,
      pinned: pinnedPaths.includes(item.path) || undefined,
      ...(runStatus ? { runStatus } : {})
    };
  });
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
async function createSession(sessionManager?: SessionManager, options: { reactivate?: boolean } = {}): Promise<void> {
  if (!workspace || !modelRuntime || !currentAgent) return;
  const generation = ++sessionGeneration;
  // Drop any pending throttled emit so a stale streaming flush from the
  // previous session cannot fire against the freshly reset state below.
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer);
    pendingFlushTimer = undefined;
    hasPendingFlush = false;
  }

  const recordWorkspace = workspace;
  const recordAgent = currentAgent;
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
  if (existing) disposeRecord(existing);

  const settingsManager = SettingsManager.create(recordWorkspace, getAgentDir());
  // Pi's own discovery is fully disabled: no extensions, no skills, no themes,
  // no ambient context files. The app injects its own system prompt, skills,
  // AGENTS.md instructions, MCP/subagent/todo tools explicitly (built in later
  // phases). Only app-owned inline extensions remain: the permission hook and
  // the tool audit logger.
  const sessionHolder: { session: AgentSession | undefined } = { session: undefined };
  let recordBox: SessionRuntimeRecord | undefined;
  const permissionDeps = permissionDepsFor(sessionHolder, recordWorkspace, recordAgent);
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
      // Tool executions land in chatanytime-sessions/<agentId>/tool-audit.jsonl
      // for post-hoc debugging; write failures never affect the turn.
      createToolAudit({
        auditDir: () => agentSessionRoot(),
        sessionId: () => sessionHolder.session?.sessionId ?? activeSessionManager.getSessionId(),
        warn: (message) => void post({ type: "log", level: "warn", message })
      }).extension
    ],
    systemPromptOverride: (base) => [base, recordAgent.systemPrompt, recordAgent.divMode ? buildDivModePrompt() : undefined, buildSkillsSystemPromptBlock(runtimeSkills.activeSkillsFor(nativeSkills, recordAgent))].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();
  syncSkills();
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
  const hasExistingMessages = activeSessionManager.buildSessionContext().messages.length > 0;
  const requested = hasExistingMessages ? undefined : defaultModel();
  const requestedModel = requested
    ? modelRuntime.getModel(requested.provider, requested.id)
    : undefined;
  // refreshSessions re-reads every session file from disk (line-by-line), which
  // is slow with many/large sessions. It only needs to be fresh for the sidebar,
  // so on switches with a known list it runs in the background instead of
  // delaying the state emit; the follow-up emit is generation-guarded.
  const hasSessionList = currentSessions.length > 0;
  const sessionsPromise = hasSessionList ? undefined : refreshSessions();
  await mcpPromise;
  emitResourceCatalog();
  const sessionRecordSeed: Pick<SessionRuntimeRecord, "workspace" | "agent" | "permissionDeps"> = { workspace: recordWorkspace, agent: recordAgent, permissionDeps };
  const subagentTools = buildSubagentTools(sessionRecordSeed, activeSessionManager.getSessionId(), requested ?? selectedModel, false);
  const todoTools = buildTodoTools(recordTodoStore);
  // ask_question 的挂起按会话清理（disposeRecord → broker.reset），而新会话的
  // sessionId 在 createAgentSession 之后才确定，因此以 getter 延迟读取。
  let recordSessionId = activeSessionManager.getSessionId();
  const questionTools = runtimeQuestionTool.buildQuestionTools({
    getSessionId: () => recordSessionId,
    broker: questionBroker
  });
  // Each record owns its customTools array: Pi stores it by reference and
  // re-reads it on every tool-registry refresh, so per-record arrays let parked
  // sessions keep their tool set while the active one hot-swaps MCP tools.
  const recordCustomTools: ToolDefinition[] = [...mcpTools, ...subagentTools, ...todoTools, ...questionTools];
  const result = await createAgentSession({
    cwd: recordWorkspace,
    modelRuntime,
    model: requestedModel,
    thinkingLevel: hasExistingMessages ? undefined : (recordAgent.defaultThinkingLevel ?? settings?.thinkingLevel ?? "medium"),
    sessionManager: activeSessionManager,
    settingsManager,
    resourceLoader,
    customTools: recordCustomTools
  });
  if (generation !== sessionGeneration) {
    result.session.dispose();
    if (sessionsPromise) await sessionsPromise;
    return;
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
    customTools: recordCustomTools,
    subagentTools,
    todoTools,
    questionTools,
    extensionApi: undefined,
    permissionDeps,
    pendingVisionMessage: undefined,
    pendingVisionSince: undefined,
    runStatus: undefined,
    abortRequested: false,
    cacheUsage: runtimeContextUsage.scanCacheUsage(result.session.state.messages),
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
  if (generation !== sessionGeneration) {
    result.session.dispose();
    if (sessionsPromise) await sessionsPromise;
    return;
  }
  // Activate the agent's enabled built-in tools plus every customTool (MCP,
  // subagent delegation, todo). customTools are registered but not active
  // unless explicitly enabled here.
  const enabledBuiltinTools = Object.entries(recordAgent.tools ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
  result.session.setActiveToolsByName([...enabledBuiltinTools, ...mcpTools.map((tool) => tool.name), ...subagentTools.map((tool) => tool.name), ...todoTools.map((tool) => tool.name), ...questionTools.map((tool) => tool.name)]);
  record.executions = new Map(restoreToolExecutions(result.session.state.messages as unknown as PersistedSessionMessage[], recordWorkspace).map((execution) => [execution.id, execution]));
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
  activate(record);
  if (sessionsPromise) {
    // First list (app start): wait so the sidebar is populated on the first emit.
    await sessionsPromise;
  }
  // Note: emitResourceCatalog()/emitTodos() are intentionally NOT re-called
  // here. Todos were published right after the session-scoped store was built,
  // the resource catalog right after the MCP sync completed, and none of the
  // native capability sources change between then and now.
  emitState();
}

async function initialize(command: Extract<RuntimeCommand, { type: "initialize" }>): Promise<void> {
  settings = command.settings;
  apiKeys = command.apiKeys;
  workspace = settings.workspace;
  recentWorkspaces = loadRecentWorkspaces(recentWorkspacesPath());
  if (workspace) touchRecentWorkspace(workspace);
  currentAgent = activeAgent();
  thinkingLevel = settings.thinkingLevel ?? "medium";
  accessMode = settings.accessMode ?? "ask";
  selectedModel = settings.model;
  modelRuntime = await ModelRuntime.create();
  const initializedProviderIds = new Set<string>();
  for (const provider of settings.providers) {
    registerCustomProvider(provider);
    initializedProviderIds.add(provider.id);
    const key = apiKeys[provider.id];
    if (key) await modelRuntime.setRuntimeApiKey(provider.id, key);
  }
  // `auth.set` stores built-in provider keys separately from provider settings.
  // Rehydrate those keys after restart so explicit app configuration remains
  // distinguishable from inherited environment credentials.
  for (const [providerId, key] of Object.entries(apiKeys)) {
    if (initializedProviderIds.has(providerId) || !key || !modelRuntime.getProvider(providerId)) continue;
    await modelRuntime.setRuntimeApiKey(providerId, key);
  }
  visionModel = resolveVisionModel(settings.vision, modelRuntime);
  await refreshCatalog();
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
    record.customTools.push(...mcpTools, ...subagentTools, ...record.todoTools, ...record.questionTools);
    // Re-registering every MCP tool covers additions and same-name schema
    // changes alike, and triggers the registry refresh that re-reads the
    // record's customTools.
    for (const tool of mcpTools) record.extensionApi.registerTool(tool);
    const enabledBuiltinTools = Object.entries(record.agent.tools ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
    record.session.setActiveToolsByName([...enabledBuiltinTools, ...mcpTools.map((tool) => tool.name), ...subagentTools.map((tool) => tool.name), ...record.todoTools.map((tool) => tool.name), ...record.questionTools.map((tool) => tool.name)]);
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

// Fallback for text-only conversation models: recognize attached images with
// the configured vision model (one of the registered provider models) and
// inject the descriptions into the prompt text, so raw image parts never
// reach a model that cannot read them.
async function applyVisionFallback(record: SessionRuntimeRecord, payload: { text: string; images: ImageContent[] }): Promise<void> {
  await runtimeVision.runVisionFallback(
    {
      resolve: () => {
        if (!visionModel || !modelRuntime) throw new Error("当前模型不支持图片输入，请先切换多模态模型，或在设置的模型服务中启用视觉识别");
        return { runtime: modelRuntime, model: visionModel, prompt: settings?.vision?.prompt };
      },
      apply: (state) => {
        record.busy = state.busy;
        record.status = state.status;
        record.pendingVisionMessage = state.pendingMessage;
        record.pendingVisionSince = state.pendingMessage?.timestamp;
        emitState();
      },
      errorText
    },
    payload
  );
}

async function handleCommand(command: RuntimeCommand): Promise<void> {
  switch (command.type) {
    case "initialize":
      await initialize(command);
      break;
    case "workspace.open":
      workspace = resolve(command.path);
      touchRecentWorkspace(workspace);
      await createSession(undefined, { reactivate: true });
      break;
    case "session.new":
      if (command.workspace) {
        workspace = resolve(command.workspace);
        touchRecentWorkspace(workspace);
      }
      // Always a fresh session id: the previously active session is parked and
      // keeps running, so a busy turn never blocks starting a new topic.
      if (workspace) await createSession(SessionManager.create(workspace, workspaceSessionDir()));
      break;
    case "session.open": {
      const root = agentSessionRoot();
      const target = resolve(command.path);
      if (!root || !pathIsWithin(root, target) || !target.toLowerCase().endsWith(".jsonl")) throw new Error("只能打开当前 Agent 的会话");
      const discovered = SessionManager.open(target);
      const sessionWorkspace = discovered.getCwd();
      if (!sessionWorkspace) throw new Error("会话缺少工作区信息");
      workspace = resolve(sessionWorkspace);
      touchRecentWorkspace(workspace);
      const sessionRoot = workspaceSessionDir();
      if (!sessionRoot || (resolve(dirname(target)).toLowerCase() !== resolve(sessionRoot).toLowerCase() && resolve(dirname(target)).toLowerCase() !== resolve(root).toLowerCase())) {
        throw new Error("会话路径与工作区不匹配");
      }
      // A live record (e.g. a session still running in the background) is
      // reactivated in place — never rebuilt — so its in-flight turn survives.
      const live = liveSessions.get(discovered.getSessionId());
      if (live) {
        activate(live);
        emitState();
        break;
      }
      await createSession(SessionManager.open(target, sessionRoot, workspace));
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
        const pinnedSet = new Set(settings.pinnedSessionPaths ?? []);
        if (command.pinned) pinnedSet.add(command.path);
        else pinnedSet.delete(command.path);
        settings = { ...settings, pinnedSessionPaths: [...pinnedSet] };
      }
      await refreshSessions();
      emitState();
      break;
    }
    case "workspace.remove": {
      recentWorkspaces = removeRecentWorkspace(recentWorkspaces, command.workspace);
      writeRecentWorkspaces(recentWorkspacesPath(), recentWorkspaces);
      const removeRoot = agentSessionRoot();
      if (removeRoot) {
        const targetWorkspace = resolve(command.workspace).toLowerCase();
        const removed = currentSessions.filter((item) => resolve(item.workspace).toLowerCase() === targetWorkspace);
        // Live records in the removed workspace are torn down together with
        // their session files, running or not.
        for (const record of [...liveSessions.values()]) {
          if (record.workspace.toLowerCase() === targetWorkspace) disposeRecord(record);
        }
        for (const item of removed) {
          if (!pathIsWithin(removeRoot, item.path) || !item.path.toLowerCase().endsWith(".jsonl")) continue;
          try { await unlink(item.path); } catch { /* 会话文件可能已释放或不存在 */ }
          // Session-scoped todo file lives next to the session list under todos/.
          try { await unlink(join(removeRoot, "todos", `${item.id}.json`)); } catch { /* 任务文件可能不存在 */ }
        }
      }
      await refreshSessions();
      emitState();
      break;
    }
    case "session.skill": {
      const prompt = runtimeSkillPrompt(command.name, command.instructions);
      await handleCommand({ type: "session.prompt", text: prompt, attachments: command.attachments });
      break;
    }
    case "session.prompt": {
      const record = activeRuntime;
      if (!record) throw new Error("请先打开工作区，再发送消息");
      if (!record.session.model) throw new Error("请先配置并选择模型，再发送消息");
      if (record.busy) throw new Error("当前话题正在执行，请等待完成或停止后再发送");
      const prompt = await preparePromptPayload(command.text, command.attachments);
      if (prompt.images.length && !hasImageInput(record.session.model)) await applyVisionFallback(record, prompt);
      record.busy = true;
      record.status = "Pi 正在工作";
      record.abortRequested = false;
      record.runStatus = "running";
      patchSessionRunStatus(record);
      beginTurn(record);
      emitState();
      void record.session.prompt(prompt.text, prompt.images.length ? { images: prompt.images } : undefined).catch((error) => {
        // The record may have been parked (still live — update it so the dot
        // resolves) or torn down (workspace removal — nothing left to update).
        if (!liveSessions.has(record.session.sessionId)) return;
        clearRecordPendingVision(record);
        completeTurn(record);
        record.busy = false;
        record.status = "请求失败";
        setTerminalRunStatus(record, true);
        post({ type: "error", message: errorText(error) });
        emitState();
        scheduleSessionsRefresh();
      });
      break;
    }
    case "session.queue.add": {
      const record = activeRuntime;
      if (!record) throw new Error("请先打开工作区，再发送消息");
      if (!record.session.model) throw new Error("请先配置并选择模型，再发送消息");
      const queueText = command.skillName ? runtimeSkillPrompt(command.skillName, command.text || undefined) : command.text;
      const prompt = await preparePromptPayload(queueText, command.attachments);
      if (prompt.images.length && !hasImageInput(record.session.model)) await applyVisionFallback(record, prompt);
      // Pi 的队列以纯文本存储，编辑/删除/立即发送需要整队重建，图片附件会
      // 丢失——排队仅支持文本与文件附件（文件附件已折叠为路径清单）。
      if (prompt.images.length) throw new Error("排队消息暂不支持图片附件，请等本轮回复结束后再发送");
      if (record.busy || record.session.isStreaming) {
        // followUp 语义：本轮回复自然结束后，该消息作为下一轮 user 消息注入。
        await record.session.prompt(prompt.text, { streamingBehavior: "followUp" });
      } else {
        // 排队瞬间回合恰好结束：直接按普通消息发送，避免消息滞留队列。
        await handleCommand({ type: "session.prompt", text: prompt.text });
      }
      emitState();
      break;
    }
    case "session.queue.sendNow":
    case "session.queue.remove": {
      const record = activeRuntime;
      if (!record) break;
      const steering = [...record.session.getSteeringMessages()];
      const followUp = [...record.session.getFollowUpMessages()];
      const target = command.kind === "steering" ? steering : followUp;
      // 快照与点击之间队列可能已投递/变动：text 校验失败即拒绝，防止误伤相邻消息。
      if (target[command.index] !== command.text) throw new Error("待发送列表已变化，请重试");
      target.splice(command.index, 1);
      const sendNow = command.type === "session.queue.sendNow";
      if (sendNow && (record.busy || record.session.isStreaming)) steering.push(command.text);
      // Pi 队列没有单项编辑 API：整队清空后按原顺序重建（sendNow 把目标提升为
      // steering，在当前回合下一次模型调用前插入，无需中断工具执行）。
      record.session.clearQueue();
      for (const text of steering) await record.session.steer(text);
      for (const text of followUp) await record.session.followUp(text);
      if (sendNow && !(record.busy || record.session.isStreaming)) {
        // 回合已结束（如失败收尾后队列仍在）：立即发送退化为直接开新回合。
        await handleCommand({ type: "session.prompt", text: command.text });
      }
      emitState();
      break;
    }
    case "session.regenerate": {
      const record = activeRuntime;
      if (!record) throw new Error("请先打开工作区，再重新生成");
      if (!record.session.model) throw new Error("请先配置并选择模型，再重新生成");
      if (record.busy) throw new Error("当前话题正在执行，请等待完成或停止后再重新生成");
      if (!command.text.trim() && !command.skillName) throw new Error("没有可重新生成的用户消息");
      const regeneratedText = command.skillName ? runtimeSkillPrompt(command.skillName, command.text) : command.text.trim();
      const regeneratedPrompt = await preparePromptPayload(regeneratedText, command.attachments);
      if (regeneratedPrompt.images.length && !hasImageInput(record.session.model)) await applyVisionFallback(record, regeneratedPrompt);
      const regenerateSession = record.session;
      record.busy = true;
      record.status = "Pi 正在重新生成";
      record.abortRequested = false;
      record.runStatus = "running";
      patchSessionRunStatus(record);
      beginTurn(record);
      emitState();
      void (async () => {
        const branch = regenerateSession.sessionManager.getBranch();
        const target = branch.filter((entry) => {
          if (entry.type !== "message" || entry.message.role !== "user") return false;
          if (command.timestamp !== undefined) return entry.message.timestamp === command.timestamp;
          const text = userMessageText(entry.message);
          if (!command.skillName) return text === command.text.trim();
          const skillPrompt = parseSkillPrompt(text);
          return skillPrompt?.name === command.skillName && skillPrompt.instructions === command.text.trim();
        }).at(-1);
        if (!target || target.type !== "message") throw new Error("找不到要重新生成的用户消息");
        await regenerateSession.navigateTree(target.id);
        await regenerateSession.prompt(regeneratedPrompt.text, regeneratedPrompt.images.length ? { images: regeneratedPrompt.images } : undefined);
      })().catch((error) => {
        if (!liveSessions.has(record.session.sessionId)) return;
        clearRecordPendingVision(record);
        completeTurn(record);
        record.busy = false;
        record.status = "请求失败";
        setTerminalRunStatus(record, true);
        post({ type: "error", message: errorText(error) });
        emitState();
        scheduleSessionsRefresh();
      });
      break;
    }
    case "session.abort": {
      const record = activeRuntime;
      if (!record) break;
      // Aborts resolve the status dot to red: the run did not complete.
      record.abortRequested = true;
      record.session.abortCompaction();
      // 中断即放弃排队消息（Pi CLI 同款语义）：渲染端在点停止时把队列文本
      // 回填输入框供编辑重发；不清空的话滞留消息会混进下一次运行。
      record.session.clearQueue();
      void record.session.abort();
      // Make the task panel reflect the abort immediately: mark every running
      // tool execution as aborted so its card disappears without waiting for
      // the SDK's tool_execution_end (which may be delayed or never arrive
      // if the killed process tree hangs the tool promise).
      {
        let changed = false;
        for (const execution of record.executions.values()) {
          if (execution.status === "running") {
            execution.status = "error";
            execution.completedAt = Date.now();
            execution.output = `${execution.output ?? ""}${execution.output ? "\n\n" : ""}（已中止）`;
            changed = true;
          }
        }
        if (changed) emitState();
      }
      break;
    }
    case "session.compact": {
      const record = activeRuntime;
      if (!record) throw new Error("请先打开工作区，再压缩上下文");
      if (!record.session.model) throw new Error("请先配置并选择模型，再压缩上下文");
      if (record.busy) throw new Error("当前话题正在执行，请等待完成后再压缩上下文");
      record.busy = true;
      record.status = "Pi 正在压缩上下文";
      record.runStatus = "running";
      patchSessionRunStatus(record);
      beginTurn(record);
      appendCompactControlMessage(record, "compact-command", command.instructions ? `/compact ${command.instructions}` : "/compact");
      emitState();
      void runManualCompaction(() => record.session.compact(command.instructions)).then((outcome) => {
        if (!liveSessions.has(record.session.sessionId)) return;
        appendCompactControlMessage(record, "compact-result", outcome.message);
        completeTurn(record);
        record.busy = false;
        record.status = outcome.status;
        setTerminalRunStatus(record, outcome.type === "failed");
        if (outcome.type === "failed") post({ type: "error", message: errorText(outcome.error) });
        emitState();
      });
      break;
    }
    case "model.select": {
      if (!modelRuntime) break;
      const model = modelRuntime.getModel(command.provider, command.id);
      if (!model) throw new Error(`无法识别模型 ${command.provider}/${command.id}`);
      selectedModel = { provider: command.provider, id: command.id };
      if (activeRuntime) await activeRuntime.session.setModel(model);
      emitState();
      break;
    }
    case "thinking.select":
      thinkingLevel = command.level;
      activeRuntime?.session.setThinkingLevel(command.level);
      emitState();
      break;
    case "auth.set":
      if (!modelRuntime) break;
      await modelRuntime.setRuntimeApiKey(command.provider, command.apiKey);
      await refreshCatalog();
      if (!activeRuntime?.session.model || activeRuntime.session.model.provider === command.provider) {
        const enabledModels = new Set(settings?.providers.flatMap((provider) => provider.models.filter((item) => item.enabled !== false).map((item) => `${provider.id}/${item.id}`)) ?? []);
        const first = modelRuntime.getModels(command.provider).find((model) => !settings?.providers.some((provider) => provider.id === command.provider) || enabledModels.has(`${command.provider}/${model.id}`))
          ?? modelRuntime.getModels(command.provider)[0];
        if (first) {
          selectedModel = { provider: first.provider, id: first.id };
          if (activeRuntime) await activeRuntime.session.setModel(first);
        }
      }
      emitState();
      break;
    case "provider.save":
      if (!modelRuntime) break;
      registerCustomProvider(command.provider);
      if (settings) settings.providers = settings.providers.some((provider) => provider.id === command.provider.id) ? settings.providers.map((provider) => provider.id === command.provider.id ? command.provider : provider) : [...settings.providers, command.provider];
      if (command.apiKey?.trim()) {
        apiKeys[command.provider.id] = command.apiKey.trim();
        await modelRuntime.setRuntimeApiKey(command.provider.id, command.apiKey.trim());
      }
      await refreshCatalog();
      {
        const first = modelRuntime.getModels(command.provider.id)[0];
        if (first) {
          selectedModel = { provider: first.provider, id: first.id };
          if (activeRuntime) await activeRuntime.session.setModel(first);
        } else if (selectedModel?.provider === command.provider.id) {
          const fallback = modelRuntime.getModels().find((model) => modelRuntime?.getProviderAuthStatus(model.provider)?.configured);
          selectedModel = fallback ? { provider: fallback.provider, id: fallback.id } : undefined;
          if (activeRuntime && fallback) await activeRuntime.session.setModel(fallback);
          applyStatusToActive(fallback ? `当前服务没有启用模型，已切换到 ${fallback.name}` : "当前服务没有启用模型，请在设置中勾选模型");
        }
      }
      emitState();
      break;
    case "provider.models.save":
      if (!modelRuntime) break;
      if (settings) settings.providers = settings.providers.some((provider) => provider.id === command.provider.id) ? settings.providers.map((provider) => provider.id === command.provider.id ? command.provider : provider) : [...settings.providers, command.provider];
      await refreshCatalog();
      emitState();
      break;
    case "provider.delete":
      modelRuntime?.unregisterProvider(command.providerId);
      await refreshCatalog();
      if (settings) {
        settings.providers = settings.providers.filter((provider) => provider.id !== command.providerId);
        settings.model = settings.model?.provider === command.providerId ? undefined : settings.model;
        settings.agents = settings.agents.map((agent) => agent.defaultModel?.provider === command.providerId ? { ...agent, defaultModel: undefined } : agent);
        if (selectedModel?.provider === command.providerId) {
          const fallbackModel = modelRuntime?.getModels().find((model) => modelRuntime?.getProviderAuthStatus(model.provider)?.configured);
          selectedModel = fallbackModel ? { provider: fallbackModel.provider, id: fallbackModel.id } : undefined;
          if (activeRuntime && fallbackModel) await activeRuntime.session.setModel(fallbackModel);
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
      // 内置服务商拉取最新模型：主路径走 SDK 远程目录覆盖（pi.dev catalog），
      // 该服务偶发超时/不可达，因此带 30 秒超时并在失败后直连服务商接口兜底，
      // 避免"拉取中"无限转圈。
      if (!modelRuntime) break;
      const refreshProviderId = command.providerId;
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
        const relevantErrors = [...result.errors].filter(([providerId]) => providerId === refreshProviderId);
        for (const [providerId, error] of [...result.errors]) {
          if (providerId !== refreshProviderId) {
            post({ type: "log", level: "warn", message: `刷新服务商 ${providerId} 模型列表失败：${errorText(error)}` });
          }
        }
        if (!refreshController.signal.aborted && relevantErrors.length === 0) {
          post({ type: "models-refreshed", providerId: refreshProviderId });
          break;
        }
        post({ type: "log", level: "warn", message: `远程目录拉取未成功（${refreshController.signal.aborted ? "超时" : relevantErrors.map(([, error]) => errorText(error)).join("；") || "无错误"}），尝试直连服务商接口` });
        await refreshBuiltinModelsFallback(refreshProviderId);
      } catch (error) {
        post({ type: "models-refresh-error", providerId: refreshProviderId, message: errorText(error) });
      } finally {
        clearTimeout(refreshTimeout);
      }
      break;
    }
    case "vision.save": {
      if (settings) settings.vision = command.vision;
      visionModel = modelRuntime ? resolveVisionModel(command.vision, modelRuntime) : undefined;
      break;
    }
    case "agent.select": {
      if (!settings?.agents.some((agent) => agent.id === command.agentId && !agent.archived)) throw new Error("Agent 不存在或已归档");
      // A running session is parked, not killed: switching agents while a turn
      // is executing keeps that turn running in the background.
      const previousAgentId = settings.currentAgentId;
      const previousModel = selectedModel;
      settings.currentAgentId = command.agentId;
      currentAgent = activeAgent();
      selectedModel = currentAgent.defaultModel ?? settings.model;
      transitionStatus = `正在切换到 ${currentAgent.name}`;
      emitState();
      try {
        if (workspace) await createSession(undefined, { reactivate: true });
        else status = "就绪";
      } catch (error) {
        settings.currentAgentId = previousAgentId;
        currentAgent = activeAgent();
        selectedModel = previousModel;
        status = "Agent 切换失败";
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
    case "settings.save":
      if (settings) { settings.model = command.settings.model; settings.thinkingLevel = command.settings.thinkingLevel; settings.accessMode = command.settings.accessMode; settings.appearance = command.settings.appearance; thinkingLevel = command.settings.thinkingLevel; accessMode = command.settings.accessMode; selectedModel = command.settings.model; if (activeRuntime) { activeRuntime.session.setThinkingLevel(thinkingLevel); if (selectedModel) { const model = modelRuntime?.getModel(selectedModel.provider, selectedModel.id); if (model) await activeRuntime.session.setModel(model); } } emitState(); }
      break;
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
      const { project, global } = mcpConfigPaths();
      const target = server.scope === "project" ? project : global;
      await runResourceOperation("正在保存 MCP Server", async () => {
        upsertMcpServerConfig(target, name, runtimeMcp.mcpConfigEntry({ ...server, name }));
        forceMcpRefresh = true;
        await applyMcpToolChanges();
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
        if (!removeMcpServerConfig(target, command.name)) throw new Error("找不到要删除的 MCP Server");
        forceMcpRefresh = true;
        // Deletion always removes tools → applyMcpToolChanges falls back to a
        // session rebuild (Pi has no tool-removal API).
        await applyMcpToolChanges();
      });
      break;
    }
    case "skill.toggle": {
      await runResourceOperation(command.enabled ? "正在启用 Skill" : "正在停用 Skill", async () => {
        setSkillEnabled(skillPaths().statePath, command.id, command.enabled);
        await reloadRuntimeResources();
      });
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
      questionBroker.resolve(command.id, command.answers);
      break;
    }
  }
}

let commandQueue = Promise.resolve();
parentPort.on("message", (event: { data: RuntimeCommand }) => {
  commandQueue = commandQueue
    .then(() => handleCommand(event.data))
    .catch((error) => {
      post({ type: "error", message: errorText(error) });
    });
});
