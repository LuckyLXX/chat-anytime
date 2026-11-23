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
import { isAbsolute, join, relative } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ModelRuntime,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AccessMode, AgentProfile, PermissionDecision, SubagentDefinition, TeamLeadSummary, TeamMemberActivityStep, TeamMemberBlocker, TeamMemberReport, TeamMemberSettlement, TeamMemberSummary, TeamMessageSummary, TeamSnapshot, TeamTaskSummary, ThinkingLevel } from "../shared/protocol.js";
import type { PermissionSettlement } from "./permission-broker.js";
import { createChildPermissionExtension, resolveSubagentDefinition } from "./subagent.js";
import { withCacheWarmingOff } from "./runtime-settings.js";
import { createTeamTools } from "./runtime-team.js";
import type { PersistedSessionEntry } from "./session-history.js";
import {
  MAX_TEAM_MEMBERS,
  TEAM_ENTRY_TYPE,
  MAX_TEAM_MESSAGE_BYTES,
  TEAM_IDLE_DISPOSE_MS,
  TEAM_SPAWN_START_TIMEOUT_MS,
  TEAM_WAIT_MAX_MS,
  TEAM_WAIT_MIN_MS,
  appendTeamMember,
  appendTeamSettlement,
  appendTeamTask,
  backendOfMemberConfig,
  reconcileProvisioningMember,
  restoreTeamState,
  type TeamMemberConfig,
  type TeamMemberRecord,
  type TeamState
} from "./team-store.js";
import {
  createTask,
  ownerNameOf,
  projectTaskView,
  taskReady,
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
  type TeamBackendView,
  type TeamListTaskFilter,
  type TeamMembership,
  type TeamMemberIdentity,
  type TeamMemberView,
  type TeamPermissionHooks,
  type TeamPermissionNotice,
  type TeamService,
  type TeamStopResult,
  type TeamWaitResult
} from "./team-contract.js";

/**
 * 子会话可选的**窄失败事件契约**。
 *
 * Pi 的 `agent_settled` 只有一个 `aborted` 布尔：模型报错与正常结束在它眼里是同一件事
 * （错误只体现在 assistant 消息里）。外部运行时（Codex）的 `turn/completed` 会明确给出
 * `failed`，把它翻译成 `agent_settled` 会被结算成「已完成」——所以失败要单独一条事件。
 * Pi 子会话从不发这条事件，旧分支零变化。
 */
export interface TeamChildRunFailedEvent {
  type: "pidesktop_run_failed";
  error: string;
  /** true = 停止/中止导致的失败（按「已中止」结算，不算成员的错）。 */
  aborted?: boolean;
}

export type TeamChildEvent = AgentSessionEvent | TeamChildRunFailedEvent;
export type TeamChildListener = (event: TeamChildEvent) => void;

/** 子会话只需要这几个方法；收窄后单测可注入 fake，不必伪造整个 AgentSession。 */
export interface TeamChildSession {
  readonly isStreaming: boolean;
  prompt(text: string, options?: { expandPromptTemplates?: boolean; preflightResult?: (disposition: "handled" | "queued" | "started") => void }): Promise<void>;
  sendCustomMessage(
    message: { customType: string; content: { type: "text"; text: string }[]; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ): Promise<void>;
  abort(): Promise<void>;
  /** 停止时清掉排队指令（Pi 的 abort 不清 steering/followUp）；旧会话没有此方法时跳过。 */
  clearQueue?(): void;
  dispose(): void;
  subscribe(listener: TeamChildListener): () => void;
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

/**
 * 外部运行时后端（首版只有 Codex）的可用性投影。
 *
 * `available=false` 时 `team_spawn backend:"codex"` 直接拒绝（不占成员名）；
 * `access` 是**这个后端当前被允许的上限**——读写能力还必须同时满足 C 阶段的逐轮策略。
 */
export interface TeamCodexBackendAvailability {
  available: boolean;
  version?: string;
  reason?: string;
  /** 已解析的可执行文件（预检通过时给出；写进成员编制冻结下来）。 */
  executable?: string;
  access: "read-only" | "workspace-write";
}

/** 为一个 Codex 成员建子会话（首次 thread/start、冷恢复 thread/resume）。 */
export interface TeamCodexChildRequest {
  memberId: string;
  memberName: string;
  workspace: string;
  /** 团队目录（成员转写与 thread 绑定都在这下面，随会话删除一并清理）。 */
  memberDir: string;
  /** 成员的 SessionManager（Codex 也写兼容的 user/assistant 条目）。 */
  manager: SessionManager;
  config: TeamMemberConfig;
  signal?: AbortSignal;
}

export interface TeamCodexBackend {
  availability(): TeamCodexBackendAvailability;
  createChild(request: TeamCodexChildRequest): Promise<TeamChildCreated>;
}

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
  /**
   * 成员请求权限：身份（Lead 会话 + 不可复用的成员 id/名字）与回调由运行时注入，
   * 实现侧（pi-runtime）负责挂到共享权限门上——按成员隔离长期授权、按成员取消、
   * 以 10 分钟兜底超时自动拒绝。
   */
  requestPermission(toolName: string, args: Record<string, unknown>, toolCallId: string, member: TeamMemberIdentity, hooks: TeamPermissionHooks): Promise<PermissionDecision>;
  /** 停止某成员时取消它的待决权限与长期授权（pi-runtime 接到共享 broker）。 */
  cancelMemberPermissions?(memberId: string): void;
  buildBrowserTools?(): ToolDefinition[];
  /** 测试注入；缺省走 createAgentSession。 */
  createChildSession?: TeamChildFactory;
  /**
   * 外部运行时（Codex）：缺省未接入 → `team_spawn backend:"codex"` 报明确原因；
   * `team_list` 的 backends 为空（零提示词成本）。
   */
  codex?: TeamCodexBackend;
  now?(): number;
  /** 状态变化（成员/任务/投递）时回调，pi-runtime 据此推快照。 */
  onChange?(): void;
  /** 设置关闭接入 / 权限收紧主动停掉的 Codex 成员（诊断日志用；缺省静默）。 */
  onCodexMemberStopped?(memberName: string, reason: string): void;
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
  /** 最后一条 assistant 文本（「最新回报」，仅本次运行）。 */
  lastReport?: TeamMemberReport;
  /** 停止已受理、等待 agent_settled 或资源回收（状态显示「正在停止」，不谎报已停止）。 */
  stopping: boolean;
  /** 已结算的回合数（结算 id 的后半段）。 */
  turnSeq: number;
  /** 当前回合；agent_start 开、agent_settled 结算。 */
  turn?: MemberTurn;
  /** 最近一个回合的结算（进快照与 team_list）。 */
  settlement?: TeamMemberSettlement;
  /** 当前显式绑定的执行任务（同一时间只绑一个；见 bindTask）。 */
  taskBinding?: string;
  /** 停止看门狗：settled 迟迟不来时兜底收口。 */
  stopTimer?: ReturnType<typeof setTimeout>;
}

/** 一个成员回合的记账：结算时一次性收口，平时只累计。 */
interface MemberTurn {
  id: string;
  startedAt: number;
  /** 本回合 write/edit 写出（或结论里明确提到）的工作区相对路径。 */
  artifacts: Set<string>;
  /** 本回合是否已主动 team_send 给 Lead（正文去重依据，回合结果照常提供）。 */
  reportedToLead: boolean;
  /** 本回合最后一条 assistant 文本（截断后进结算）。 */
  lastReport?: string;
  /** 卡点：权限被拒 / 模式拦截 / 等审批超时。 */
  blocker?: TeamMemberBlocker;
  /** 正在等审批的请求（id → 摘要），停止时逐条取消。 */
  pending: Map<string, TeamPermissionNotice>;
}

const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEAM_MESSAGE_TYPE = "pidesktop-team-message";
/** 通讯记录只留最近 80 条；单条截 400 字符——快照每帧都会带，不能无限长。 */
const TEAM_LOG_LIMIT = 80;
const TEAM_LOG_TEXT_LIMIT = 400;
/** Lead 统计要遍历整条会话日志，活动期快照约 8 次/秒 ⇒ 最多每秒重算一次。 */
const LEAD_STATS_TTL_MS = 1_000;
/** 结算里最多带 8 个产物引用（快照与工具回执都按帧带，不能无限长）。 */
const SETTLEMENT_ARTIFACT_LIMIT = 8;
/** 停止受理后的收尾看门狗：abort 卡住或 settled 丢失时强制收口（不谎报永久「正在停止」）。 */
const TEAM_STOP_SETTLE_TIMEOUT_MS = 30_000;
/** 待被 Lead 消费的结算环形缓冲上限（超出丢最老；持久化副本仍在 Lead 日志里）。 */
const SETTLEMENT_QUEUE_LIMIT = 50;

/** 取 assistant 消息里的可读文本（忽略 thinking / tool 块），折叠空白。 */
function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant") return "";
  const content = record.content;
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map((block) => {
          if (!block || typeof block !== "object") return "";
          const item = block as { type?: unknown; text?: unknown };
          return item.type === "text" && typeof item.text === "string" ? item.text : "";
        })
        .filter(Boolean)
        .join("\n")
      : "";
  return raw.replace(/\s+/gu, " ").trim();
}

