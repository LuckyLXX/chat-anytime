import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage, ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type InlineExtension
} from "@earendil-works/pi-coding-agent";
import type {
  AccessMode,
  ChatMessage,
  DesktopSettings, AgentProfile, ProviderSettings, ProviderModelSettings, PromptAttachment,
  MessageBlock,
  ModelOption,
  PermissionDecision,
  PermissionRequest,
  ProviderOption,
  RuntimeCommand,
  RuntimeMessage,
  RuntimeSnapshot,
  ResourceCatalog,
  ResourceScope,
  SkillSummary,
  ExtensionSummary,
  PackageSummary,
  McpServerSummary,
  McpServerConfigDraft,
  SessionSummary,
  ThinkingLevel,
  ToolExecution,
  TurnTiming
} from "../shared/protocol.js";
import { toolLabel } from "../shared/locale.js";
import { customProviderModelDefinition, inferCustomModelImageInput } from "./custom-provider.js";
import { permissionAction, permissionScope, toolRisk } from "./permissions.js";
import { agentWorkspaceSessionDir } from "./session-scope.js";
import { workspaceRelativeAttachment } from "./attachments.js";
import { mergeProviderModels } from "./settings.js";
import { upsertMcpServerConfig, type McpServerConfigEntry } from "./mcp-config.js";
import { buildSkillPrompt, parseSkillPrompt, type SkillPromptDisplay } from "./skill-prompt.js";
import { buildDivModePrompt } from "./div-prompt.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Pi 运行时必须作为 Electron 工具进程启动");

let modelRuntime: ModelRuntime | undefined;
let session: AgentSession | undefined;
let unsubscribeSession: (() => void) | undefined;
let workspace: string | undefined;
let thinkingLevel: ThinkingLevel = "medium";
let accessMode: AccessMode = "ask";
let status = "请选择一个项目开始使用";
let busy = false;
let turnTiming: TurnTiming | undefined;
let executions = new Map<string, ToolExecution>();
let currentSessions: SessionSummary[] = [];
let selectedModel: { provider: string; id: string } | undefined;
let settings: DesktopSettings | undefined;
let apiKeys: Record<string, string> = {};
let currentAgent: AgentProfile | undefined;
const customProviderId = "chatanytime-openai-compatible";
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
let permissionSequence = 0;
const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
const allowedForSession = new Set<string>();
const builtinToolNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const mcpStatusEvent = "pi-mcp-adapter/status/v1";
let resourceLoader: DefaultResourceLoader | undefined;
let packageManager: DefaultPackageManager | undefined;
let mcpStatusUnsubscribe: (() => void) | undefined;
let mcpServers: McpServerSummary[] = [];
let mcpAdapterLoaded = false;
let resourceOperationBusy = false;

// Streaming coalescer: high-frequency partial frames (message_update token
// batches, tool partial output) are throttled to 50ms (20fps) to avoid IPC
// storms. State transitions that change busy/status/executions flush
// immediately so the UI never lags on real lifecycle changes.
const STREAM_FLUSH_INTERVAL_MS = 50;
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

const emptyResourceCatalog: ResourceCatalog = {
  skills: [],
  extensions: [],
  packages: [],
  mcpServers: [],
  mcpAdapterLoaded: false,
  diagnostics: []
};

function post(message: RuntimeMessage): void {
  parentPort.postMessage(message);
}

function resourceScope(scope: string | undefined, origin: string | undefined): ResourceScope {
  if (origin === "package") return "package";
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  if (scope === "temporary") return "temporary";
  return "unknown";
}

function resourceSource(source: string | undefined, scope: ResourceScope, origin?: string): string {
  if (origin === "package" && source && /^(?:npm:|git:|https?:|ssh:)/u.test(source)) return source;
  if (source === "cli") return "临时资源";
  if (source?.startsWith("<inline:")) return "PiDesktop 内置";
  if (scope === "project") return "当前项目";
  if (scope === "global") return "用户资源";
  if (scope === "package") return "Pi Package";
  return "PiDesktop";
}

function isSafePackageSource(source: string): boolean {
  return /^(?:npm:|git:|https?:|ssh:)[^\r\n]+$/u.test(source);
}

