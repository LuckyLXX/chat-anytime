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

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AccessMode, ThinkingLevel, TeamMemberSettlement } from "../shared/protocol.js";
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
/** 成员的运行来源：`inherit`/`subagent` 是 Pi 子会话，`codex` 是外部 Codex App Server。 */
export type TeamMemberBackend = "pi" | "codex";
export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/**
 * 成员创建时冻结的编制：冷恢复不读定义文件，避免「定义被删/被改」让历史成员
 * 变样或无法复活。systemPrompt 是有效人设（不含 base 与团队身份块），上限沿用
 * 子智能体定义的 20000 字符。
 */
/**
 * Codex 成员的编制（冻结）。thread id 不在这里：它在回合之间会变（首次创建/冷恢复），
 * 单独原子落成员目录（见 `writeCodexThreadBinding`），成员编制保持不可变。
 */
export interface TeamCodexMemberConfig {
  /** 创建时冻结的可执行文件（用户换 CLI 后旧成员仍用这条；失效时给出具体原因）。 */
  executable: string;
  /** 首版冻结的访问上限；C 阶段逐轮与 Lead 当前模式取严。 */
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "never" | "on-request";
  /** 用户选的 Codex 模型；缺省 = 用本机 Codex 配置的模型。 */
  model?: string;
  /** 探测到的 CLI 版本（展示/诊断用）。 */
  version?: string;
}

export interface TeamMemberConfig {
  /**
   * `inherit` / `subagent` = Pi 子会话（旧记录的读法完全不变）；`codex` = 外部运行时，
   * 不要求虚构的 Pi provider/model。
   */
  mode: "inherit" | "subagent" | "codex";
  subagentId?: string;
  subagentName?: string;
  systemPrompt: string;
  tools: string[];
  /** Codex 成员没有 Pi 模型（只有 `codex.model` / 本机配置）。 */
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  browserTools: boolean;
  color?: string;
  /**
   * 成员的**可选**权限上限（与 Lead 当前访问模式逐次取严）。缺省 = 不设上限，
   * 沿用原会话访问策略（存量成员零变化）；值在创建时冻结，冷恢复沿用同一条。
   */
  accessModeCap?: AccessMode;
  /** `mode: "codex"` 时的 Codex 编制。 */
  codex?: TeamCodexMemberConfig;
}

