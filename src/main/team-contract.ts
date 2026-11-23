/**
 * 团队服务的对外契约（只放类型与常量）：工具构建器与运行时实现都依赖它，
 * 避免 `runtime-team.ts` ↔ `team-runtime.ts` 之间出现值循环。
 */

import type { TeamMemberSettlement, TeamMemberSummary, TeamSnapshot, TeamStopResult } from "../shared/protocol.js";
import type { PermissionSettlement } from "./permission-broker.js";
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
  /** 运行来源：`codex` = 外部 Codex App Server（Pi 成员缺省不带）。 */
  backend?: "codex";
  diagnostics: string[];
  /** 最近一个回合的结算（回合结果 / 短结论 / 任务 / 产物 / 卡点），旧会话缺省。 */
  settlement?: TeamMemberSettlement;
}

/** 外部运行时（首版只有 Codex）的轻量可用性标识：进 `team_list`，让 Lead 知道能派给谁。 */
export interface TeamBackendView {
  backend: "codex";
  /** 设置里启用、CLI 可执行文件可解析、协议版本已知：三者都满足才 true。 */
  available: boolean;
  /** 探测到的 CLI 版本（`codex-cli 0.171.0` 这种可读串）。 */
  version?: string;
  /** 不可用时给模型看的可行动原因（「未启用」「找不到 CLI」「只读」…）。 */
  reason?: string;
  /** 这个后端当前允许的访问上限；`read-only` 时不要指望它能改文件。 */
  access: "read-only" | "workspace-write";
}

export interface TeamWaitNoProgress {
  reason: "no-active-peer";
  message: string;
}

export type { TeamStopResult, TeamStopStatus } from "../shared/protocol.js";

export interface TeamPermissionNotice {
  memberName: string;
  toolName: string;
  summary: string;
}

export interface TeamWaitResult {
  timedOut: boolean;
  /** 只在没有其他成员 running/provisioning 时返回（模型不该白等）。 */
  noProgress?: TeamWaitNoProgress;
  /** 本次等待期间新产生的回合结算（按时间顺序，不重复返回旧事件）。 */
  settlements?: TeamMemberSettlement[];
  /** 正在等审批的成员请求（成员名 + 工具 + 摘要），让 Lead 知道卡在哪。 */
  pendingApprovals?: TeamPermissionNotice[];
  /** 用户在聊天里「立即发送」唤醒的等待：有新的用户指令要进模型。 */
  userInput?: true;
}

export interface TeamListTaskFilter {
  status?: "pending" | "in_progress" | "completed";
  owner?: string;
  ready?: boolean;
  cursor?: number;
  limit?: number;
}

/** 团队成员请求权限时的身份与回调（由运行时按成员注入，工具层不感知）。 */
export interface TeamMemberIdentity {
  /** 成员子会话 id；不可复用，是授权隔离与按成员取消的键。 */
  memberId: string;
  memberName: string;
}

export interface TeamPermissionHooks {
  /** 审批卡已发出（Lead 在等时能看到「某成员在等审批」）；`requestId` 与 settlement.id 同一个键。 */
  onPending(request: TeamPermissionNotice, requestId?: string): void;
  /** 请求收场（含模式直通/授权复用）：deny 的来源与取消都要能区分。 */
  onSettled(settlement: PermissionSettlement & { request: TeamPermissionNotice }): void;
}

export interface TeamService {
  spawn(membership: TeamMembership, params: { name: string; description: string; prompt: string; subagent?: string; taskId?: string; backend?: "codex" }, signal?: AbortSignal): Promise<TeamMemberView>;
  send(membership: TeamMembership, target: string, text: string, signal?: AbortSignal, taskId?: string): Promise<{ sent: true }>;
  list(membership: TeamMembership): TeamMemberView[];
  wait(membership: TeamMembership, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>;
  /** 按成员名或任务 id 停止（二选一）；完成任务/未绑定/无活跃执行时如实返回状态。 */
  interrupt(membership: TeamMembership, target: { name?: string; taskId?: string }): TeamStopResult;
  createTask(membership: TeamMembership, input: TeamTaskCreateInput): Promise<TeamTaskView>;
  listTasks(membership: TeamMembership, filter: TeamListTaskFilter): { tasks: TeamTaskView[]; nextCursor?: number };
  getTask(membership: TeamMembership, taskId: string): TeamTaskView;
  updateTask(membership: TeamMembership, mutation: TeamTaskMutation): Promise<TeamTaskView>;
  /** 可用外部运行时（首版只有 Codex）；未接入时返回空表（零提示词成本）。 */
  backends(): TeamBackendView[];
  /** 渲染端状态条用的成员摘要（只含 teammate）。 */
  snapshot(): TeamSnapshot;
  hasRunningMembers(): boolean;
  stopAll(): void;
  /** 用户在聊天里发新指令（立即发送/直接发送）：叫醒等待中的 Lead，让它尽快进模型。 */
  wakeForUserInput(): void;
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