function mcpConfigPath(scope: McpServerConfigDraft["scope"]): string {
  if (!workspace) throw new Error("请先打开工作区，再添加 MCP Server");
  return scope === "project" ? resolve(workspace, ".mcp.json") : join(getAgentDir(), "mcp.json");
}

function mcpConfigEntry(server: McpServerConfigDraft): McpServerConfigEntry {
  if (server.transport === "stdio") {
    const command = server.command?.trim();
    if (!command) throw new Error("stdio MCP Server 需要填写启动命令");
    return {
      command,
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {})
    };
  }
  const url = server.url?.trim();
  if (!url || !/^https?:\/\//iu.test(url)) throw new Error("HTTP MCP Server 需要填写 http:// 或 https:// 地址");
  if (server.auth === "bearer-env" && !server.bearerTokenEnv?.trim()) throw new Error("Bearer 认证需要填写环境变量名");
  return {
    url,
    ...(server.auth === "oauth" ? { auth: "oauth" as const } : {}),
    ...(server.auth === "bearer-env" ? { bearerTokenEnv: server.bearerTokenEnv!.trim() } : {})
  };
}

function sanitizeResourceError(message: string): string {
  return message.replace(/[A-Za-z]:[\\/][^\r\n\s]*/gu, "[本地路径]").replace(/\\\\[^\r\n\s]+/gu, "[本地路径]");
}

function bundledMcpAdapterPath(): string {
  return fileURLToPath(import.meta.resolve("pi-mcp-adapter"));
}

function isMcpStatusSnapshot(value: unknown): value is {
  servers: Array<{ name: string; status: McpServerSummary["status"]; toolCount: number; resourceCount?: number; failedAgoSeconds?: number; disabled: boolean }>;
} {
  if (!value || typeof value !== "object") return false;
  const servers = (value as { servers?: unknown }).servers;
  return Array.isArray(servers) && servers.every((server) => {
    if (!server || typeof server !== "object") return false;
    const item = server as Record<string, unknown>;
    return typeof item.name === "string" && typeof item.status === "string" && typeof item.toolCount === "number" && typeof item.disabled === "boolean";
  });
}

function createMcpStatusExtension(): InlineExtension {
  return {
    name: "chat-anytime-mcp-status",
    hidden: true,
    factory(pi) {
      mcpStatusUnsubscribe?.();
      mcpStatusUnsubscribe = pi.events.on(mcpStatusEvent, (value) => {
        if (!isMcpStatusSnapshot(value)) return;
        mcpAdapterLoaded = true;
        mcpServers = value.servers.map((server) => ({
          name: server.name,
          status: server.status,
          toolCount: server.toolCount,
          ...(server.resourceCount === undefined ? {} : { resourceCount: server.resourceCount }),
          ...(server.failedAgoSeconds === undefined ? {} : { failedAgoSeconds: server.failedAgoSeconds }),
          disabled: server.disabled
        }));
        emitResourceCatalog();
      });
    }
  };
}

