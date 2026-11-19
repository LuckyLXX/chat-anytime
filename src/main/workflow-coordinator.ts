import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * 工作流工作区运行协调器：跨实例目录锁。
 * mkdir 原子占用 <agentDir>/pidesktop-workflows/locks/<workspaceHash>，
 * owner.json 记录实例与 run。记录缺失或损坏时保守拒绝，不猜测是否可以回收。
 * 确认 PID 已退出后，在同级回收互斥下复核 owner 再删除旧目录，避免两个回收者
 * 误删彼此新锁；互斥残留也保守拒绝。signal 0 只用于存在性检查，不结束进程。
 */

/** 锁记录文件名（锁目录创建成功后写入）。 */
export const WORKFLOW_LOCK_FILE_NAME = "owner.json";
/** 死锁回收期间的一次性互斥文件名（同一工作区锁目录内）。 */
export const WORKFLOW_RECLAIM_FILE_NAME = "reclaim.lock";

const LOCK_RECORD_VERSION = 1;
/** 抢锁循环上限：正常路径只需要 1–3 轮（EEXIST → 读 → 抢）。 */
const ACQUIRE_ATTEMPTS = 4;
/** runId 长度上限（只防脏数据，不参与语义）。 */
const MAX_RUN_ID_LENGTH = 256;

/** 进程存活三态：`unknown` 永远按「不能回收」处理。 */
export type WorkflowProcessLiveness = "alive" | "dead" | "unknown";

/** 锁记录：写进 `owner.json` 的归属凭证。 */
export interface WorkflowLockOwner {
  version: typeof LOCK_RECORD_VERSION;
  /** 本实例标识（每个协调器一份），用来区分 dev 实例 / 安装版 / 同进程的其他协调器。 */
  instanceId: string;
  /** 持有进程 PID（utility 进程）。 */
  pid: number;
  /** 持有这把锁的工作流运行。 */
  runId: string;
  /** 抢到锁的墙钟时间（ms）。 */
  startedAt: number;
  /** 归一化后的工作区真实路径，只用于诊断。 */
  workspace: string;
}

export interface WorkflowCoordinatorOptions {
  /** 运行记录与锁的根目录（`<agentDir>`）。 */
  agentDir: string;
  /** 本实例标识；缺省随机 UUID（测试注入固定值）。 */
  instanceId?: string;
  /** 本进程 PID；缺省 `process.pid`（测试注入）。 */
  pid?: number;
  /** 时间源；缺省 `Date.now`（测试注入）。 */
  now?: () => number;
  /** 进程存活检查；缺省 {@link processLiveness}（测试注入）。 */
  liveness?: (pid: number) => WorkflowProcessLiveness;
}

export interface WorkflowLockRequest {
  /** 工作区路径（可为任意绝对写法；协调器负责 realpath 归一化）。 */
  workspace: string;
  /** 要占用工作区的运行。 */
  runId: string;
}

/** 抢到的锁。释放是幂等的：重复释放不会删除别人之后抢到的锁。 */
export interface WorkflowLockLease {
  /** 归一化工作区键（锁目录名由它派生）。 */
  readonly key: string;
  /** 本实例写进 `owner.json` 的记录。 */
  readonly owner: WorkflowLockOwner;
  /** 释放（只删自己那份；归属不符时保守失败、不删除）。 */
  release(): WorkflowLockReleaseResult;
}

export type WorkflowLockAcquireResult =
  | { ok: true; lease: WorkflowLockLease }
  | {
      ok: false;
      /** 已有存活实例持有：直接返回现场摘要（不排队、不等待）。 */
      reason: "conflict";
      holder: WorkflowLockOwner;
      summary: string;
    }
  | {
      ok: false;
      /** 判定不确定（未知存活、回收互斥被占、重试不收敛）：保守拒绝启动。 */
      reason: "indeterminate" | "corrupt" | "error";
      message: string;
    };

