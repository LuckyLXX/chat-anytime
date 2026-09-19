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
  if (toolName === "bash" || toolName === "powershell" || toolName === "mcp" || toolName.startsWith("mcp_") || toolName.startsWith("server_")) return "command";
  if (toolName === "edit" || toolName === "write") return "write";
  // 设计模式：改 workspace 内的 .design.json 文档 / 写导出 HTML，与 write 同风险
  //（workspace 模式自动放行，read-only 拒绝）；design_list/guides/open/read/create 免门。
  // design_set_guide 虽只写 guide 一个字段，也是一次真实落盘（推进 revision），
  // 与 design_update 同门——否则 read-only 模式下能绕过 write 门改文档。
  if (toolName === "design_update" || toolName === "design_export" || toolName === "design_set_guide") return "write";
  // 浏览器自动化：导航与写入型 eval 过门；页面内操作（快照/点击/输入/滚动/
  // 截图/等待/读取）信任模型直接执行。
  // browser_save_image 与 browser_screenshot 同口径免门：都是「AI 把看到的
  // 内容落到 .pidesktop/ 下的观察产物」，不写用户工作区文件（写盘目标是自动化
  // 标签页的下载目录，与网页下载同一落点——网页下载本身也不走权限门）。
  if (toolName === "browser_navigate") return "browse";
  if (toolName === "browser_eval") return args.mode === "write" ? "browse" : undefined;
  if (toolName === "browser_tabs") return args.action === "close" ? "browse" : undefined;
  // 电脑控制：全局键鼠注入是比命令执行更做作的风险面——read-only 拒绝、
  // ask 逐次确认（权限卡显示目标窗口与坐标）、workspace 以上自动放行。
  // computer_windows / computer_screenshot 是只读观察，免门。
  if (toolName === "computer_click" || toolName === "computer_type" || toolName === "computer_press") return "desktop";
  // SSH 远程操作：云服务器命令不可回滚（无 checkpoint），风险高于本地 bash。
  // read-only 拒绝；workspace 逐次确认（权限卡可选「本会话允许」即保留的
  // 自动放行）；full 放行。ssh_hosts / ssh_read 是只读观察，免门。
  // ssh_upload / ssh_download 同轴：两者都需先有 SSH 会话（用户已授权的能力），
  // 且 ssh_download 是把**不可信的远端字节**落进本地磁盘——与 ssh_exec 同级待确认。
  if (toolName === "ssh_connect" || toolName === "ssh_exec" || toolName === "ssh_write" || toolName === "ssh_close" || toolName === "ssh_upload" || toolName === "ssh_download") return "ssh";
  return undefined;
}

export function permissionScope(toolName: string, risk: PermissionRequest["risk"]): string {
  return `${toolName}:${risk}`;
}

export type PermissionAction = "allow" | "ask" | "deny";

export function permissionAction(mode: AccessMode, toolName: string, risk: PermissionRequest["risk"] | undefined): PermissionAction {
  if (mode === "full" || !risk) return "allow";
  if (mode === "read-only" && (risk === "command" || risk === "write" || risk === "browse" || risk === "desktop" || risk === "ssh")) return "deny";
  if (mode === "workspace" && (risk === "write" || risk === "desktop")) return "allow";
  // ssh 在 workspace 模式下不自动放行（远端命令无本地文件边界），逐次确认；
  // command / browse / ssh 落到 ask。
  return "ask";
}

export function permissionNeedsApproval(mode: AccessMode, toolName: string, risk: PermissionRequest["risk"] | undefined): boolean {
  return permissionAction(mode, toolName, risk) === "ask";
}
