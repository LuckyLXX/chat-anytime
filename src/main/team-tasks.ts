/**
 * 共享任务板的纯状态机（无 I/O、无 Pi 依赖）：创建、CAS 变更、DAG 校验与视图派生。
 *
 * 设计来自 dsh 的 task-board：任务不是增量补丁而是**全量快照 + 单调 revision**，
 * 每次变更都带 expectedRevision——两个成员基于同一份旧副本提交时，后到的会被
 * 拒绝而不是悄悄覆盖。依赖只构成 DAG；writeScopes 只做重叠告警，**绝不加锁**
 * （bash/formatter/外部写入都能绕过文件版本检查，虚假的互斥保证比明确告警更危险）。
 */

import { MAX_TEAM_TASKS, type TeamState, type TeamTaskRecord, type TeamTaskStatus } from "./team-store.js";

export interface TeamTaskView {
  id: string;
  revision: number;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  ownerName?: string;
  blockedBy: string[];
  writeScopes: string[];
  ready: boolean;
  writeScopeWarnings: string[];
}

export type TeamTaskAction = "claim" | "release" | "edit" | "set_dependencies" | "complete" | "reopen" | "reassign" | "delete";

export interface TeamTaskCreateInput {
  subject: string;
  description: string;
  blockedBy?: readonly string[];
  writeScopes?: readonly string[];
}

/** 一次 CAS 变更；字段按 action 取用。 */
export interface TeamTaskMutation {
  taskId: string;
  expectedRevision: number;
  action: TeamTaskAction;
  subject?: string;
  description?: string;
  blockedBy?: readonly string[];
  writeScopes?: readonly string[];
  owner?: string;
}

/** 当前调用者的身份（由运行时从成员表解析，状态机不信任外部输入）。 */
export interface TeamTaskCaller {
  id: string;
  role: "lead" | "teammate";
  name: string;
}

export interface TeamTaskCreateInputNormalized {
  subject: string;
  description: string;
  blockedBy: string[];
  writeScopes: string[];
}

const TASK_ID_PATTERN = /^task-(\d+)$/u;

function requiredText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`任务 ${field} 不能为空`);
  if (text.length > max) throw new Error(`任务 ${field} 过长（最多 ${max} 字符）`);
  return text;
}

/** 归一化工作区相对写入范围前缀；拒绝绝对路径与 `..`（只用于告警，不授权）。 */
export function normalizeWriteScope(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+/gu, "/").replace(/\/$/u, "");
  if (!normalized) throw new Error("write_scopes 不能包含空路径");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) throw new Error(`write_scopes 必须是工作区相对路径：${value}`);
  if (normalized.split("/").includes("..")) throw new Error(`write_scopes 不能包含 ..：${value}`);
  return normalized;
}

export function normalizeWriteScopes(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalizeWriteScope))];
}

/** 两个路径前缀是否在组件边界上重叠（父子目录也算重叠）。 */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** 任务的全部依赖是否都已完成。 */
export function taskReady(state: TeamState, task: TeamTaskRecord): boolean {
  return task.blockedBy.every((id) => state.tasks.find((candidate) => candidate.id === id)?.status === "completed");
}

function taskById(state: TeamState, id: string): TeamTaskRecord | undefined {
  return state.tasks.find((candidate) => candidate.id === id);
}

/** 解析 owner 名字 → 记录里的 ownerId；`lead` 是伪成员，空值表示无主。 */
export function resolveOwnerId(state: TeamState, leadSessionId: string, owner: string): string | undefined {
  const value = owner.trim();
  if (!value || value === "unowned") return undefined;
  if (value === "lead") return leadSessionId;
  const member = state.members.find((candidate) => candidate.name === value && candidate.phase === "active");
  if (!member) throw new Error(`找不到可用的团队成员「${value}」；先用 team_list 查看成员`);
  return member.id;
}

/** ownerId → 展示名；未知 id 回退为 `已离开的成员`（任务不因成员消失而丢 owner）。 */
export function ownerNameOf(state: TeamState, leadSessionId: string, ownerId: string | undefined): string | undefined {
  if (ownerId === undefined) return undefined;
  if (ownerId === leadSessionId) return "lead";
  return state.members.find((candidate) => candidate.id === ownerId)?.name ?? "已离开的成员";
}

/**
 * 派生一个任务视图：owner 名、就绪状态、与其它 in_progress 任务的写入范围重叠告警。
 * 提交方可以传提交前的 state（新任务值由 task 显式给出；owner 名/依赖就绪/其它
 * 任务的 scope 不会因为这次 append 而改变）。
 */
