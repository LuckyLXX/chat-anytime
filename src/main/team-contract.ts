/**
 * 团队服务的对外契约（只放类型与常量）：工具构建器与运行时实现都依赖它，
 * 避免 `runtime-team.ts` ↔ `team-runtime.ts` 之间出现值循环。
 */

import type { TeamMemberSummary, TeamSnapshot } from "../shared/protocol.js";
import type { TeamTaskAction, TeamTaskCreateInput, TeamTaskMutation, TeamTaskView } from "./team-tasks.js";

export type TeamRole = "lead" | "teammate";

/** 调用者身份：由工具闭包捕获，运行时据此校验 Lead-only 操作与自发消息。 */
export interface TeamMembership {
  role: TeamRole;
  name: string;
}

/** 模型可见的成员行；`target` 是发给 `team_send` 的名字。 */
export interface TeamMemberView {
  target: string;
  role: TeamRole;
  status: TeamMemberSummary["status"];
  description?: string;
  subagent?: string;
  model?: string;
  diagnostics: string[];
}

export interface TeamWaitNoProgress {
  reason: "no-active-peer";
  message: string;
}

export interface TeamWaitResult {
  timedOut: boolean;
  /** 只在没有其他成员 running/provisioning 时返回（模型不该白等）。 */
  noProgress?: TeamWaitNoProgress;
}

export interface TeamListTaskFilter {
  status?: "pending" | "in_progress" | "completed";
  owner?: string;
  ready?: boolean;
  cursor?: number;
  limit?: number;
}

export interface TeamService {
  spawn(membership: TeamMembership, params: { name: string; description: string; prompt: string; subagent?: string }, signal?: AbortSignal): Promise<TeamMemberView>;
  send(membership: TeamMembership, target: string, text: string, signal?: AbortSignal): Promise<{ sent: true }>;
  list(membership: TeamMembership): TeamMemberView[];
  wait(membership: TeamMembership, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>;
  interrupt(membership: TeamMembership, target: string): { previousStatus: "running" | "inactive" };
  createTask(membership: TeamMembership, input: TeamTaskCreateInput): Promise<TeamTaskView>;
  listTasks(membership: TeamMembership, filter: TeamListTaskFilter): { tasks: TeamTaskView[]; nextCursor?: number };
  getTask(membership: TeamMembership, taskId: string): TeamTaskView;
  updateTask(membership: TeamMembership, mutation: TeamTaskMutation): Promise<TeamTaskView>;
  /** 渲染端状态条用的成员摘要（只含 teammate）。 */
  snapshot(): TeamSnapshot;
  hasRunningMembers(): boolean;
  stopAll(): void;
  dispose(): void;
}

/** 成员会话里的身份说明（写在子会话系统提示词尾部；不进 Lead 的提示词）。 */
export function teamIdentityBlock(name: string): string {
  return [
    `你是智能体团队的成员「${name}」。Team Lead 的名字是 "lead"。`,
    "用 team_send 给 lead 或其他成员发消息；用 team_task_* 查看、认领与完成任务。",
    "你与 Lead 共享同一工作区，文件改动对所有成员立即可见；按任务拆分互不重叠的写入范围。"
  ].join("\n");
}

/** `team_wait` 在没有活跃同伴时的固定文案（dsh 同款语义，避免模型轮询）。 */
export const TEAM_NO_ACTIVE_PEER_MESSAGE = "没有其他成员正在运行或创建中；team_wait 不会唤醒 inactive 成员。请先 team_list 查看成员与任务，再用 team_send 唤醒需要的成员。";

/** 任务动作的模型可读文案（工具 schema 的 enum 与错误提示共用）。 */
export const TEAM_TASK_ACTIONS: readonly TeamTaskAction[] = [
  "claim",
  "release",
  "edit",
  "set_dependencies",
  "complete",
  "reopen",
  "reassign",
  "delete"
];
