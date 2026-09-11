export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AccessMode = "read-only" | "ask" | "workspace" | "full";

import type { DesignCanvasInfo, DesignNode, DesignOp } from "./design-schema.js";
export type { DesignCanvasInfo, DesignDoc, DesignLayout, DesignNode, DesignNodeDraft, DesignOp, DesignNodeType } from "./design-schema.js";
export { applyDesignOps, cloneNodeWithNewIds, countNodes, createDesignDoc, findNode, makeNodeId, normalizeDesignDoc, sanitizeDesignName, summarizeNode } from "./design-schema.js";

/** 模型请求的 API 模式：OpenAI 兼容 chat completions，或较新的 Responses（/v1/responses）。 */
export type ProviderApiMode = "openai-completions" | "openai-responses";

/** powershell 为 opt-in 工具：存量 Agent 配置缺键时默认关闭（见 settings.ts defaultToolEnabled）。 */
export type BuiltinToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";

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
  /** 模型当前生效的 API 模式（目录定义优先，settings 覆盖优先于目录）；仅用于设置页展示，且只携带 OpenAI 兼容两档值。 */
  api?: ProviderApiMode;
}

export interface ProviderModelSettings {
  id: string;
  name: string;
  imageInput?: boolean;
  /** 用户手动修正的最大上下文窗口（tokens）；缺省回退到目录/模板值。 */
  contextWindow?: number;
  /** 用户手动修正的最大输出 token；缺省回退到目录/模板值。 */
  maxTokens?: number;
  /** 模型级 API 模式覆盖；缺省 = 跟随服务商默认（自定义）或目录定义（内置）。 */
  api?: ProviderApiMode;
  /** Whether this model is shown in the composer model switcher. */
  enabled?: boolean;
  /**
   * `true` marks a hand-added model entry（设置页「手动添加」或空列表时手填的
   * 模型 ID）：上游 /models 刷新不会丢弃它（mergeProviderModels 保留），内置
   * 服务商还据此把它克隆进 models-store 覆盖层（否则目录里没有这个模型，
   * 会话无法使用）。缺省 = 目录/拉取来源的普通条目。
   */
  manual?: boolean;
}

export interface ProviderSettings {
  id: string;
  name: string;
  /**
   * 接口地址。自定义服务商必填；内置服务商（custom:false）可选携带 = 覆盖目录
   * 默认地址（空/缺省 = 跟随目录）。
   */
  baseUrl: string;
  models: ProviderModelSettings[];
  keyConfigured?: boolean;
  /**
   * 服务商级 API 模式覆盖。自定义服务商缺省按 openai-completions 解析保持现状；
   * 内置服务商（custom:false）可选携带 = 整组覆盖目录 API 模式。
   */
  api?: ProviderApiMode;
  /**
   * `false` marks a built-in provider entry that only records per-model
   * visibility (optional baseUrl/api overrides). Absent/true means an
   * OpenAI-compatible custom provider entry.
   */
  custom?: boolean;
}

