export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AccessMode = "read-only" | "ask" | "workspace" | "full";

export type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  configured: boolean;
  input: ("text" | "image")[];
  imageInput: boolean;
}

export interface ProviderModelSettings {
  id: string;
  name: string;
  imageInput?: boolean;
  /** Whether this model is shown in the composer model switcher. */
  enabled?: boolean;
}

export interface ProviderSettings {
  id: string;
  name: string;
  baseUrl: string;
  models: ProviderModelSettings[];
  keyConfigured?: boolean;
  /**
   * `false` marks a built-in provider entry that only records per-model
   * visibility (no custom baseUrl). Absent/true means an OpenAI-compatible
   * custom provider entry.
   */
  custom?: boolean;
}

export interface ProviderOption {
  id: string;
  name: string;
  configured: boolean;
  authSource?: string;
  custom?: boolean;
}

export interface CustomProviderSettings {
  id?: string;
  name: string;
  baseUrl: string;
  modelId: string;
  modelName?: string;
  models?: ProviderModelSettings[];
}

export type CustomProviderModel = ProviderModelSettings;

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  divMode: boolean;
  defaultModel?: { provider: string; id: string };
  defaultThinkingLevel: ThinkingLevel;
  tools: Record<BuiltinToolName, boolean>;
  /** Agent-owned Skill enablement layered over Pi's discovered defaults. */
  skillOverrides?: Record<string, boolean>;
  archived?: boolean;
}

export const THEME_PRESET_IDS = ["default", "ocean", "emerald", "indigo", "forest", "rose", "amber", "violet", "carbon", "blue-dream"] as const;
export type ThemePresetId = typeof THEME_PRESET_IDS[number];

export type ThemeAssetMap = Record<string, string>;

export interface CustomThemeDefinition {
  id: string;
  name: string;
  css: string;
  /** Image/font data is kept separately so the editable CSS stays readable. */
  assets?: ThemeAssetMap;
}

export type ThemeMode = "light" | "dark";

/**
 * Per-mode user preference for the wallpaper opacity slider. Themes own every
 * color token; the only renderer-side override left is this slider value.
 */
export interface WallpaperOpacityOverrides {
  light?: number;
  dark?: number;
}

export interface AppearanceSettings {
  theme: "system" | "light" | "dark";
  themePreset: ThemePresetId;
  customCss: string;
  /** Imported image/font data keyed by the relative url used in customCss. */
  customCssAssets?: ThemeAssetMap;
  customThemes: CustomThemeDefinition[];
  wallpaperOpacity?: WallpaperOpacityOverrides;
  showThinking: boolean;
}

/**
 * Vision fallback configuration: images attached for a text-only conversation
 * model are recognized by one of the already-configured provider models
 * (picked from the fetched model catalog, must support image input).
 */
export interface VisionSettings {
  enabled: boolean;
  provider: string;
  model: string;
  /** Optional custom recognition prompt; falls back to the built-in default. */
  prompt?: string;
}

export interface DesktopSettings {
  version: 2;
  workspace?: string;
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  accessMode: AccessMode;
  providers: ProviderSettings[];
  agents: AgentProfile[];
  currentAgentId: string;
  appearance: AppearanceSettings;
  vision?: VisionSettings;
  customProvider?: CustomProviderSettings;
  customProviderKeyConfigured?: boolean;
  pinnedSessionPaths?: string[];
}

export interface ImageAttachment {
  kind: "image";
  name: string;
  mimeType: string;
  size: number;
  data: string;
}

export interface FileAttachment {
  kind: "file";
  name: string;
  /** Workspace-relative path. Absolute paths must never cross the renderer/runtime protocol. */
  path: string;
  relativePath: string;
  size: number;
}

export type PromptAttachment = ImageAttachment | FileAttachment;

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: unknown }
  | { type: "image"; mimeType: string; data: string };

