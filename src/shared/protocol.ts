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
  role: "user" | "assistant";
  timestamp: number;
  blocks: MessageBlock[];
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
}

export interface SessionSummary {
  id: string;
  path: string;
  workspace: string;
  title: string;
  modifiedAt: number;
  messageCount: number;
}

export type ResourceScope = "global" | "project" | "package" | "bundled" | "temporary" | "unknown";

export type ExtensionOrigin = "bundled" | "local" | "package" | "unknown";
export type ExtensionTrust = "trusted" | "restricted" | "blocked" | "undecided";
export type ExtensionExecutionMode = "native" | "restricted-host";
export type ExtensionCompatibility = "full" | "partial" | "unsupported" | "unknown";

export interface SkillSummary {
  name: string;
  description: string;
  source: string;
  scope: ResourceScope;
  disableModelInvocation: boolean;
}

export interface ExtensionSummary {
  id: string;
  name: string;
  source: string;
  scope: ResourceScope;
  origin: ExtensionOrigin;
  trust: ExtensionTrust;
  executionMode: ExtensionExecutionMode;
  enabled: boolean;
  modelVisible: boolean;
  compatibility: ExtensionCompatibility;
  tools: string[];
  commands: string[];
  loaded: boolean;
  error?: string;
}

export interface PackageSummary {
  source: string;
  scope: "global" | "project" | "bundled";
  installed: boolean;
  removable: boolean;
}

export type McpServerStatus = "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";

export interface McpServerSummary {
  name: string;
  status: McpServerStatus;
  toolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  disabled: boolean;
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
  extensions: ExtensionSummary[];
  packages: PackageSummary[];
  mcpServers: McpServerSummary[];
  mcpAdapterLoaded: boolean;
  diagnostics: string[];
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
  sessions: SessionSummary[];
}

export interface ExecutionPrincipal {
  kind: "root-agent" | "subagent" | "native-extension" | "restricted-extension";
  sessionId: string;
  parentSessionId?: string;
  agentId?: string;
  extensionId?: string;
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

export type ExtensionUiDialogRequest =
  | { id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: "editor"; title: string; prefill?: string };

export interface ExtensionUiResponse {
  id: string;
  cancelled?: boolean;
  value?: string;
  confirmed?: boolean;
}

export type RuntimeCommand =
  | { type: "initialize"; settings: DesktopSettings; apiKeys: Record<string, string> }
  | { type: "workspace.open"; path: string }
  | { type: "session.new" }
  | { type: "session.open"; path: string; workspace?: string }
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
  | { type: "resources.package.install"; source: string }
  | { type: "resources.package.remove"; source: string; scope?: "global" | "project" }
  | { type: "resources.extension.approve"; id: string }
  | { type: "resources.reload" }
  | { type: "mcp.server.save"; server: McpServerConfigDraft }
  | { type: "mcp.server.toggle"; name: string; enabled: boolean }
  | { type: "extension-ui.resolve"; response: ExtensionUiResponse }
  | { type: "permission.resolve"; id: string; decision: PermissionDecision };

export type RuntimeMessage =
  | { type: "catalog"; models: ModelOption[]; providers: ProviderOption[] }
  | { type: "custom-models"; providerId: string; models: ProviderModelSettings[] }
  | { type: "custom-model-error"; providerId: string; message: string }
  | { type: "state"; snapshot: RuntimeSnapshot }
  | { type: "resources"; resources: ResourceCatalog }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission.dismiss"; id: string }
  | { type: "extension-ui.request"; request: ExtensionUiDialogRequest }
  | { type: "extension-ui.dismiss"; id: string }
  | { type: "extension-ui.notify"; message: string; level: "info" | "warning" | "error" }
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
  send(command: RuntimeCommand): Promise<void>;
  onRuntimeMessage(listener: (message: RuntimeMessage) => void): () => void;
}