export interface ProviderOption {
  id: string;
  name: string;
  configured: boolean;
  authSource?: string;
  custom?: boolean;
  /**
   * 该服务商是否支持「手动添加模型」。自定义服务商恒支持（模型表就是设置
   * 条目）；内置服务商只有 PiDesktop 直连管理 models-store 覆盖层的渠道
   * （BUILTIN_MODELS_ENDPOINTS）支持——远程目录渠道（radius 等）的覆盖键由
   * SDK 管理，写入会破坏其 etag/lastModified 门控。缺省 = 不支持。
   */
  manualModels?: boolean;
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

/** Div 气泡模式三档：off 不注入提示词；auto 按场景酌情使用；always 所有回复强制气泡。 */
export type DivBubbleMode = "off" | "auto" | "always";

/** 子智能体作用域：global=用户级（所有工作区可见）；project=项目级（仅绑定工作区生效）。 */
export type SubagentScope = "global" | "project";

/** 自定义子智能体定义：delegate_agent 委派时可按名称引用，覆盖固定的 role 枚举。 */
export interface SubagentDefinition {
  id: string;
  name: string;
  description: string;
  /** 列表/卡片上显示的颜色标记（一组预设色之一的 key，如 "amber"）。 */
  color?: string;
  /** 委派时使用的模型；缺省继承主会话当前模型。 */
  model?: { provider: string; id: string };
  systemPrompt: string;
  /** 可用工具集："inherit" = 继承父会话已启用的内置工具；否则按启停数组精确控制。 */
  tools: Record<BuiltinToolName, boolean> | "inherit";
  scope: SubagentScope;
  /** 是否注入工作区 AGENTS.md 作为子代理系统提示的一部分。 */
  injectAgentsMd?: boolean;
  builtin?: boolean;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  divMode: DivBubbleMode;
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
  /** 界面动效总开关：false = 关停全部过渡/弹出动画（styles.css 的
   *  html[data-ui-motion="off"] 关停块）；缺省/true = 开启。系统
   *  prefers-reduced-motion 时无论该值如何都会关停。 */
  motion?: boolean;
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
  /** 已废弃（保留为迁移期一次性兜底）：旧版全局工作区。启动 initialize 时仅当前活跃助手消费一次（提升进 agentWorkspaces）后冻结，不再写入。 */
  workspace?: string;
  /** 每助手最后使用的工作区（agentId → resolve 后的绝对路径）。刻意不进 AgentProfile（agent.save 整对象覆盖会过期冲掉运行时字段）；与 pinnedSessionPaths 同级，设置页不渲染，渲染端类型零负担。 */
  agentWorkspaces?: Record<string, string>;
  /** 默认工作区：没有选择过工作区的助手所有会话落位于此；未自定义时使用内置目录 <agentDir>/workspace-default（mkdir 幂等创建）。设置页「通用」tab 可改。 */
  defaultWorkspace?: string;
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
  design?: DesignSettings;
  checkpoint?: CheckpointSettings;
  customProvider?: CustomProviderSettings;
  customProviderKeyConfigured?: boolean;
  pinnedSessionPaths?: string[];
}

/** checkpoint 回滚总开关，语义与 memory/hooks/browser 相同：缺省视为启用。 */
export interface CheckpointSettings {
  enabled?: boolean;
}

/** 单个文件的回滚结果；action=skipped 时 detail 说明原因。toolCallIds 供渲染端把行标记为已回滚。 */
export interface CheckpointRollbackResult {
  relativePath: string;
  action: "restored" | "deleted" | "skipped";
  detail?: string;
  /** 该文件在本回复内被改动的全部调用 id；skipped 时缺省。 */
  toolCallIds?: string[];
}

/** 回滚目标：单个文件 + 它在该回复内被改动的全部工具调用 id（主进程据此取该文件最早快照 = 回复动手前状态）。 */
export interface CheckpointRollbackTarget {
  relativePath: string;
  toolCallIds: string[];
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
  /**
   * 本消息携带的斜杠调用（Skill / 自定义命令），按选择顺序排列——一条消息可挂
   * 多个、可混搭（composer 多次「空格 + /」挑选）。气泡按此渲染徽标、编辑重发
   * 按此回填 chips。历史消息里的旧 marker（单 skill / 单命令）由 message-normalize
   * 归一成只含一项的数组，读旧会话没有差异。
   */
  invocations?: SlashInvocation[];
  attachments?: Array<{ kind: PromptAttachment["kind"]; name: string; relativePath?: string }>;
  streaming?: boolean;
  error?: string;
  /**
   * 该条 assistant 消息以「中止」结束（用户点停止；Pi 的 stopReason=aborted）。
   * 与 error 互斥：中止不是失败，各家 SDK 的中止英文原文（This operation was
   * aborted / Request aborted …）已在归一化时剥离，渲染端只显示中性「已停止生成」。
   */
  aborted?: boolean;
}

export interface TurnTiming {
  startedAt: number;
  answerStartedAt?: number;
  completedAt?: number;
}

/**
 * dsh（deepseek-harness）风格的会话性能统计，驱动输入框下方的状态行。
 * 时间指标（llmMs/toolMs/ttft/decode）只在进程存活期内累计——时间戳不进
 * JSONL，恢复会话时只回填可从 transcript 重派的计数字段；口径见 speed-stats.ts。
 */
export interface SpeedStats {
  /** 用户轮次数：每次发送/重新生成（beginTurn）计 1。 */
  turns: number;
  /** 模型调用步数：每个有效完成的 assistant 消息（一次 turn 周期）= 1 步。 */
  steps: number;
  /** LLM 耗时累计（ms）：Σ(assistant 消息完成 − 该步 turn_start)，不含工具执行。 */
  llmMs: number;
  /** 工具执行耗时累计（ms）：Σ(tool_execution_end − start)。 */
  toolMs: number;
  /** 首 token 延迟累计与计步数（出现过流式首帧的步）；平均 = ttftMs / ttftSteps。 */
  ttftMs: number;
  ttftSteps: number;
  /** 解码阶段（首帧 → 消息完成）累计，只统计带 usage 的步；tok/s = decodeTokens / decodeMs。 */
  decodeTokens: number;
  decodeMs: number;
  /** 会话累计计费输入（input+cacheRead+cacheWrite）与输出 token；与缓存命中率同源（runtime-context-usage）。 */
  promptTokens: number;
  outputTokens: number;
  /**
   * 流式中的实时读数（message_update 节流帧上更新，消息完成即清除）：
   * tokens 是当前步部分消息的本地估算（chars/4，含 thinking/toolCall），与
   * 最终 usage 不同源——实时显示用，收步后被累计口径接管。等待首 token
   * 期间 firstTokenAt 缺省，渲染层按 startedAt 显示计时。
   */
  live?: { startedAt: number; firstTokenAt?: number; tokens: number };
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
  /**
   * 三段近似构成（token 估算）：系统提示词 / 活动工具 schema / 对话消息。
   * 纯本地启发式（chars/4 + 开销），与 tokens 不同源——三行带 ~ 前缀展示，
   * 加总不必等于 tokens（dsh 同款语义）。仅在稳定边界（消息完成/压缩/切模型）
   * 重算，流式期间沿用上一帧。
   */
  breakdown?: ContextUsageBreakdown;
}

/** 上下文三段明细的本地估算（ContextUsage.breakdown）。 */
export interface ContextUsageBreakdown {
  system: number;
  tools: number;
  messages: number;
}

// ─── 用量统计（usage.stats.request → usage-stats-result）───

/** 聚合后的单项用量小计；四类维度（总览/按天/按模型/按会话）共用。 */
export interface UsageAmount {
  /** LLM 请求次数（每条有效 assistant 消息 = 1 次）。 */
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 推理 token（部分模型才返回，全量累加）。 */
  reasoning?: number;
  /** 服务商报告的成本（多数中转报 0，有值才有意义）。 */
  cost: number;
}

export interface UsageTotals extends UsageAmount {
  /** 缓存命中率 %：cacheRead/(input+cacheRead+cacheWrite)；无计费输入时为 null。 */
  cacheHitRate: number | null;
  /** 覆盖范围内最早/最新的消息时间戳（毫秒）。 */
  firstAt?: number;
  lastAt?: number;
}

export interface UsageDayEntry extends UsageAmount {
  /** 本地时区日期 YYYY-MM-DD（按消息时间戳）。 */
  date: string;
}

export interface UsageModelEntry extends UsageAmount {
  model: string;
  provider: string;
  lastAt: number;
}

export interface UsageAgentEntry extends UsageAmount {
  agentId: string;
}

export interface UsageSessionEntry extends UsageAmount {
  agentId: string;
  sessionPath: string;
  /** 首条 user 消息前 60 字符；无 user 消息时用文件名。 */
  title: string;
  lastAt: number;
}

export interface UsageStats {
  generatedAt: number;
  /** 本次实际解析的会话文件数（缓存命中跳过的不计）。 */
  scannedFiles: number;
  scanMs: number;
  total: UsageTotals;
  /** 按本地日期升序。 */
  byDay: UsageDayEntry[];
  /** 按累计输出 token 降序。 */
  byModel: UsageModelEntry[];
  /** 按累计输出 token 降序（助手筛选下拉的数据源）。 */
  byAgent: UsageAgentEntry[];
  /** 最近使用的会话（按 lastAt 降序，截前 60 条）。 */
  bySession: UsageSessionEntry[];
}

export interface ToolExecution {
  id: string;
  name: string;
  args: unknown;
  /** aborted = 用户中止导致的结束（区别于工具自身失败的 error）。 */
  status: "running" | "completed" | "error" | "aborted";
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
  /** delegate_agent 的实时/最终委派进度（见 DelegationProgress）；其余工具缺省。 */
  delegation?: DelegationProgress;
}

/** 子代理执行中的一步（对应子会话的一次工具调用）。 */
export interface DelegationStep {
  /** 子会话内的 toolCallId，用于完整记录查看时对齐。 */
  toolCallId: string;
  tool: string;
  /** 人类可读摘要（summarizeArgs 生成，如命令行、文件路径），≤120 字符。 */
  label: string;
  /** aborted = 父会话被用户中止时封口的未完成步骤（渲染中性图标，不转圈不报错）。 */
  status: "running" | "completed" | "error" | "aborted";
  startedAt: number;
  completedAt?: number;
}

/** delegate_agent 工具执行的实时/最终进度，挂 ToolExecution.delegation。 */
export interface DelegationProgress {
  childSessionId: string;
  /** 子会话 JSONL 绝对路径（完整记录查看的入口凭据）。 */
  childSessionFile: string;
  /** 命中的自定义子智能体名（未命中时无此字段，走 role 渲染）。 */
  subagentName?: string;
  subagentColor?: string;
  role: DelegationRole;
  model: { provider: string; id: string };
  steps: DelegationStep[];
}

/**
 * DelegationProgress 形状校验（details 会经 JSONL 持久化/恢复，需防御脏数据；
 * 渲染端与 session-history 恢复共用）。
 */
export function isDelegationProgress(value: unknown): value is DelegationProgress {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DelegationProgress>;
  return typeof record.childSessionId === "string"
    && typeof record.childSessionFile === "string"
    && typeof record.role === "string"
    && Array.isArray(record.steps);
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

/** 文件树「添加到聊天」前的体积探测结果（组装 FileAttachment 用）。 */
export interface WorkspaceFileStat {
  name: string;
  relativePath: string;
  size: number;
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
 * Windows 反斜杠必须先换成正斜杠：scheme 注册为 standard 时 URL 解析器会把 `%5C`
 * 规范化成路径分隔符并丢弃，workspace 段会被拆散（图片/PDF 一并 404）。
 */
export function workspaceFilePreviewUrl(workspace: string, relativePath: string): string {
  const root = workspace.replaceAll("\\", "/");
  const relative = relativePath.replaceAll("\\", "/");
  return `${PREVIEW_FILE_SCHEME}://preview/${encodeURIComponent(root)}/${encodeURIComponent(relative)}`;
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
  /** 页面实测内容尺寸（scrollWidth/Height，主进程 executeJavaScript 量测后推送）；缺省=未量测。 */
  contentWidth?: number;
  contentHeight?: number;
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
  /** 设备视口缩放（适应窗口）：页面 CSS 视口 = bounds 宽 / factor，1 = 原始尺寸。 */
  | { type: "zoom"; tabId?: string; factor: number }
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
  /** workspace：本地文件导航（file:// / 绝对路径）挂载静态预览服务的优先根目录。 */
  | { op: "navigate"; url: string; workspace?: string }
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

/**
 * 设计导出缩略图（design_export 回执附图）。utility 请求 main 用隐藏离屏窗口
 * 渲染导出的 HTML 单文件并截图，省掉 export→navigate→wait→screenshot→recognize
 * 的五步视觉验证回路；请求经 RuntimeMessage["design-snapshot.request"] 上行、
 * 结果经 RuntimeCommand["design-snapshot.result"] 回传（与浏览器 RPC 同旁路语义）。
 */
export interface DesignSnapshotRequest {
  /** 导出 HTML 的绝对路径（design-store 写盘产物，workspace 内）。 */
  htmlPath: string;
  /** 画布 ∪ 顶层内容包围盒（exportBounds）：缩略视口按它适配缩放。 */
  contentWidth: number;
  contentHeight: number;
  /** 截图落盘的工作区（saveBrowserScreenshot 写 .pidesktop/screenshots/）。 */
  workspace: string;
}

export type DesignSnapshotResult =
  | { ok: true; data: string; width: number; height: number; mimeType: "image/png"; savedPath: string }
  | { ok: false; error: string };

/** 浏览器自动化总开关；缺省视为启用（settings.browser?.enabled !== false）。 */
export interface BrowserSettings {
  enabled: boolean;
}

/** 设计模式总开关（全局总闸）；缺省视为启用（settings.design?.enabled !== false）。
 *  与 browser 的关键差别：browser_* 常驻激活、execute 实时判断；design_* 的工具
 *  定义较重（8 个≈1.5K tokens），仅在本会话开了设计模式时才注入活动工具集
 *  （session.designMode / 会话级状态文件），本总闸关闭时任何会话都不注入。 */
export interface DesignSettings {
  enabled: boolean;
}

/** 设计文档列表条目（designs/ 目录扫描结果，design.docs 推送）。 */
export interface DesignDocSummary {
  id: string;
  name: string;
  revision: number;
  width: number;
  height: number;
  nodeCount: number;
  /** Epoch ms。 */
  modifiedAt: number;
  /** 工作区相对路径。 */
  relativePath: string;
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
export type SessionRunStatus = "running" | "completed" | "failed" | "aborted";

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

/** 自定义斜杠命令摘要（命令目录下的 md 模板文件）。 */
export interface CommandSummary {
  /** 命令名 = md 文件名去扩展；斜杠菜单展示为 /<name>。 */
  name: string;
  description: string;
  scope: ResourceScope;
  /** 模板文件绝对路径。 */
  filePath?: string;
  /** 模板正文（剥掉 frontmatter），设置页编辑表单回填用。 */
  template?: string;
}

/** 设置页保存命令的载荷（写入哪个作用域目录）。 */
export interface CommandDraft {
  name: string;
  description?: string;
  template: string;
  scope: "project" | "global";
}

export type McpServerStatus = "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";

/**
 * OAuth 凭据生命周期状态（HTTP server）：idle = 无凭据/未开始，pending = 已打开
 * 授权页等回调，authorized = 已保存可用凭据，failed = 上一次授权失败。
 */
export type McpAuthState = "idle" | "pending" | "authorized" | "failed";

export interface McpServerSummary {
  name: string;
  /** 配置所在文件：项目 `.mcp.json` / 用户全局 `mcp.json`（编辑表单回填与删除定位）。 */
  scope: "project" | "global";
  /** 连接方式：有 command 即 stdio，否则 HTTP。 */
  transport: "stdio" | "http";
  /** 以下为配置投影，供设置页编辑表单明文回填（与配置文件内容一致）。 */
  command?: string;
  args?: string[];
  url?: string;
  auth?: "none" | "oauth" | "bearer-env";
  bearerTokenEnv?: string;
  env?: Record<string, string>;
  status: McpServerStatus;
  /** OAuth 凭据状态（仅 HTTP 且非 bearer-env 的 server 会出现）。 */
  authState?: McpAuthState;
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

/** cron 5 字段调度；timezone 缺省 = 跟随系统（留空）。"0 9 * * 1-5"=工作日每天 09:00。 */
export interface AutomationSchedule {
  cron: string;
  /** IANA 时区名；缺省跟随系统。 */
  timezone?: string;
}

/** 近一次运行摘要（列表/详情展示）。 */
export interface AutomationRunInfo {
  /** 运行所用会话 id（回看入口）。 */
  sessionId: string;
  startedAt: number;
  /**
   * ok=正常完成；error=真实失败；aborted=运行被中止（用户停止或连接中断）。
   * aborted 与 error 分开：中止不是失败，运行记录页不该给它红色失败态
   * （2026-09-10 会话复盘：ok/err 二态把一次「流被截断」的日报记成了成功）。
   */
  status: "ok" | "error" | "aborted";
  /** 结果摘要（最后一段助手文本）。 */
  preview?: string;
  error?: string;
}

/**
 * 一条持久化的运行历史记录（`pidesktop-automation/runs.jsonl` 事件流，全角色共用）。
 * taskName/agentName 是快照：任务/角色被删后记录仍可读。preview/error 二选一（成功/失败）。
 * 不快照 prompt——详情展开时按 taskId 从 store.automation 现查，任务已删则不显示该行。
 */
export interface AutomationRunRecord {
  /** 运行记录 id（randomUUID，与 automation.run.open 的寻址键）。 */
  id: string;
  taskId: string;
  /** 快照：任务被删后记录仍可读。 */
  taskName: string;
  agentId: string;
  /** 快照。 */
  agentName: string;
  /** 回看入口（AutomationRunInfo.sessionId 同源）。 */
  sessionId: string;
  startedAt: number;
  durationMs: number;
  /** 同 {@link AutomationRunInfo.status}：ok / error / aborted。 */
  status: "ok" | "error" | "aborted";
  trigger: "cron" | "manual";
  /** 实际使用的模型 id（回退链解析后的结果）。 */
  modelId?: string;
  /** 最后一段助手文本截断 200 字。 */
  preview?: string;
  error?: string;
}

/** 自动化任务（定时任务）。 */
export interface AutomationTask {
  id: string;
  name: string;
  schedule: AutomationSchedule;
  /** 触发后让 Agent 做什么。 */
  prompt: string;
  /** 归属 Agent（创建时取当前）。 */
  agentId: string;
  /** 参照「空间」；v1 供展示/DSL，执行用当前工作区。 */
  workspace?: string;
  /** 执行时所用模型；缺省 = 该 Agent 默认模型或全局默认。 */
  model?: { provider: string; id: string };
  /** 权限；无人值守下受限模式会触发权限确认而挂起。 */
  accessMode: AccessMode;
  /** 可选绑定技能（v1 仅存，供展示）。 */
  skillName?: string;
  /** 可选绑定子智能体（v1 仅存，供展示）。 */
  subagentName?: string;
  enabled: boolean;
  createdAt: number;
  lastRun?: AutomationRunInfo;
}

export interface ResourceCatalog {
  skills: SkillSummary[];
  commands: CommandSummary[];
  mcpServers: McpServerSummary[];
  todos: Todo[];
  /** 激活助手的全量记忆主题（面板治理视图，不经工作区过滤）。 */
  memory: MemoryTopic[];
  /** 双作用域合并后的自定义子智能体定义（项目覆盖全局）。 */
  subagents: SubagentDefinition[];
  /** 双作用域合并后的钩子规则（项目覆盖全局）。 */
  hooks: HookSummary[];
  /** 钩子总开关（settings.hooks 的实时投影），面板头部的治理开关。 */
  hooksEnabled: boolean;
  /** 全部角色的自动化定时任务（设置页「自动化任务」列表，按角色分组展示）。 */
  automation: AutomationTask[];
  /** 全角色自动化运行历史（新增/裁剪后全量推送；bootstrap 初始注入）。 */
  automationRuns: AutomationRunRecord[];
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
 * 消息带图片时主进程在队列镜像里保存完整图片数据，快照只投影数量——
 * 高频快照不携带大 base64，编辑/删除/立即发送仍按既有 kind+index+text 寻址。
 */
/** 一次斜杠调用：Skill（读 SKILL.md 后执行）或自定义命令（展开 md 模板）。 */
export interface SlashInvocation {
  kind: "skill" | "command";
  name: string;
}

export interface QueuedMessage {
  kind: "steering" | "followUp";
  /** 在同类队列中的下标；命令以 kind+index+text 寻址，列表变动后校验失败即拒绝。 */
  index: number;
  text: string;
  /** 该排队消息附带图片数（缺省/0 = 无图）；图片数据不进快照。 */
  imageCount?: number;
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
  /** 激活会话的 dsh 风格性能统计（输入框下方状态行）。 */
  speedStats?: SpeedStats;
  /** 激活会话是否处于计划模式（先产出计划、审查批准后才实施）。 */
  planMode?: boolean;
  /** 激活会话是否处于设计模式（design_* 工具已注入 + 画布工作台打开）。 */
  designMode?: boolean;
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
  speedStats?: SpeedStats;
  planMode?: boolean;
  /** 该会话是否处于设计模式；分屏格子据此跟随显隐（画布只展激活格）。 */
  designMode?: boolean;
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
  /**
   * 移交出口（计划审查专用）：值为 options 中某一选项的原文。渲染端点选该选项时
   * 不立即提交，而是先展开实施模型选择，确认后连同 question.resolve.model 一起提交。
   * ask_question 永不设置该字段。
   */
  handoffOption?: string;
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
  /**
   * 斜杠调用（Skill / 自定义命令，可多个混搭）：invocations 决定要展开什么，
   * text 是同时作为每个 Skill「用户要求」与每个命令 $ARGUMENTS 的共享文本
   * （单调用时沿用既有的 skill/command 展开语义与 marker，字节不变）。
   */
  | { type: "session.invoke"; invocations: SlashInvocation[]; text: string; attachments?: PromptAttachment[]; sessionId?: string }
  | { type: "session.regenerate"; text: string; timestamp?: number; invocations?: SlashInvocation[]; attachments?: PromptAttachment[]; sessionId?: string }
  | { type: "session.compact"; instructions?: string; sessionId?: string }
  | { type: "session.planMode"; enabled: boolean; sessionId?: string }
  /** 会话级设计模式开关：决定 design_* 工具是否进入本会话的活动工具集（前缀
   *  缓存纪律：会话内不再变动），并联动渲染端画布。全局总闸 settings.design.enabled
   *  关闭时工具一律不注入（本命令仍记录会话意愿，总闸恢复后即可生效）。 */
  | { type: "session.designMode"; enabled: boolean; sessionId?: string }
  | { type: "session.abort"; sessionId?: string }
  /** 任务面板按命令停止：只终止一条正在执行的 bash/powershell 调用（杀进程树），
   * 不中止整个会话——工具以错误结果收场供模型继续本轮。executionId 即
   * ToolExecution.id（Pi toolCallId）。 */
  | { type: "session.killExecution"; sessionId?: string; executionId: string }
  | { type: "session.queue.add"; text: string; invocations?: SlashInvocation[]; attachments?: PromptAttachment[]; sessionId?: string }
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
  | { type: "settings.save"; settings: Pick<DesktopSettings, "model" | "thinkingLevel" | "accessMode" | "appearance" | "browser" | "design" | "defaultWorkspace"> }
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
  | { type: "subagent.save"; subagent: SubagentDefinition }
  | { type: "subagent.delete"; id: string; scope: SubagentScope }
  /** 读取子代理完整记录（JSONL 转 ChatMessage[]，结果经 subagent.transcript-result 推送）。 */
  | { type: "subagent.transcript"; childSessionId: string; path: string }
  | { type: "appearance.save"; appearance: AppearanceSettings }
  /** 保存 MCP Server：original = 编辑前的位置（名称/作用域），用于作用域迁移与保留停用态。 */
  | { type: "mcp.server.save"; server: McpServerConfigDraft; original?: { name: string; scope: "project" | "global" } }
  /** 开始/重新打开 OAuth 授权（自动打开系统浏览器，回调落回应用后重连）。 */
  | { type: "mcp.server.auth"; name: string }
  /** 清除某个 server 已保存的 OAuth 凭据（client 注册信息 + token）。 */
  | { type: "mcp.server.auth.clear"; name: string }
  | { type: "mcp.server.toggle"; name: string; enabled: boolean }
  | { type: "mcp.server.delete"; name: string; scope: "project" | "global" }
  | { type: "hooks.save"; hook: HookRuleDraft }
  | { type: "hooks.toggle"; name: string; scope: "project" | "global"; enabled: boolean }
  | { type: "hooks.delete"; name: string; scope: "project" | "global" }
  | { type: "hooks.settings"; hooks: HooksSettings }
  /** 用样例上下文试跑一条钩子（面板“测试”按钮）；sample 是给 bash/拦截正则用的样例行。 */
  | { type: "hooks.run"; name: string; scope: "project" | "global"; sample?: string }
  /** 自定义斜杠命令管理：写/删命令目录下的 md 模板并刷新目录（不重建会话）。 */
  | { type: "command.save"; command: CommandDraft }
  | { type: "command.delete"; name: string; scope: "project" | "global" }
  | { type: "skill.toggle"; id: string; enabled: boolean }
  | { type: "background.kill"; id: string }
  | { type: "resources.reload" }
  /** 自动化定时任务：保存（创建/编辑整任务）、删除、开关、手动运行一次。 */
  | { type: "automation.save"; task: AutomationTask }
  | { type: "automation.delete"; id: string; agentId?: string }
  | { type: "automation.toggle"; id: string; enabled: boolean; agentId?: string }
  | { type: "automation.run"; id: string; agentId?: string }
  /** 运行记录「查看会话」：渲染端只发 runId；主进程负责查记录、跨角色切换、定位会话、激活/恢复。 */
  | { type: "automation.run.open"; runId: string }
  | { type: "permission.resolve"; id: string; decision: PermissionDecision }
  | { type: "question.resolve"; id: string; answers?: string[]; /** 移交出口选定的实施模型（handoffOption 流程携带；ask_question 忽略）。 */ model?: { provider: string; id: string } }
  /** 回滚单条回复内指定文件的改动：按（文件 + 调用 id）定位快照，每文件取最早快照恢复；targets 可含多个文件。 */
  | { type: "checkpoint.rollback"; sessionId?: string; targets: CheckpointRollbackTarget[] }
  /** 用量统计：跨助手扫描会话 JSONL 聚合 token 用量；agentId 缺省=全部助手。 */
  | { type: "usage.stats.request"; agentId?: string }
  /** main 进程回传的浏览器自动化结果（响应 utility 的 browser-automation.request）。 */
  | { type: "browser-automation.result"; requestId: string; result: BrowserAutomationResult }
  /** main 进程回传的设计导出缩略图（响应 utility 的 design-snapshot.request）。 */
  | { type: "design-snapshot.result"; requestId: string; result: DesignSnapshotResult }
  // —— 设计模式（Design Studio）：画布 ↔ utility 会话的文档命令。sessionId 走
  // resolveTargetRecord（缺省激活会话）；designDoc 绑定是会话级，画布跟随激活会话。 ——
  /** 列出工作区设计文档（结果经 design.docs 推送）。 */
  | { type: "design.list"; sessionId?: string }
  /** 新建并绑定文档（同名已存在则直接打开）；结果经 design.state 推送。 */
  | { type: "design.new"; name: string; width?: number; height?: number; sessionId?: string }
  /** 打开并绑定文档，结果经 design.state 推送。 */
  | { type: "design.open"; name: string; sessionId?: string }
  /** 批量应用 ops（原子）；成功后 revision+1 并推送 design.state，失败整批拒绝。 */
  | { type: "design.edit"; ops: DesignOp[]; sessionId?: string }
  /** 强制保存当前文档（每次 edit 已写盘，此处为显式落盘口）。 */
  | { type: "design.save"; sessionId?: string }
  /** 导出 HTML 单文件到工作区（缺省 designs/exports/<名称>.html）；结果经 design.exported 推送。 */
  | { type: "design.export"; path?: string; sessionId?: string }
  /** 解绑当前会话的设计文档（渲染端本地同步清空画布）。 */
  | { type: "design.close"; sessionId?: string }
  /** 拉取当前会话的设计状态：推送 design.state（若已绑定）+ design.docs（列表）。会话激活/创建后主动调一次。 */
  | { type: "design.query"; sessionId?: string };

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
  /** checkpoint 回滚完成：逐文件结果随推送展示；渲染端据此刷新工作区树。 */
  | { type: "checkpoint-result"; sessionId: string; results: CheckpointRollbackResult[]; message?: string }
  /** 用量统计结果（响应 usage.stats.request；按需拉取，不进快照）。 */
  | { type: "usage-stats-result"; stats: UsageStats }
  /** 自动化任务列表（store 变化时推送，当前 Agent）。 */
  | { type: "automation"; tasks: AutomationTask[] }
  /** 自动化任务运行状态（running=开始，ok/error/aborted=终态）；终态携带任务名（toast 文案）与运行记录 id（看结果直达）。 */
  | { type: "automation-run"; id: string; status: "ok" | "error" | "aborted" | "running"; taskName?: string; runId?: string; message?: string }
  /** 自动化运行历史全量推送（每次运行结束后随终态推送，渲染端全量替换）。 */
  | { type: "automation-runs"; runs: AutomationRunRecord[] }
  /** utility 进程请求用系统默认浏览器打开一个 URL（OAuth 授权页）；main 进程 shell.openExternal。 */
  | { type: "open-external"; url: string }
  /** utility 进程发起的浏览器自动化操作；main 完成后以 browser-automation.result 命令回传。 */
  | { type: "browser-automation.request"; requestId: string; sessionKey: string; request: BrowserAutomationRequest }
  /** utility 进程通知某 Pi 会话已销毁（LRU 驱逐/删除会话/移除工作区；同 id 重建不发）——main 侧释放并关闭其绑定的自动化标签页。 */
  | { type: "browser-automation.session-disposed"; sessionKey: string }
  /** utility 进程请求渲染设计导出缩略图；main 完成后以 design-snapshot.result 命令回传。 */
  | { type: "design-snapshot.request"; requestId: string; request: DesignSnapshotRequest }
  | { type: "error"; message: string }
  /** 子代理完整记录（响应 subagent.transcript）；childSessionId 用于对齐请求。 */
  | { type: "subagent.transcript-result"; childSessionId: string; messages: ChatMessage[] }
  /** 子代理完整记录读取失败（文件不存在等）；弹窗内展示，不走全局 toast。 */
  | { type: "subagent.transcript-error"; childSessionId: string; message: string }
  | { type: "log"; level: "info" | "warn"; message: string }
  // —— 设计模式推送 ——
  /** 当前会话绑定文档的全量状态（工具/命令变更后、会话激活、design.query 时推送）；
   *  revision 单调递增，渲染端丢弃 revision ≤ 已见的推送（防回环重渲），且只采纳
   *  激活会话的推送（sessionId 不匹配忽略）。docId 缺省（未绑定）时清空画布。 */
  | { type: "design.state"; sessionId: string; revision: number; docId?: string; name?: string; canvas?: DesignCanvasInfo; nodes?: DesignNode[]; dirty?: boolean }
  /** 工作区设计文档列表（design.list / 会话激活 / design.query 时推送，全量替换）。 */
  | { type: "design.docs"; docs: DesignDocSummary[] }
  /** 设计导出完成（design.export 命令的成功回执；失败走 error toast）。 */
  | { type: "design.exported"; relativePath: string };

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
  /** 在系统文件管理器中定位工作区条目：文件选中、文件夹进入；空路径打开工作区根目录。 */
  revealInExplorer(workspace: string, relativePath?: string): Promise<void>;
  /** 读取工作区文件的名称/相对路径/体积（文件树「添加到聊天」组装附件用）。 */
  statWorkspaceFile(workspace: string, relativePath: string): Promise<WorkspaceFileStat>;
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