export function projectTaskView(state: TeamState, task: TeamTaskRecord, leadSessionId: string): TeamTaskView {
  const warnings = new Set<string>();
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== "in_progress") continue;
    if (task.writeScopes.some((left) => other.writeScopes.some((right) => scopesOverlap(left, right)))) {
      warnings.add(`写入范围与 ${other.id} 重叠（仅告警，不阻止）`);
    }
  }
  const ownerName = ownerNameOf(state, leadSessionId, task.ownerId);
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...ownerName === undefined ? {} : { ownerName },
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ready: task.status === "pending" && taskReady(state, task),
    writeScopeWarnings: [...warnings]
  };
}

/**
 * 校验依赖列表：必须指向未删除的既有任务、无重复、无自环。返回去重后的列表。
 * @param self - 正在编辑的任务 id（新建时缺省）。
 */
export function normalizeDependencies(state: TeamState, values: readonly string[] | undefined, self?: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values ?? []) {
    const id = raw.trim();
    if (!id) throw new Error("blocked_by 不能包含空任务 id");
    if (id === self) throw new Error("任务不能依赖自己");
    if (seen.has(id)) throw new Error(`blocked_by 包含重复任务 ${id}`);
    const target = taskById(state, id);
    if (!target || target.status === "deleted") throw new Error(`依赖的任务不存在：${id}`);
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * DAG 校验：从候选任务的依赖出发做 DFS，若回到候选任务本身即为环。
 * 新任务的依赖不可能反向依赖它，但编辑 / set_dependencies 需要这道门。
 */
export function assertTaskGraph(tasks: readonly TeamTaskRecord[], candidate: TeamTaskRecord): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  byId.set(candidate.id, candidate);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (id === candidate.id) throw new Error(`任务依赖形成环：${candidate.id}`);
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error("任务依赖形成环");
    const task = byId.get(id);
    if (!task) return;
    visiting.add(id);
    for (const blocker of task.blockedBy) visit(blocker);
    visiting.delete(id);
    done.add(id);
  };
  for (const blocker of candidate.blockedBy) visit(blocker);
}

/** 下一个任务 id：数字后缀单调递增、永不复用；安全整数耗尽时报错。 */
export function nextTaskId(state: TeamState): string {
  let max = 0;
  for (const task of state.tasks) {
    const match = TASK_ID_PATTERN.exec(task.id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) max = Math.max(max, value);
  }
  const next = max + 1;
  if (!Number.isSafeInteger(next)) throw new Error("任务 id 空间已耗尽");
  return `task-${next}`;
}

/** 活动（未删除）任务数是否已达上限。 */
export function assertTaskCapacity(state: TeamState): void {
  if (state.tasks.filter((task) => task.status !== "deleted").length >= MAX_TEAM_TASKS) {
    throw new Error(`任务板已达上限 ${MAX_TEAM_TASKS} 条未删除任务`);
  }
}

/** 新建一条无主待办任务（revision 1）。调用方负责把它加入 state 并落盘。 */
export function createTask(state: TeamState, input: TeamTaskCreateInput): TeamTaskRecord {
  assertTaskCapacity(state);
  const subject = requiredText(input.subject, "subject", 200);
  const description = requiredText(input.description, "description", 16_384);
  const blockedBy = normalizeDependencies(state, input.blockedBy);
  const writeScopes = normalizeWriteScopes(input.writeScopes);
  const task: TeamTaskRecord = {
    id: nextTaskId(state),
    revision: 1,
    subject,
    description,
    status: "pending",
    blockedBy,
    writeScopes
  };
  assertTaskGraph(state.tasks, task);
  return task;
}

function authorizeOwner(task: TeamTaskRecord, caller: TeamTaskCaller): void {
  if (caller.role === "lead") return;
  if (task.ownerId !== caller.id) throw new Error("任务变更需要任务 owner 或 Team Lead");
}

function requireStatus(task: TeamTaskRecord, expected: TeamTaskStatus, message: string): void {
  if (task.status !== expected) throw new Error(message);
}

function withoutOwner(task: TeamTaskRecord): TeamTaskRecord {
  const { ownerId: _ownerId, ...rest } = task;
  return rest;
}

/**
 * 应用一次 CAS 变更并返回新快照（不修改入参）。调用方负责替换 state 与落盘。
 * 所有错误都是中文、可直接展示给模型与用户。
 */
