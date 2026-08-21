// Permission cluster extracted from pi-runtime.ts: the app-owned inline
// extension that gates risky tool calls through the PermissionBroker, plus the
// shared request helper used by both the extension (root agent) and the
// subagent delegation context. State is read through getters so the live
// session/workspace/agent values are always current.

import type { AgentSession, ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AccessMode, AgentProfile, PermissionDecision } from "../shared/protocol.js";
import { toolLabel } from "../shared/locale.js";
import { toolRisk } from "./permissions.js";
import type { PermissionBroker } from "./permission-broker.js";

export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return String(args.command ?? "执行命令");
  if (toolName === "browser_navigate") return `导航到 ${String(args.url ?? "")}`;
  if (toolName === "browser_eval") return `执行 JavaScript（${String(args.mode ?? "read")}）：${String(args.expression ?? "").slice(0, 80)}`;
  if (toolName === "browser_tabs") return `关闭浏览器标签页 ${String(args.tabId ?? "")}`;
  const path = args.path ?? args.file_path ?? args.filePath;
  if (path) return `${toolLabel(toolName)}：${String(path)}`;
  return toolLabel(toolName);
}

export interface PermissionGateDeps {
  broker: PermissionBroker;
  workspace: () => string | undefined;
  accessMode: () => AccessMode;
  session: () => AgentSession | undefined;
  agent: () => AgentProfile | undefined;
}

export function requestPermission(deps: PermissionGateDeps, toolName: string, args: Record<string, unknown>, toolCallId: string, principalKind: "root-agent" | "subagent" = "root-agent"): Promise<PermissionDecision> {
  const risk = toolRisk(deps.workspace(), toolName, args);
  if (!risk) return Promise.resolve("allow-once");
  const sessionId = deps.session()?.sessionId ?? "session-pending";
  return deps.broker.request({
    accessMode: deps.accessMode(),
    toolName,
    summary: summarizeArgs(toolName, args),
    args,
    risk,
    principal: {
      kind: principalKind,
      sessionId,
      ...(principalKind === "subagent" ? { parentSessionId: sessionId } : {}),
      agentId: deps.agent()?.id,
      toolCallId
    }
  });
}

/**
 * The permission gate extension. `onApiBound` receives the ExtensionAPI at
 * bind time — pi-runtime uses the captured handle to hot-reload MCP tools via
 * registerTool() without recreating the session.
 */
export function createPermissionExtension(deps: PermissionGateDeps, onApiBound: (api: ExtensionAPI) => void): InlineExtension {
  return {
    name: "chat-anytime-permissions",
    hidden: true,
    factory(pi) {
      onApiBound(pi);
      pi.on("tool_call", async (event) => {
        const args = event.input as Record<string, unknown>;
        const risk = toolRisk(deps.workspace(), event.toolName, args);
        if (!risk) return undefined;
        const decision = await requestPermission(deps, event.toolName, args, event.toolCallId);
        if (decision === "deny") return { block: true, reason: "用户已在 PiDesktop 中拒绝此操作" };
        return undefined;
      });
    }
  };
}