/** 成员的运行来源（旧记录没有 mode/codex 之外的信息 → 一律按 Pi 读）。 */
export function backendOfMemberConfig(config: TeamMemberConfig): TeamMemberBackend {
  return config.mode === "codex" ? "codex" : "pi";
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
  | { kind: "task"; task: TeamTaskRecord }
  /** 成员回合结算：只进会话日志（不进 LLM 上下文），供重启后回看「上一回合怎么结束的」。 */
  | { kind: "settled"; settlement: TeamMemberSettlement };

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

function isModelRef(value: unknown): value is { provider: string; id: string } {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";
}

function isTeamCodexMemberConfig(value: unknown): value is TeamCodexMemberConfig {
  if (!isRecord(value)) return false;
  if (typeof value.executable !== "string" || !value.executable) return false;
  if (value.sandbox !== "read-only" && value.sandbox !== "workspace-write") return false;
  if (value.approvalPolicy !== "never" && value.approvalPolicy !== "on-request") return false;
  if (value.model !== undefined && typeof value.model !== "string") return false;
  if (value.version !== undefined && typeof value.version !== "string") return false;
  return true;
}

function isTeamMemberConfig(value: unknown): value is TeamMemberConfig {
  if (!isRecord(value)) return false;
  if (value.mode !== "inherit" && value.mode !== "subagent" && value.mode !== "codex") return false;
  if (typeof value.systemPrompt !== "string") return false;
  if (stringArray(value.tools) === undefined) return false;
  if (value.mode === "codex") {
    // Codex 成员不要求 Pi 的 provider/model；model 若出现仍要合法（导出/迁移时容错）。
    if (!isTeamCodexMemberConfig(value.codex)) return false;
    if (value.model !== undefined && !isModelRef(value.model)) return false;
  } else if (!isModelRef(value.model)) {
    return false;
  }
  if (!isThinkingLevel(value.thinkingLevel)) return false;
  if (typeof value.browserTools !== "boolean") return false;
  if (value.subagentId !== undefined && typeof value.subagentId !== "string") return false;
  if (value.subagentName !== undefined && typeof value.subagentName !== "string") return false;
  if (value.color !== undefined && typeof value.color !== "string") return false;
  if (value.accessModeCap !== undefined
    && value.accessModeCap !== "read-only" && value.accessModeCap !== "ask"
    && value.accessModeCap !== "workspace" && value.accessModeCap !== "full") return false;
  if (value.mode === "codex" && value.accessModeCap !== undefined) return false;
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

/** 校验日志里的一条回合结算。 */
export function isTeamSettlement(value: unknown): value is TeamMemberSettlement {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.memberName !== "string") return false;
  if (value.outcome !== "completed" && value.outcome !== "failed" && value.outcome !== "aborted") return false;
  if (typeof value.reported !== "boolean" || typeof value.at !== "number") return false;
  if (value.summary !== undefined && typeof value.summary !== "string") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (stringArray(value.taskIds) === undefined || stringArray(value.artifacts) === undefined) return false;
  if (value.blocker !== undefined) {
    const blocker = value.blocker;
    if (!isRecord(blocker)) return false;
    if (blocker.kind !== "permission-denied" && blocker.kind !== "permission-mode"
      && blocker.kind !== "permission-timeout" && blocker.kind !== "permission-pending") return false;
    if (typeof blocker.toolName !== "string" || typeof blocker.summary !== "string") return false;
  }
  return true;
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
  if (value.kind === "settled" && isTeamSettlement(value.settlement)) return { kind: "settled", settlement: value.settlement };
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
    if (data.kind === "settled") continue; // 结算只回看，不重建成员/任务状态
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

/** 追加一条回合结算（Lead 的既有持久化路径：CustomEntry 不进 LLM 上下文）。 */
export function appendTeamSettlement(session: AgentSession, settlement: TeamMemberSettlement): void {
  session.sessionManager.appendCustomEntry(TEAM_ENTRY_TYPE, { kind: "settled", settlement } satisfies TeamEntryData);
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

/**
 * Codex 线程绑定文件（成员目录内，与成员转写并列）。
 *
 * 为什么单独落盘而不是写进 Lead 的会话日志：thread id 是**成员级的运行时事实**，
 * 与成员目录同生共死（删会话/删团队目录时一并清掉）；写进 Lead 日志会让一个本该
 * 只在 Codex 侧存在的 id 进入团队的全量快照。
 */
export interface CodexThreadBinding {
  memberId: string;
  memberName: string;
  /** 绑定创建时的工作区；工作区变了的旧绑定不再复用（否则会把两个项目混进同一线程）。 */
  workspace: string;
  threadId: string;
  /** Codex 线程实际使用的 cwd。 */
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  updatedAt: number;
}

export function codexThreadBindingPath(memberDir: string, memberId: string): string {
  return join(memberDir, `${memberId}.codex-thread.json`);
}

function isCodexThreadBinding(value: unknown): value is CodexThreadBinding {
  if (!isRecord(value)) return false;
  return typeof value.memberId === "string"
    && typeof value.memberName === "string"
    && typeof value.workspace === "string"
    && typeof value.threadId === "string"
    && value.threadId.length > 0
    && typeof value.cwd === "string"
    && (value.sandbox === "read-only" || value.sandbox === "workspace-write")
    && typeof value.updatedAt === "number";
}

/** 读回线程绑定；文件缺失/损坏/成员或工作区不符时返回 undefined（调用方按新线程处理）。 */
export function readCodexThreadBinding(path: string, expected: { memberId: string; workspace: string }): CodexThreadBinding | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isCodexThreadBinding(parsed)) return undefined;
    if (parsed.memberId !== expected.memberId || parsed.workspace !== expected.workspace) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 原子写线程绑定（同目录 tmp + rename；半截文件永远不会被读到）。 */
export function writeCodexThreadBinding(path: string, binding: CodexThreadBinding): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}
`, "utf8");
  renameSync(temporary, path);
}