export type WorkflowLockReleaseResult =
  | { ok: true; released: boolean }
  | { ok: false; reason: "not-owner" | "corrupt" | "error"; message: string };

/** 只读查询（启动对账 / 「其他实例运行中」展示用），绝不写盘。 */
export interface WorkflowLockInspectResult {
  state: "free" | "held" | "stale" | "corrupt" | "indeterminate" | "unavailable";
  /** 归一化工作区真实路径；无法解析时回退为入参。 */
  workspace: string;
  key: string;
  lockFile: string;
  holder?: WorkflowLockOwner;
  message?: string;
}

/** 窄同步 API：构造一次，之后所有方法都是同步的（临界区里没有 await 点）。 */
export interface WorkflowCoordinator {
  readonly instanceId: string;
  readonly pid: number;
  readonly agentDir: string;
  /**
   * 抢工作区锁。
   * - `ok:true` → 拿到 lease，运行结束（**清理完成之后**）才能 `release()`。
   * - `reason:"conflict"` → 别的（或本实例的另一个）运行占着，`summary` 可直接展示。
   * - `reason:"indeterminate" | "corrupt" | "error"` → 保守拒绝，`message` 带可诊断信息。
   */
  acquire(request: WorkflowLockRequest): WorkflowLockAcquireResult;
  /**
   * 按工作区 + runId 释放（归属校验：只删 instanceId 与 runId 都匹配的记录）。
   * 记录已不在时返回 `{ok:true, released:false}`（幂等）。
   */
  release(request: WorkflowLockRequest): WorkflowLockReleaseResult;
  /** 只读查询当前锁状态（不创建目录、不写盘）。 */
  inspect(workspace: string): WorkflowLockInspectResult;
  /** 进程收尾用：释放本实例持有的全部锁，返回实际删除的数量。 */
  releaseAll(): number;
}

export function createWorkflowCoordinator(options: WorkflowCoordinatorOptions): WorkflowCoordinator {
  return new WorkflowCoordinatorImpl(options);
}

/**
 * 工作区路径归一化键：分隔符统一成 `/`、去掉尾部多余分隔符；`win32` 再整体转小写
 * （Windows 大小写不敏感）。平台可注入，测试能在 Windows 上覆盖 POSIX 分支。
 */
export function workspaceLockKey(realPath: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = realPath.replaceAll("\\", "/");
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/u, "") || "/" : slashed;
  if (platform !== "win32") return trimmed;
  const lower = trimmed.toLowerCase();
  // 盘符根目录 "c:" 补回斜杠，避免和 "c:/" 两种写法分叉。
  return /^[a-z]:$/u.test(lower) ? `${lower}/` : lower;
}

/** 工作区锁目录：`<agentDir>/pidesktop-workflows/locks/<hash>`（hash 由 {@link workspaceLockKey} 派生）。 */
export function workflowLockDir(agentDir: string, key: string): string {
  const hash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
  return join(agentDir, "pidesktop-workflows", "locks", hash);
}

/**
 * 进程存活探测（Windows / POSIX 同一套）：signal 0 不投递信号，只做存在性检查。
 *
 * - 已退出 → ESRCH → `"dead"`（**唯一**允许触发回收的结果）。
 * - 存在但当前用户无权操作 → EPERM / EACCES → `"alive"`（保守）。
 * - 其余错误、非法 pid → `"unknown"`：调用方必须保守拒绝，不能当成已退出。
 *
 * 刻意不复用 `background-processes.isProcessAlive`：那个布尔口径把未知错误算成
 * 「不存在」，在这条路径上会导致误回收（两个运行同时跑）。
 */
export function processLiveness(pid: number): WorkflowProcessLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "dead";
    // EPERM / EACCES：进程存在，只是当前用户碰不得（Windows 上受保护进程会给 EACCES）。
    if (code === "EPERM" || code === "EACCES") return "alive";
    return "unknown";
  }
}