function emitResourceCatalog(): void {
  if (!resourceLoader) {
    post({ type: "resources", resources: structuredClone(emptyResourceCatalog) });
    return;
  }
  const skillResult = resourceLoader.getSkills();
  const extensionResult = resourceLoader.getExtensions();
  const skills: SkillSummary[] = skillResult.skills.map((skill) => {
    const scope = resourceScope(skill.sourceInfo.scope, skill.sourceInfo.origin);
    return {
      name: skill.name,
      description: skill.description,
      source: resourceSource(skill.sourceInfo.source, scope, skill.sourceInfo.origin),
      scope,
      disableModelInvocation: skill.disableModelInvocation
    };
  });
  const extensions: ExtensionSummary[] = extensionResult.extensions.map((extension) => {
    const scope = resourceScope(extension.sourceInfo.scope, extension.sourceInfo.origin);
    const name = extension.path.startsWith("<inline:") ? extension.path.slice(8, -1) : basename(extension.path);
    if (extension.resolvedPath.toLowerCase().includes("pi-mcp-adapter")) mcpAdapterLoaded = true;
    return {
      name,
      source: resourceSource(extension.sourceInfo.source, scope, extension.sourceInfo.origin),
      scope,
      loaded: true
    };
  });
  for (const error of extensionResult.errors) {
    const name = error.path.startsWith("<inline:") ? error.path.slice(8, -1) : basename(error.path);
    extensions.push({ name, source: "加载失败", scope: "unknown", loaded: false, error: sanitizeResourceError(error.error) });
  }
  const packages: PackageSummary[] = packageManager?.listConfiguredPackages().map((item) => ({
    source: isSafePackageSource(item.source) ? item.source : `本地 Pi Package（${basename(item.source)}）`,
    scope: item.scope === "project" ? "project" : "global",
    installed: Boolean(item.installedPath),
    removable: isSafePackageSource(item.source)
  })) ?? [];
  if (mcpAdapterLoaded && !packages.some((item) => item.source === "pi-mcp-adapter")) {
    packages.unshift({ source: "pi-mcp-adapter", scope: "bundled", installed: true, removable: false });
  }
  const diagnostics = [
    ...skillResult.diagnostics.map((item) => sanitizeResourceError(item.message)),
    ...extensionResult.errors.map((item) => sanitizeResourceError(item.error))
  ].filter((message, index, list) => Boolean(message) && list.indexOf(message) === index);
  post({
    type: "resources",
    resources: { skills, extensions, packages, mcpServers: structuredClone(mcpServers), mcpAdapterLoaded, diagnostics }
  });
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
  const visible = messages.filter((message) => message.role === "user" || message.role === "assistant");
  if (streamingMessage && streamingMessage.role === "assistant") {
    const last = visible.at(-1);
    if (last !== streamingMessage) visible.push(streamingMessage);
  }
  return visible.map((message, index) => {
    const skillPrompt = message.role === "user" ? parseSkillPrompt(userMessageText(message)) : undefined;
    return {
      id: `${message.timestamp ?? 0}-${index}-${message.role}`,
      uuid: messageUuid(message, index),
      role: message.role as "user" | "assistant",
      timestamp: message.timestamp ?? Date.now(),
      blocks: blocksFromMessage(message, skillPrompt),
      skill: skillPrompt ? { name: skillPrompt.name } : undefined,
      streaming: message === streamingMessage,
      error: message.role === "assistant" ? (message as AssistantMessage).errorMessage : undefined
    };
  });
}

function runtimeSkillPrompt(name: string, instructions?: string): string {
  if (!resourceLoader) throw new Error("Skill 资源尚未加载");
  const skill = resourceLoader.getSkills().skills.find((item) => item.name === name);
  if (!skill) throw new Error(`未找到 Skill：${name}`);
  if (!session?.getActiveToolNames().includes("read")) throw new Error("当前 Agent 未启用 read 工具，无法读取 Skill");
  const userInstructions = instructions?.trim() ?? "";
  const executionPrompt = [
    `使用 Skill「${skill.name}」完成任务。`,
    `首先调用 read 工具读取 Skill 文件：${skill.filePath}`,
    "完整阅读后遵循其中的说明；其中的相对路径均以该 Skill 文件所在目录为基准。",
    userInstructions ? `用户要求：\n${userInstructions}` : undefined
  ].filter(Boolean).join("\n\n");
  return buildSkillPrompt(skill.name, userInstructions, executionPrompt);
}

function snapshot(): RuntimeSnapshot {
  const messages = session
    ? normalizeMessages(session.state.messages, session.state.streamingMessage)
    : [];
  return {
    workspace,
    agentId: currentAgent?.id ?? "default",
    agentName: currentAgent?.name ?? "默认助手",
    sessionId: session?.sessionId,
    sessionFile: session?.sessionManager.getSessionFile(),
    model: session?.model ? { provider: session.model.provider, id: session.model.id } : selectedModel,
    thinkingLevel: session?.thinkingLevel ?? thinkingLevel,
    busy,
    status,
    turnTiming,
    messages,
    executions: [...executions.values()],
    sessions: currentSessions
  };
}

