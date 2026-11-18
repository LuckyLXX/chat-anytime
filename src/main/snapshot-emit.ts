/**
 * 激活会话 / 分屏格子的**发帧决策**（纯逻辑，可在 vitest 里直接跑）。
 *
 * 为什么从 `pi-runtime.ts` 抽出来：那个模块在顶层就要 Electron utility 进程的
 * `parentPort`，vitest 里导入不了；而「这一刻该发全量、该发 `state.patch`、还是该
 * 发切回旧会话的 `state.resume.patch`」是这套协议里最容易改错、也最必须钉住的判断
 * （发错一句就是「切回长会话重新传一遍几十 MB 历史」或者「把 A 的差量算到 B 头上」）。
 *
 * 协议要点（与 `shared/protocol.ts` 的注释同源）：
 * - `revision` 是**跨会话共享**的全局发帧序号，只有 utility 递增它；
 * - 同一 active 会话的连续帧保持 revision 连号（接收端会校验 `revision === current + 1`）；
 * - 切回一个有基线的旧会话时，底座是**那个会话自己**的基线，令牌是 `baseRevision`，
 *   新 revision 可以跳号（中间夹着别的会话用掉的序号）；
 * - 同一会话且毫无变化时**不占用 revision**（否则接收端会看到序号断档）。
 */

import type {
  ChatMessage,
  ContextUsage,
  RuntimeResumePatch,
  RuntimeSnapshot,
  RuntimeSnapshotFieldsPatch,
  RuntimeStatePatch,
  SessionPaneFieldsPatch,
  SessionPaneSnapshot,
  SpeedStats,
  ToolExecution
} from "../shared/protocol.js";
import { diffChatMessages, diffToolExecutions, snapshotToolExecution, toolExecutionPatchEqual } from "../shared/snapshot-patch.js";
import { MAX_SESSION_BASELINES, createSessionBaselineCache, type SessionBaselineCache } from "../shared/session-baseline-cache.js";

/**
 * 一次已推送的基线：只保存数组引用/不可变浅拷贝，内存与 snapshot 同量级——
 * 用于把下一帧差分成 tail 补丁，而不是每帧重传整段历史。
 */
export interface EmittedSnapshot<T> {
  sessionId?: string;
  messages: ChatMessage[];
  executions: ToolExecution[];
  /** 展平一份「标量视图 + 同引用数组」的快照副本，供下一帧逐字段比较。 */
  snapshot: T;
}

/** 执行数组的不可变浅拷贝：未变化项复用旧快照对象（内存/GC 友好）。 */
export function executionSnapshots(list: readonly ToolExecution[], previous?: readonly ToolExecution[]): ToolExecution[] {
  if (!previous) return list.map(snapshotToolExecution);
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return list.map((item) => {
    const prior = previousById.get(item.id);
    return prior && toolExecutionPatchEqual(prior, item) ? prior : snapshotToolExecution(item);
  });
}

export function makeEmitted<T extends { sessionId?: string; messages: ChatMessage[]; executions: ToolExecution[] }>(
  next: T,
  executions: ToolExecution[]
): EmittedSnapshot<T> {
  return {
    sessionId: next.sessionId,
    messages: next.messages,
    executions,
    // 展平一份「执行快照」的标量视图，供下一帧逐字段比较。
    snapshot: { ...next, messages: next.messages, executions } as T
  };
}

export function sameQueuedMessages(left: RuntimeSnapshot["queuedMessages"], right: RuntimeSnapshot["queuedMessages"]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return Boolean(other)
      && item.kind === other!.kind && item.index === other!.index
      && item.text === other!.text && item.imageCount === other!.imageCount;
  });
}

export function sameContextUsage(left: ContextUsage | undefined, right: ContextUsage | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.tokens === right.tokens
    && left.contextWindow === right.contextWindow
    && left.percent === right.percent
    && left.cacheHitRate === right.cacheHitRate
    && left.breakdown?.system === right.breakdown?.system
    && left.breakdown?.tools === right.breakdown?.tools
    && left.breakdown?.messages === right.breakdown?.messages;
}

export function sameSpeedStats(left: SpeedStats | undefined, right: SpeedStats | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.turns === right.turns && left.steps === right.steps
    && left.llmMs === right.llmMs && left.toolMs === right.toolMs
    && left.ttftMs === right.ttftMs && left.ttftSteps === right.ttftSteps
    && left.decodeTokens === right.decodeTokens && left.decodeMs === right.decodeMs
    && left.promptTokens === right.promptTokens && left.outputTokens === right.outputTokens
    && left.live?.startedAt === right.live?.startedAt
    && left.live?.firstTokenAt === right.live?.firstTokenAt
    && left.live?.tokens === right.live?.tokens;
}