export interface ChatMessage {
  id: string;
  /**
   * Stable identifier for the underlying Pi message object. The same Pi
   * message keeps one uuid across its partial (streaming) and final frames,
   * letting the renderer update a bubble in place instead of re-appending.
   * Omitted on snapshots produced before this field existed.
   */
  uuid?: string;
  role: "user" | "assistant" | "extension";
  timestamp: number;
  blocks: MessageBlock[];
  extension?: { customType: string; details?: unknown };
  /** Desktop-generated control messages are visible but not editable or regenerable. */
  control?: "compact";
  skill?: { name: string };
  attachments?: Array<{ kind: PromptAttachment["kind"]; name: string; relativePath?: string }>;
  streaming?: boolean;
  error?: string;
}

export interface TurnTiming {
  startedAt: number;
  answerStartedAt?: number;
  completedAt?: number;
}

/**
 * 当前会话上下文窗口占用估算（Pi 的 AgentSession.getContextUsage()，
 * 跟随激活会话）。窗口大小来自模型定义，token 数优先取最后一次
 * LLM 响应的真实 usage，其后新消息按 chars/4 估算。
 */
export interface ContextUsage {
  /** 估算上下文 token 数；压缩后、下一次 LLM 响应前不可知，为 null。 */
  tokens: number | null;
  /** 模型上下文窗口（token 数）。 */
  contextWindow: number;
  /** 相对上下文窗口的百分比；tokens 未知时为 null。 */
  percent: number | null;
  /**
   * 会话累计缓存命中率：ΣcacheRead / Σ(input + cacheRead + cacheWrite)，
   * 与 claude-stat / pi CLI 的 CH 指标同源。累计口径平滑（瞬时值会随工具
   * 结果回填剧烈波动）。没有可用 usage（未发过请求、中转站不报 usage）
   * 时为 null。独立于 tokens——压缩后估算未知时累计命中率仍有意义。
   */
  cacheHitRate: number | null;
}

export interface ToolExecution {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "completed" | "error";
  startedAt: number;
  completedAt?: number;
  output?: string;
  patch?: string;
  /** Workspace-relative file changed by a write/edit tool. */
  changedFile?: { relativePath: string };
}

export type WorkspaceFilePreviewKind = "markdown" | "code" | "html" | "svg" | "image" | "text" | "binary" | "pdf";

/** 图片预览内联为 base64 数据 URL 的体积上限（与聊天附件 20MB 限制一致）。 */
export const IMAGE_PREVIEW_LIMIT_BYTES = 20 * 1024 * 1024;

export interface WorkspaceFilePreview {
  relativePath: string;
  name: string;
  kind: WorkspaceFilePreviewKind;
  size: number;
  language?: string;
  mimeType?: string;
  content?: string;
  data?: string;
  truncated?: boolean;
  /** 文件所在工作区的真实（realpath）根目录，编辑后必须写回该工作区。 */
  workspace?: string;
}

export interface WorkspaceFileWriteResult {
  saved: true;
  size: number;
  relativePath: string;
}

/** 工作区文件预览的自定义协议：PDF 等大文件由主进程流式读取，避免内联拷贝。 */
export const PREVIEW_FILE_SCHEME = "pidesktop-file";

/**
 * 生成工作区文件的协议 URL，形如 pidesktop-file://preview/<enc(workspace)>/<enc(relativePath)>。
 * 工作区与相对路径分别 encodeURIComponent 后以 path 段承载（host 会被小写化，不能放路径）。
 */
export function workspaceFilePreviewUrl(workspace: string, relativePath: string): string {
  return `${PREVIEW_FILE_SCHEME}://preview/${encodeURIComponent(workspace)}/${encodeURIComponent(relativePath)}`;
}

/** 解析预览 URL，返回 {""} 表示非法；分段解码，path 段缺失/多余一律拒绝。 */
export function parseWorkspaceFilePreviewUrl(input: string): { workspace: string; relativePath: string } | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== `${PREVIEW_FILE_SCHEME}:` || url.hostname !== "preview") return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return undefined;
    const workspace = decodeURIComponent(segments[0]!);
    const relativePath = decodeURIComponent(segments[1]!);
    if (!workspace || !relativePath || relativePath.includes("..")) return undefined;
    return { workspace, relativePath };
  } catch {
    return undefined;
  }
}

export interface WorkspaceDirectoryEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
}

