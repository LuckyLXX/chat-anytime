import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage, ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
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
  SessionSummary,
  ThinkingLevel,
  ToolExecution
} from "../shared/protocol.js";
import { toolLabel } from "../shared/locale.js";
import { customProviderModelDefinition, inferCustomModelImageInput } from "./custom-provider.js";
import { permissionScope, toolRisk } from "./permissions.js";
import { agentWorkspaceSessionDir } from "./session-scope.js";
import { workspaceRelativeAttachment } from "./attachments.js";
import { mergeProviderModels } from "./settings.js";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Pi 运行时必须作为 Electron 工具进程启动");

let modelRuntime: ModelRuntime | undefined;
let session: AgentSession | undefined;
let unsubscribeSession: (() => void) | undefined;
let workspace: string | undefined;
let thinkingLevel: ThinkingLevel = "medium";
let status = "请选择一个项目开始使用";
let busy = false;
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

function post(message: RuntimeMessage): void {
  parentPort.postMessage(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function blocksFromMessage(message: AgentMessage): MessageBlock[] {
  if (message.role === "user") {
    const user = message as UserMessage;
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

function normalizeMessages(messages: AgentMessage[], streamingMessage?: AgentMessage): ChatMessage[] {
  const visible = messages.filter((message) => message.role === "user" || message.role === "assistant");
  if (streamingMessage && streamingMessage.role === "assistant") {
    const last = visible.at(-1);
    if (last !== streamingMessage) visible.push(streamingMessage);
  }
  return visible.map((message, index) => ({
    id: `${message.timestamp ?? 0}-${index}-${message.role}`,
    role: message.role as "user" | "assistant",
    timestamp: message.timestamp ?? Date.now(),
    blocks: blocksFromMessage(message),
    streaming: message === streamingMessage,
    error: message.role === "assistant" ? (message as AssistantMessage).errorMessage : undefined
  }));
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
  return list.find((agent) => agent.id === settings?.currentAgentId && !agent.archived) ?? list.find((agent) => agent.id === "default") ?? list[0] ?? { id: "default", name: "默认助手", description: "", systemPrompt: "", defaultThinkingLevel: "medium", tools: { read: true, bash: true, edit: true, write: true, grep: true, find: true, ls: true } };
}

function defaultModel(): { provider: string; id: string } | undefined {
  return currentAgent?.defaultModel ?? settings?.model;
}

function hasImageInput(model: { input?: readonly string[] } | undefined): boolean { return Boolean(model?.input?.includes("image")); }

function emitState(): void {
  post({ type: "state", snapshot: snapshot() });
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
  switch (event.type) {
    case "agent_start":
      busy = true;
      status = "Pi 正在工作";
      break;
    case "agent_end":
    case "agent_settled":
      busy = false;
      status = event.type === "agent_end" && event.willRetry ? "正在重试" : "就绪";
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
      const current = executions.get(event.toolCallId);
      if (current) current.output = textFromToolResult(event.partialResult);
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
  }
  emitState();
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
  unsubscribeSession?.();
  session?.dispose();
  executions = new Map();
  allowedForSession.clear();

  const settingsManager = SettingsManager.create(workspace, getAgentDir());
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noThemes: true,
    extensionFactories: [createPermissionExtension()]
    ,systemPromptOverride: (base) => [base, currentAgent?.systemPrompt].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();

  const activeSessionManager = sessionManager ?? SessionManager.continueRecent(workspace, workspaceSessionDir());
  const hasExistingMessages = activeSessionManager.buildSessionContext().messages.length > 0;
  const requested = hasExistingMessages ? undefined : defaultModel();
  const requestedModel = requested
    ? modelRuntime.getModel(requested.provider, requested.id)
    : undefined;
  const result = await createAgentSession({
    cwd: workspace,
    modelRuntime,
    model: requestedModel,
    thinkingLevel: hasExistingMessages ? undefined : (currentAgent?.defaultThinkingLevel ?? settings?.thinkingLevel ?? "medium"),
    tools: Object.entries(currentAgent?.tools ?? {}).filter(([, enabled]) => enabled).map(([name]) => name),
    sessionManager: activeSessionManager,
    settingsManager,
    resourceLoader
  });
  session = result.session;
  selectedModel = session.model ? { provider: session.model.provider, id: session.model.id } : requested;
  thinkingLevel = session.thinkingLevel;
  unsubscribeSession = session.subscribe(handleSessionEvent);
  status = sessionReadyStatus(Boolean(session.model), Boolean(result.modelFallbackMessage));
  busy = false;
  await refreshSessions();
  emitState();
}

async function initialize(command: Extract<RuntimeCommand, { type: "initialize" }>): Promise<void> {
  settings = command.settings;
  apiKeys = command.apiKeys;
  workspace = settings.workspace;
  currentAgent = activeAgent();
  thinkingLevel = settings.thinkingLevel ?? "medium";
  selectedModel = settings.model;
  modelRuntime = await ModelRuntime.create();
  for (const provider of settings.providers) {
    registerCustomProvider(provider);
    const key = apiKeys[provider.id];
    if (key) await modelRuntime.setRuntimeApiKey(provider.id, key, { allowNetwork: false });
  }
  await refreshCatalog();
  if (workspace) await createSession();
  else emitState();
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
    case "session.prompt":
      if (!session) throw new Error("请先打开工作区，再发送消息");
      if (!session.model) throw new Error("请先配置并选择模型，再发送消息");
      if ((command.attachments?.length ?? 0) > 5) throw new Error("最多同时发送 5 个附件");
      const images: ImageContent[] = [];
      const fileRefs: string[] = [];
      for (const attachment of command.attachments ?? []) {
        if (attachment.kind === "image") {
          if (!imageMimeTypes.has(attachment.mimeType) || !attachment.data || !/^[A-Za-z0-9+/]+=*$/u.test(attachment.data)) throw new Error(`图片附件无效：${attachment.name}`);
          if (Math.ceil((attachment.data.length * 3) / 4) > 20 * 1024 * 1024) throw new Error(`附件超过 20 MB 限制：${attachment.name}`);
          images.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
        }
        else {
          const rel = attachment.relativePath || attachment.path;
          if (!rel || isAbsolute(rel) || rel.split(/[\\/]/u).includes("..")) throw new Error(`附件路径无效：${attachment.name}`);
          const candidate = resolve(workspace!, rel);
          const rootReal = await realpath(workspace!);
          const candidateReal = await realpath(candidate);
          const relativeReal = workspaceRelativeAttachment(rootReal, candidateReal);
          if (!relativeReal || relativeReal === ".." || relativeReal.startsWith(`..${sep}`)) throw new Error(`附件必须位于当前工作区内：${attachment.name}`);
          const info = await stat(candidateReal);
          if (!info.isFile()) throw new Error(`附件不是普通文件：${attachment.name}`);
          if (info.size > 20 * 1024 * 1024) throw new Error(`附件超过 20 MB 限制：${attachment.name}`);
          fileRefs.push(relativeReal);
        }
      }
      const promptText = fileRefs.length ? `${command.text}\n\n项目文件附件（请使用 read 工具按需读取）：\n${fileRefs.map((path) => `- ${path}`).join("\n")}` : command.text;
      if (images.length && !hasImageInput(session.model)) throw new Error("当前模型不支持图片输入，请先切换多模态模型");
      busy = true;
      status = "Pi 正在工作";
      emitState();
      void session.prompt(promptText, images.length ? { images } : undefined).catch((error) => {
        busy = false;
        status = "请求失败";
        post({ type: "error", message: errorText(error) });
        emitState();
      });
      break;
    case "session.regenerate":
      if (!session) throw new Error("请先打开工作区，再重新生成");
      if (!session.model) throw new Error("请先配置并选择模型，再重新生成");
      if (!command.text.trim()) throw new Error("没有可重新生成的用户消息");
      busy = true;
      status = "Pi 正在重新生成";
      emitState();
      void (async () => {
        const branch = session!.sessionManager.getBranch();
        const target = branch.filter((entry) => entry.type === "message" && entry.message.role === "user" && (command.timestamp !== undefined ? entry.message.timestamp === command.timestamp : userMessageText(entry.message) === command.text.trim())).at(-1);
        if (!target || target.type !== "message") throw new Error("找不到要重新生成的用户消息");
        await session!.navigateTree(target.id);
        await session!.prompt(command.text.trim());
      })().catch((error) => {
        busy = false;
        status = "请求失败";
        post({ type: "error", message: errorText(error) });
        emitState();
      });
      break;
    case "session.abort":
      session?.abort();
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
      if (settings) { settings.model = command.settings.model; settings.thinkingLevel = command.settings.thinkingLevel; settings.appearance = command.settings.appearance; thinkingLevel = command.settings.thinkingLevel; selectedModel = command.settings.model; if (session) { session.setThinkingLevel(thinkingLevel); if (selectedModel) { const model = modelRuntime?.getModel(selectedModel.provider, selectedModel.id); if (model) await session.setModel(model); } } emitState(); }
      break;
    case "agent.archive":
      if (settings && command.agentId !== "default") { settings.agents = settings.agents.map((item) => item.id === command.agentId ? { ...item, archived: command.archived } : item); if (settings.currentAgentId === command.agentId) { settings.currentAgentId = "default"; currentAgent = activeAgent(); } if (workspace) await createSession(); }
      break;
    case "appearance.save":
      break;
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
