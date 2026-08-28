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
  /** 目录元数据（含用户修正后的生效值）。 */
  contextWindow?: number;
  maxTokens?: number;
  /** 目录条目的启用状态（settings.providers 的勾选结果）；缺省视为启用。目录必须包含被禁用的模型（设置页要还原勾选），选择器类消费方自行过滤 enabled !== false。 */
  enabled?: boolean;
}

export interface ProviderModelSettings {
  id: string;
  name: string;
  imageInput?: boolean;
  /** 用户手动修正的最大上下文窗口（tokens）；缺省回退到目录/模板值。 */
  contextWindow?: number;
  /** 用户手动修正的最大输出 token；缺省回退到目录/模板值。 */
  maxTokens?: number;
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

/**
 * Per-mode user preference for the chat-bubble translucency slider (widget /
 * bubble-mode only): the wallpaper-mode alpha for message bubbles and their
 * inner fills, 0-1. Undefined means the application default (0.8) applies.
 */
export interface BubbleOpacityOverrides {
  light?: number;
  dark?: number;
}

/**
 * Per-mode user preference for the sidebar/topbar/right-panel/composer
 * translucency slider (wallpaper mode only): how much of the theme's
 * --panel-bg survives the color-mix blend, 0-1. Undefined (or 1) keeps the
 * theme's panel background as-is.
 */
export interface PanelOpacityOverrides {
  light?: number;
  dark?: number;
}

/**
 * 运行时界面微调（主题之上的可选覆盖层）。缺省 undefined = 跟随主题/默认视觉。
 * density 控制侧栏列表行高与主控件高度；radius 控制控件/容器圆角。
 * 默认值等于当前视觉现状，主题可忽略或覆盖对应 token。
 */
export interface InterfaceTuning {
  density?: "compact" | "comfortable" | "relaxed";
  radius?: "square" | "small" | "medium" | "round";
}

export interface AppearanceSettings {
  theme: "system" | "light" | "dark";
  themePreset: ThemePresetId;
  customCss: string;
  /** 运行时界面微调（密度/圆角），缺省时保持主题默认。 */
  tune?: InterfaceTuning;
  /** Imported image/font data keyed by the relative url used in customCss. */
  customCssAssets?: ThemeAssetMap;
  customThemes: CustomThemeDefinition[];
  wallpaperOpacity?: WallpaperOpacityOverrides;
  bubbleOpacity?: BubbleOpacityOverrides;
  panelOpacity?: PanelOpacityOverrides;
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

/** 长期记忆总开关：关闭后不注入索引快照、memory_* 工具返回停用提示（工具保持注册，无需重建会话）。 */
export interface MemorySettings {
  enabled: boolean;
}

/**
 * 钩子系统总开关：关闭后所有事件不触发任何动作（规则保留在配置文件中）。
 * 与 memory 同款语义：字段缺省视为启用，消费方用 `settings.hooks?.enabled !== false` 判断。
 */
export interface HooksSettings {
  enabled: boolean;
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
  memory?: MemorySettings;
  hooks?: HooksSettings;
  browser?: BrowserSettings;
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
  /**
   * 交付产物：本次工具调用产出/改动的工作区内文件（可多个）。
   * edit/write 直接取路径；其它产出型工具（bash、MCP 等）从工具结果文本
   * 解析候选路径并校验存在性后回填。changedFile 为其单文件兼容形态，
   * 渲染端优先读取本数组。
   */
  changedFiles?: { relativePath: string }[];
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
  /** AI 正在操作此标签页时的操作描述（如「点击 @e3」）；缺省表示无 AI 操作。 */
  automating?: string;
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
  | { type: "close"; tabId?: string }
  /** 手动元素选择模式：开启后用户点击页面元素会被捕获并推送给渲染端。 */
  | { type: "pick-mode"; tabId?: string; enabled: boolean };

/**
 * 手动元素选择结果：用户在预览浏览器点击元素后，页面 preload 在点击位置
 * 就地弹出的迷你输入卡上确认（可带备注文本），随元素一起经 main 进程转发
 * 给渲染端（browser-preview:pick 推送），写入聊天输入框。
 */
export interface BrowserElementPick {
  tabId: string;
  /** 选中时刻的页面 URL（元素引用来源；同源 iframe 内的元素为该 iframe 的 URL）。 */
  url: string;
  /** 用户在就地输入卡里填写、随元素一起发送的备注（可空）。 */
  note?: string;
  element: {
    tag: string;
    /** 从文档根（或最近的 id 锚点）到该元素的 CSS 选择器路径，AI 可用于精确定位。 */
    path?: string;
    role?: string;
    type?: string;
    /** aria-label / placeholder / alt / title 之一。 */
    name?: string;
    /** 元素的文本或值（已压缩空白、截断）。 */
    text?: string;
    /** 最近的 <a> 链接（含元素自身）。 */
    href?: string;
    /** <img> 的图片地址。 */
    src?: string;
  };
}

/**
 * 内置浏览器自动化（AI 操作内置浏览器）。工具在 utility 进程执行，
 * 操作在 main 进程通过 CDP 驱动可见预览标签页；请求经
 * RuntimeMessage["browser-automation.request"] 上行、结果经
 * RuntimeCommand["browser-automation.result"] 回传。sessionKey 是发起
 * 操作的 Pi 会话 id，main 用它维护「会话 → 标签页」绑定。
 */

/** browser_wait 的等待条件。 */
export type BrowserAutomationWait =
  | { kind: "load"; timeoutMs: number }
  | { kind: "selector"; selector: string; timeoutMs: number }
  | { kind: "url"; pattern: string; timeoutMs: number }
  | { kind: "ms"; ms: number };

export type BrowserAutomationRequest =
  | { op: "attach" }
  | { op: "navigate"; url: string }
  | { op: "snapshot" }
  | { op: "click"; ref: string }
  | { op: "type"; ref: string; text: string; mode: "fill" | "append" }
  | { op: "press"; key: string }
  | { op: "scroll"; direction: "up" | "down"; amount: number; ref?: string }
  | { op: "eval"; expression: string; mode: "read" | "write" }
  | { op: "select"; ref: string; values: string[] }
  | { op: "upload"; ref: string; files: string[] }
  | { op: "screenshot"; fullPage?: boolean; scale?: number; maxWidth?: number; format?: "png" | "jpeg"; quality?: number }
  | { op: "wait"; wait: BrowserAutomationWait }
  | { op: "get"; what: "url" | "title" | "text"; ref?: string }
  | { op: "tabs"; action: "list" | "new" | "switch" | "close"; tabId?: string };

/** 各操作的成功载荷。 */
export type BrowserAutomationData =
  | { kind: "attach"; tabId: string; url: string }
  | { kind: "navigate"; url: string; title: string }
  | { kind: "snapshot"; text: string; refCount: number; truncated: boolean }
  | { kind: "click"; description: string }
  | { kind: "type"; description: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; description: string }
  | { kind: "select"; description: string }
  | { kind: "upload"; description: string }
  | { kind: "eval"; value: string }
  | { kind: "screenshot"; data: string; width: number; height: number; mimeType: "image/png" | "image/jpeg" }
  | { kind: "wait"; description: string }
  | { kind: "get"; value: string }
  | { kind: "tabs"; tabs: BrowserTabSummary[] };

export type BrowserAutomationResult =
  | { ok: true; data: BrowserAutomationData }
  | { ok: false; error: string };

export interface BrowserTabSummary {
  id: string;
  url: string;
  title: string;
  /** 该标签页是否是发起方会话当前绑定的标签页。 */
  active: boolean;
}

/** 标签页生命周期推送：AI（或用户）创建/关闭标签页时通知渲染端同步预览面板。 */
export type BrowserTabsEvent =
  | { action: "created"; tabId: string; url: string }
  | { action: "closed"; tabId: string }
  /** AI 会话开始操作某个标签页：渲染端自动展开预览面板并激活该标签（用户可见）。 */
  | { action: "automation-started"; tabId: string };

/** 浏览器自动化总开关；缺省视为启用（settings.browser?.enabled !== false）。 */
export interface BrowserSettings {
  enabled: boolean;
}

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

/**
 * 钩子监听的会话生命周期事件（Pi 扩展事件名的稳定子集）。
 * 注意粒度：agent_end 是一次完整回复（含全部工具调用小轮）结束，只触发一次；
 * turn_end 是每个模型调用小轮结束，一次回复会触发多次。
 */
export type HookEventName = "session_start" | "tool_call" | "tool_execution_end" | "agent_end" | "turn_end";

/**
 * 钩子动作。notify/http/block 是 app 内置动作（零脚本），command 是用户 shell
 * 逃生舱。block 与 command.blocking 只在 tool_call 事件上有阻断语义。
 */
export type HookAction =
  | { kind: "notify"; title?: string; body?: string }
  | { kind: "http"; url: string }
  | { kind: "block"; deny: string[] }
  | { kind: "command"; command: string; blocking?: boolean };

/** pidesktop-hooks.json 中的一条钩子规则；name 在单个配置文件内唯一。 */
export interface HookRule {
  name: string;
  event: HookEventName;
  /** 工具名正则（仅 tool_call / tool_execution_end 有意义）；缺省匹配全部工具。 */
  matcher?: string;
  /** App-owned 停用标记，语义与 MCP 的 disabled 一致。 */
  disabled?: boolean;
  /** command 动作超时毫秒；缺省 10s，允许 1s–120s。 */
  timeoutMs?: number;
  action: HookAction;
}

/** 面板保存钩子时的载荷（规则 + 写入哪个作用域文件）。 */
export interface HookRuleDraft {
  name: string;
  scope: "project" | "global";
  event: HookEventName;
  matcher?: string;
  timeoutMs?: number;
  action: HookAction;
}

/** 资源目录中的钩子投影（面板列表项）。 */
export interface HookSummary {
  name: string;
  event: HookEventName;
  matcher?: string;
  actionKind: HookAction["kind"];
  /** 完整动作定义（面板“编辑”回填表单用）。 */
  action: HookAction;
  /** 动作的一行摘要（命令 / URL / 正则条数 / 通知文案）。 */
  actionPreview: string;
  /** tool_call 事件上的拦截型钩子（block 或 blocking command）。 */
  blocking: boolean;
  scope: "project" | "global";
  enabled: boolean;
}

export interface ResourceCatalog {
  skills: SkillSummary[];
  mcpServers: McpServerSummary[];
  todos: Todo[];
  /** 激活助手的全量记忆主题（面板治理视图，不经工作区过滤）。 */
  memory: MemoryTopic[];
  /** 双作用域合并后的钩子规则（项目覆盖全局）。 */
  hooks: HookSummary[];
  /** 钩子总开关（settings.hooks 的实时投影），面板头部的治理开关。 */
  hooksEnabled: boolean;
  diagnostics: string[];
}

/**
 * Native (non-Pi-extension) capability types below. These back the self-built
 * MCP / Skill / Subagent / Todo features and are layered in over the refactor
 * phases. They intentionally avoid any Pi-extension trust/approval model.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

/** dsh 式最小条目形状：整表替换语义下不需要稳定 id / 备注 / 时间戳。 */
export interface Todo {
  content: string;
  status: TodoStatus;
}

/**
 * 长期记忆主题：`pidesktop-memory/<agentId>/topics/<id>.md` 的协议投影。
 * 正文只在面板编辑时随推送全量下发；模型侧细节按需经 memory_read 取。
 */
export interface MemoryTopic {
  /** 稳定文件名 id（topics/<id>.md 的 stem，不随标题变化）。 */
  id: string;
  title: string;
  /** 一句话索引行描述（存在性编码：只路由，不承载正文）。 */
  description: string;
  /** 绑定的工作区绝对路径；缺省为全局记忆（所有会话可见）。 */
  workspace?: string;
  content: string;
  /** YYYY-MM-DD；时间敏感事实还应在正文内另行标注日期。 */
  createdAt: string;
  updatedAt: string;
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
  /** 当前工作区的 git 分支（非 git 项目或缺省为空时不提供）。 */
  gitBranch?: string;
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
  /** 激活会话是否处于计划模式（先产出计划、审查批准后才实施）。 */
  planMode?: boolean;
  messages: ChatMessage[];
  executions: ToolExecution[];
  backgroundProcesses: BackgroundProcess[];
  sessions: SessionSummary[];
  recentWorkspaces: RecentWorkspace[];
}

/**
 * 分屏格子的会话级快照：渲染端同时展示多个会话时，非激活（parked 但被
 * watch 的）会话通过 `session.state` 推送获得与 RuntimeSnapshot 同构的会话
 * 字段；激活会话仍走完整 `state` 推送（两通道字段一致，渲染端按 sessionId
 * 归一）。构建逻辑见 pi-runtime 的 `paneSnapshotFrom`（snapshot() 复用它）。
 */
export interface SessionPaneSnapshot {
  sessionId?: string;
  sessionFile?: string;
  /** 该会话的工作区（record 捕获值）：格子的发送/@提及/附件据此判断。 */
  workspace?: string;
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  busy: boolean;
  status: string;
  turnTiming?: TurnTiming;
  queuedMessages: QueuedMessage[];
  contextUsage?: ContextUsage;
  planMode?: boolean;
  messages: ChatMessage[];
  executions: ToolExecution[];
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
  risk: "write" | "command" | "outside-workspace" | "browse";
  principal: ExecutionPrincipal;
}

export type PermissionDecision = "allow-once" | "allow-session" | "deny";

/** ask_question 的单个问题；type=single/multiple 时附带选项，渲染端另提供自定义输入。 */
export interface QuestionItem {
  text: string;
  type: "text" | "single" | "multiple";
  options: string[];
  /** 可选 markdown 详情（如计划审查展示计划全文），渲染在题目文本与选项之间；缺省不渲染。 */
  detail?: string;
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
  /** activate=false（分屏启动恢复的背景格）：创建 record 但不激活——全局镜像
   * 与 state 通道保持焦点格，格子数据走 session.state（watch 已先行排队）。 */
  | { type: "session.open"; path: string; workspace?: string; activate?: boolean }
  | { type: "session.rename"; path: string; title: string }
  | { type: "session.pin"; path: string; pinned: boolean }
  | { type: "session.delete"; path: string }
  | { type: "session.prompt"; text: string; attachments?: PromptAttachment[]; sessionId?: string }
  | { type: "session.skill"; name: string; instructions?: string; attachments?: PromptAttachment[]; sessionId?: string }
  | { type: "session.regenerate"; text: string; timestamp?: number; skillName?: string; attachments?: PromptAttachment[]; sessionId?: string }
  | { type: "session.compact"; instructions?: string; sessionId?: string }
  | { type: "session.planMode"; enabled: boolean; sessionId?: string }
  | { type: "session.abort"; sessionId?: string }
  | { type: "session.queue.add"; text: string; skillName?: string; attachments?: PromptAttachment[]; sessionId?: string }
  | { type: "session.queue.sendNow"; kind: QueuedMessage["kind"]; index: number; text: string; sessionId?: string }
  | { type: "session.queue.remove"; kind: QueuedMessage["kind"]; index: number; text: string; sessionId?: string }
  /** 分屏：渲染端注册/注销某会话为“正在渲染”（watched）。watched 会话豁免空闲
   * 驱逐、流式事件改走 session.state 推送、不设侧栏终端圆点；首次 watch 立即
   * 推送一次全量 session.state 供水合。hidden=true 是“注册但暂停推送”模式
   * （最大化时其余格子）：保留驱逐豁免与圆点语义，只停 session.state 流，
   * 从 hidden 切回可见时主进程补推一帧水合。 */
  | { type: "session.watch"; sessionId: string; watch: boolean; hidden?: boolean }
  | { type: "agent.select"; agentId: string }
  | { type: "agent.save"; agent: AgentProfile }
  | { type: "agent.archive"; agentId: string; archived: boolean }
  | { type: "settings.save"; settings: Pick<DesktopSettings, "model" | "thinkingLevel" | "accessMode" | "appearance" | "browser"> }
  | { type: "model.select"; provider: string; id: string; sessionId?: string }
  | { type: "thinking.select"; level: ThinkingLevel; sessionId?: string }
  | { type: "auth.set"; provider: string; apiKey: string }
  | { type: "provider.save"; provider: ProviderSettings; apiKey?: string }
  | { type: "provider.models.save"; provider: ProviderSettings }
  | { type: "provider.delete"; providerId: string }
  | { type: "provider.models.fetch"; providerId: string; baseUrl: string; apiKey?: string }
  | { type: "provider.models.refresh"; providerId: string }
  | { type: "vision.save"; vision: VisionSettings }
  | { type: "memory.save"; memory: MemorySettings }
  | { type: "memory.create"; topic: string; description: string; content: string; workspaceScoped?: boolean }
  | { type: "memory.update"; topic: string; description: string; content: string }
  | { type: "memory.delete"; topic: string }
  | { type: "appearance.save"; appearance: AppearanceSettings }
  | { type: "mcp.server.save"; server: McpServerConfigDraft }
  | { type: "mcp.server.toggle"; name: string; enabled: boolean }
  | { type: "mcp.server.delete"; name: string; scope: "project" | "global" }
  | { type: "hooks.save"; hook: HookRuleDraft }
  | { type: "hooks.toggle"; name: string; scope: "project" | "global"; enabled: boolean }
  | { type: "hooks.delete"; name: string; scope: "project" | "global" }
  | { type: "hooks.settings"; hooks: HooksSettings }
  /** 用样例上下文试跑一条钩子（面板“测试”按钮）；sample 是给 bash/拦截正则用的样例行。 */
  | { type: "hooks.run"; name: string; scope: "project" | "global"; sample?: string }
  | { type: "skill.toggle"; id: string; enabled: boolean }
  | { type: "background.kill"; id: string }
  | { type: "resources.reload" }
  | { type: "permission.resolve"; id: string; decision: PermissionDecision }
  | { type: "question.resolve"; id: string; answers?: string[] }
  /** main 进程回传的浏览器自动化结果（响应 utility 的 browser-automation.request）。 */
  | { type: "browser-automation.result"; requestId: string; result: BrowserAutomationResult };

export type RuntimeMessage =
  | { type: "catalog"; models: ModelOption[]; providers: ProviderOption[] }
  | { type: "custom-models"; providerId: string; models: ProviderModelSettings[] }
  | { type: "custom-model-error"; providerId: string; message: string }
  | { type: "models-refreshed"; providerId: string }
  | { type: "models-refresh-error"; providerId: string; message: string }
  | { type: "state"; snapshot: RuntimeSnapshot }
  /** 分屏格子（watched 非激活会话）的会话级快照；与 state 的节流节奏一致（50ms 批量、生命周期立即）。 */
  | { type: "session.state"; snapshot: SessionPaneSnapshot }
  | { type: "resources"; resources: ResourceCatalog }
  | { type: "todos"; todos: Todo[] }
  | { type: "memory"; memory: MemoryTopic[] }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission.dismiss"; id: string }
  | { type: "question"; request: QuestionRequest }
  | { type: "question.dismiss"; id: string }
  | { type: "hook-notify"; title: string; body: string; /** 触发钩子的会话；主进程据此在“正在查看且窗口聚焦”时免打扰。 */
    sessionId?: string;
    /** 该会话当前是否正被渲染端展示（激活或分屏 watch）；main 端免打扰判断用。 */
    visible?: boolean }
  | { type: "hook-run"; name: string; scope: "project" | "global"; ok: boolean; blocked?: boolean; detail: string; durationMs: number }
  /** utility 进程发起的浏览器自动化操作；main 完成后以 browser-automation.result 命令回传。 */
  | { type: "browser-automation.request"; requestId: string; sessionKey: string; request: BrowserAutomationRequest }
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
  browserAutomationCancel(tabId: string): Promise<void>;
  terminal(command: TerminalCommand): Promise<void>;
  send(command: RuntimeCommand): Promise<void>;
  onRuntimeMessage(listener: (message: RuntimeMessage) => void): () => void;
  onBrowserPreviewState(tabId?: string, listener?: (state: BrowserPreviewState) => void): () => void;
  onBrowserTabsChanged(listener: (event: BrowserTabsEvent) => void): () => void;
  onBrowserElementPicked(listener: (pick: BrowserElementPick) => void): () => void;
  onTerminalData(terminalId: string, listener: (event: TerminalEventData) => void): () => void;
}
