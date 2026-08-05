import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionRequest } from "../shared/protocol.js";

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
  if (toolName === "bash") return "command";
  if (toolName === "edit" || toolName === "write") return "write";
  return undefined;
}

export function permissionScope(toolName: string, risk: PermissionRequest["risk"]): string {
  return `${toolName}:${risk}`;
}