type LockRead = { state: "missing" } | { state: "corrupt"; message: string } | { state: "ok"; owner: WorkflowLockOwner };

type ClaimResult = "claimed" | "exists" | { error: string };

type ReclaimOutcome = { kind: "claimed" } | { kind: "retry" } | { kind: "busy"; message: string } | { kind: "error"; message: string };

class WorkflowCoordinatorImpl implements WorkflowCoordinator {
  readonly instanceId: string;
  readonly pid: number;
  readonly agentDir: string;
  private readonly now: () => number;
  private readonly liveness: (pid: number) => WorkflowProcessLiveness;
  /** 本实例当前持有的锁（key → 记录）：双抢同一工作区在进程内就能当场拒绝。 */
  private readonly held = new Map<string, WorkflowLockOwner>();

  constructor(options: WorkflowCoordinatorOptions) {
    this.agentDir = options.agentDir;
    this.instanceId = options.instanceId?.trim() || randomUUID();
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.liveness = options.liveness ?? processLiveness;
  }

  acquire(request: WorkflowLockRequest): WorkflowLockAcquireResult {
    const runId = typeof request.runId === "string" ? request.runId.trim() : "";
    if (!runId) return { ok: false, reason: "error", message: "工作流运行 id 为空，拒绝抢工作区锁" };
    if (runId.length > MAX_RUN_ID_LENGTH) {
      return { ok: false, reason: "error", message: `工作流运行 id 过长（${runId.length} > ${MAX_RUN_ID_LENGTH}）：${runId.slice(0, 32)}…` };
    }
    const resolved = this.canonical(request.workspace);
    if (!resolved.ok) return { ok: false, reason: "error", message: resolved.message };
    const { canonical, key } = resolved;
    const lockDir = workflowLockDir(this.agentDir, key);
    const lockFile = join(lockDir, WORKFLOW_LOCK_FILE_NAME);

    const heldHere = this.held.get(key);
    if (heldHere) return { ok: false, reason: "conflict", holder: heldHere, summary: conflictSummary(heldHere, this.instanceId) };

    try {
      mkdirSync(dirname(lockDir), { recursive: true });
    } catch (error) {
      return { ok: false, reason: "error", message: `无法创建工作流锁目录（${describeError(error)}）：${lockDir}` };
    }

    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      const owner: WorkflowLockOwner = {
        version: LOCK_RECORD_VERSION,
        instanceId: this.instanceId,
        pid: this.pid,
        runId,
        startedAt: this.now(),
        workspace: canonical
      };
      const claim = this.createLockFile(lockFile, owner);
      if (claim === "claimed") return this.grant(key, owner);
      if (claim !== "exists") return { ok: false, reason: "error", message: claim.error };

      // 有人占着：先判定它是活的、死了、还是判不出来。
      const read = readLockOwner(lockFile);
      if (read.state === "missing") {
        if (existsSync(lockDir)) return { ok: false, reason: "corrupt", message: `工作区锁目录存在但 owner.json 缺失：${lockDir}` };
        continue;
      }
      if (read.state === "corrupt") {
        return {
          ok: false,
          reason: "corrupt",
          message: `工作区锁记录损坏或不可读（${read.message}）：${lockFile}。为避免抢占他人运行，本次拒绝启动；确认无进程在运行后可删除该文件重试。`
        };
      }
      const holder = read.owner;
      if (holder.instanceId === this.instanceId) {
        return { ok: false, reason: "conflict", holder, summary: conflictSummary(holder, this.instanceId) };
      }
      const liveness = this.liveness(holder.pid);
      if (liveness === "alive") return { ok: false, reason: "conflict", holder, summary: conflictSummary(holder, this.instanceId) };
      if (liveness === "unknown") {
        return {
          ok: false,
          reason: "indeterminate",
          message: `无法确定工作区锁的持有进程 PID ${holder.pid} 是否存活（锁文件 ${lockFile}）。为避免双开，本次拒绝启动；确认该进程已退出后可删除锁文件重试。`
        };
      }

      const reclaim = this.reclaimDeadLock(lockDir, lockFile, owner);
      if (reclaim.kind === "claimed") return this.grant(key, owner);
      if (reclaim.kind === "busy") return { ok: false, reason: "indeterminate", message: reclaim.message };
      if (reclaim.kind === "error") return { ok: false, reason: "error", message: reclaim.message };
      // kind === "retry"：状态在窗口里变了，重新判定。
    }

