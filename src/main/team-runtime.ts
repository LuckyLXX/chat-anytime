/**
 * 团队运行时：每个 Lead 会话一个实例，持有 roster、共享任务板、成员子会话与
 * 等待者。所有 durable 状态写在 Lead 的会话日志（`customType="pidesktop-team"`），
 * 成员子会话落在 `chatanytime-sessions/<agentId>/delegations/teams/<leadSessionId>/`
 * ——`delegations` 已被侧栏目录扫描排除，成员不会污染话题列表。
 *
 * 来自 dsh 的硬约束：
 * - roster 变更先落 `provisioning` 再建子会话，失败写 `failed`；名字永久占用。
 * - 所有 roster/task 变更串行化（Pi 一个回合内可能并行发起多个工具调用）。
 * - 重启时对账：provisioning 记录只有在子会话已记录首条 user 消息时才转 active。
 * - 消息 = 直接投递（running 在步骤边界、inactive 唤醒），成功只代表收件箱接收。
 * - 任务板 CAS；writeScopes 只告警，绝不加锁。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEventListener,
  type ModelRuntime,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentProfile, PermissionDecision, SubagentDefinition, TeamMemberActivityStep, TeamMemberSummary, TeamSnapshot, TeamTaskSummary, ThinkingLevel } from "../shared/protocol.js";
import { createChildPermissionExtension, resolveSubagentDefinition } from "./subagent.js";
import { withCacheWarmingOff } from "./runtime-settings.js";
import { createTeamTools } from "./runtime-team.js";
import type { PersistedSessionEntry } from "./session-history.js";
import {
  MAX_TEAM_MEMBERS,
  MAX_TEAM_MESSAGE_BYTES,
  TEAM_IDLE_DISPOSE_MS,
  TEAM_SPAWN_START_TIMEOUT_MS,
  TEAM_WAIT_MAX_MS,
  TEAM_WAIT_MIN_MS,
  appendTeamMember,
  appendTeamTask,
  reconcileProvisioningMember,
  restoreTeamState,
  type TeamMemberConfig,
  type TeamMemberRecord,
  type TeamState
} from "./team-store.js";
import {
  createTask,
  projectTaskView,
  updateTask,
  withTask,
  type TeamTaskCaller,
  type TeamTaskCreateInput,
  type TeamTaskMutation,
  type TeamTaskView
} from "./team-tasks.js";
import {
  TEAM_NO_ACTIVE_PEER_MESSAGE,
  teamIdentityBlock,
  type TeamListTaskFilter,
  type TeamMembership,
  type TeamMemberView,
  type TeamService,
  type TeamWaitResult
} from "./team-contract.js";

/** 子会话只需要这几个方法；收窄后单测可注入 fake，不必伪造整个 AgentSession。 */
export interface TeamChildSession {
  readonly isStreaming: boolean;
  prompt(text: string, options?: { expandPromptTemplates?: boolean; preflightResult?: (disposition: "handled" | "queued" | "started") => void }): Promise<void>;
  sendCustomMessage(
    message: { customType: string; content: { type: "text"; text: string }[]; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: AgentSessionEventListener): () => void;
  /** 只读统计；测试 fake 可以缺省。 */
  getSessionStats?(): { toolCalls: number; tokens: { total: number }; cost: number };
  getContextUsage?(): { percent: number | null } | undefined;
}

export interface TeamChildCreated {
  handle: TeamChildSession;
  sessionId: string;
  sessionFile: string;
  dispose(): void;
}

export interface TeamChildFactoryRequest {
  /** Lead 日志里为该成员预留的 SessionManager（新建或 `SessionManager.open` 冷恢复）。 */
  manager: SessionManager;
  config: TeamMemberConfig;
  name: string;
  signal?: AbortSignal;
}

export type TeamChildFactory = (request: TeamChildFactoryRequest) => Promise<TeamChildCreated>;

export interface TeamRuntimeOptions {
  leadSession: AgentSession;
  workspace: string;
  agentDir: string;
  agent: AgentProfile;
  modelRuntime: ModelRuntime;
  getThinkingLevel(): ThinkingLevel;
  getSubagentCatalog?(): SubagentDefinition[] | undefined;
  isModelEnabled?(provider: string, id: string): boolean;
  transformModel?(model: Model<Api>): Model<Api>;
  requestPermission(toolName: string, args: Record<string, unknown>, toolCallId: string): Promise<PermissionDecision>;
  buildBrowserTools?(): ToolDefinition[];
  /** 测试注入；缺省走 createAgentSession。 */
  createChildSession?: TeamChildFactory;
  now?(): number;
  /** 状态变化（成员/任务/投递）时回调，pi-runtime 据此推快照。 */
  onChange?(): void;
}

interface MemberRuntime {
  record: TeamMemberRecord;
  handle?: TeamChildSession;
  unsubscribe?: () => void;
  running: boolean;
  lastError?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  livePromise?: Promise<void>;
  /** 本运行时观察到的工具步骤（不持久化；冷恢复后从新事件重新累计）。 */
  steps: number;
  startedAt?: number;
  lastActiveAt?: number;
  currentTool?: string;
  currentDetail?: string;
  recent: TeamMemberActivityStep[];
}

const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEAM_MESSAGE_TYPE = "pidesktop-team-message";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ES2022 lib 没有 Promise.withResolvers，运行时手动建一个。 */
function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`团队成员 ${field} 不能为空`);
  if (text.length > max) throw new Error(`团队成员 ${field} 过长（最多 ${max} 字符）`);
  return text;
}