export interface WorkspaceDirectoryListing {
  relativePath: string;
  entries: WorkspaceDirectoryEntry[];
}

/** 工作区目录树的新建/删除/重命名操作结果。 */
export interface WorkspaceEntryResult {
  /** 操作生效后的工作区相对路径（重命名为新路径，其余为原路径）。 */
  relativePath: string;
}

/** 输入框 @ 提及的工作区文件/目录搜索结果条目。 */
export interface WorkspaceFileSearchEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
}

export interface WorkspaceFileSearchResult {
  entries: WorkspaceFileSearchEntry[];
}

export interface BrowserPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPreviewState {
  attached: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export type BrowserPreviewCommand =
  | { type: "bounds"; tabId?: string; bounds: BrowserPreviewBounds }
  | { type: "visible"; tabId?: string; visible: boolean }
  | { type: "navigate"; tabId?: string; url: string }
  | { type: "back"; tabId?: string }
  | { type: "forward"; tabId?: string }
  | { type: "reload"; tabId?: string }
  | { type: "stop"; tabId?: string }
  | { type: "open-external"; tabId?: string }
  | { type: "close"; tabId?: string };

/**
 * User terminal (PTY) hosted in the main process, rendered with xterm.js in a
 * preview tab. Input/output are UTF-8 strings; `create` reconnects to an
 * existing terminal and replays its scrollback instead of spawning a new one.
 */
export type TerminalCommand =
  | { type: "create"; terminalId: string; cwd?: string; cols: number; rows: number; shell?: string }
  | { type: "input"; terminalId: string; data: string }
  | { type: "resize"; terminalId: string; cols: number; rows: number }
  | { type: "kill"; terminalId: string };

export type TerminalEventData =
  | { type: "data"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode?: number }
  | { type: "error"; terminalId: string; message: string };

/**
 * Execution state of a session, shown as a sidebar dot. "running" is live
 * state; "completed"/"failed" are unseen-outcome notifications that clear as
 * soon as the session is opened (the result is then visible in the chat).
 */
export type SessionRunStatus = "running" | "completed" | "failed";

export interface SessionSummary {
  id: string;
  path: string;
  workspace: string;
  title: string;
  modifiedAt: number;
  messageCount: number;
  pinned?: boolean;
  /** Present only for live sessions; terminal dots clear once viewed. */
  runStatus?: SessionRunStatus;
}

/**
 * A workspace the user opened recently, tracked independently of sessions so
 * freshly created (still empty) workspaces show up in the sidebar immediately.
 */
export interface RecentWorkspace {
  path: string;
  /** Epoch ms of the last time the workspace was opened. */
  openedAt: number;
}

export type ResourceScope = "global" | "project" | "package" | "bundled" | "temporary" | "unknown";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: string;
  scope: ResourceScope;
  /** Absolute path to the SKILL.md file, so the agent can `read` it on invocation. */
  filePath?: string;
  defaultEnabled: boolean;
  enabled: boolean;
  toggleable: boolean;
  disableModelInvocation: boolean;
}

export type McpServerStatus = "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";

export interface McpServerSummary {
  name: string;
  status: McpServerStatus;
  toolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  disabled: boolean;
  error?: string;
}

export interface McpServerConfigDraft {
  name: string;
  scope: "project" | "global";
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  auth?: "none" | "oauth" | "bearer-env";
  bearerTokenEnv?: string;
  env?: Record<string, string>;
}

export interface ResourceCatalog {
  skills: SkillSummary[];
  mcpServers: McpServerSummary[];
  todos: Todo[];
  diagnostics: string[];
}

/**
 * Native (non-Pi-extension) capability types below. These back the self-built
 * MCP / Skill / Subagent / Todo features and are layered in over the refactor
 * phases. They intentionally avoid any Pi-extension trust/approval model.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/**
 * A background process left running by a bash tool execution (e.g. a dev
 * server started with `nohup ... &` / `( ... & )`). Tracked by the utility
 * process so the task panel can show and kill it.
 */
export interface BackgroundProcess {
  id: string;
  /** The bash command that launched it (as invoked by the agent). */
  command: string;
  pid: number;
  startedAt: number;
}

