import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
  type InlineExtension,
  type ModelRuntime,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AccessMode, AgentProfile, DelegationRole, PermissionDecision, ThinkingLevel } from "../shared/protocol.js";

/**
 * Self-built subagent delegation. Replaces the old `pi-subagents` CLI shim that
 * intercepted the official Pi subagent extension. Here a `delegate_agent`
 * customTool creates a real child AgentSession in the same utility process,
 * runs it headlessly to completion, and returns the final assistant text. Only
 * one level of delegation is allowed: child sessions are created without the
 * delegate tool, so they cannot spawn grandchildren.
 */

export interface SubagentContext {
  modelRuntime: ModelRuntime;
  workspace: string;
  agentDir: string;
  agent: AgentProfile;
  thinkingLevel: ThinkingLevel;
  accessMode: AccessMode;
  model: { provider: string; id: string };
  parentSessionId?: string;
  /** Route risky tool calls from the child through the same permission broker. */
  requestPermission(toolName: string, args: Record<string, unknown>, toolCallId: string): Promise<PermissionDecision>;
  /** True when this context itself is a delegation child (blocks nesting). */
  isDelegationChild: boolean;
}

const DELEGATION_TIMEOUT_MS = 30 * 60 * 1000;

export function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as AssistantMessage).content;
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

function createChildPermissionExtension(ctx: SubagentContext): InlineExtension {
  return {
    name: "chat-anytime-subagent-permissions",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event) => {
        const args = (event.input ?? {}) as Record<string, unknown>;
        const decision = await ctx.requestPermission(event.toolName, args, event.toolCallId);
        if (decision === "deny") return { block: true, reason: "用户已在 PiDesktop 中拒绝该子代理操作" };
        return undefined;
      });
    }
  };
}

function runChildToCompletion(child: AgentSession, goal: string, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastText = "";
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    const unsubscribe = child.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        lastText = assistantText(event.message) || lastText;
      } else if (event.type === "agent_end" && !event.willRetry) {
        finish(() => { unsubscribe(); resolve(lastText || "(子代理未返回文本)"); });
      } else if (event.type === "agent_settled") {
        finish(() => { unsubscribe(); resolve(lastText || "(子代理未返回文本)"); });
      }
    });
    const timeout = setTimeout(() => {
      finish(() => { unsubscribe(); void child.abort(); reject(new Error("子代理执行超时（30 分钟）")); });
    }, DELEGATION_TIMEOUT_MS);
    signal?.addEventListener("abort", () => {
      finish(() => { clearTimeout(timeout); unsubscribe(); void child.abort(); reject(new Error("子代理被中止")); });
    });
    void child.prompt(goal).catch((error) => {
      finish(() => { clearTimeout(timeout); unsubscribe(); reject(error instanceof Error ? error : new Error(String(error))); });
    });
  });
}

function roleGuideline(role: DelegationRole | undefined): string {
  switch (role) {
    case "explore": return "你的职责是探索与信息收集，不要修改文件。";
    case "research": return "你的职责是研究与方案分析，给出结论与建议。";
    case "implement": return "你的职责是具体实现，可使用工具修改文件并验证。";
    case "review": return "你的职责是审查现有改动，列出风险与改进建议。";
    default: return "完成委派给你的独立子任务。";
  }
}

async function runDelegation(ctx: SubagentContext, params: { goal?: unknown; role?: unknown; modelId?: unknown }, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>> {
  if (ctx.isDelegationChild) throw new Error("子代理不能再创建子代理（仅支持一层委派）");
  const goal = String(params.goal ?? "").trim();
  if (!goal) throw new Error("delegate_agent 需要 goal 参数");
  const role = (typeof params.role === "string" ? params.role : "custom") as DelegationRole;
  const modelIdRaw = typeof params.modelId === "string" ? params.modelId.trim() : "";
  const modelTarget = modelIdRaw ? parseModelId(modelIdRaw, ctx.model) : ctx.model;
  const childModel = ctx.modelRuntime.getModel(modelTarget.provider, modelTarget.id);
  if (!childModel) throw new Error(`子代理模型不可用：${modelTarget.provider}/${modelTarget.id}`);

  const delegationsDir = join(ctx.agentDir, "chatanytime-sessions", ctx.agent.id, "delegations");
  const sessionManager = SessionManager.create(ctx.workspace, delegationsDir);
  const settingsManager = SettingsManager.create(ctx.workspace, ctx.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.workspace,
    agentDir: ctx.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createChildPermissionExtension(ctx)],
    systemPromptOverride: (base) => [base, ctx.agent.systemPrompt, `你是被主会话委派的子代理。${roleGuideline(role)}完成后给出简洁结论。`].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();
  const { session: child } = await createAgentSession({
    cwd: ctx.workspace,
    modelRuntime: ctx.modelRuntime,
    model: childModel,
    thinkingLevel: ctx.thinkingLevel,
    sessionManager,
    settingsManager,
    resourceLoader
  });
  const enabledBuiltinTools = Object.entries(ctx.agent.tools ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
  await child.bindExtensions({ onError: () => { /* logged via permission broker path */ } });
  child.setActiveToolsByName(enabledBuiltinTools);

  try {
    const result = await runChildToCompletion(child, goal, signal);
    return {
      content: [{ type: "text", text: result }],
      details: { goal, role, childSessionId: child.sessionId, model: modelTarget }
    };
  } finally {
    child.dispose();
  }
}

export function parseModelId(modelId: string, fallback: { provider: string; id: string }): { provider: string; id: string } {
  const slash = modelId.indexOf("/");
  return slash > 0 ? { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) } : fallback;
}

/** Build the subagent customTools for a session. Empty when nesting is blocked. */
export function createSubagentTools(ctx: SubagentContext): ToolDefinition[] {
  if (ctx.isDelegationChild) return [];
  return [
    defineTool({
      name: "delegate_agent",
      label: "委派子代理",
      description: "把一个独立子任务委派给子代理执行并等待结果返回。子代理在同一工作区内运行，不能再创建子代理。适用于可并行/隔离的子任务。",
      promptSnippet: "delegate_agent: 委派独立子任务给子代理并等待结果",
      parameters: Type.Object({
        goal: Type.String({ description: "子代理要完成的具体目标，应足够独立、可单独完成" }),
        role: Type.Optional(Type.Union([
          Type.Literal("explore"),
          Type.Literal("research"),
          Type.Literal("implement"),
          Type.Literal("review"),
          Type.Literal("custom")
        ], { description: "子代理角色，影响其系统提示约束" })),
        modelId: Type.Optional(Type.String({ description: "可选，provider/id 形式的模型；缺省沿用当前模型" }))
      }),
      execute: async (_toolCallId, params, signal) => runDelegation(ctx, (params ?? {}) as { goal?: unknown; role?: unknown; modelId?: unknown }, signal)
    })
  ];
}