function enabledTools(agent: AgentProfile): string[] {
  return Object.entries(agent.tools ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
}

/** 把正在运行的最近步骤收口；只闭合同名/最后一条，避免乱序事件误关其他步骤。 */
function closeRunningSteps(member: MemberRuntime, status: "done" | "error" | "aborted", now: number, toolCallId?: string, durationMs?: number): void {
  for (let index = member.recent.length - 1; index >= 0; index -= 1) {
    const step = member.recent[index]!;
    if (step.status !== "running") continue;
    if (toolCallId !== undefined && step.toolCallId !== toolCallId) continue;
    member.recent[index] = {
      ...step,
      status,
      endedAt: now,
      durationMs: durationMs ?? Math.max(0, now - step.startedAt)
    };
  }
  refreshCurrentTool(member);
}

/** 并行工具调用时，当前工具取最近仍在运行的那一条，而不是简单清空。 */
function refreshCurrentTool(member: MemberRuntime): void {
  const running = [...member.recent].reverse().find((step) => step.status === "running");
  member.currentTool = running?.tool;
  member.currentDetail = running?.detail;
}

/** 工具参数的一行摘要（看板时间线用；完整参数在完整记录里）。 */
function activityDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const pick = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const text = value.replace(/\s+/gu, " ").trim();
    if (!text) return undefined;
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  };
  const path = pick(record.path);
  if (path) return path;
  const command = pick(record.command);
  if (command) return command;
  const pattern = pick(record.pattern) ?? pick(record.query);
  if (pattern) return pattern;
  const goal = pick(record.goal);
  if (goal) return goal;
  return undefined;
}

