/**
 * 团队状态的持久化层：Lead 会话日志里的全量快照 + 启动时折叠。
 *
 * 为什么落在 Lead 日志而不是独立 JSON：团队状态必须跟会话同生共死（用户删会话、
 * 软归档、分支切换都以会话为单位），而 Pi 的 `CustomEntry` 恰好是为这种「扩展
 * 私有状态」设计的——它写进会话 JSONL，但**不进 LLM 上下文**（Pi d.ts 明确），
 * 已有 `pidesktop-control` 先例。每条记录都是全量快照，读侧后写覆盖前写，
 * 因此不需要 version 迁移逻辑，坏条目丢弃也不会让会话打不开。
 *
 * 与 dsh 的差别：dsh 走 session projection（web 端全量广播）；我们只需给
 * pi-runtime 的会话快照提供成员行，任务板只在工具结果里出现，所以折叠逻辑
 * 留在 utility 进程即可。
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../shared/protocol.js";
import type { PersistedSessionEntry } from "./session-history.js";

/** Lead 日志里团队快照的 customType（CustomEntry 不进 LLM 上下文）。 */
export const TEAM_ENTRY_TYPE = "pidesktop-team";

/** 上限与超时（对齐 dsh 的默认值；wait 的上下界是模型可感知的契约）。 */
export const MAX_TEAM_MEMBERS = 16;
export const MAX_TEAM_TASKS = 256;
export const MAX_TEAM_MESSAGE_BYTES = 65_536;
export const TEAM_WAIT_MIN_MS = 10_000;
export const TEAM_WAIT_MAX_MS = 3_600_000;
export const TEAM_WAIT_DEFAULT_MS = 30_000;
/** 成员空闲这么久后释放子会话（只断开，不删文件；下次 send 冷恢复）。 */
export const TEAM_IDLE_DISPOSE_MS = 30 * 60_000;
/** spawn 等「首条 prompt 已被接受」的上限；超时按 failed 处理。 */
export const TEAM_SPAWN_START_TIMEOUT_MS = 30_000;

export type TeamMemberPhase = "provisioning" | "active" | "failed";
export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/**
 * 成员创建时冻结的编制：冷恢复不读定义文件，避免「定义被删/被改」让历史成员
 * 变样或无法复活。systemPrompt 是有效人设（不含 base 与团队身份块），上限沿用
 * 子智能体定义的 20000 字符。
 */
export interface TeamMemberConfig {
  mode: "inherit" | "subagent";
  subagentId?: string;
  subagentName?: string;
  systemPrompt: string;
  tools: string[];
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  browserTools: boolean;
  color?: string;
}

/** 一个 teammate 的持久记录。 */
export interface TeamMemberRecord {
  /** 子会话 id（Pi SessionId）。 */
  id: string;
  name: string;
  description: string;
  phase: TeamMemberPhase;
  error?: string;
  /** 子会话 JSONL 绝对路径（冷恢复入口）。 */
  sessionFile: string;
  createdAt: number;
  config: TeamMemberConfig;
}

/** 共享任务的全量快照；每次变更 revision + 1，读侧做 CAS。 */
export interface TeamTaskRecord {
  id: string;
  revision: number;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  /** 成员 id 或 Lead 的 session id。 */
  ownerId?: string;
  blockedBy: string[];
  writeScopes: string[];
}

export interface TeamState {
  members: TeamMemberRecord[];
  tasks: TeamTaskRecord[];
}

/** 日志里的一条团队快照（全量值，后写覆盖前写）。 */
export type TeamEntryData =
  | { kind: "member"; member: TeamMemberRecord }
  | { kind: "task"; task: TeamTaskRecord };