export function sameBackgroundProcesses(left: RuntimeSnapshot["backgroundProcesses"], right: RuntimeSnapshot["backgroundProcesses"]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return Boolean(other) && item.id === other!.id && item.pid === other!.pid
      && item.command === other!.command && item.startedAt === other!.startedAt;
  });
}

/** 活跃会话的标量字段差量（不含 messages/executions，那两个走专用补丁）。 */
export function activeFieldsPatch(previous: RuntimeSnapshot, next: RuntimeSnapshot): RuntimeSnapshotFieldsPatch {
  const fields: RuntimeSnapshotFieldsPatch = { sessionId: next.sessionId };
  if (previous.workspace !== next.workspace) fields.workspace = next.workspace;
  if (previous.readOnlyReason !== next.readOnlyReason) fields.readOnlyReason = next.readOnlyReason;
  if (previous.gitBranch !== next.gitBranch) fields.gitBranch = next.gitBranch;
  if (previous.agentId !== next.agentId) fields.agentId = next.agentId;
  if (previous.agentName !== next.agentName) fields.agentName = next.agentName;
  if (previous.sessionFile !== next.sessionFile) fields.sessionFile = next.sessionFile;
  if (previous.model?.provider !== next.model?.provider || previous.model?.id !== next.model?.id) fields.model = next.model;
  if (previous.thinkingLevel !== next.thinkingLevel) fields.thinkingLevel = next.thinkingLevel;
  if (previous.busy !== next.busy) fields.busy = next.busy;
  if (previous.status !== next.status) fields.status = next.status;
  if (previous.turnTiming !== next.turnTiming) fields.turnTiming = next.turnTiming;
  if (!sameQueuedMessages(previous.queuedMessages, next.queuedMessages)) fields.queuedMessages = next.queuedMessages;
  if (!sameContextUsage(previous.contextUsage, next.contextUsage)) fields.contextUsage = next.contextUsage;
  if (!sameSpeedStats(previous.speedStats, next.speedStats)) fields.speedStats = next.speedStats;
  if (previous.planMode !== next.planMode) fields.planMode = next.planMode;
  if (previous.computerMode !== next.computerMode) fields.computerMode = next.computerMode;
  if (previous.designMode !== next.designMode) fields.designMode = next.designMode;
  if (previous.teamMode !== next.teamMode) fields.teamMode = next.teamMode;
  if (previous.team !== next.team) fields.team = next.team;
  // 列表/进程数组变化频率低（refreshSessions / 进程发现），只在引用或内容变化时附带。
  if (previous.sessions !== next.sessions) fields.sessions = next.sessions;
  if (previous.recentWorkspaces !== next.recentWorkspaces) fields.recentWorkspaces = next.recentWorkspaces;
  if (!sameBackgroundProcesses(previous.backgroundProcesses, next.backgroundProcesses)) fields.backgroundProcesses = next.backgroundProcesses;
  return fields;
}

export function paneFieldsPatch(previous: SessionPaneSnapshot, next: SessionPaneSnapshot): SessionPaneFieldsPatch {
  const fields: SessionPaneFieldsPatch = { sessionId: next.sessionId };
  if (previous.sessionFile !== next.sessionFile) fields.sessionFile = next.sessionFile;
  if (previous.workspace !== next.workspace) fields.workspace = next.workspace;
  if (previous.agentId !== next.agentId) fields.agentId = next.agentId;
  if (previous.agentName !== next.agentName) fields.agentName = next.agentName;
  if (previous.readOnlyReason !== next.readOnlyReason) fields.readOnlyReason = next.readOnlyReason;
  if (previous.model?.provider !== next.model?.provider || previous.model?.id !== next.model?.id) fields.model = next.model;
  if (previous.thinkingLevel !== next.thinkingLevel) fields.thinkingLevel = next.thinkingLevel;
  if (previous.busy !== next.busy) fields.busy = next.busy;
  if (previous.status !== next.status) fields.status = next.status;
  if (previous.turnTiming !== next.turnTiming) fields.turnTiming = next.turnTiming;
  if (!sameQueuedMessages(previous.queuedMessages, next.queuedMessages)) fields.queuedMessages = next.queuedMessages;
  if (!sameContextUsage(previous.contextUsage, next.contextUsage)) fields.contextUsage = next.contextUsage;
  if (!sameSpeedStats(previous.speedStats, next.speedStats)) fields.speedStats = next.speedStats;
  if (previous.planMode !== next.planMode) fields.planMode = next.planMode;
  if (previous.computerMode !== next.computerMode) fields.computerMode = next.computerMode;
  if (previous.designMode !== next.designMode) fields.designMode = next.designMode;
  if (previous.teamMode !== next.teamMode) fields.teamMode = next.teamMode;
  if (previous.team !== next.team) fields.team = next.team;
  return fields;
}