function clipTeamText(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > TEAM_LOG_TEXT_LIMIT ? `${compact.slice(0, TEAM_LOG_TEXT_LIMIT - 1)}…` : compact;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 卡点原因的中文短句（结算正文与工具回执共用）。 */
function blockerCauseLabel(kind: TeamMemberBlocker["kind"]): string {
  switch (kind) {
    case "permission-denied": return "用户拒绝";
    case "permission-mode": return "访问模式拦截";
    case "permission-timeout": return "等待审批超时";
    case "permission-pending": return "仍在等待审批";
  }
}

/**
 * 从成员结论里抽出「明确提到的产物引用」：只认带扩展名的路径片段，最多 8 个。
 * 不做模糊匹配——结算里的产物是要交给下一个成员直接复用的，宁可少给也不错给。
 */
function mentionedArtifacts(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s`("'（\[:：])((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`)"'），。；:：、\]])/gu)) {
    const value = match[1]!;
    if (value.length > 240) continue;
    if (/^(?:https?|file):/u.test(value)) continue;
    found.add(value);
    if (found.size >= SETTLEMENT_ARTIFACT_LIMIT) break;
  }
  return [...found];
}

/** Lead 收件箱里的结算正文：结论 / 任务 / 产物 / 卡点各一行，模型可直接照做。 */
function settlementText(settlement: TeamMemberSettlement): string {
  const lines = [`成员「${settlement.memberName}」回合结束：${settlement.outcome === "completed" ? "已完成" : settlement.outcome === "failed" ? "失败" : "已中止"}`];
  if (settlement.summary) lines.push(`结论：${settlement.summary}`);
  if (settlement.error) lines.push(`错误：${settlement.error}`);
  if (settlement.taskIds.length > 0) lines.push(`任务：${settlement.taskIds.join("、")}`);
  if (settlement.artifacts.length > 0) lines.push(`产物：${settlement.artifacts.join("、")}`);
  if (settlement.blocker) lines.push(`卡点：${blockerCauseLabel(settlement.blocker.kind)}（${settlement.blocker.summary}）`);
  if (settlement.reported) lines.push("（该回合已主动汇报过，此处只补回合结果）");
  return lines.join("\n");
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
  private readonly waiters = new Set<(input?: "user") => void>();
  private readonly userWaiters = new Set<(input?: "user") => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private snapshotCache: TeamSnapshot | undefined;
  private activityTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private messages: TeamMessageSummary[] = [];
  private messageSeq = 0;
  /** 待 Lead 消费的结算队列（有界；持久副本在 Lead 日志里）。 */
  private pendingSettlements: Array<{ seq: number; settlement: TeamMemberSettlement }> = [];
  private settlementSeq = 0;
  /** 每个调用者已消费到的结算序号（team_wait 不重复返回同一旧事件）。 */
  private readonly settlementCursor = new Map<string, number>();
  private leadStatsCache?: {
    at: number;
    stats: { toolCalls: number; tokens: { total: number }; cost: number } | undefined;
    context: { percent: number | null } | undefined;
  };

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
    // 回合号从 Lead 日志里的既有结算恢复：结算 id 是「成员id:回合号」，只从 1 起
    // 数会跨重启重复（历史结算与新的混成一条）。
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== TEAM_ENTRY_TYPE) continue;
      const data = entry.data as { kind?: string; settlement?: { id?: string; memberName?: string } } | undefined;
      if (data?.kind !== "settled" || typeof data.settlement?.id !== "string" || typeof data.settlement.memberName !== "string") continue;
      const turnSeq = Number(data.settlement.id.slice(data.settlement.id.lastIndexOf(":") + 1));
      if (!Number.isSafeInteger(turnSeq) || turnSeq <= 0) continue;
      const record = this.state.members.find((member) => member.name === data.settlement!.memberName);
      if (!record) continue;
      const slot = this.members.get(record.id);
      if (slot) slot.turnSeq = Math.max(slot.turnSeq, turnSeq);
    }
    // 恢复已有成员的运行时槽位（不重新拉子会话；handle 留空，首次 send 时冷恢复）。
    // 漏掉这一步会让重启后的 active 成员在 activeMember() 里「运行时不存在」。
    for (const member of this.state.members) {
      if (!this.members.has(member.id)) this.members.set(member.id, this.emptyMemberRuntime(member));
    }
  }

  // ── 成员 ────────────────────────────────────────────────────────────────

  async spawn(
    membership: TeamMembership,
    params: { name: string; description: string; prompt: string; subagent?: string; taskId?: string; backend?: "codex" },
    signal?: AbortSignal
  ): Promise<TeamMemberView> {
    this.assertNotDisposed();
    this.assertLead(membership);
    let prepared: { member: TeamMemberRecord; manager: SessionManager; prompt: string } | undefined;
    let created: TeamChildCreated | undefined;
    try {
      prepared = await this.mutate(() => this.prepareSpawn(params));
      const reservation = prepared;
      created = await this.createChildFor(reservation.member, reservation.manager, signal);
      if (!this.attach(reservation.member.id, created)) {
        created = undefined;
        throw new Error("成员会话未能挂载到团队运行时");
      }
      // 显式任务绑定（可选）：在首条 prompt 之前定好，成员一开跑就能被按任务停止。
      if (params.taskId !== undefined) {
        const bound = this.members.get(reservation.member.id);
        if (bound) this.bindTask(bound, params.taskId);
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

  async send(membership: TeamMembership, target: string, text: string, signal?: AbortSignal, taskId?: string): Promise<{ sent: true }> {
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
      // 本回合是否已主动汇报：结算据此去重正文（回合结果照常提供，不会被漏掉）。
      const senderRecord = this.state.members.find((member) => member.name === membership.name);
      const senderRuntime = senderRecord ? this.members.get(senderRecord.id) : undefined;
      if (senderRuntime?.turn) senderRuntime.turn.reportedToLead = true;
      const delivery = this.deliverToLead(`来自${senderLabel}：\n${body}`, membership.name);
      void delivery.catch(() => undefined);
      await this.observeImmediate(delivery);
      this.recordMessage(membership.name, "lead", body);
      this.notify();
      return { sent: true };
    }
    const member = this.activeMember(name);
    if (taskId !== undefined) this.bindTask(member, taskId);
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
    this.recordMessage(membership.name, name, body);
    this.notify();
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
      return status === "running" || status === "provisioning" || status === "stopping";
    });
    // 先结算「在开始等待之前就已经发生」的回合结束：漏掉这一步，成员在 Lead 调用
    // team_wait 之前就结束时会静默丢失（用户看到的是一次白等）。游标保证不重复返回。
    const fresh = this.drainSettlements(membership);
    const approvals = this.pendingApprovals();
    if (!activePeer) {
      return {
        timedOut: false,
        noProgress: { reason: "no-active-peer", message: TEAM_NO_ACTIVE_PEER_MESSAGE },
        ...(fresh.length > 0 ? { settlements: fresh } : {}),
        ...(approvals.length > 0 ? { pendingApprovals: approvals } : {})
      };
    }
    let userInput = false;
    const changed = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
        this.userWaiters.delete(waiter);
        action();
      };
      const waiter = (input?: "user"): void => finish(() => {
        if (input === "user") userInput = true;
        resolve(true);
      });
      const onAbort = (): void => finish(() => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error("team_wait 被中止"));
      });
      this.waiters.add(waiter);
      this.userWaiters.add(waiter);
      timer = setTimeout(() => finish(() => resolve(false)), timeoutMs);
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    // fresh（开始等待之前就已结束的回合）与 after（等待期间结束的回合）都要返回：
    // 游标只在 drain 时前进，两段之间不会重叠，也不会重复。
    const after = [...fresh, ...this.drainSettlements(membership)];
    const stillPending = this.pendingApprovals();
    return {
      timedOut: !changed,
      ...(after.length > 0 ? { settlements: after } : {}),
      ...(stillPending.length > 0 ? { pendingApprovals: stillPending } : {}),
      ...(userInput ? { userInput: true as const } : {})
    };
  }

  interrupt(membership: TeamMembership, target: { name?: string; taskId?: string }): TeamStopResult {
    this.assertNotDisposed();
    this.assertLead(membership);
    const name = target.name?.trim();
    const taskId = target.taskId?.trim();
    if (Boolean(name) === Boolean(taskId)) throw new Error("停止成员需要 name 或 taskId（二选一）");
    if (name) {
      if (name === "lead") throw new Error("不能中断 Team Lead");
      const member = this.activeMember(name);
      return this.stopMember(member, { target: "member", value: name });
    }
    const task = this.state.tasks.find((candidate) => candidate.id === taskId && candidate.status !== "deleted");
    if (!taskId) throw new Error("task_id 不能为空");
    if (!task) return { target: "task", value: taskId!, status: "unknown", message: `任务 ${taskId} 不存在（或已删除）` };
    if (task.status === "completed") {
      return { target: "task", value: taskId!, status: "completed", taskId: taskId!, message: `任务 ${taskId} 已完成，不能按任务停止；如需停止成员请用 name` };
    }
    const bound = this.memberBoundToTask(taskId)
      ?? [...this.members.values()].find((member) => member.taskBinding === taskId && (member.running || member.stopping));
    if (!bound) {
      return { target: "task", value: taskId!, status: "unbound", taskId: taskId!, message: `任务 ${taskId} 没有活跃的成员执行（未绑定或成员已空闲），不需要停止` };
    }
    return this.stopMember(bound, { target: "task", value: taskId!, taskId: taskId! });
  }

  hasRunningMembers(): boolean {
    return [...this.members.values()].some((member) => member.running || member.stopping);
  }

  /** 成员的权限上限（创建时冻结；缺省 = 不设上限，沿用原会话访问策略）。 */
  memberAccessModeCap(memberId: string): AccessMode | undefined {
    return this.members.get(memberId)?.record.config.accessModeCap;
  }

  /**
   * 设置关闭接入 / 权限收紧时停掉**正在跑的 Codex 成员**（Pi 成员不受影响）。
   *
   * 为什么要主动停：Codex 的沙箱是**逐轮参数**，已经在跑的那一轮不会因为设置变化
   * 自己缩小权限；不停它，就等于用一个已作废的授权继续写盘。返回被要求停止的成员数，
   * 调用方（pi-runtime）据此写日志/回执。
   */
  stopCodexMembers(reason: string): number {
    if (this.disposed) return 0;
    let stopped = 0;
    for (const member of this.members.values()) {
      if (backendOfMemberConfig(member.record.config) !== "codex") continue;
      if (!member.running && !member.stopping) continue;
      const result = this.stopMember(member, { target: "member", value: member.record.name });
      if (result.status === "delivered") {
        stopped += 1;
        this.options.onCodexMemberStopped?.(member.record.name, reason);
      }
    }
    if (stopped > 0) this.notify();
    return stopped;
  }

  stopAll(): void {
    if (this.disposed) return;
    let changed = false;
    for (const member of this.members.values()) {
      if (!member.running && !member.stopping) continue;
      const result = this.stopMember(member, { target: "member", value: member.record.name });
      if (result.status === "delivered") changed = true;
    }
    if (changed) this.notify();
  }

  /** 用户发新指令：只叫醒「等团队事件」的等待者，团队自身的事件（活动帧/结算）不走这条。 */
  wakeForUserInput(): void {
    if (this.disposed || this.userWaiters.size === 0) return;
    for (const waiter of [...this.userWaiters]) waiter("user");
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

  backends(): TeamBackendView[] {
    const backend = this.options.codex;
    if (!backend) return [];
    const availability = backend.availability();
    return [{
      backend: "codex",
      available: availability.available,
      access: availability.access,
      ...(availability.version ? { version: availability.version } : {}),
      ...(availability.reason ? { reason: availability.reason } : {})
    }];
  }

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
        ...(this.modelLabel(record.config) ? { model: this.modelLabel(record.config) } : {}),
        ...(backendOfMemberConfig(record.config) === "codex" ? { backend: "codex" as const } : {}),
        thinkingLevel: record.config.thinkingLevel,
        ...(task ? { taskId: task.id, taskSubject: task.subject } : {}),
        ...(activity ? { activity } : {}),
        ...(member?.lastReport ? { lastReport: { ...member.lastReport } } : {}),
        ...(member?.settlement ? { settlement: { ...member.settlement } } : {})
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
    this.snapshotCache = {
      members,
      running: members.filter((member) => member.status === "running").length,
      ...(members.some((member) => member.status === "stopping") ? { stopping: members.filter((member) => member.status === "stopping").length } : {}),
      tasks,
      lead: this.leadSummary(),
      ...(this.messages.length > 0 ? { messages: [...this.messages] } : {})
    };
    return this.snapshotCache;
  }

  /** Lead 的团队级汇总；stats 遍历整条会话日志，1s 内复用上次结果。 */
  private leadSummary(): TeamLeadSummary {
    const now = this.now();
    if (!this.leadStatsCache || now - this.leadStatsCache.at >= LEAD_STATS_TTL_MS) {
      this.leadStatsCache = { at: now, stats: this.readLeadStats(), context: this.readLeadContext() };
    }
    const stats = this.leadStatsCache.stats;
    const context = this.leadStatsCache.context;
    const model = this.leadSession.model;
    return {
      status: this.leadSession.isStreaming ? "running" : "inactive",
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      ...(stats ? { tokens: stats.tokens.total, cost: stats.cost, steps: stats.toolCalls } : {}),
      ...(context && context.percent !== null ? { contextPercent: context.percent } : {})
    };
  }

  private readLeadStats(): { toolCalls: number; tokens: { total: number }; cost: number } | undefined {
    try {
      return this.leadSession.getSessionStats();
    } catch {
      return undefined;
    }
  }

  private readLeadContext(): { percent: number | null } | undefined {
    try {
      return this.leadSession.getContextUsage();
    } catch {
      return undefined;
    }
  }

  /** 记录一条团队消息（内存环形缓冲，重启清空）；只有投递被接收后才调用。 */
  private recordMessage(sender: string, target: string, text: string): void {
    const body = clipTeamText(text);
    if (!body) return;
    this.messageSeq += 1;
    const kind: TeamMessageSummary["kind"] = target === "lead" ? "report" : sender === "lead" ? "assign" : "direct";
    this.messages = [...this.messages, {
      id: `team-msg-${this.messageSeq}`,
      sender,
      target,
      text: body,
      at: this.now(),
      kind
    }].slice(-TEAM_LOG_LIMIT);
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
    this.userWaiters.clear();
    for (const member of this.members.values()) {
      if (member.idleTimer) clearTimeout(member.idleTimer);
      member.idleTimer = undefined;
      const handle = member.handle;
      member.handle = undefined;
      member.unsubscribe?.();
      member.unsubscribe = undefined;
      member.running = false;
      member.stopping = false;
      // 销毁时先把还在等的卡收掉：迟到的点击不能落到已经没人接的回合上（与 stop 同口径）。
      this.options.cancelMemberPermissions?.(member.record.id);
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

  private prepareSpawn(params: { name: string; description: string; prompt: string; subagent?: string; backend?: "codex" }): { member: TeamMemberRecord; manager: SessionManager; prompt: string } {
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
    // 后端预检留在「占用成员名」之前：Codex 未启用/CLI 解析不出来时，成员名不该被
    // 一条 failed 记录永久占掉（用户修好设置后可以直接用同一个名字重试）。
    const backend = params.backend === "codex" ? "codex" : "pi";
    const config = backend === "codex"
      ? this.codexConfigFor(name, params.subagent)
      : this.configFor(name, params.subagent);
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
      const isCodex = backendOfMemberConfig(member.record.config) === "codex";
      const hasFile = existsSync(member.record.sessionFile);
      if (!hasFile && !isCodex) {
        throw new Error(`成员「${member.record.name}」的会话文件不存在，无法冷恢复`);
      }
      // Codex 成员的转写文件可能还没落（首回合之前）：这时新建一个同 id 的 manager，
      // 让后续 user/assistant 条目照常写入；已有文件则沿用（原转写保留）。
      const manager = hasFile
        ? SessionManager.open(member.record.sessionFile, this.teamDir)
        : SessionManager.create(this.options.workspace, this.teamDir, { id: member.record.id, parentSession: this.leadSession.sessionId });
      const created = await this.createChildFor(member.record, manager, signal);
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
      // 窄失败契约（Codex 的 failed 终态）：按失败结算一次，并带上真实原因。
      if (event.type === "pidesktop_run_failed") {
        member.running = false;
        member.stopping = false;
        closeRunningSteps(member, event.aborted ? "aborted" : "error", now);
        this.settleTurn(member, event.aborted ? "aborted" : "failed", event.aborted ? undefined : event.error);
        this.notify();
        this.scheduleIdle(member);
        return;
      }
      if (event.type === "agent_settled") {
        member.running = false;
        member.stopping = false;
        closeRunningSteps(member, event.aborted ? "aborted" : "done", now);
        // 每成员每回合一条结算：写进 Lead 的会话日志（不进 LLM 上下文），并经
        // team_wait / team_list / Lead 收件箱之一送达模型。
        this.settleTurn(member, event.aborted ? "aborted" : "completed");
        this.notify();
        this.scheduleIdle(member);
        return;
      }
      if (event.type === "agent_start") {
        member.running = true;
        member.startedAt = now;
        member.lastActiveAt = now;
        this.beginTurn(member);
        // 停止已受理后又起了一个回合（排队消息的 triggerTurn）：不能把 stopping 清掉
        // ——那等于静默撤销用户的停止；立刻再停一次，等这次 run 的 settled 再收口。
        if (member.stopping) {
          this.requestStop(member);
        }
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
        // artifacts 只收「写」：read/grep 的路径不算产物，否则结算里全是噪声。
        if (event.toolName === "write" || event.toolName === "edit") this.noteArtifact(member, event.args);
        member.currentTool = event.toolName;
        member.currentDetail = detail;
        member.lastActiveAt = now;
        this.scheduleIdle(member);
        this.notifyActivity();
        return;
      }
      if (event.type === "tool_execution_end") {
        if (member.record.config.mode === "codex" && event.toolName === "fileChange" && !event.isError) {
          const result = event.result as { changedPaths?: unknown } | undefined;
          if (Array.isArray(result?.changedPaths)) {
            for (const path of result.changedPaths) {
              if (typeof path === "string") this.noteArtifactValue(member, isAbsolute(path) ? relative(this.options.workspace, path) : path);
            }
          }
        }
        closeRunningSteps(member, event.isError ? "error" : "done", now, event.toolCallId, event.durationMs);
        member.lastActiveAt = now;
        this.notifyActivity();
        return;
      }
      if (event.type === "message_end") {
        const report = assistantText(event.message);
        if (report) {
          member.lastReport = { text: clipTeamText(report), at: now };
          if (member.turn) {
            member.turn.lastReport = clipTeamText(report);
            for (const path of mentionedArtifacts(report)) this.noteArtifactValue(member, path);
          }
        }
        this.notifyActivity();
        return;
      }
    });
    this.scheduleIdle(member);
    return true;
  }

  private detach(memberId: string): void {
    const member = this.members.get(memberId);
    if (!member) return;
    if (member.idleTimer) clearTimeout(member.idleTimer);
    member.idleTimer = undefined;
    if (member.stopTimer) clearTimeout(member.stopTimer);
    member.stopTimer = undefined;
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
    const hadTurn = member.turn !== undefined;
    member.running = false;
    if (error !== undefined) member.lastError = errorText(error);
    // 失败与正常结算分开：outcome=failed 才带 error，且只在本回合真的跑过时结算
    // （首条 prompt 被 preflight 拦下这类「还没开跑」的失败由 spawn 自己的 failed 记账）。
    if (hadTurn) this.settleTurn(member, "failed", error);
    this.notify();
    this.scheduleIdle(member);
  }

  // ── 内部：回合记账 / 结算 ─────────────────────────────────────────────

  private emptyMemberRuntime(record: TeamMemberRecord): MemberRuntime {
    return { record, running: false, stopping: false, turnSeq: 0, steps: 0, recent: [] };
  }

  /** 开新回合：id 用 `成员id:回合号`（重启后从日志重算，不依赖内存）。 */
  private beginTurn(member: MemberRuntime): void {
    if (member.turn) return;
    member.turn = {
      id: `${member.record.id}:${member.turnSeq + 1}`,
      startedAt: this.now(),
      artifacts: new Set(),
      reportedToLead: false,
      pending: new Map()
    };
  }

  private noteArtifact(member: MemberRuntime, args: unknown): void {
    if (!args || typeof args !== "object") return;
    const value = (args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file_path ?? (args as Record<string, unknown>).filePath;
    if (typeof value === "string") this.noteArtifactValue(member, value);
  }

  /** 只收工作区相对路径；绝对路径与 `..` 一律丢弃（结算要能直接交给别的成员复用）。 */
  private noteArtifactValue(member: MemberRuntime, value: string): void {
    const turn = member.turn;
    if (!turn || turn.artifacts.size >= SETTLEMENT_ARTIFACT_LIMIT) return;
    const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
    if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").includes("..")) return;
    if (normalized.length > 240) return;
    turn.artifacts.add(normalized);
  }

  /** 成员当前在跑的任务 id（显式绑定的优先，其次任务板上 in_progress 的认领）。 */
  private taskIdsFor(member: MemberRuntime): string[] {
    const ids = new Set<string>();
    if (member.taskBinding) ids.add(member.taskBinding);
    for (const task of this.state.tasks) {
      if (task.status === "in_progress" && task.ownerId === member.record.id) ids.add(task.id);
    }
    return [...ids];
  }

  /**
   * 收口一个成员回合并产出结算：
   * - outcome 区分 completed / failed / aborted（用户/Lead 停止不算失败）；
   * - 已主动 team_send 给 Lead 的回合不再重复投递正文，但结算照常提供；
   * - 结算写进 Lead 日志（CustomEntry，不进 LLM 上下文）并进待消费队列（team_wait 取）。
   */
  private settleTurn(member: MemberRuntime, outcome: TeamMemberSettlement["outcome"], error?: unknown): void {
    const turn = member.turn;
    // 没有回合就不结算：首条 prompt 在 Pi 的 preflight 阶段就失败时 running 可能已被
    // 置 true，但那是「创建失败」（由 spawn 自己记账），不是一次跑到一半的回合。
    if (!turn) return;
    member.turn = undefined;
    member.turnSeq += 1;
    member.stopping = false;
    const settlement: TeamMemberSettlement = {
      id: `${member.record.id}:${member.turnSeq}`,
      memberName: member.record.name,
      outcome,
      ...(turn?.lastReport ? { summary: turn.lastReport } : {}),
      taskIds: this.taskIdsFor(member),
      artifacts: [...(turn?.artifacts ?? [])].slice(0, SETTLEMENT_ARTIFACT_LIMIT),
      ...(turn?.blocker ? { blocker: { ...turn.blocker } } : {}),
      reported: turn?.reportedToLead === true,
      ...(error === undefined ? {} : { error: errorText(error) }),
      at: this.now()
    };
    member.settlement = settlement;
    member.lastError = error === undefined ? member.lastError : errorText(error);
    try {
      appendTeamSettlement(this.leadSession, settlement);
    } catch {
      // 日志是派生的：写失败不阻断成员回合收尾，内存态与工具回执仍可用。
    }
    this.settlementSeq += 1;
    this.pendingSettlements = [...this.pendingSettlements, { seq: this.settlementSeq, settlement }].slice(-SETTLEMENT_QUEUE_LIMIT);
    // 已经主动汇报过的正常结算不再往 Lead 收件箱塞一条重复正文；失败/中止必须通知
    // （成员自己没法汇报），卡点也在正文里点明，Lead 才知道该改派还是补授权。
    if (!settlement.reported || outcome !== "completed" || settlement.blocker) {
      const delivery = this.deliverToLead(settlementText(settlement), member.record.name);
      void delivery.catch(() => undefined);
    }
    this.refreshTaskBinding(member);
    this.snapshotCache = undefined;
  }

  /** 取走调用者尚未消费的结算（游标保证同一事件不重复返回）。 */
  private drainSettlements(membership: TeamMembership): TeamMemberSettlement[] {
    const cursor = this.settlementCursor.get(membership.name) ?? 0;
    const fresh = this.pendingSettlements.filter((entry) => entry.seq > cursor);
    if (fresh.length === 0) return [];
    this.settlementCursor.set(membership.name, fresh[fresh.length - 1]!.seq);
    // 只给「自己以外」的成员结算：Lead 不需要自己的结算（它没有成员回合）。
    return fresh.map((entry) => entry.settlement).filter((settlement) => settlement.memberName !== membership.name);
  }

  /** 正在等审批的成员请求（team_wait 的事件之一，让 Lead 知道卡在哪一步）。 */
  private pendingApprovals(): TeamPermissionNotice[] {
    const notices: TeamPermissionNotice[] = [];
    for (const member of this.members.values()) {
      for (const notice of member.turn?.pending.values() ?? []) notices.push({ ...notice });
    }
    return notices;
  }

  /** 权限请求的收场回调：deny 的来源（用户拒绝 / 模式拦截 / 超时）分开记，取消归中止。 */
  private notePermissionOutcome(member: MemberRuntime, settlement: PermissionSettlement & { request: TeamPermissionNotice }): void {
    const turn = member.turn;
    // 按请求 id 精确摘除：同一命令并发两次审批时，收场一条不能把另一条也抹掉。
    if (turn && settlement.id) turn.pending.delete(settlement.id);
    if (settlement.decision !== "deny") return;
    // 取消 = 成员/团队被停止：结局是「中止」，不记成卡点（否则结算会误导 Lead 去补授权）。
    if (settlement.cause === "cancel") return;
    const kind = settlement.cause === "timeout"
      ? "permission-timeout"
      : settlement.cause === "mode"
        ? "permission-mode"
        : "permission-denied";
    if (turn) turn.blocker = { kind, toolName: settlement.request.toolName, summary: settlement.request.summary };
    // 权限被拦下不结束成员回合（工具以错误结果回到成员模型），但 Lead 应立即知道，
    // 才能决定「换个审查员」还是「把命令验证交给有授权的会话」。
    const delivery = this.deliverToLead(
      `成员「${member.record.name}」的权限请求被拒（${blockerCauseLabel(kind)}）：${settlement.request.summary}。该成员这一回合会继续，但这一步没有执行；可以换成员/换任务，或把需要授权的那一步交给有权限的会话。`,
      member.record.name
    );
    void delivery.catch(() => undefined);
    this.notify();
  }

  /** 收到成员权限卡时的登记（team_wait 的 pendingApprovals 由此而来）。 */
  private notePermissionPending(member: MemberRuntime, notice: TeamPermissionNotice, requestId: string): void {
    if (!member.turn) return;
    member.turn.pending.set(requestId, notice);
    // 等审批是**可行动事件**（Lead 要决定换人还是补授权），不是活动帧：它要唤醒
    // 等待中的 Lead，而工具步骤/消息流的刷新不允许唤醒（见 notifyActivity）。
    this.notify();
  }

  // ── 内部：任务绑定 / 停止 ─────────────────────────────────────────────

  /**
   * 把任务板上的任务与这名成员的执行回合显式关联（可选）。
   * 复用任务板归属与 CAS：pending+就绪 → 以成员身份认领；已由该成员认领 → 直接绑定；
   * 已完成 / 他人认领 / 依赖未完成都明确报错。同一成员同一时间只绑一个任务。
   */
  private bindTask(member: MemberRuntime, taskId: string): void {
    const id = taskId.trim();
    if (!id) throw new Error("task_id 不能为空");
    const task = this.state.tasks.find((candidate) => candidate.id === id && candidate.status !== "deleted");
    if (!task) throw new Error(`任务不存在：${id}`);
    if (task.status === "completed") throw new Error(`任务 ${id} 已完成，不能再绑定执行成员`);
    if (member.taskBinding && member.taskBinding !== id && (member.running || member.stopping)) {
      throw new Error(`成员「${member.record.name}」正在执行 ${member.taskBinding}；同一时间只能绑定一个任务，先等它结束或停止该成员`);
    }
    if (task.status === "in_progress" && task.ownerId !== member.record.id) {
      const owner = ownerNameOf(this.state, this.leadSession.sessionId, task.ownerId) ?? "其他成员";
      throw new Error(`任务 ${id} 已由「${owner}」认领；要改派请用 team_task_update 的 reassign`);
    }
    if (task.status === "pending") {
      if (!taskReady(this.state, task)) throw new Error(`任务 ${id} 的依赖尚未全部完成，不能开始执行`);
      const next = updateTask(this.state, this.leadSession.sessionId, this.taskCaller({ role: "teammate", name: member.record.name }), {
        taskId: id,
        expectedRevision: task.revision,
        action: "claim"
      });
      this.state = { ...this.state, tasks: withTask(this.state, next) };
      appendTeamTask(this.leadSession, next);
    }
    member.taskBinding = id;
    this.snapshotCache = undefined;
  }

  /**
   * 共享停止路径（单成员停止、「全部停止」、按任务停止都走它）：
   * 受理即进入 stopping，清排队指令、取消该成员的待决权限与长期授权；`agent_settled`
   * 或资源回收后才回到 inactive（结算 outcome=aborted）。重复停止幂等，不误停其他成员。
   */
  private stopMember(member: MemberRuntime, target: { target: "member" | "task"; value: string; taskId?: string }): TeamStopResult {
    const base: Omit<TeamStopResult, "status" | "message"> = {
      ...target,
      memberName: member.record.name,
      ...(member.taskBinding ? { taskId: member.taskBinding } : {})
    };
    if (!member.running && !member.stopping) {
      return { ...base, status: "idle", message: `成员「${member.record.name}」当前没有活跃回合，不需要停止` };
    }
    if (member.stopping) {
      // 已受理过：重发一次停止兜底（abort 可能被迟到的 run 复位），没有进行中的 run
      // 时直接收口——不能让 stopping 只能靠销毁会话才解除。
      this.requestStop(member);
      return { ...base, status: "delivered", message: `已受理：成员「${member.record.name}」正在停止中，收到回合结束或资源回收后才算「已停止」` };
    }
    member.stopping = true;
    this.clearMemberQueue(member);
    member.turn?.pending.clear();
    this.options.cancelMemberPermissions?.(member.record.id);
    this.requestStop(member);
    this.notify();
    return { ...base, status: "delivered", message: `已受理：正在停止成员「${member.record.name}」，收到回合结束或资源回收后报告「已停止」` };
  }

  /**
   * 发一次停止请求，并保证「停止受理」一定能收口：
   * - 没有进行中的 run 时 Pi 的 abort 是空操作（不会发 agent_settled）→ 就地收口；
   * - 有进行中的 run 时等 settled，另挂看门狗兜底（abort 卡住/事件丢失也不悬挂）。
   * 重复调用是安全的：只会重发一次 abort。
   */
  private requestStop(member: MemberRuntime): void {
    const handle = member.handle;
    if (!handle) {
      this.finishStoppedMember(member);
      return;
    }
    const streaming = handle.isStreaming === true;
    // Pi 的 abort 不清 steering/followUp 队列、也不撤任务归属；队列在 stopMember 里
    // 显式清掉，任务归属与已完成依赖保留（Lead 可用既有 CAS reassign 改派）。
    void handle.abort().catch((error: unknown) => {
      member.lastError = errorText(error);
      this.finishStoppedMember(member);
    });
    if (!streaming) {
      // 没有进行中的 run：abort 不会产生 settled，直接按「已中止」收口。
      this.finishStoppedMember(member);
      return;
    }
    if (member.stopTimer) clearTimeout(member.stopTimer);
    const timer = setTimeout(() => {
      member.stopTimer = undefined;
      if (this.disposed || !member.stopping) return;
      member.lastError = member.lastError ?? "停止未在预期时间内收尾，已强制释放成员子会话";
      this.finishStoppedMember(member);
    }, TEAM_STOP_SETTLE_TIMEOUT_MS);
    timer.unref?.();
    member.stopTimer = timer;
  }

  /** 任务当前归属的成员（优先按任务板 ownerId，其次按执行绑定）。 */
  private memberBoundToTask(taskId: string): MemberRuntime | undefined {
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    const byOwner = task?.ownerId ? this.members.get(task.ownerId) : undefined;
    if (byOwner && (byOwner.running || byOwner.stopping) && (byOwner.taskBinding === taskId || task?.ownerId === byOwner.record.id)) return byOwner;
    return undefined;
  }

  /** 结算后清掉「已不再属于本成员」的任务绑定（任务被改派/完成后不再按旧绑定停人）。 */
  private refreshTaskBinding(member: MemberRuntime): void {
    if (!member.taskBinding) return;
    const task = this.state.tasks.find((candidate) => candidate.id === member.taskBinding);
    if (!task || task.status === "completed" || task.status === "deleted" || (task.ownerId !== undefined && task.ownerId !== member.record.id)) {
      member.taskBinding = undefined;
    }
  }

  /** 停止路径的兜底收口：abort 失败/未回 settled 时按「已中止」结算并释放子会话。 */
  private finishStoppedMember(member: MemberRuntime): void {
    if (member.stopTimer) clearTimeout(member.stopTimer);
    member.stopTimer = undefined;
    if (member.turn) this.settleTurn(member, "aborted");
    member.running = false;
    member.stopping = false;
    this.detach(member.record.id);
    this.notify();
  }

  /** 停止时清掉该成员排队的指令（防止取消后又收到旧任务）。 */
  private clearMemberQueue(member: MemberRuntime): void {
    try {
      member.handle?.clearQueue?.();
    } catch {
      // 旧会话/测试替身没有 clearQueue：best-effort，abort 仍会结束当前回合。
    }
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

  /** Codex 成员的编制：不伪造 Pi provider/model，冻结 CLI 与访问上限。 */
  private codexConfigFor(name: string, subagentKey: string | undefined): TeamMemberConfig {
    if (subagentKey !== undefined && subagentKey.trim()) {
      throw new Error("Codex 成员不支持 subagent（那是 Pi 子智能体定义）：请把角色要求写进 prompt 或成员的 description");
    }
    const backend = this.options.codex;
    if (!backend) throw new Error("Codex 后端未接入：请在「设置 → 子智能体 → Codex CLI」启用并选择可执行文件");
    const availability = backend.availability();
    if (!availability.available || !availability.executable) {
      throw new Error(`Codex 后端不可用：${availability.reason ?? "未检测到可用的 Codex CLI"}`);
    }
    return {
      mode: "codex",
      systemPrompt: "",
      tools: [],
      thinkingLevel: this.options.getThinkingLevel(),
      browserTools: false,
      codex: {
        executable: availability.executable,
        sandbox: availability.access,
        approvalPolicy: "never",
        ...(availability.version ? { version: availability.version } : {})
      }
    };
  }

  /** 按成员编制选后端：Codex 走外部运行时，其余（含旧记录）走 Pi 子会话。 */
  private async createChildFor(member: TeamMemberRecord, manager: SessionManager, signal?: AbortSignal): Promise<TeamChildCreated> {
    if (backendOfMemberConfig(member.config) !== "codex") {
      return await this.createChild({
        manager,
        config: member.config,
        name: member.name,
        ...(signal === undefined ? {} : { signal })
      });
    }
    const backend = this.options.codex;
    if (!backend) throw new Error(`成员「${member.name}」是 Codex 成员，但 Codex 后端当前未接入（设置里未启用）`);
    return await backend.createChild({
      memberId: member.id,
      memberName: member.name,
      workspace: this.options.workspace,
      memberDir: this.teamDir,
      manager,
      config: member.config,
      ...(signal === undefined ? {} : { signal })
    });
  }

  /** 成员模型的可读标签（Codex 成员没有 Pi provider/model）。 */
  private modelLabel(config: TeamMemberConfig): string | undefined {
    if (backendOfMemberConfig(config) === "codex") return `codex/${config.codex?.model ?? "default"}`;
    return config.model ? `${config.model.provider}/${config.model.id}` : undefined;
  }

  private async createChild(request: TeamChildFactoryRequest): Promise<TeamChildCreated> {
    if (this.options.createChildSession) return await this.options.createChildSession(request);
    return await this.defaultCreateChild(request);
  }

  /**
   * 成员的权限请求（defaultCreateChild 与单测共用）：把成员身份与两条回调接到
   * `options.requestPermission` 上——待审批登记进回合（team_wait 能看到），收场按
   * 原因记卡点并回报 Lead。工具层不感知这些细节。
   */
  memberPermissionRequest(
    member: TeamMemberIdentity,
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string
  ): Promise<PermissionDecision> {
    const hooks: TeamPermissionHooks = {
      onPending: (notice, requestId) => {
        const runtime = this.members.get(member.memberId);
        // 权限 id 与 settlement.id 同键；旧调用方（测试替身）没给 id 时退回工具调用 id。
        if (runtime) this.notePermissionPending(runtime, notice, requestId ?? toolCallId);
      },
      onSettled: (settlement) => {
        const runtime = this.members.get(member.memberId);
        if (runtime) this.notePermissionOutcome(runtime, settlement);
      }
    };
    return this.options.requestPermission(toolName, args, toolCallId, member, hooks);
  }

  /**
   * Codex 轮次确认（工作区写入的本轮授权）的登记入口。
   *
   * 与 Pi 成员共用同一套口径：确认发生在 `turn/start` **之前**，所以这里先把回合开账，
   * 否则 `team_wait` 的 `pendingApprovals` 看不到、拒绝后的结算也丢；`requestId` 必须是
   * 权限请求自己的 id（broker 的 onPending 给出），收场时按同一个键摘除。
   */
  noteCodexApprovalPending(memberId: string, notice: TeamPermissionNotice, requestId: string): void {
    if (this.disposed || !requestId) return;
    const member = this.members.get(memberId);
    if (!member) return;
    this.beginTurn(member);
    this.notePermissionPending(member, notice, requestId);
  }

  /** Codex 轮次确认收场：只摘除卡片登记（拒绝/超时的语义由本回合的失败结算表达）。 */
  noteCodexApprovalSettled(memberId: string, requestId: string): void {
    if (this.disposed || !requestId) return;
    const turn = this.members.get(memberId)?.turn;
    if (!turn || !turn.pending.delete(requestId)) return;
    this.notify();
  }

  private async defaultCreateChild(request: TeamChildFactoryRequest): Promise<TeamChildCreated> {
    request.signal?.throwIfAborted();
    // 成员身份（Lead 会话 + 不可复用的成员 id）：权限请求按它隔离授权、按它取消，
    // 审批卡也能显示是谁在请求。id 取自 SessionManager（= 成员记录 id）。
    const memberId = request.manager.getSessionId();
    const member: TeamMemberIdentity = { memberId, memberName: request.name };
    const requestForMember = (toolName: string, args: Record<string, unknown>, toolCallId: string): Promise<PermissionDecision> =>
      this.memberPermissionRequest(member, toolName, args, toolCallId);
    const settingsManager = withCacheWarmingOff(SettingsManager.create(this.options.workspace, this.options.agentDir));
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.workspace,
      agentDir: this.options.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createChildPermissionExtension(requestForMember, "用户已在 PiDesktop 中拒绝该团队成员操作")],
      systemPromptOverride: (base) => [base, request.config.systemPrompt, teamIdentityBlock(request.name)].filter(Boolean).join("\n\n")
    });
    await resourceLoader.reload();
    const teamTools = createTeamTools(this, { role: "teammate", name: request.name });
    const browserTools = request.config.browserTools && this.options.buildBrowserTools ? this.options.buildBrowserTools() : [];
    // Pi 子会话必须有模型（Codex 成员走 createChildFor 的另一条分支，不会到这里）。
    if (!request.config.model) throw new Error("成员缺少 Pi 模型（记录已损坏？）");
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
      ...(this.modelLabel(record.config) ? { model: this.modelLabel(record.config) } : {}),
      ...(backendOfMemberConfig(record.config) === "codex" ? { backend: "codex" as const } : {}),
      diagnostics,
      ...(memberRuntime?.settlement ? { settlement: { ...memberRuntime.settlement } } : {})
    };
  }

  private statusOf(record: TeamMemberRecord, member: MemberRuntime | undefined): TeamMemberSummary["status"] {
    if (record.phase === "failed") return "failed";
    if (record.phase === "provisioning") return "provisioning";
    if (member?.stopping) return "stopping";
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
    else this.members.set(record.id, this.emptyMemberRuntime(record));
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