export function emptyTeamState(): TeamState {
  return { members: [], tasks: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh" || value === "max";
}

function isTeamMemberConfig(value: unknown): value is TeamMemberConfig {
  if (!isRecord(value)) return false;
  if (value.mode !== "inherit" && value.mode !== "subagent") return false;
  if (typeof value.systemPrompt !== "string") return false;
  if (stringArray(value.tools) === undefined) return false;
  if (!isRecord(value.model) || typeof value.model.provider !== "string" || typeof value.model.id !== "string") return false;
  if (!isThinkingLevel(value.thinkingLevel)) return false;
  if (typeof value.browserTools !== "boolean") return false;
  if (value.subagentId !== undefined && typeof value.subagentId !== "string") return false;
  if (value.subagentName !== undefined && typeof value.subagentName !== "string") return false;
  if (value.color !== undefined && typeof value.color !== "string") return false;
  return true;
}

/** 校验日志里的一条成员快照；坏数据丢弃（不能阻断会话打开）。 */
export function isTeamMemberRecord(value: unknown): value is TeamMemberRecord {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.description === "string"
    && (value.phase === "provisioning" || value.phase === "active" || value.phase === "failed")
    && (value.error === undefined || typeof value.error === "string")
    && typeof value.sessionFile === "string"
    && typeof value.createdAt === "number"
    && isTeamMemberConfig(value.config);
}

/** 校验日志里的一条任务快照。 */
export function isTeamTaskRecord(value: unknown): value is TeamTaskRecord {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.revision === "number"
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && typeof value.subject === "string"
    && typeof value.description === "string"
    && (value.status === "pending" || value.status === "in_progress" || value.status === "completed" || value.status === "deleted")
    && (value.ownerId === undefined || typeof value.ownerId === "string")
    && stringArray(value.blockedBy) !== undefined
    && stringArray(value.writeScopes) !== undefined;
}

/** 校验一条日志载荷并归一化为团队快照。 */
export function readTeamEntryData(value: unknown): TeamEntryData | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "member" && isTeamMemberRecord(value.member)) return { kind: "member", member: value.member };
  if (value.kind === "task" && isTeamTaskRecord(value.task)) return { kind: "task", task: value.task };
  return undefined;
}

/**
 * 从 Lead 的分支 entries 重建团队状态。后写覆盖前写（按 id），成员保持首次
 * 出现的顺序；删除的任务保留为 tombstone（id 永不复用），由视图层过滤。
 */
export function restoreTeamState(entries: readonly PersistedSessionEntry[]): TeamState {
  const members: TeamMemberRecord[] = [];
  const memberIndex = new Map<string, number>();
  const tasks: TeamTaskRecord[] = [];
  const taskIndex = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TEAM_ENTRY_TYPE) continue;
    const data = readTeamEntryData(entry.data);
    if (!data) continue;
    if (data.kind === "member") {
      const index = memberIndex.get(data.member.id);
      if (index === undefined) {
        memberIndex.set(data.member.id, members.length);
        members.push(data.member);
      } else {
        members[index] = data.member;
      }
      continue;
    }
    const index = taskIndex.get(data.task.id);
    if (index === undefined) {
      taskIndex.set(data.task.id, tasks.length);
      tasks.push(data.task);
    } else {
      tasks[index] = data.task;
    }
  }
  return { members, tasks };
}

/** 追加一条成员快照；`appendCustomEntry` 同步落盘（Lead 已有消息时）。 */
export function appendTeamMember(session: AgentSession, member: TeamMemberRecord): void {
  session.sessionManager.appendCustomEntry(TEAM_ENTRY_TYPE, { kind: "member", member } satisfies TeamEntryData);
}

/** 追加一条任务快照。 */
export function appendTeamTask(session: AgentSession, task: TeamTaskRecord): void {
  session.sessionManager.appendCustomEntry(TEAM_ENTRY_TYPE, { kind: "task", task } satisfies TeamEntryData);
}

/**
 * 启动对账：provisioning 成员只可能停在「创建中崩溃」这一种状态。子会话文件
 * 存在且已记录首条 user 消息 → 首条 prompt 已被接受，转 active；否则转 failed。
 * 名字不因失败回滚（永久占用），所以 failed 记录必须保留。
 */
export function reconcileProvisioningMember(
  member: TeamMemberRecord,
  childHasUserMessage: boolean
): TeamMemberRecord {
  if (member.phase !== "provisioning") return member;
  if (childHasUserMessage) return { ...member, phase: "active", error: undefined };
  return {
    ...member,
    phase: "failed",
    error: "团队创建未完成（应用在创建过程中退出，子会话缺少首条消息）"
  };
}