export function updateTask(
  state: TeamState,
  leadSessionId: string,
  caller: TeamTaskCaller,
  mutation: TeamTaskMutation
): TeamTaskRecord {
  const current = taskById(state, mutation.taskId);
  if (!current) throw new Error(`任务不存在：${mutation.taskId}`);
  if (current.revision !== mutation.expectedRevision) {
    throw new Error(`任务 ${current.id} 已被更新（当前 revision ${current.revision}，你基于 ${mutation.expectedRevision}）；请先 team_task_get 后重试`);
  }
  if (current.status === "deleted") throw new Error(`任务 ${current.id} 已删除`);
  const lead = caller.role === "lead";

  let next: TeamTaskRecord;
  switch (mutation.action) {
    case "claim": {
      if (current.ownerId !== undefined && current.ownerId !== caller.id) throw new Error(`任务 ${current.id} 已被其他成员认领`);
      requireStatus(current, "pending", `只有 pending 任务可以认领（当前 ${current.status}）`);
      if (!taskReady(state, current)) throw new Error(`任务 ${current.id} 的依赖尚未全部完成`);
      next = { ...current, status: "in_progress", ownerId: caller.id };
      break;
    }
    case "release": {
      authorizeOwner(current, caller);
      requireStatus(current, "in_progress", "只有 in_progress 任务可以释放");
      next = withoutOwner({ ...current, status: "pending" });
      break;
    }
    case "edit": {
      authorizeOwner(current, caller);
      if (mutation.subject === undefined && mutation.description === undefined && mutation.writeScopes === undefined) {
        throw new Error("edit 至少需要 subject / description / write_scopes 之一");
      }
      next = {
        ...current,
        ...mutation.subject === undefined ? {} : { subject: requiredText(mutation.subject, "subject", 200) },
        ...mutation.description === undefined ? {} : { description: requiredText(mutation.description, "description", 16_384) },
        ...mutation.writeScopes === undefined ? {} : { writeScopes: normalizeWriteScopes(mutation.writeScopes) }
      };
      break;
    }
    case "set_dependencies": {
      authorizeOwner(current, caller);
      if (mutation.blockedBy === undefined) throw new Error("set_dependencies 需要 blocked_by");
      next = { ...current, blockedBy: normalizeDependencies(state, mutation.blockedBy, current.id) };
      break;
    }
    case "complete": {
      authorizeOwner(current, caller);
      requireStatus(current, "in_progress", "只有 in_progress 任务可以完成");
      next = { ...current, status: "completed" };
      break;
    }
    case "reopen": {
      authorizeOwner(current, caller);
      requireStatus(current, "completed", "只有 completed 任务可以重新打开");
      next = withoutOwner({ ...current, status: "pending" });
      break;
    }
    case "reassign": {
      if (!lead) throw new Error("只有 Team Lead 可以重新指派任务");
      if (current.status !== "pending" && current.status !== "in_progress") {
        throw new Error("只有 pending / in_progress 任务可以重新指派");
      }
      if (mutation.owner === undefined || mutation.owner.trim().length === 0) {
        next = withoutOwner({ ...current, status: "pending" });
        break;
      }
      if (!taskReady(state, current)) throw new Error(`任务 ${current.id} 的依赖尚未全部完成`);
      const ownerId = resolveOwnerId(state, leadSessionId, mutation.owner);
      next = ownerId === undefined
        ? withoutOwner({ ...current, status: "pending" })
        : { ...current, status: "in_progress", ownerId };
      break;
    }
    case "delete": {
      authorizeOwner(current, caller);
      const dependent = state.tasks.find((candidate) => candidate.status !== "deleted" && candidate.id !== current.id && candidate.blockedBy.includes(current.id));
      if (dependent) throw new Error(`任务 ${current.id} 仍被 ${dependent.id} 依赖，不能删除`);
      next = { ...current, status: "deleted" };
      break;
    }
    default:
      throw new Error(`未知任务动作：${String(mutation.action)}`);
  }
  const committed: TeamTaskRecord = { ...next, revision: current.revision + 1 };
  assertTaskGraph(state.tasks, committed);
  return committed;
}

/** 替换 state 里的任务（不存在则追加）；返回新数组，便于运行时统一落盘。 */
export function withTask(state: TeamState, task: TeamTaskRecord): TeamTaskRecord[] {
  const index = state.tasks.findIndex((candidate) => candidate.id === task.id);
  if (index < 0) return [...state.tasks, task];
  return state.tasks.map((candidate) => candidate.id === task.id ? task : candidate);
}
