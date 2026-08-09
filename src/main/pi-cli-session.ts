import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension
} from "@earendil-works/pi-coding-agent";
import type {
  AccessMode,
  ExecutionPrincipal,
  PermissionDecision,
  ThinkingLevel
} from "../shared/protocol.js";
import {
  parsePiCliArgs,
  type ParsedPiCliArgs
} from "./pi-cli-host.js";
import type { PiCliPermissionRequest, PiCliRunErrorSink, PiCliRunRequest, PiCliRunEventSink } from "./pi-cli-compat.js";
import { toolRisk } from "./permissions.js";

export interface PiCliSessionContext {
  modelRuntime: ModelRuntime;
  agentDir: string;
  workspace: string;
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  accessMode: AccessMode;
  parentSessionId?: string;
  requestPermission: (request: PiCliPermissionRequest) => Promise<PermissionDecision>;
  resetPermissions?: (sessionId: string) => void;
}

function summarizePermission(toolName: string, args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length > 500 ? `${toolName} ${text.slice(0, 497)}...` : `${toolName} ${text}`;
}

function createCliPermissionExtension(
  workspace: string,
  childSessionId: string,
  parentSessionId: string | undefined,
  accessMode: AccessMode,
  requestPermission: PiCliSessionContext["requestPermission"]
): InlineExtension {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const args = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      const risk = toolRisk(workspace, event.toolName, args);
      if (!risk) return undefined;
      const principal: ExecutionPrincipal = {
        kind: "subagent",
        sessionId: childSessionId,
        parentSessionId,
        toolCallId: event.toolCallId
      };
      const decision = await requestPermission({
        accessMode,
        toolName: event.toolName,
        summary: summarizePermission(event.toolName, args),
        args,
        risk,
        principal
      });
      if (decision === "deny") return { block: true, reason: "用户已在 PiDesktop 中拒绝此子代理操作" };
      return undefined;
    });
  };
}

function findModel(
  modelRuntime: ModelRuntime,
  requested: string | undefined,
  provider: string | undefined,
  fallback: { provider: string; id: string } | undefined
): Model<any> | undefined {
  if (requested) {
    const thinkingSeparator = requested.lastIndexOf(":");
    const modelRequest = thinkingSeparator > 0 ? requested.slice(0, thinkingSeparator) : requested;
    const slash = modelRequest.indexOf("/");
    if (slash > 0) {
      const model = modelRuntime.getModel(modelRequest.slice(0, slash), modelRequest.slice(slash + 1));
      if (model) return model as Model<any>;
    }
    if (provider) {
      const model = modelRuntime.getModel(provider, modelRequest);
      if (model) return model as Model<any>;
    }
    const byId = modelRuntime.getModels().find((candidate) => candidate.id === modelRequest);
    if (byId) return byId as Model<any>;
  }
  if (fallback) return modelRuntime.getModel(fallback.provider, fallback.id) as Model<any> | undefined;
  return undefined;
}

function thinkingFromModelRequest(requested: string | undefined): ThinkingLevel | undefined {
  if (!requested) return undefined;
  const separator = requested.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const value = requested.slice(separator + 1) as ThinkingLevel;
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value) ? value : undefined;
}

async function readPromptValue(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  try {
    return await readFile(value, "utf8");
  } catch {
    // Pi accepts literal text as well as a path. The official subagent
    // extension passes a temporary file, while other extensions may pass text.
    return value;
  }
}