function workspaceSessionDir(): string | undefined {
  if (!workspace || !currentAgent) return undefined;
  return agentWorkspaceSessionDir(getAgentDir(), currentAgent.id, workspace);
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

function beginTurn(): void {
  turnTiming = { startedAt: Date.now() };
}

function markAnswerStarted(): void {
  if (!turnTiming || turnTiming.answerStartedAt !== undefined) return;
  turnTiming = { ...turnTiming, answerStartedAt: Date.now() };
}

function completeTurn(): void {
  if (!turnTiming || turnTiming.completedAt !== undefined) return;
  turnTiming = { ...turnTiming, completedAt: Date.now() };
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return String(args.command ?? "执行命令");
  const path = args.path ?? args.file_path ?? args.filePath;
  if (path) return `${toolLabel(toolName)}：${String(path)}`;
  return toolLabel(toolName);
}

function requestPermission(toolName: string, args: Record<string, unknown>): Promise<PermissionDecision> {
  const id = `permission-${++permissionSequence}`;
  const risk = toolRisk(workspace, toolName, args);
  if (!risk) return Promise.resolve("allow-once");
  const action = permissionAction(accessMode, toolName, risk);
  if (action === "allow") return Promise.resolve("allow-once");
  if (action === "deny") return Promise.resolve("deny");
  if (allowedForSession.has(permissionScope(toolName, risk))) return Promise.resolve("allow-session");
  const request: PermissionRequest = {
    id,
    toolName,
    summary: summarizeArgs(toolName, args),
    args,
    risk
  };
  post({ type: "permission", request });
  return new Promise((resolveDecision) => pendingPermissions.set(id, resolveDecision));
}

function createPermissionExtension(): InlineExtension {
  return {
    name: "chat-anytime-permissions",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event) => {
        const args = event.input as Record<string, unknown>;
        const risk = toolRisk(workspace, event.toolName, args);
        if (!risk) return undefined;
        const decision = await requestPermission(event.toolName, args);
        if (decision === "allow-session") allowedForSession.add(permissionScope(event.toolName, risk));
        if (decision === "deny") return { block: true, reason: "用户已在 ChatAnyTime 中拒绝此操作" };
        return undefined;
      });
    }
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

function handleSessionEvent(event: AgentSessionEvent): void {
  // Pure streaming accumulation can safely batch at 20fps; everything that
  // changes busy/status/executions must flush immediately so the UI never
  // lags on lifecycle transitions.
  let immediate = true;
  switch (event.type) {
    case "agent_start":
      busy = true;
      status = "Pi 正在工作";
      break;
    case "agent_end":
      if (event.willRetry) {
        busy = true;
        status = "正在重试";
      } else {
        completeTurn();
        busy = false;
        status = "就绪";
      }
      break;
    case "agent_settled":
      busy = false;
      status = "就绪";
      break;
    case "message_start":
      if (event.message.role === "assistant") markAnswerStarted();
      break;
    case "message_update":
      // Token-batch partial; high frequency — throttle.
      immediate = false;
      break;
    case "message_end":
      // Final frame carries the completed message; flush immediately so the
      // streaming flag clears without a 50ms gap.
      break;
    case "tool_execution_start":
      executions.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: "running",
        startedAt: Date.now()
      });
      status = `正在${toolLabel(event.toolName)}`;
      break;
    case "tool_execution_update": {
      // Partial tool output; high frequency — throttle.
      const current = executions.get(event.toolCallId);
      if (current) current.output = textFromToolResult(event.partialResult);
      immediate = false;
      break;
    }
    case "tool_execution_end": {
      const current = executions.get(event.toolCallId);
      executions.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: current?.args ?? {},
        startedAt: current?.startedAt ?? Date.now(),
        completedAt: Date.now(),
        status: event.isError ? "error" : "completed",
        output: textFromToolResult(event.result),
        patch: patchFromToolResult(event.result)
      });
      break;
    }
    case "compaction_start":
      status = "正在压缩上下文";
      break;
    case "auto_retry_start":
      status = `正在重试（${event.attempt}/${event.maxAttempts}）`;
      break;
    default:
      // Unknown event types also flush immediately to be safe.
      break;
  }
  scheduleEmit(immediate);
}