export type DelegationRole = "explore" | "research" | "implement" | "review" | "custom";
export type DelegationStatus = "running" | "completed" | "failed" | "cancelled";

export interface DelegationSummary {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  role: DelegationRole;
  status: DelegationStatus;
  goal: string;
  modelId?: string;
  startedAt: number;
  completedAt?: number;
  /** Last assistant text emitted by the child session, if any. */
  preview?: string;
  error?: string;
}

/**
 * AI 回复期间排队的待发送消息（Pi 会话 steering/followUp 队列的快照投影，
 * 只含当前激活会话）。followUp 是默认形态：本轮回复结束后作为下一轮 user
 * 消息注入；steering 由“立即发送”升级而来：当前回合下一次模型调用前插入。
 */
export interface QueuedMessage {
  kind: "steering" | "followUp";
  /** 在同类队列中的下标；命令以 kind+index+text 寻址，列表变动后校验失败即拒绝。 */
  index: number;
  text: string;
}

export interface RuntimeSnapshot {
  workspace?: string;
  agentId: string;
  agentName: string;
  sessionId?: string;
  sessionFile?: string;
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  busy: boolean;
  status: string;
  turnTiming?: TurnTiming;
  /** 激活会话的待发送队列；空闲会话为空数组。 */
  queuedMessages: QueuedMessage[];
  /** 激活会话的上下文占用估算；无会话或模型窗口未知时缺省。 */
  contextUsage?: ContextUsage;
  messages: ChatMessage[];
  executions: ToolExecution[];
  backgroundProcesses: BackgroundProcess[];
  sessions: SessionSummary[];
  recentWorkspaces: RecentWorkspace[];
}

export interface ExecutionPrincipal {
  kind: "root-agent" | "subagent";
  sessionId: string;
  parentSessionId?: string;
  agentId?: string;
  toolCallId?: string;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  summary: string;
  args: unknown;
  risk: "write" | "command" | "outside-workspace";
  principal: ExecutionPrincipal;
}

export type PermissionDecision = "allow-once" | "allow-session" | "deny";

/** ask_question 的单个问题；type=single/multiple 时附带选项，渲染端另提供自定义输入。 */
export interface QuestionItem {
  text: string;
  type: "text" | "single" | "multiple";
  options: string[];
}

/** ask_question 工具发给渲染端的提问请求；answers 缺省即视为用户取消。 */
export interface QuestionRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  questions: QuestionItem[];
}

export type RuntimeCommand =
  | { type: "initialize"; settings: DesktopSettings; apiKeys: Record<string, string> }
  | { type: "workspace.open"; path: string }
  | { type: "workspace.remove"; workspace: string }
  | { type: "session.new"; workspace?: string }
  | { type: "session.open"; path: string; workspace?: string }
  | { type: "session.rename"; path: string; title: string }
  | { type: "session.pin"; path: string; pinned: boolean }
  | { type: "session.prompt"; text: string; attachments?: PromptAttachment[] }
  | { type: "session.skill"; name: string; instructions?: string; attachments?: PromptAttachment[] }
  | { type: "session.regenerate"; text: string; timestamp?: number; skillName?: string; attachments?: PromptAttachment[] }
  | { type: "session.compact"; instructions?: string }
  | { type: "session.abort" }
  | { type: "session.queue.add"; text: string; skillName?: string; attachments?: PromptAttachment[] }
  | { type: "session.queue.sendNow"; kind: QueuedMessage["kind"]; index: number; text: string }
  | { type: "session.queue.remove"; kind: QueuedMessage["kind"]; index: number; text: string }
  | { type: "agent.select"; agentId: string }
  | { type: "agent.save"; agent: AgentProfile }
  | { type: "agent.archive"; agentId: string; archived: boolean }
  | { type: "settings.save"; settings: Pick<DesktopSettings, "model" | "thinkingLevel" | "accessMode" | "appearance"> }
  | { type: "model.select"; provider: string; id: string }
  | { type: "thinking.select"; level: ThinkingLevel }
  | { type: "auth.set"; provider: string; apiKey: string }
  | { type: "provider.save"; provider: ProviderSettings; apiKey?: string }
  | { type: "provider.models.save"; provider: ProviderSettings }
  | { type: "provider.delete"; providerId: string }
  | { type: "provider.models.fetch"; providerId: string; baseUrl: string; apiKey?: string }
  | { type: "provider.models.refresh"; providerId: string }
  | { type: "vision.save"; vision: VisionSettings }
  | { type: "appearance.save"; appearance: AppearanceSettings }
  | { type: "mcp.server.save"; server: McpServerConfigDraft }
  | { type: "mcp.server.toggle"; name: string; enabled: boolean }
  | { type: "mcp.server.delete"; name: string; scope: "project" | "global" }
  | { type: "skill.toggle"; id: string; enabled: boolean }
  | { type: "todo.create"; title: string; notes?: string }
  | { type: "todo.update"; id: string; title?: string; notes?: string; status?: TodoStatus }
  | { type: "todo.delete"; id: string }
  | { type: "background.kill"; id: string }
  | { type: "resources.reload" }
  | { type: "permission.resolve"; id: string; decision: PermissionDecision }
  | { type: "question.resolve"; id: string; answers?: string[] };