/**
 * active 通道的一次基线（每个 sessionId 一份）。
 *
 * `revision` 必填：它就是 `state.resume.patch` 的基线令牌（`baseRevision`）。
 * 消息/执行数组与快照同引用，不复制大会话正文。
 */
export interface ActiveBaseline {
  sessionId: string;
  revision: number;
  snapshot: RuntimeSnapshot;
  messages: ChatMessage[];
  executions: ToolExecution[];
}

/** 一次发帧：全量 state / 同会话补丁 / 切回旧会话的定向增量。 */
export type ActiveFrame =
  | { type: "state"; snapshot: RuntimeSnapshot }
  | RuntimeStatePatch
  | RuntimeResumePatch;

export interface ActiveEmitOptions {
  /** 强制全量（`state.sync`、`state.recover`）：不看旧基线，直接分配新 revision。 */
  forceFull?: boolean;
}

export interface ActiveEmitter {
  /** 决定下一帧；`undefined` = 同一会话且毫无变化，无需发帧。 */
  plan(next: RuntimeSnapshot, options?: ActiveEmitOptions): ActiveFrame | undefined;
  /** 会话销毁：释放该会话的基线（之后切回走全量，不会基于已删基线发 resume）。 */
  drop(sessionId: string): void;
  /** 全局重同步：清空所有基线（revision 序号继续单调递增，不回绕）。 */
  reset(): void;
  /** 当前全局发帧序号（诊断/测试用）。 */
  revision(): number;
  /** 某会话是否仍有基线（诊断/测试用；会刷新该条目的 LRU 位置）。 */
  hasBaseline(sessionId: string | undefined): boolean;
}

export function createActiveEmitter(capacity: number = MAX_SESSION_BASELINES): ActiveEmitter {
  const baselines: SessionBaselineCache<ActiveBaseline> = createSessionBaselineCache<ActiveBaseline>(capacity);
  let revision = 0;
  /**
   * 最近一次 active 发帧的目标会话。它是「同一会话继续流式」与「切回旧会话」的唯一
   * 区分依据：只有当目标与它不同、且目标**自己有**基线时才发 `state.resume.patch`。
   */
  let lastSessionId: string | undefined;

  function store(sessionId: string, frameRevision: number, next: RuntimeSnapshot, executions: ToolExecution[]): void {
    baselines.set({
      sessionId,
      revision: frameRevision,
      messages: next.messages,
      executions,
      // 基线快照的 messages/executions 指向同一批数组（不复制大会话正文）。
      snapshot: { ...next, revision: frameRevision, executions }
    });
  }

  return {
    plan(next: RuntimeSnapshot, options?: ActiveEmitOptions): ActiveFrame | undefined {
      const sessionId = next.sessionId;
      // 没有激活会话（启动/落地页）时一律全量：这种「无会话」帧本身很小（消息与
      // 执行都是空数组），键控基线在这里既没有键也没有意义。
      const previous = options?.forceFull || !sessionId ? undefined : baselines.get(sessionId);
      if (!sessionId || !previous) {
        const frameRevision = ++revision;
        const executions = executionSnapshots(next.executions, undefined);
        const snapshot: RuntimeSnapshot = { ...next, revision: frameRevision };
        if (sessionId) store(sessionId, frameRevision, next, executions);
        lastSessionId = sessionId;
        return { type: "state", snapshot };
      }

      const fields = activeFieldsPatch(previous.snapshot, next);
      const messages = diffChatMessages(previous.messages, next.messages);
      const { patch: executions, snapshots } = diffToolExecutions(previous.executions, next.executions);
      const resumed = lastSessionId !== sessionId;
      // 同一会话且毫无变化就不要占用 revision（否则接收端会看到序号断档，
      // 白白触发一次定向恢复）。
      if (!resumed && !messages && !executions && Object.keys(fields).every((key) => key === "sessionId")) return undefined;
      const frameRevision = ++revision;
      fields.revision = frameRevision;
      store(sessionId, frameRevision, next, snapshots);
      lastSessionId = sessionId;
      if (resumed) {
        return {
          type: "state.resume.patch",
          sessionId,
          baseRevision: previous.revision,
          snapshot: fields,
          messages,
          executions
        };
      }
      return { type: "state.patch", snapshot: fields, messages, executions };
    },
    drop(sessionId: string): void {
      baselines.delete(sessionId);
      if (lastSessionId === sessionId) lastSessionId = undefined;
    },
    reset(): void {
      baselines.clear();
      lastSessionId = undefined;
    },
    revision(): number {
      return revision;
    },
    hasBaseline(sessionId: string | undefined): boolean {
      return Boolean(sessionId && baselines.get(sessionId));
    }
  };
}