    return {
      ok: false,
      reason: "indeterminate",
      message: `回收工作区死锁时状态持续变化，重试 ${ACQUIRE_ATTEMPTS} 次仍未收敛：${lockFile}`
    };
  }

  release(request: WorkflowLockRequest): WorkflowLockReleaseResult {
    const resolved = this.canonical(request.workspace);
    if (!resolved.ok) return { ok: false, reason: "error", message: resolved.message };
    const runId = typeof request.runId === "string" ? request.runId.trim() : "";
    return this.releaseKey(resolved.key, runId);
  }

  inspect(workspace: string): WorkflowLockInspectResult {
    const resolved = this.canonical(workspace);
    if (!resolved.ok) return { state: "unavailable", workspace, key: "", lockFile: "", message: resolved.message };
    const { canonical, key } = resolved;
    const lockFile = join(workflowLockDir(this.agentDir, key), WORKFLOW_LOCK_FILE_NAME);
    const read = readLockOwner(lockFile);
    if (read.state === "missing") return { state: existsSync(dirname(lockFile)) ? "corrupt" : "free", workspace: canonical, key, lockFile, ...(existsSync(dirname(lockFile)) ? { message: "锁目录存在但 owner.json 缺失" } : {}) };
    if (read.state === "corrupt") return { state: "corrupt", workspace: canonical, key, lockFile, message: read.message };
    const liveness = this.liveness(read.owner.pid);
    if (liveness === "alive") return { state: "held", workspace: canonical, key, lockFile, holder: read.owner };
    if (liveness === "dead") return { state: "stale", workspace: canonical, key, lockFile, holder: read.owner };
    return {
      state: "indeterminate",
      workspace: canonical,
      key,
      lockFile,
      holder: read.owner,
      message: `无法确定持有进程 PID ${read.owner.pid} 是否存活`
    };
  }

  releaseAll(): number {
    let released = 0;
    for (const [key, owner] of [...this.held]) {
      const result = this.releaseKey(key, owner.runId);
      if (result.ok && result.released) released += 1;
    }
    this.held.clear();
    return released;
  }

  private grant(key: string, owner: WorkflowLockOwner): WorkflowLockAcquireResult {
    this.held.set(key, owner);
    const lease: WorkflowLockLease = {
      key,
      owner,
      release: () => this.releaseKey(key, owner.runId)
    };
    return { ok: true, lease };
  }

  /**
   * 删除**自己**那份记录。归属校验在删除前完成：instanceId 与 runId 必须同时匹配。
   * 记录损坏时不删（无法证明是自己的）；记录已不在时按幂等成功处理。
   */
  private releaseKey(key: string, runId: string): WorkflowLockReleaseResult {
    const lockDir = workflowLockDir(this.agentDir, key);
    const lockFile = join(lockDir, WORKFLOW_LOCK_FILE_NAME);
    const read = readLockOwner(lockFile);
    if (read.state === "missing") {
      this.held.delete(key);
      return { ok: true, released: false };
    }
    if (read.state === "corrupt") {
      return {
        ok: false,
        reason: "corrupt",
        message: `工作区锁记录损坏或不可读（${read.message}），无法确认归属，未删除：${lockFile}`
      };
    }
    if (read.owner.instanceId !== this.instanceId || read.owner.runId !== runId) {
      return {
        ok: false,
        reason: "not-owner",
        message: `工作区锁不属于本实例（持有者：${describeHolder(read.owner)}），未删除：${lockFile}`
      };
    }
    try {
      unlinkSync(lockFile);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return { ok: false, reason: "error", message: `无法删除工作区锁文件（${describeError(error)}）：${lockFile}` };
      }
    }
    this.held.delete(key);
    // 只清空目录：里面还有别的实例的回收互斥文件时留着（ENOTEMPTY 直接忽略）。
    try {
      rmdirSync(lockDir);
    } catch {
      /* 目录非空或被占用：不影响锁的语义 */
    }
    return { ok: true, released: true };
  }

  /** 以原子 mkdir 抢锁目录，再写入归属记录；失败保留可诊断的损坏锁。 */
  private createLockFile(lockFile: string, owner: WorkflowLockOwner): ClaimResult {
    let fd: number;
    const lockDir = dirname(lockFile);
    try {
      mkdirSync(lockDir);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return "exists";
      return { error: `无法原子创建锁目录（${describeError(error)}）：${lockDir}` };
    }
    try {
      fd = openSync(lockFile, "wx");
    } catch (error) {
      try { rmdirSync(lockDir); } catch { /* 留下可诊断的损坏锁 */ }
      return { error: `无法创建锁记录（${describeError(error)}）：${lockFile}` };
    }
    try {
      writeSync(fd, JSON.stringify(owner));
    } catch (error) {
      closeQuietly(fd);
      // 半成品记录会被后来者判成「损坏」并卡住：刚才是自己独占创建的，删掉是安全的。
      try {
        unlinkSync(lockFile);
        rmdirSync(lockDir);
      } catch {
        /* 尽力清理 */
      }
      return { error: `无法写入锁记录（${describeError(error)}）：${lockFile}` };
    }
    closeQuietly(fd);
    return "claimed";
  }

  /**
   * 回收「确定已死」的旧锁并立刻抢锁。整个过程在 `reclaim.lock` 互斥之下进行，
   * 见文件头注释：互斥内重新读盘并复核存活，是防「误删别人的新锁」的关键。
   */
  private reclaimDeadLock(lockDir: string, lockFile: string, owner: WorkflowLockOwner): ReclaimOutcome {
    const mutexFile = join(dirname(lockDir), `${basename(lockDir)}.${WORKFLOW_RECLAIM_FILE_NAME}`);
    let fd: number;
    try {
      fd = openSync(mutexFile, "wx");
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        return { kind: "error", message: `无法创建回收互斥文件（${describeError(error)}）：${mutexFile}` };
      }
      const mutexRead = readReclaimMutex(mutexFile);
      const holder = mutexRead.state === "ok" ? `占用 PID ${mutexRead.pid}` : `占用信息不可读（${mutexRead.state === "missing" ? "文件已消失" : mutexRead.message}）`;
      return {
        kind: "busy",
        message: `另一个实例正在回收该工作区锁（互斥文件 ${mutexFile}，${holder}）。本次拒绝启动；若确认没有实例在运行，可手动删除该互斥文件后重试。`
      };
    }
    try {
      writeSync(fd, JSON.stringify({ instanceId: this.instanceId, pid: this.pid, startedAt: this.now() }));
    } catch {
      closeQuietly(fd);
      try {
        unlinkSync(mutexFile);
      } catch {
        /* 尽力清理 */
      }
      return { kind: "error", message: `无法写入回收互斥文件：${mutexFile}` };
    }
    closeQuietly(fd);

    try {
      // 复核：互斥内重新读盘 —— 窗口里可能被释放、被别的回收者换掉、或持有者又活了。
      // 「当前记录的进程仍然确定不存在」是唯一的删除依据；读不到/换人/变活都放弃本轮。
      const current = readLockOwner(lockFile);
      if (current.state !== "ok") return { kind: "retry" };
      if (current.owner.instanceId === this.instanceId) return { kind: "retry" };
      if (this.liveness(current.owner.pid) !== "dead") return { kind: "retry" };
      try {
        unlinkSync(lockFile);
        rmdirSync(lockDir);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          return { kind: "error", message: `无法删除陈旧工作区锁（${describeError(error)}）：${lockDir}` };
        }
      }
      // 持着互斥立刻抢：普通抢锁者可能抢先（它不是回收者，不删任何东西），抢先就重试。
      const claim = this.createLockFile(lockFile, owner);
      if (claim === "claimed") return { kind: "claimed" };
      if (claim === "exists") return { kind: "retry" };
      return { kind: "error", message: claim.error };
    } finally {
      try {
        unlinkSync(mutexFile);
      } catch {
        /* 尽力清理；残留会让下次回收保守失败并给出路径 */
      }
    }
  }

  private canonical(workspace: string): { ok: true; canonical: string; key: string } | { ok: false; message: string } {
    if (typeof workspace !== "string" || !workspace.trim()) return { ok: false, message: "工作区路径为空" };
    // 相对路径会隐式吃 cwd（桌面应用里 cwd 不是用户工作区），直接拒绝。
    if (!isAbsolute(workspace)) return { ok: false, message: `工作区必须是绝对路径：${workspace}` };
    let real: string;
    try {
      real = realpathSync.native(workspace);
    } catch (error) {
      return { ok: false, message: `无法解析工作区真实路径（${describeError(error)}）：${workspace}` };
    }
    return { ok: true, canonical: real, key: workspaceLockKey(real) };
  }
}