export type RuntimeMessage =
  | { type: "catalog"; models: ModelOption[]; providers: ProviderOption[] }
  | { type: "custom-models"; providerId: string; models: ProviderModelSettings[] }
  | { type: "custom-model-error"; providerId: string; message: string }
  | { type: "models-refreshed"; providerId: string }
  | { type: "models-refresh-error"; providerId: string; message: string }
  | { type: "state"; snapshot: RuntimeSnapshot }
  | { type: "resources"; resources: ResourceCatalog }
  | { type: "todos"; todos: Todo[] }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission.dismiss"; id: string }
  | { type: "question"; request: QuestionRequest }
  | { type: "question.dismiss"; id: string }
  | { type: "error"; message: string }
  | { type: "log"; level: "info" | "warn"; message: string };

export interface DesktopBootstrap {
  platform: string;
  version: string;
  securityWarning?: string;
  settings: DesktopSettings;
  runtime?: RuntimeSnapshot;
  catalog?: { models: ModelOption[]; providers: ProviderOption[] };
  resources?: ResourceCatalog;
}

export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  chooseWorkspace(): Promise<string | undefined>;
  chooseAttachments(workspace?: string): Promise<PromptAttachment[]>;
  /** 位图-only 剪贴板的兜底：无图片时返回 undefined（浏览器演示环境同样返回 undefined）。 */
  readClipboardImage(): Promise<{ data: string } | undefined>;
  choosePreviewFile(): Promise<WorkspaceFilePreview | undefined>;
  readWorkspaceFile(relativePath: string, workspace?: string): Promise<WorkspaceFilePreview>;
  writeWorkspaceFile(relativePath: string, content: string, workspace?: string): Promise<WorkspaceFileWriteResult>;
  listWorkspaceDirectory(workspace: string, relativePath?: string): Promise<WorkspaceDirectoryListing>;
  searchWorkspaceFiles(workspace: string, query: string): Promise<WorkspaceFileSearchResult>;
  createWorkspaceFile(workspace: string, relativePath: string): Promise<WorkspaceEntryResult>;
  createWorkspaceDirectory(workspace: string, relativePath: string): Promise<WorkspaceEntryResult>;
  deleteWorkspaceEntry(workspace: string, relativePath: string): Promise<WorkspaceEntryResult>;
  renameWorkspaceEntry(workspace: string, relativePath: string, newName: string): Promise<WorkspaceEntryResult>;
  browserPreview(command: BrowserPreviewCommand): Promise<BrowserPreviewState>;
  terminal(command: TerminalCommand): Promise<void>;
  send(command: RuntimeCommand): Promise<void>;
  onRuntimeMessage(listener: (message: RuntimeMessage) => void): () => void;
  onBrowserPreviewState(tabId?: string, listener?: (state: BrowserPreviewState) => void): () => void;
  onTerminalData(terminalId: string, listener: (event: TerminalEventData) => void): () => void;
}