function taskNumber(id: string): number {
  const match = /^task-(\d+)$/u.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** 一个团队会话的运行时服务。实现 `TeamService`，供工具层与 pi-runtime 共用。 */
export class TeamRuntime implements TeamService {
  private readonly leadSession: AgentSession;
  private readonly teamDir: string;
  private readonly members = new Map<string, MemberRuntime>();
  private state: TeamState;
  private readonly waiters = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private snapshotCache: TeamSnapshot | undefined;
  private activityTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: TeamRuntimeOptions) {
    this.leadSession = options.leadSession;
    this.teamDir = join(options.agentDir, "chatanytime-sessions", options.agent.id, "delegations", "teams", options.leadSession.sessionId);
    const entries = options.leadSession.sessionManager.getBranch() as unknown as PersistedSessionEntry[];
    this.state = restoreTeamState(entries);
    // 启动对账：创建中崩溃的成员不能永远停在 provisioning。
    for (const member of [...this.state.members]) {
      if (member.phase !== "provisioning") continue;
      const next = reconcileProvisioningMember(member, this.childHasUserMessage(member.sessionFile));
      this.replaceMember(next);
      try {
        appendTeamMember(this.leadSession, next);
      } catch {
        // 日志是派生的：写失败不阻断会话打开，内存态仍可用。
      }
    }
    // 恢复已有成员的运行时槽位（不重新拉子会话；handle 留空，首次 send 时冷恢复）。
    // 漏掉这一步会让重启后的 active 成员在 activeMember() 里「运行时不存在」。
    for (const member of this.state.members) {
      if (!this.members.has(member.id)) this.members.set(member.id, { record: member, running: false, steps: 0, recent: [] });
    }
  }

  // ── 成员 ────────────────────────────────────────────────────────────────

  async spawn(
    membership: TeamMembership,
    params: { name: string; description: string; prompt: string; subagent?: string },
    signal?: AbortSignal
  ): Promise<TeamMemberView> {
    this.assertNotDisposed();
    this.assertLead(membership);
    let prepared: { member: TeamMemberRecord; manager: SessionManager; prompt: string } | undefined;
    let created: TeamChildCreated | undefined;
    try {
      prepared = await this.mutate(() => this.prepareSpawn(params));
      const reservation = prepared;
      created = await this.createChild({
        manager: reservation.manager,
        config: reservation.member.config,
        name: reservation.member.name,
        ...(signal === undefined ? {} : { signal })
      });
      if (!this.attach(reservation.member.id, created)) {
        created = undefined;
        throw new Error("成员会话未能挂载到团队运行时");
      }
      // 所有权已转交 member.handle；失败路径不要再 dispose 第二次。
      created = undefined;
      await this.startInitialPrompt(reservation.member.id, reservation.prompt, signal);
      await this.mutate(() => this.settleSpawn(reservation.member.id, "active"));
      return this.viewFor(reservation.member.id);
    } catch (error) {
      if (created) {
        try {
          created.dispose();
        } catch {
          // best-effort
        }
      }
      if (prepared) {
        const reservation = prepared;
        try {
          this.detach(reservation.member.id);
          await this.mutate(() => this.settleSpawn(reservation.member.id, "failed", errorText(error)));
        } catch {
          // 运行时已销毁：保持内存态，别再抛第二个错掩盖根因。
        }
      }
      throw error;
    }
  }

  list(membership: TeamMembership): TeamMemberView[] {
    this.assertMembership(membership);
    const leadModel = this.leadSession.model;
    return [
      {
        target: "lead",
        role: "lead",
        status: this.leadSession.isStreaming ? "running" : "inactive",
        ...(leadModel ? { model: `${leadModel.provider}/${leadModel.id}` } : {}),
        diagnostics: []
      },
      ...this.state.members.map((member) => this.viewFor(member.id))
    ];
  }

  async send(membership: TeamMembership, target: string, text: string, signal?: AbortSignal): Promise<{ sent: true }> {
    this.assertNotDisposed();
    this.assertMembership(membership);
    const name = String(target ?? "").trim();
    if (!name) throw new Error("team_send 需要 target（成员名或 lead）");
    if (name === membership.name) throw new Error("不能给自己发消息");
    const body = String(text ?? "");
    if (!body.trim()) throw new Error("team_send 的消息不能为空");
    if (Buffer.byteLength(body, "utf8") > MAX_TEAM_MESSAGE_BYTES) {
      throw new Error(`消息超过 ${MAX_TEAM_MESSAGE_BYTES} 字节上限`);
    }
    const senderLabel = membership.role === "lead" ? " Lead" : `团队成员「${membership.name}」`;
    if (name === "lead") {
      const delivery = this.deliverToLead(`来自${senderLabel}：\n${body}`, membership.name);
      void delivery.catch(() => undefined);
      await this.observeImmediate(delivery);
      this.notify();
      return { sent: true };
    }
    const member = this.activeMember(name);
    const handle = await this.ensureLive(member, signal);
    member.running = true;
    member.lastError = undefined;
    this.scheduleIdle(member);
    this.notify();
    // 投递只保证收件箱接收：running 在步骤边界送达，inactive 会启动/恢复一轮。
    const delivery = handle.sendCustomMessage(this.message(`来自${senderLabel}：\n${body}`, membership.name, name), {
      deliverAs: "steer",
      triggerTurn: true
    });
    void delivery.catch((error: unknown) => this.noteRunEnd(member.record.id, error));
    // 只等一个宏任务窗口：立即失败（缺模型/鉴权、目标已销毁）如实报错，正常投递
    // 不被挂到整轮结束（idle 目标会 await 完整 run）。
    await this.observeImmediate(delivery);
    return { sent: true };
  }

  async wait(membership: TeamMembership, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    this.assertNotDisposed();
    this.assertMembership(membership);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TEAM_WAIT_MIN_MS || timeoutMs > TEAM_WAIT_MAX_MS) {
      throw new Error(`timeout_ms 必须是 ${TEAM_WAIT_MIN_MS} 到 ${TEAM_WAIT_MAX_MS} 之间的整数`);
    }
    signal.throwIfAborted();
    // 活跃同伴判断与 waiter 注册必须在同一个同步区间内，否则会丢掉唯一的边。
    // 只数 teammate：Lead 不是同伴（teammate 等 Lead 没有意义，Lead 等自己更不会发生）。
    const activePeer = this.state.members.some((member) => {
      if (member.name === membership.name) return false;
      const status = this.statusOf(member, this.members.get(member.id));
      return status === "running" || status === "provisioning";
    });
    if (!activePeer) {
      return { timedOut: false, noProgress: { reason: "no-active-peer", message: TEAM_NO_ACTIVE_PEER_MESSAGE } };
    }
    const changed = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
        action();
      };
      const waiter = (): void => finish(() => resolve(true));
      const onAbort = (): void => finish(() => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error("team_wait 被中止"));
      });
      this.waiters.add(waiter);
      timer = setTimeout(() => finish(() => resolve(false)), timeoutMs);
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return { timedOut: !changed };
  }

  interrupt(membership: TeamMembership, target: string): { previousStatus: "running" | "inactive" } {
    this.assertNotDisposed();
    this.assertLead(membership);
    const name = String(target ?? "").trim();
    if (name === "lead") throw new Error("不能中断 Team Lead");
    const member = this.activeMember(name);
    if (!member.handle) return { previousStatus: "inactive" };
    const previousStatus = member.running ? "running" : "inactive";
    member.running = false;
    // Pi 的 abort 不清 steering/followUp 队列：成员重新被唤醒时仍会收到排队消息，
    // 任务归属也不因中断改变（与 dsh 的 keepInbox 语义一致）。
    void member.handle.abort().catch((error: unknown) => {
      member.lastError = errorText(error);
    });
    this.notify();
    return { previousStatus };
  }

  hasRunningMembers(): boolean {
    return [...this.members.values()].some((member) => member.running);
  }

  stopAll(): void {
    if (this.disposed) return;
    let changed = false;
    for (const member of this.members.values()) {
      if (!member.running || !member.handle) continue;
      member.running = false;
      changed = true;
      void member.handle.abort().catch((error: unknown) => {
        member.lastError = errorText(error);
      });
    }
    if (changed) this.notify();
  }

  // ── 任务板 ──────────────────────────────────────────────────────────────

  async createTask(membership: TeamMembership, input: TeamTaskCreateInput): Promise<TeamTaskView> {
    this.assertNotDisposed();
    this.assertMembership(membership);
    return await this.mutate(() => {
      const task = createTask(this.state, input);
      this.state = { ...this.state, tasks: withTask(this.state, task) };
      appendTeamTask(this.leadSession, task);
      this.notify();
      return projectTaskView(this.state, task, this.leadSession.sessionId);
    });
  }

  listTasks(membership: TeamMembership, filter: TeamListTaskFilter): { tasks: TeamTaskView[]; nextCursor?: number } {
    this.assertMembership(membership);
    const cursor = filter.cursor ?? 0;
    const limit = filter.limit ?? 50;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor 必须是非负整数");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit 必须是 1 到 100 之间的整数");
    const views = this.state.tasks
      .filter((task) => task.status !== "deleted")
      .sort((left, right) => taskNumber(left.id) - taskNumber(right.id))
      .map((task) => projectTaskView(this.state, task, this.leadSession.sessionId))
      .filter((task) =>
        (filter.status === undefined || task.status === filter.status)
        && (filter.owner === undefined || (filter.owner === "unowned" ? task.ownerName === undefined : task.ownerName === filter.owner))
        && (filter.ready === undefined || task.ready === filter.ready));
    return {
      tasks: views.slice(cursor, cursor + limit),
      ...(cursor + limit < views.length ? { nextCursor: cursor + limit } : {})
    };
  }

  getTask(membership: TeamMembership, taskId: string): TeamTaskView {
    this.assertMembership(membership);
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    return projectTaskView(this.state, task, this.leadSession.sessionId);
  }

  async updateTask(membership: TeamMembership, mutation: TeamTaskMutation): Promise<TeamTaskView> {
    this.assertNotDisposed();
    this.assertMembership(membership);
    return await this.mutate(() => {
      const next = updateTask(this.state, this.leadSession.sessionId, this.taskCaller(membership), mutation);
      this.state = { ...this.state, tasks: withTask(this.state, next) };
      appendTeamTask(this.leadSession, next);
      this.notify();
      return projectTaskView(this.state, next, this.leadSession.sessionId);
    });
  }

  // ── 渲染端快照 ──────────────────────────────────────────────────────────

  snapshot(): TeamSnapshot {
    if (this.snapshotCache) return this.snapshotCache;
    const members: TeamMemberSummary[] = this.state.members.map((record) => {
      const member = this.members.get(record.id);
      const error = record.error ?? member?.lastError;
      const stats = member?.handle?.getSessionStats?.();
      const context = member?.handle?.getContextUsage?.();
      const activity = member ? this.activityFor(member, stats, context) : undefined;
      const task = this.state.tasks.find((candidate) => candidate.ownerId === record.id && candidate.status === "in_progress")
        ?? this.state.tasks.find((candidate) => candidate.ownerId === record.id && candidate.status !== "deleted");
      return {
        name: record.name,
        status: this.statusOf(record, member),
        ...(record.description ? { description: record.description } : {}),
        ...(record.config.subagentName ? { subagent: record.config.subagentName } : {}),
        ...(record.config.color ? { color: record.config.color } : {}),
        ...(error ? { error } : {}),
        sessionId: record.id,
        sessionFile: record.sessionFile,
        model: `${record.config.model.provider}/${record.config.model.id}`,
        thinkingLevel: record.config.thinkingLevel,
        ...(task ? { taskId: task.id, taskSubject: task.subject } : {}),
        ...(activity ? { activity } : {})
      };
    });
    const tasks: TeamTaskSummary[] = [];
    for (const task of this.state.tasks) {
      if (task.status === "deleted") continue;
      const view = projectTaskView(this.state, task, this.leadSession.sessionId);
      tasks.push({
        id: view.id,
        revision: view.revision,
        subject: view.subject,
        // 上面已过滤 tombstone；类型收窄在视图里丢失，这里显式声明展示态。
        status: view.status as TeamTaskSummary["status"],
        ...(view.ownerName === undefined ? {} : { ownerName: view.ownerName }),
        blockedBy: view.blockedBy,
        writeScopes: view.writeScopes,
        ready: view.ready,
        writeScopeWarnings: view.writeScopeWarnings
      });
    }
    this.snapshotCache = { members, running: members.filter((member) => member.status === "running").length, tasks };
    return this.snapshotCache;
  }

  /** 成员的实时活动摘要；没有可展示内容时返回 undefined，避免空对象进快照。 */
  private activityFor(
    member: MemberRuntime,
    stats: { toolCalls: number; tokens: { total: number }; cost: number } | undefined,
    context: { percent: number | null } | undefined
  ): NonNullable<TeamMemberSummary["activity"]> | undefined {
    const steps = Math.max(stats?.toolCalls ?? 0, member.steps);
    const recent = member.recent;
    if (steps === 0 && recent.length === 0 && !member.startedAt && !member.currentTool) return undefined;
    return {
      steps,
      ...(member.startedAt === undefined ? {} : { startedAt: member.startedAt }),
      ...(member.lastActiveAt === undefined ? {} : { lastActiveAt: member.lastActiveAt }),
      ...(member.currentTool === undefined ? {} : { currentTool: member.currentTool }),
      ...(member.currentDetail === undefined ? {} : { currentDetail: member.currentDetail }),
      recent: recent.map((step) => ({ ...step })),
      ...(stats ? { tokens: stats.tokens.total, cost: stats.cost } : {}),
      ...(context && context.percent !== null ? { contextPercent: context.percent } : {})
    };
  }

  /** 运行时销毁：关准入、唤醒等待者、停止并断开所有成员（不删子会话文件）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = undefined;
    }
    for (const waiter of [...this.waiters]) waiter();
    this.waiters.clear();
    for (const member of this.members.values()) {
      if (member.idleTimer) clearTimeout(member.idleTimer);
      member.idleTimer = undefined;
      const handle = member.handle;
      member.handle = undefined;
      member.unsubscribe?.();
      member.unsubscribe = undefined;
      member.running = false;
      if (!handle) continue;
      // abort 可能卡在模型请求上；5s 后强制断开，别让一次退出拖住整个进程。
      const force = setTimeout(() => {
        try {
          handle.dispose();
        } catch {
          // best-effort
        }
      }, 5_000);
      force.unref?.();
      void handle.abort().catch(() => undefined).finally(() => {
        clearTimeout(force);
        try {
          handle.dispose();
        } catch {
          // best-effort
        }
      });
    }
    this.snapshotCache = undefined;
  }

  // ── 内部：创建 / 恢复 ───────────────────────────────────────────────────

  private prepareSpawn(params: { name: string; description: string; prompt: string; subagent?: string }): { member: TeamMemberRecord; manager: SessionManager; prompt: string } {
    this.assertNotDisposed();
    const name = String(params.name ?? "").trim();
    if (!MEMBER_NAME.test(name) || name.length > 64 || name === "lead") {
      throw new Error("成员名字必须是小写 kebab-case（最多 64 字符，且不能是 lead）");
    }
    if (this.state.members.some((member) => member.name === name)) {
      throw new Error(`成员名字「${name}」已被使用（含失败成员；名字永不复用）`);
    }
    if (this.state.members.length >= MAX_TEAM_MEMBERS) {
      throw new Error(`团队成员数已达上限 ${MAX_TEAM_MEMBERS}`);
    }
    const description = requiredText(params.description, "description", 200);
    const prompt = requiredText(params.prompt, "prompt", MAX_TEAM_MESSAGE_BYTES);
    // requiredText 按字符数收口；这里再按 UTF-8 字节收口，与 team_send 同口径。
    if (Buffer.byteLength(prompt, "utf8") > MAX_TEAM_MESSAGE_BYTES) {
      throw new Error(`成员首条 prompt 超过 ${MAX_TEAM_MESSAGE_BYTES} 字节上限`);
    }
    const config = this.configFor(name, params.subagent);
    const id = randomUUID();
    const manager = SessionManager.create(this.options.workspace, this.teamDir, {
      id,
      parentSession: this.leadSession.sessionId
    });
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("无法为团队成员创建会话文件");
    const member: TeamMemberRecord = {
      id,
      name,
      description,
      phase: "provisioning",
      sessionFile,
      createdAt: this.now(),
      config
    };
    this.replaceMember(member);
    appendTeamMember(this.leadSession, member);
    this.notify();
    return { member, manager, prompt };
  }

  private settleSpawn(memberId: string, phase: "active" | "failed", error?: string): void {
    this.assertNotDisposed();
    const member = this.members.get(memberId);
    if (!member) return;
    if (member.record.phase === "failed" && phase === "active") return;
    const record: TeamMemberRecord = phase === "active"
      ? { ...member.record, phase, error: undefined }
      : { ...member.record, phase, error: error ?? "成员创建失败" };
    this.replaceMember(record);
    appendTeamMember(this.leadSession, record);
    if (phase === "failed") {
      this.detach(memberId);
      member.running = false;
    }
    this.notify();
  }

  private async startInitialPrompt(memberId: string, prompt: string, signal?: AbortSignal): Promise<void> {
    const member = this.members.get(memberId);
    const handle = member?.handle;
    if (!member || !handle) throw new Error("成员会话尚未就绪");
    const started = createDeferred();
    let settled = false;
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      started.resolve();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      started.reject(error instanceof Error ? error : new Error(String(error)));
    };
    member.running = true;
    member.lastError = undefined;
    this.notify();
    const run = handle.prompt(prompt, {
      expandPromptTemplates: false,
      preflightResult: (disposition) => {
        if (disposition === "handled") fail(new Error("成员首条 prompt 被扩展命令拦截"));
        else succeed();
      }
    });
    void run.catch((error: unknown) => {
      fail(error);
      this.noteRunEnd(memberId, error);
    });
    const timer = setTimeout(() => {
      fail(new Error(`成员首条 prompt 未在 ${TEAM_SPAWN_START_TIMEOUT_MS / 1000}s 内启动`));
    }, TEAM_SPAWN_START_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = (): void => fail(new Error("团队创建被中止"));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      await started.promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async ensureLive(member: MemberRuntime, signal?: AbortSignal): Promise<TeamChildSession> {
    this.assertNotDisposed();
    if (member.handle) return member.handle;
    if (member.livePromise) {
      await member.livePromise;
      if (member.handle) return member.handle;
      throw new Error(`成员「${member.record.name}」的会话未能恢复`);
    }
    member.livePromise = (async () => {
      if (!existsSync(member.record.sessionFile)) {
        throw new Error(`成员「${member.record.name}」的会话文件不存在，无法冷恢复`);
      }
      const manager = SessionManager.open(member.record.sessionFile, this.teamDir);
      const created = await this.createChild({
        manager,
        config: member.record.config,
        name: member.record.name,
        ...(signal === undefined ? {} : { signal })
      });
      if (!this.attach(member.record.id, created)) throw new Error("成员会话未能挂载到团队运行时");
    })();
    try {
      await member.livePromise;
    } catch (error) {
      member.lastError = errorText(error);
      this.notify();
      throw error;
    } finally {
      member.livePromise = undefined;
    }
    if (!member.handle) throw new Error(`成员「${member.record.name}」的会话未能恢复`);
    return member.handle;
  }

  /** 把子会话挂到成员上；运行时已销毁/成员不存在时由本方法负责 dispose 并返回 false。 */
  private attach(memberId: string, created: TeamChildCreated): boolean {
    if (this.disposed) {
      created.dispose();
      return false;
    }
    const member = this.members.get(memberId);
    if (!member) {
      created.dispose();
      return false;
    }
    member.handle = created.handle;
    if (created.sessionFile && created.sessionFile !== member.record.sessionFile) {
      this.replaceMember({ ...member.record, sessionFile: created.sessionFile });
    }
    member.unsubscribe = created.handle.subscribe((event) => {
      const now = Date.now();
      if (event.type === "agent_settled") {
        member.running = false;
        closeRunningSteps(member, event.aborted ? "aborted" : "done", now);
        this.notify();
        this.scheduleIdle(member);
        return;
      }
      if (event.type === "agent_start") {
        member.running = true;
        member.startedAt = now;
        member.lastActiveAt = now;
        this.notifyActivity();
        return;
      }
      if (event.type === "tool_execution_start") {
        const detail = activityDetail(event.args);
        const step: TeamMemberActivityStep = {
          tool: event.toolName,
          status: "running",
          startedAt: now,
          toolCallId: event.toolCallId,
          ...(detail ? { detail } : {}),
        };
        member.recent = [...member.recent, step].slice(-8);
        member.steps += 1;
        member.currentTool = event.toolName;
        member.currentDetail = detail;
        member.lastActiveAt = now;
        this.scheduleIdle(member);
        this.notifyActivity();
        return;
      }
      if (event.type === "tool_execution_end") {
        closeRunningSteps(member, event.isError ? "error" : "done", now, event.toolCallId, event.durationMs);
        member.lastActiveAt = now;
        this.notifyActivity();
        return;
      }
      if (event.type === "message_end") this.notifyActivity();
    });
    this.scheduleIdle(member);
    return true;
  }

  private detach(memberId: string): void {
    const member = this.members.get(memberId);
    if (!member) return;
    if (member.idleTimer) clearTimeout(member.idleTimer);
    member.idleTimer = undefined;
    const handle = member.handle;
    member.handle = undefined;
    member.unsubscribe?.();
    member.unsubscribe = undefined;
    if (handle) {
      try {
        handle.dispose();
      } catch {
        // best-effort
      }
    }
  }

  private scheduleIdle(member: MemberRuntime): void {
    if (member.idleTimer) clearTimeout(member.idleTimer);
    const timer = setTimeout(() => {
      member.idleTimer = undefined;
      if (this.disposed || member.running || !member.handle) return;
      const handle = member.handle;
      member.handle = undefined;
      member.unsubscribe?.();
      member.unsubscribe = undefined;
      try {
        handle.dispose();
      } catch {
        // best-effort
      }
      this.notify();
    }, TEAM_IDLE_DISPOSE_MS);
    timer.unref?.();
    member.idleTimer = timer;
  }

  private noteRunEnd(memberId: string, error?: unknown): void {
    const member = this.members.get(memberId);
    if (!member) return;
    member.running = false;
    if (error !== undefined) member.lastError = errorText(error);
    this.notify();
    this.scheduleIdle(member);
  }

  // ── 内部：编制 / 子会话工厂 ─────────────────────────────────────────────

  private configFor(name: string, subagentKey: string | undefined): TeamMemberConfig {
    const leadModel = this.leadSession.model
      ? { provider: this.leadSession.model.provider, id: this.leadSession.model.id }
      : undefined;
    const fallbackThinking = this.options.getThinkingLevel();
    if (subagentKey === undefined || !subagentKey.trim()) {
      if (!leadModel) throw new Error("Lead 会话没有可用模型，无法创建成员");
      return {
        mode: "inherit",
        systemPrompt: this.options.agent.systemPrompt ?? "",
        tools: enabledTools(this.options.agent),
        model: leadModel,
        thinkingLevel: fallbackThinking,
        browserTools: false
      };
    }
    const catalog = this.options.getSubagentCatalog?.() ?? [];
    const definition = resolveSubagentDefinition(catalog, subagentKey.trim());
    if (!definition) {
      const available = catalog.length > 0 ? catalog.map((entry) => entry.name).join("、") : "（当前没有可用的子智能体定义）";
      throw new Error(`没有名为「${subagentKey}」的子智能体定义；可用：${available}`);
    }
    const tools = definition.tools === "inherit" ? enabledTools(this.options.agent) : Object.entries(definition.tools).filter(([, enabled]) => enabled).map(([tool]) => tool);
    const requested = definition.model ?? leadModel;
    if (!requested) throw new Error("Lead 会话没有可用模型，无法创建成员");
    const model = this.options.isModelEnabled && !this.options.isModelEnabled(requested.provider, requested.id) && leadModel
      ? leadModel
      : requested;
    return {
      mode: "subagent",
      subagentId: definition.id,
      subagentName: definition.name,
      systemPrompt: [definition.systemPrompt, definition.injectAgentsMd ? "请阅读并遵循当前工作区的 AGENTS.md。" : null]
        .filter((part): part is string => Boolean(part))
        .join("\n\n"),
      tools,
      model,
      thinkingLevel: definition.thinkingLevel ?? fallbackThinking,
      browserTools: definition.browserTools === true,
      ...(definition.color ? { color: definition.color } : {})
    };
  }

  private async createChild(request: TeamChildFactoryRequest): Promise<TeamChildCreated> {
    if (this.options.createChildSession) return await this.options.createChildSession(request);
    return await this.defaultCreateChild(request);
  }

  private async defaultCreateChild(request: TeamChildFactoryRequest): Promise<TeamChildCreated> {
    request.signal?.throwIfAborted();
    const settingsManager = withCacheWarmingOff(SettingsManager.create(this.options.workspace, this.options.agentDir));
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.workspace,
      agentDir: this.options.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createChildPermissionExtension(this.options.requestPermission, "用户已在 PiDesktop 中拒绝该团队成员操作")],
      systemPromptOverride: (base) => [base, request.config.systemPrompt, teamIdentityBlock(request.name)].filter(Boolean).join("\n\n")
    });
    await resourceLoader.reload();
    const teamTools = createTeamTools(this, { role: "teammate", name: request.name });
    const browserTools = request.config.browserTools && this.options.buildBrowserTools ? this.options.buildBrowserTools() : [];
    const model = this.resolveModel(request.config.model);
    const { session } = await createAgentSession({
      cwd: this.options.workspace,
      modelRuntime: this.options.modelRuntime,
      model,
      thinkingLevel: request.config.thinkingLevel,
      sessionManager: request.manager,
      settingsManager,
      resourceLoader,
      customTools: [...teamTools, ...browserTools]
    });
    await session.bindExtensions({ onError: () => { /* 权限扩展的错误已由 broker 记录 */ } });
    session.setActiveToolsByName([
      ...request.config.tools,
      ...teamTools.map((tool) => tool.name),
      ...browserTools.map((tool) => tool.name)
    ]);
    return {
      handle: session as unknown as TeamChildSession,
      sessionId: session.sessionId,
      sessionFile: request.manager.getSessionFile() ?? "",
      dispose: () => session.dispose()
    };
  }

  private resolveModel(target: { provider: string; id: string }): Model<Api> {
    const model = this.options.modelRuntime.getModel(target.provider, target.id);
    if (!model) throw new Error(`成员模型不可用：${target.provider}/${target.id}`);
    return this.options.transformModel ? this.options.transformModel(model) : model;
  }

  // ── 内部：查询 / 校验 / 通知 ────────────────────────────────────────────

  private viewFor(memberId: string): TeamMemberView {
    const member = this.members.get(memberId);
    const record = member?.record ?? this.state.members.find((candidate) => candidate.id === memberId);
    if (!record) throw new Error(`成员不存在：${memberId}`);
    const memberRuntime = this.members.get(memberId);
    const diagnostics = [record.error, memberRuntime?.lastError].filter((item): item is string => Boolean(item));
    return {
      target: record.name,
      role: "teammate",
      status: this.statusOf(record, memberRuntime),
      ...(record.description ? { description: record.description } : {}),
      ...(record.config.subagentName ? { subagent: record.config.subagentName } : {}),
      model: `${record.config.model.provider}/${record.config.model.id}`,
      diagnostics
    };
  }

  private statusOf(record: TeamMemberRecord, member: MemberRuntime | undefined): TeamMemberSummary["status"] {
    if (record.phase === "failed") return "failed";
    if (record.phase === "provisioning") return "provisioning";
    return member?.running ? "running" : "inactive";
  }

  private activeMember(name: string): MemberRuntime {
    const record = this.state.members.find((member) => member.name === name && member.phase === "active");
    if (!record) throw new Error(`找不到可用成员「${name}」；用 team_list 查看成员状态`);
    const member = this.members.get(record.id);
    if (!member) throw new Error(`成员「${name}」的运行时不存在`);
    return member;
  }

  private taskCaller(membership: TeamMembership): TeamTaskCaller {
    if (membership.role === "lead") return { id: this.leadSession.sessionId, role: "lead", name: "lead" };
    const record = this.state.members.find((member) => member.name === membership.name);
    if (!record) throw new Error(`「${membership.name}」不是当前团队成员`);
    return { id: record.id, role: "teammate", name: membership.name };
  }

  private assertMembership(membership: TeamMembership): void {
    if (membership.role === "lead") {
      if (membership.name !== "lead") throw new Error("Team Lead 身份不匹配");
      return;
    }
    const record = this.state.members.find((member) => member.name === membership.name
      && (member.phase === "active" || member.phase === "provisioning"));
    if (!record) throw new Error(`「${membership.name}」不是当前团队成员`);
  }

  private assertLead(membership: TeamMembership): void {
    if (membership.role !== "lead" || membership.name !== "lead") throw new Error("只有 Team Lead 可以执行该操作");
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("团队运行时已销毁");
  }

  private deliverToLead(text: string, sender: string): Promise<void> {
    // Lead 正在跑：在步骤边界投递；Lead 空闲：只入历史、不自动起回合（用户决策：
    // 成员的消息等 Lead 下一次运行再消费，避免后台成员凭空触发付费回合）。
    const streaming = this.leadSession.isStreaming;
    return this.leadSession.sendCustomMessage(this.message(text, sender, "lead"), streaming
      ? { deliverAs: "steer", triggerTurn: true }
      : { triggerTurn: false });
  }

  /** 只等一个宏任务窗口来暴露「立刻失败」，不等待一整轮 run。 */
  private async observeImmediate(delivery: Promise<unknown>): Promise<void> {
    const timer = new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, 0);
      handle.unref?.();
    });
    await Promise.race([delivery, timer]);
  }

  private message(text: string, sender: string, target: string): { customType: string; content: { type: "text"; text: string }[]; display: boolean; details: unknown } {
    return {
      customType: TEAM_MESSAGE_TYPE,
      content: [{ type: "text", text }],
      display: true,
      details: { sender, target }
    };
  }

  private replaceMember(record: TeamMemberRecord): void {
    const index = this.state.members.findIndex((member) => member.id === record.id);
    this.state = index < 0
      ? { ...this.state, members: [...this.state.members, record] }
      : { ...this.state, members: this.state.members.map((member) => member.id === record.id ? record : member) };
    const runtime = this.members.get(record.id);
    if (runtime) runtime.record = record;
    else this.members.set(record.id, { record, running: false, steps: 0, recent: [] });
  }

  private childHasUserMessage(path: string): boolean {
    try {
      if (!existsSync(path)) return false;
      // 子会话是刚创建的，正常只有几十 KB；异常大文件按「已接受」处理，别让启动
      // 被一次 8MB+ 的同步读拖住（真到了这个体量也早已不是本次创建的窗口）。
      if (statSync(path).size > 8 * 1024 * 1024) return true;
      const text = readFileSync(path, "utf8");
      return text.includes('"role":"user"');
    } catch {
      return false;
    }
  }

  /** 活动帧（工具开始/结束、消息完成）只刷新看板，不唤醒 team_wait。 */
  private notifyActivity(): void {
    if (this.disposed) return;
    this.snapshotCache = undefined;
    if (this.activityTimer) return;
    const timer = setTimeout(() => {
      this.activityTimer = undefined;
      if (!this.disposed) this.options.onChange?.();
    }, 120);
    timer.unref?.();
    this.activityTimer = timer;
  }

  private notify(): void {
    if (this.disposed) return;
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = undefined;
    }
    this.snapshotCache = undefined;
    for (const waiter of [...this.waiters]) waiter();
    this.options.onChange?.();
  }

  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