async function readInitialPrompt(value: string): Promise<string> {
  if (!value.startsWith("@") || value.length === 1) return value;
  try {
    return await readFile(value.slice(1), "utf8");
  } catch (error) {
    throw new Error(`无法读取 Pi CLI 任务文件：${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertChildCwd(workspace: string, cwd: string): void {
  const relation = relative(resolve(workspace), resolve(cwd));
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Pi 子代理工作目录必须位于当前工作区内");
  }
}

async function createChildSession(
  context: PiCliSessionContext,
  parsed: ParsedPiCliArgs,
  cwd: string,
  sessionManager: SessionManager,
  childSessionId: string
) {
  const settingsManager = SettingsManager.create(cwd, context.agentDir);
  const [systemPrompt, ...appendSystemPromptValues] = await Promise.all([
    readPromptValue(parsed.systemPrompt),
    ...(parsed.appendSystemPrompts ?? []).map((value) => readPromptValue(value))
  ]);
  const appendSystemPrompts = appendSystemPromptValues.filter((value): value is string => Boolean(value));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: context.agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    appendSystemPrompt: appendSystemPrompts.length > 0 ? appendSystemPrompts : undefined,
    systemPromptOverride: systemPrompt ? () => systemPrompt : undefined,
    extensionFactories: [createCliPermissionExtension(
      context.workspace,
      childSessionId,
      context.parentSessionId,
      context.accessMode,
      context.requestPermission
    )]
  });
  await resourceLoader.reload();

  const model = findModel(context.modelRuntime, parsed.model, parsed.provider, context.model);
  if (!model) throw new Error("Pi CLI 兼容宿主无法解析子代理模型，请检查模型配置");
  const { session } = await createAgentSession({
    cwd,
    agentDir: context.agentDir,
    modelRuntime: context.modelRuntime,
    model,
    thinkingLevel: parsed.thinking ?? thinkingFromModelRequest(parsed.model) ?? context.thinkingLevel,
    resourceLoader,
    sessionManager,
    settingsManager
  });
  return session;
}

export function createCliSessionManager(parsed: ParsedPiCliArgs, cwd: string, childSessionId: string): SessionManager {
  const resolvedSessionDir = parsed.sessionDir ? resolve(cwd, parsed.sessionDir) : undefined;
  if (parsed.sessionFile) {
    const sessionFile = resolve(cwd, parsed.sessionFile);
    return SessionManager.open(sessionFile, resolvedSessionDir ?? dirname(sessionFile), cwd);
  }
  if (resolvedSessionDir) return SessionManager.create(cwd, resolvedSessionDir, { id: childSessionId });
  return SessionManager.inMemory(cwd, { id: childSessionId });
}

export async function runPiCliSession(
  context: PiCliSessionContext,
  request: PiCliRunRequest,
  emit: PiCliRunEventSink,
  signal: AbortSignal,
  reportError: PiCliRunErrorSink = () => undefined
): Promise<number> {
  const parsed = parsePiCliArgs(request.argv);
  if (!parsed.prompt) throw new Error("Pi CLI 兼容宿主缺少初始任务");
  const cwd = resolve(request.cwd);
  assertChildCwd(context.workspace, cwd);
  const cwdInfo = await stat(cwd);
  if (!cwdInfo.isDirectory()) throw new Error("Pi CLI 子代理工作目录不是目录");

  const requestedChildSessionId = `subagent-${randomUUID()}`;
  const sessionManager = createCliSessionManager(parsed, cwd, requestedChildSessionId);
  const childSessionId = sessionManager.getSessionId() || requestedChildSessionId;
  const session = await createChildSession(context, parsed, cwd, sessionManager, childSessionId);
  const onAbort = (): void => {
    context.resetPermissions?.(childSessionId);
    void session.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) return 143;
    if (parsed.noTools || parsed.noBuiltinTools) {
      session.setActiveToolsByName([]);
    } else if (parsed.tools || parsed.excludeTools) {
      const excluded = new Set(parsed.excludeTools ?? []);
      const active = (parsed.tools ?? session.getActiveToolNames()).filter((name) => !excluded.has(name));
      session.setActiveToolsByName(active);
    }
    session.subscribe(emit);
    if (parsed.mode === "json") {
      const header = session.sessionManager.getHeader();
      if (header) emit(header);
    }
    await session.bindExtensions({
      mode: parsed.mode === "json" ? "json" : "print",
      onError: (error) => reportError(`扩展错误（${error.extensionPath}）：${error.error}`)
    });
    await session.prompt(await readInitialPrompt(parsed.prompt));
    const last = session.state.messages.at(-1);
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) return 1;
    return signal.aborted ? 143 : 0;
  } finally {
    context.resetPermissions?.(childSessionId);
    signal.removeEventListener("abort", onAbort);
    session.dispose();
  }
}
