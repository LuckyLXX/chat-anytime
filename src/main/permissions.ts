import { isAbsolute, relative, resolve } from "node:path";
import type { AccessMode, PermissionRequest } from "../shared/protocol.js";

export function toolPath(args: Record<string, unknown>): unknown {
  return args.path ?? args.file_path ?? args.filePath;
}

export function pathLeavesWorkspace(workspace: string | undefined, pathValue: unknown): boolean {
  if (!workspace || typeof pathValue !== "string" || !pathValue.trim()) return false;
  const target = isAbsolute(pathValue) ? resolve(pathValue) : resolve(workspace, pathValue);
  const relation = relative(resolve(workspace), target);
  return relation.startsWith("..") || isAbsolute(relation);
}

export function toolRisk(
  workspace: string | undefined,
  toolName: string,
  args: Record<string, unknown>
): PermissionRequest["risk"] | undefined {
  if (pathLeavesWorkspace(workspace, toolPath(args))) return "outside-workspace";
  if (toolName === "bash" || toolName === "mcp" || toolName.startsWith("mcp_") || toolName.startsWith("server_")) return "command";
  if (toolName === "edit" || toolName === "write") return "write";
  // 浏览器自动化：导航与写入型 eval 过门；页面内操作（快照/点击/输入/滚动/
  // 截图/等待/读取）信任模型直接执行。
  if (toolName === "browser_navigate") return "browse";
  if (toolName === "browser_eval") return args.mode === "write" ? "browse" : undefined;
  if (toolName === "browser_tabs") return args.action === "close" ? "browse" : undefined;
  return undefined;
}

export function permissionScope(toolName: string, risk: PermissionRequest["risk"]): string {
  return `${toolName}:${risk}`;
}

export type PermissionAction = "allow" | "ask" | "deny";

export function permissionAction(mode: AccessMode, toolName: string, risk: PermissionRequest["risk"] | undefined): PermissionAction {
  if (mode === "full" || !risk) return "allow";
  if (mode === "read-only" && (risk === "command" || risk === "write" || risk === "browse")) return "deny";
  if (mode === "workspace" && risk === "write") return "allow";
  return "ask";
}

export function permissionNeedsApproval(mode: AccessMode, toolName: string, risk: PermissionRequest["risk"] | undefined): boolean {
  return permissionAction(mode, toolName, risk) === "ask";
}