/** 归属摘要：直接可展示，说明是哪个运行、哪个实例、从什么时候开始。 */
function describeHolder(owner: WorkflowLockOwner): string {
  return `run ${owner.runId}（实例 ${owner.instanceId}，PID ${owner.pid}，开始于 ${new Date(owner.startedAt).toISOString()}）`;
}

/** 冲突摘要（§5.2「冲突直接返回现有 run 摘要」）。 */
function conflictSummary(owner: WorkflowLockOwner, selfInstanceId: string): string {
  const scope = owner.instanceId === selfInstanceId ? "本实例" : "其他实例";
  return `工作区已有${scope}的工作流运行：${describeHolder(owner)}`;
}

function readLockOwner(lockFile: string): LockRead {
  let raw: string;
  try {
    raw = readFileSync(lockFile, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "missing" };
    return { state: "corrupt", message: `${describeError(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "corrupt", message: "内容不是合法 JSON" };
  }
  const owner = normalizeLockOwner(parsed);
  if (!owner) return { state: "corrupt", message: "记录字段不完整或类型不符" };
  return { state: "ok", owner };
}

/** 严格校验：字段缺失/类型不符一律视为损坏（不猜、不补默认值）。 */
function normalizeLockOwner(raw: unknown): WorkflowLockOwner | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== LOCK_RECORD_VERSION) return undefined;
  if (typeof value.instanceId !== "string" || !value.instanceId.trim()) return undefined;
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
  if (typeof value.runId !== "string" || !value.runId.trim()) return undefined;
  if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || value.startedAt <= 0) return undefined;
  if (typeof value.workspace !== "string") return undefined;
  return {
    version: LOCK_RECORD_VERSION,
    instanceId: value.instanceId,
    pid: value.pid as number,
    runId: value.runId,
    startedAt: value.startedAt,
    workspace: value.workspace
  };
}

function readReclaimMutex(mutexFile: string): { state: "missing" } | { state: "corrupt"; message: string } | { state: "ok"; pid: number } {
  let raw: string;
  try {
    raw = readFileSync(mutexFile, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "missing" };
    return { state: "corrupt", message: describeError(error) };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0) return { state: "ok", pid: parsed.pid as number };
  } catch {
    /* 落到损坏分支 */
  }
  return { state: "corrupt", message: "内容不是合法 JSON" };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function describeError(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* 已关闭 */
  }
}