async function refreshCatalog(): Promise<void> {
  if (!modelRuntime) return;
  let available = modelRuntime.getAvailableSnapshot();
  try {
    available = await modelRuntime.getAvailable();
  } catch (error) {
    post({ type: "log", level: "warn", message: `检查模型可用性失败：${errorText(error)}` });
  }
  const configured = new Set(available.map((model) => model.provider));
  const providers: ProviderOption[] = modelRuntime.getProviders().map((provider) => {
    const auth = modelRuntime?.getProviderAuthStatus(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      configured: auth?.configured ?? false,
      authSource: auth?.source
    };
  });
  if (!providers.some((provider) => provider.id === customProviderId)) {
    providers.push({ id: customProviderId, name: settings?.providers.find((item) => item.id === customProviderId)?.name ?? "自定义 OpenAI 兼容服务", configured: false });
  }
  const enabledModels = new Set(settings?.providers.flatMap((provider) => provider.models.filter((item) => item.enabled !== false).map((item) => `${provider.id}/${item.id}`)) ?? []);
  const models: ModelOption[] = modelRuntime.getModels().filter((model) => !settings?.providers.some((provider) => provider.id === model.provider) || enabledModels.has(`${model.provider}/${model.id}`)).map((model) => ({
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

async function refreshSessions(): Promise<void> {
  if (!workspace) {
    currentSessions = [];
    return;
  }
  const items = await SessionManager.list(workspace, workspaceSessionDir());
  currentSessions = items.map((item) => ({
    id: item.id,
    path: item.path,
    title: item.name || item.firstMessage || "新会话",
    modifiedAt: item.modified.getTime(),
    messageCount: item.messageCount
  }));
}

function sessionReadyStatus(hasModel: boolean, usedFallback: boolean): string {
  if (usedFallback) return "已自动切换到可用模型";
  if (hasModel) return "就绪";
  return "请先配置模型";
}

async function createSession(sessionManager?: SessionManager): Promise<void> {
  if (!workspace || !modelRuntime) return;
  // Drop any pending throttled emit so a stale streaming flush from the
  // previous session cannot fire against the freshly reset state below.
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer);
    pendingFlushTimer = undefined;
    hasPendingFlush = false;
  }
  unsubscribeSession?.();
  mcpStatusUnsubscribe?.();
  mcpStatusUnsubscribe = undefined;
  session?.dispose();
  mcpServers = [];
  mcpAdapterLoaded = false;
  executions = new Map();
  turnTiming = undefined;
  allowedForSession.clear();

  const settingsManager = SettingsManager.create(workspace, getAgentDir());
  packageManager = new DefaultPackageManager({ cwd: workspace, agentDir: getAgentDir(), settingsManager });
  resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noThemes: true,
    additionalExtensionPaths: [bundledMcpAdapterPath()],
    extensionFactories: [createPermissionExtension(), createMcpStatusExtension()],
    systemPromptOverride: (base) => [base, currentAgent?.systemPrompt, currentAgent?.divMode ? buildDivModePrompt() : undefined].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();
  emitResourceCatalog();

  const activeSessionManager = sessionManager ?? SessionManager.continueRecent(workspace, workspaceSessionDir());
  const hasExistingMessages = activeSessionManager.buildSessionContext().messages.length > 0;
  const requested = hasExistingMessages ? undefined : defaultModel();
  const requestedModel = requested
    ? modelRuntime.getModel(requested.provider, requested.id)
    : undefined;
  const enabledBuiltinTools = Object.entries(currentAgent?.tools ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
  const result = await createAgentSession({
    cwd: workspace,
    modelRuntime,
    model: requestedModel,
    thinkingLevel: hasExistingMessages ? undefined : (currentAgent?.defaultThinkingLevel ?? settings?.thinkingLevel ?? "medium"),
    sessionManager: activeSessionManager,
    settingsManager,
    resourceLoader
  });
  session = result.session;
  await session.bindExtensions({
    mode: "rpc",
    onError: (error) => post({ type: "log", level: "warn", message: `Pi 扩展错误：${error.error}` })
  });
  const extensionTools = session.getAllTools().map((tool) => tool.name).filter((name) => !builtinToolNames.has(name));
  session.setActiveToolsByName([...enabledBuiltinTools, ...extensionTools]);
  selectedModel = session.model ? { provider: session.model.provider, id: session.model.id } : requested;
  thinkingLevel = session.thinkingLevel;
  unsubscribeSession = session.subscribe(handleSessionEvent);
  status = sessionReadyStatus(Boolean(session.model), Boolean(result.modelFallbackMessage));
  busy = false;
  await refreshSessions();
  emitResourceCatalog();
  emitState();
}

async function initialize(command: Extract<RuntimeCommand, { type: "initialize" }>): Promise<void> {
  settings = command.settings;
  apiKeys = command.apiKeys;
  workspace = settings.workspace;
  currentAgent = activeAgent();
  thinkingLevel = settings.thinkingLevel ?? "medium";
  accessMode = settings.accessMode ?? "ask";
  selectedModel = settings.model;
  modelRuntime = await ModelRuntime.create();
  for (const provider of settings.providers) {
    registerCustomProvider(provider);
    const key = apiKeys[provider.id];
    if (key) await modelRuntime.setRuntimeApiKey(provider.id, key, { allowNetwork: false });
  }
  await refreshCatalog();
  if (workspace) await createSession();
  else {
    emitResourceCatalog();
    emitState();
  }
}

async function runResourceOperation(label: string, operation: () => Promise<void>): Promise<void> {
  if (!session || !packageManager) throw new Error("请先打开工作区，再管理 Skill 或 MCP");
  if (busy || resourceOperationBusy) throw new Error("当前会话正在运行，请等待完成后再管理 Skill 或 MCP");
  resourceOperationBusy = true;
  busy = true;
  status = label;
  emitState();
  try {
    await operation();
    emitResourceCatalog();
  } finally {
    resourceOperationBusy = false;
    busy = false;
    status = "就绪";
    emitResourceCatalog();
    emitState();
  }
}

async function reloadRuntimeResources(): Promise<void> {
  if (!session) throw new Error("请先打开工作区，再重载资源");
  // Pi's in-place reload publishes the MCP adapter shutdown snapshot but does
  // not reliably rebuild the adapter state. Recreate the runtime while keeping
  // the current session manager so the updated global/project config is read.
  await createSession(session.sessionManager);
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
  return {
    text: fileRefs.length ? `${text}\n\n项目文件附件（请使用 read 工具按需读取）：\n${fileRefs.map((path) => `- ${path}`).join("\n")}` : text,
    images
  };
}

async function handleCommand(command: RuntimeCommand): Promise<void> {
  switch (command.type) {
    case "initialize":
      await initialize(command);
      break;
    case "workspace.open":
      workspace = resolve(command.path);
      await createSession();
      break;
    case "session.new":
      if (workspace) await createSession(SessionManager.create(workspace, workspaceSessionDir()));
      break;
    case "session.open":
      if (workspace) {
        const sessionRoot = workspaceSessionDir();
        if (!sessionRoot || !resolve(command.path).toLowerCase().startsWith(`${resolve(sessionRoot).toLowerCase()}${sep}`)) throw new Error("只能打开当前 Agent 和工作区下的会话");
        await createSession(SessionManager.open(command.path, sessionRoot, workspace));
      }
      break;
    case "session.skill": {
      const prompt = runtimeSkillPrompt(command.name, command.instructions);
      await handleCommand({ type: "session.prompt", text: prompt, attachments: command.attachments });
      break;
    }
    case "session.prompt":
      if (!session) throw new Error("请先打开工作区，再发送消息");
      if (!session.model) throw new Error("请先配置并选择模型，再发送消息");
      const prompt = await preparePromptPayload(command.text, command.attachments);
      if (prompt.images.length && !hasImageInput(session.model)) throw new Error("当前模型不支持图片输入，请先切换多模态模型");
      busy = true;
      status = "Pi 正在工作";
      beginTurn();
      emitState();
      void session.prompt(prompt.text, prompt.images.length ? { images: prompt.images } : undefined).catch((error) => {
        completeTurn();
        busy = false;
        status = "请求失败";
        post({ type: "error", message: errorText(error) });
        emitState();
      });
      break;
    case "session.regenerate":
      if (!session) throw new Error("请先打开工作区，再重新生成");
      if (!session.model) throw new Error("请先配置并选择模型，再重新生成");
      if (!command.text.trim() && !command.skillName) throw new Error("没有可重新生成的用户消息");
      const regeneratedText = command.skillName ? runtimeSkillPrompt(command.skillName, command.text) : command.text.trim();
      const regeneratedPrompt = await preparePromptPayload(regeneratedText, command.attachments);
      if (regeneratedPrompt.images.length && !hasImageInput(session.model)) throw new Error("当前模型不支持图片输入，请先切换多模态模型");
      busy = true;
      status = "Pi 正在重新生成";
      beginTurn();
      emitState();
      void (async () => {
        const branch = session!.sessionManager.getBranch();
        const target = branch.filter((entry) => {
          if (entry.type !== "message" || entry.message.role !== "user") return false;
          if (command.timestamp !== undefined) return entry.message.timestamp === command.timestamp;
          const text = userMessageText(entry.message);
          if (!command.skillName) return text === command.text.trim();
          const skillPrompt = parseSkillPrompt(text);
          return skillPrompt?.name === command.skillName && skillPrompt.instructions === command.text.trim();
        }).at(-1);
        if (!target || target.type !== "message") throw new Error("找不到要重新生成的用户消息");
        await session!.navigateTree(target.id);
        await session!.prompt(regeneratedPrompt.text, regeneratedPrompt.images.length ? { images: regeneratedPrompt.images } : undefined);
      })().catch((error) => {
        completeTurn();
        busy = false;
        status = "请求失败";
        post({ type: "error", message: errorText(error) });
        emitState();
      });
      break;
    case "session.abort":
      session?.abort();
      break;
    case "session.compact":
      if (!session) throw new Error("请先打开工作区，再压缩上下文");
      if (!session.model) throw new Error("请先配置并选择模型，再压缩上下文");
      busy = true;
      status = "Pi 正在压缩上下文";
      beginTurn();
      emitState();
      void session.compact(command.instructions).catch((error) => {
        completeTurn();
        busy = false;
        status = "压缩失败";
        post({ type: "error", message: errorText(error) });
        emitState();
      });
      break;
    case "model.select": {
      if (!modelRuntime) break;
      const model = modelRuntime.getModel(command.provider, command.id);
      if (!model) throw new Error(`无法识别模型 ${command.provider}/${command.id}`);
      selectedModel = { provider: command.provider, id: command.id };
      if (session) await session.setModel(model);
      emitState();
      break;
    }
    case "thinking.select":
      thinkingLevel = command.level;
      session?.setThinkingLevel(command.level);
      emitState();
      break;
    case "auth.set":
      if (!modelRuntime) break;
      await modelRuntime.setRuntimeApiKey(command.provider, command.apiKey, { allowNetwork: false });
      await refreshCatalog();
      if (!session?.model || session.model.provider === command.provider) {
        const first = modelRuntime.getModels(command.provider)[0];
        if (first) {
          selectedModel = { provider: first.provider, id: first.id };
          if (session) await session.setModel(first);
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
        await modelRuntime.setRuntimeApiKey(command.provider.id, command.apiKey.trim(), { allowNetwork: false });
      }
      await refreshCatalog();
      {
        const first = modelRuntime.getModels(command.provider.id)[0];
        if (first) {
          selectedModel = { provider: first.provider, id: first.id };
          if (session) await session.setModel(first);
        } else if (selectedModel?.provider === command.provider.id) {
          const fallback = modelRuntime.getModels().find((model) => modelRuntime?.getProviderAuthStatus(model.provider)?.configured);
          selectedModel = fallback ? { provider: fallback.provider, id: fallback.id } : undefined;
          if (session && fallback) await session.setModel(fallback);
          status = fallback ? `当前服务没有启用模型，已切换到 ${fallback.name}` : "当前服务没有启用模型，请在设置中勾选模型";
        }
      }
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
          if (session && fallbackModel) await session.setModel(fallbackModel);
          status = fallbackModel ? `原模型已删除，已切换到 ${fallbackModel.name}` : "原模型已删除，请先配置模型";
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
    case "agent.select":
      if (busy) throw new Error("当前会话正在运行，暂时不能切换 Agent");
      if (!settings?.agents.some((agent) => agent.id === command.agentId && !agent.archived)) throw new Error("Agent 不存在或已归档");
      settings.currentAgentId = command.agentId;
      currentAgent = activeAgent();
      selectedModel = currentAgent.defaultModel ?? settings.model;
      busy = true;
      status = `正在切换到 ${currentAgent.name}`;
      emitState();
      try {
        if (workspace) await createSession();
        else {
          busy = false;
          status = "就绪";
          emitState();
        }
      } catch (error) {
        busy = false;
        status = "Agent 切换失败";
        emitState();
        throw error;
      }
      break;
    case "agent.save":
      if (settings) {
        if (busy && settings.currentAgentId === command.agent.id) throw new Error("当前会话正在运行，请等待完成后再保存当前 Agent");
        const isCurrent = settings.currentAgentId === command.agent.id;
        settings.agents = settings.agents.some((item) => item.id === command.agent.id) ? settings.agents.map((item) => item.id === command.agent.id ? command.agent : item) : [...settings.agents, command.agent];
        currentAgent = activeAgent();
        if (isCurrent && workspace) {
          busy = true;
          status = `正在应用 ${currentAgent.name} 配置`;
          emitState();
          try {
            await createSession();
          } catch (error) {
            busy = false;
            status = "Agent 配置应用失败";
            emitState();
            throw error;
          }
        } else emitState();
      }
      break;
    case "settings.save":
      if (settings) { settings.model = command.settings.model; settings.thinkingLevel = command.settings.thinkingLevel; settings.accessMode = command.settings.accessMode; settings.appearance = command.settings.appearance; thinkingLevel = command.settings.thinkingLevel; accessMode = command.settings.accessMode; selectedModel = command.settings.model; if (session) { session.setThinkingLevel(thinkingLevel); if (selectedModel) { const model = modelRuntime?.getModel(selectedModel.provider, selectedModel.id); if (model) await session.setModel(model); } } emitState(); }
      break;
    case "agent.archive":
      if (settings && command.agentId !== "default") { settings.agents = settings.agents.map((item) => item.id === command.agentId ? { ...item, archived: command.archived } : item); if (settings.currentAgentId === command.agentId) { settings.currentAgentId = "default"; currentAgent = activeAgent(); } if (workspace) await createSession(); }
      break;
    case "appearance.save":
      break;
    case "resources.package.install": {
      const source = command.source.trim();
      if (!source) throw new Error("请输入 Pi Package 来源");
      await runResourceOperation("正在安装 Pi Package", async () => {
        await packageManager!.installAndPersist(source);
        await reloadRuntimeResources();
      });
      break;
    }
    case "resources.package.remove": {
      const source = command.source.trim();
      if (!source) throw new Error("缺少要删除的 Pi Package");
      await runResourceOperation("正在删除 Pi Package", async () => {
        await packageManager!.removeAndPersist(source, { local: command.scope === "project" });
        await reloadRuntimeResources();
      });
      break;
    }
    case "resources.reload":
      await runResourceOperation("正在重载 Skill 和 MCP", reloadRuntimeResources);
      break;
    case "mcp.server.save": {
      const server = command.server;
      const name = server.name.trim();
      if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new Error("MCP Server 名称只能包含字母、数字、点、下划线和短横线");
      await runResourceOperation("正在添加 MCP Server", async () => {
        upsertMcpServerConfig(mcpConfigPath(server.scope), name, mcpConfigEntry({ ...server, name }));
        await reloadRuntimeResources();
      });
      break;
    }
    case "mcp.server.toggle": {
      if (!/^[A-Za-z0-9._-]+$/u.test(command.name)) throw new Error("MCP Server 名称无效");
      await runResourceOperation(command.enabled ? "正在启用 MCP Server" : "正在停用 MCP Server", async () => {
        await session!.prompt(`/mcp ${command.enabled ? "enable" : "disable"} ${command.name}`);
        await reloadRuntimeResources();
      });
      break;
    }
    case "permission.resolve": {
      const resolveDecision = pendingPermissions.get(command.id);
      if (resolveDecision) {
        pendingPermissions.delete(command.id);
        resolveDecision(command.decision);
      }
      break;
    }
  }
}

parentPort.on("message", (event: { data: RuntimeCommand }) => {
  void handleCommand(event.data).catch((error) => {
    post({ type: "error", message: errorText(error) });
  });
});
