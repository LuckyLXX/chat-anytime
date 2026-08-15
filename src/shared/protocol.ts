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
  /** Image data is kept separately so the editable CSS stays readable. */
  assets?: ThemeAssetMap;
}

export type ThemeColorKey = "accent" | "accentHover" | "userBubble" | "aiBubble";
export type ThemeOverrideMode = "light" | "dark";

export interface ThemeColorOverrides {
  accent?: string;
  accentHover?: string;
  userBubble?: string;
  aiBubble?: string;
  wallpaperOpacity?: number;
}

export interface ThemeOverrides {
  light: ThemeColorOverrides;
  dark: ThemeColorOverrides;
}

export interface AppearanceSettings {
  theme: "system" | "light" | "dark";
  themePreset: ThemePresetId;
  customCss: string;
  /** Imported image data keyed by the relative url used in customCss. */
  customCssAssets?: ThemeAssetMap;
  customThemes: CustomThemeDefinition[];
  themeOverrides: ThemeOverrides;
  showThinking: boolean;
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

export type WorkspaceFilePreviewKind = "markdown" | "code" | "html" | "svg" | "image" | "text" | "binary";

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

export interface WorkspaceDirectoryEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
}

export interface WorkspaceDirectoryListing {
  relativePath: string;
  entries: WorkspaceDirectoryEntry[];
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

export interface SessionSummary {
  id: string;
  path: string;
  workspace: string;
  title: string;
  modifiedAt: number;
  messageCount: number;
  pinned?: boolean;
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
  | { type: "agent.select"; agentId: string }
  | { type: "agent.save"; agent: AgentProfile }
  | { type: "agent.archive"; agentId: string; archived: boolean }
  | { type: "settings.save"; settings: Pick<DesktopSettings, "model" | "thinkingLevel" | "accessMode" | "appearance"> }
  | { type: "model.select"; provider: string; id: string }
  | { type: "thinking.select"; level: ThinkingLevel }
  | { type: "auth.set"; provider: string; apiKey: string }
  | { type: "provider.save"; provider: ProviderSettings; apiKey?: string }
  | { type: "provider.delete"; providerId: string }
  | { type: "provider.models.fetch"; providerId: string; baseUrl: string; apiKey?: string }
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
  | { type: "permission.resolve"; id: string; decision: PermissionDecision };

export type RuntimeMessage =
  | { type: "catalog"; models: ModelOption[]; providers: ProviderOption[] }
  | { type: "custom-models"; providerId: string; models: ProviderModelSettings[] }
  | { type: "custom-model-error"; providerId: string; message: string }
  | { type: "state"; snapshot: RuntimeSnapshot }
  | { type: "resources"; resources: ResourceCatalog }
  | { type: "todos"; todos: Todo[] }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission.dismiss"; id: string }
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
  choosePreviewFile(): Promise<WorkspaceFilePreview | undefined>;
  readWorkspaceFile(relativePath: string, workspace?: string): Promise<WorkspaceFilePreview>;
  writeWorkspaceFile(relativePath: string, content: string, workspace?: string): Promise<WorkspaceFileWriteResult>;
  listWorkspaceDirectory(workspace: string, relativePath?: string): Promise<WorkspaceDirectoryListing>;
  browserPreview(command: BrowserPreviewCommand): Promise<BrowserPreviewState>;
  send(command: RuntimeCommand): Promise<void>;
  onRuntimeMessage(listener: (message: RuntimeMessage) => void): () => void;
  onBrowserPreviewState(tabId?: string, listener?: (state: BrowserPreviewState) => void): () => void;
}
