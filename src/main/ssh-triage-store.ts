import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  SSH_TRIAGE_CARD_LIMITS,
  SSH_TRIAGE_KEEP_BATCHES,
  SSH_TRIAGE_LOG_LIMIT_CHARS,
  SSH_TRIAGE_MAX_TOTAL_BYTES,
  describeSshTriageCheck,
  sshEndpointKey,
  validateSshTriageCheck
} from "../shared/ssh-triage.js";
import type {
  SshTriageBatchStatus,
  SshTriageBatchSummary,
  SshTriageCard,
  SshTriageCardDirectory,
  SshTriageCardSummary,
  SshTriageCheckKind,
  SshTriageCheckRequest,
  SshTriageCheckResult,
  SshTriageCheckStatus,
  SshTriageFailure,
  SshTriageHostSnapshot,
  SshTriageHostStatus
} from "../shared/ssh-triage.js";

/**
 * SSH 后台排查的持久化：`<userData>/pidesktop-ssh-triage/`。
 *
 * 布局（版本化，读侧一律宽容归一化——单条脏数据绝不拖垮整个历史）：
 * ```
 * index.json                       { version: 1, batches: [ 批次元数据（按新→旧，已裁剪） ] }
 * logs/<batchId>/<name>.log        逐主机逐检查项的有界文本（只保留尾部）
 * cards.json                       { version: 1, cards: [ 主机卡片 ] }
 * ```
 *
 * 三条写入纪律：
 * 1. **元数据原子写**：tmp + rename，任何时刻磁盘上要么是旧版要么是新版。
 * 2. **日志合并写**：采集过程中按短间隔（缺省 200ms）把脏日志一起落盘，检查收尾时
 *    再写一次终态。「在途断开保留当前项部分输出」靠的就是这层——崩溃时最多丢最后
 *    一个合并窗口的字节。
 * 3. **写失败不打断采集**：所有写盘异常只经 onError 上报（面板单独提示），连接与
 *    批次调度照常收尾——磁盘满不该让用户以为 SSH 挂了。
 *
 * 另有两处「状态诚实」规则：
 * - 启动时把遗留的 `running` 批次归档为**应用中断**（在途主机 → interrupted、排队主机
 *   → not-run），已采集的检查与输出原样保留；
 * - 裁剪只看已结束的批次（活动批次永不裁）：先按最近 SSH_TRIAGE_KEEP_BATCHES 批，
 *   再按目录总量上限淘汰最旧的。
 */

/** 落库的单项检查：共享类型去掉 output 正文（正文在日志文件里），加日志文件名。 */
export interface SshTriageStoredCheck extends Omit<SshTriageCheckResult, "output"> {
  /** 日志文件名（相对 `logs/<batchId>/`）；无输出时缺省。 */
  log?: string;
}

/** 落库的主机记录（主进程内部形状）：`current` / `endpointChanged` / `hostMissing` 是读取时现算的，不落盘。 */
export interface SshTriageStoredHost {
  /** 创建批次时的主机身份快照（排队期间主机被编辑也不连新地址）。 */
  snapshot: SshTriageHostSnapshot;
  status: SshTriageHostStatus;
  reason?: string;
  startedAt?: number;
  endedAt?: number;
  checksDone: number;
  checksTotal: number;
  checks: SshTriageStoredCheck[];
}

/** 落库的批次（主进程内部形状）：`checkLabels` 由 checks 派生，不落盘。 */
export interface SshTriageStoredBatch {
  id: string;
  title: string;
  status: SshTriageBatchStatus;
  createdAt: number;
  endedAt?: number;
  checks: SshTriageCheckRequest[];
  sourceBatchId?: string;
  hosts: SshTriageStoredHost[];
}

export interface SshTriageStoreLimits {
  keepBatches?: number;
  maxTotalBytes?: number;
  logLimitChars?: number;
  /** 日志合并写间隔（ms）。 */
  logFlushMs?: number;
  /** 元数据合并写间隔（ms）。 */
  indexFlushMs?: number;
}

export interface SshTriageStore {
  readonly dir: string;
  /** 全部批次（新→旧）；启动时已把遗留的活动记录归档为应用中断。 */
  list(): SshTriageStoredBatch[];
  get(id: string): SshTriageStoredBatch | undefined;
  /** 新建或更新（内存立即生效；写盘按短间隔合并，flush() 立即写）。 */
  put(batch: SshTriageStoredBatch): void;
  /** 分配本批次内唯一的日志名（`h<host>-<check>.log`）。 */
  logName(batchId: string, hostIndex: number, checkIndex: number): string;
  /** 追写日志（有界，只保留尾部）。 */
  appendLog(batchId: string, logName: string, chunk: string): void;
  /** 覆盖写日志（检查收尾时用最终文本定型）。 */
  writeLog(batchId: string, logName: string, text: string): void;
  readLog(batchId: string, logName: string): string | undefined;
  flush(): void;
  /** 按保留上限裁剪（活动批次不裁）。 */
  prune(): void;
  /** 停掉定时器并 flush（应用退出前调用）。 */
  dispose(): void;
}

const INDEX_VERSION = 1;
const CARDS_VERSION = 1;
const DEFAULT_LOG_FLUSH_MS = 200;
const DEFAULT_INDEX_FLUSH_MS = 150;

const BATCH_STATUSES: readonly SshTriageBatchStatus[] = ["running", "finished", "stopped", "interrupted"];
const HOST_STATUSES: readonly SshTriageHostStatus[] = ["queued", "running", "passed", "warning", "failed", "error", "stopped", "interrupted", "not-run"];
const CHECK_STATUSES: readonly SshTriageCheckStatus[] = ["pending", "running", "pass", "warning", "fail", "error", "skipped"];
const CHECK_KINDS: readonly SshTriageCheckKind[] = ["service", "port", "disk", "journal"];

/** 原子写（tmp + rename）：任何时刻磁盘上的文件都是旧版或新版，不会是半截 JSON。 */
function writeAtomic(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, filePath);
}

function readJson(filePath: string): unknown {
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 目录/文件名白名单：批次 id 与日志名都只允许这一组字符（防路径穿越）。 */
function safeToken(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : undefined;
}

const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LOG_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}\.log$/;

function normalizeCheckRequest(raw: unknown): SshTriageCheckRequest | undefined {
  if (validateSshTriageCheck(raw) !== undefined) return undefined;
  const check = raw as Record<string, unknown>;
  switch (check.kind) {
    case "service":
      return { kind: "service", unit: String(check.unit).trim() };
    case "port":
      return {
        kind: "port",
        port: Math.round(check.port as number),
        ...(check.protocol === "udp" ? { protocol: "udp" as const } : {})
      };
    case "disk":
      return {
        kind: "disk",
        path: String(check.path).trim(),
        ...(finiteNumber(check.warnPercent) !== undefined ? { warnPercent: finiteNumber(check.warnPercent)! } : {}),
        ...(finiteNumber(check.failPercent) !== undefined ? { failPercent: finiteNumber(check.failPercent)! } : {})
      };
    case "journal":
      return {
        kind: "journal",
        ...(typeof check.unit === "string" && check.unit.trim() ? { unit: check.unit.trim() } : {}),
        ...(finiteNumber(check.minutes) !== undefined ? { minutes: Math.round(finiteNumber(check.minutes)!) } : {})
      };
    default:
      return undefined;
  }
}

export function normalizeCheckRequests(raw: unknown): SshTriageCheckRequest[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: SshTriageCheckRequest[] = [];
  for (const item of raw) {
    const check = normalizeCheckRequest(item);
    if (!check) continue;
    // 同一种检查 + 同一参数只跑一次（重复勾选不该浪费一条远端命令）。
    const key = `${check.kind}|${describeSshTriageCheck(check)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(check);
  }
  return result;
}

function normalizeStoredCheck(raw: unknown): SshTriageStoredCheck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const check = raw as Record<string, unknown>;
  const kind = CHECK_KINDS.find((item) => item === check.kind);
  if (!kind) return undefined;
  const status = CHECK_STATUSES.find((item) => item === check.status) ?? "error";
  const exitCode = typeof check.exitCode === "number" && Number.isFinite(check.exitCode) ? Math.round(check.exitCode) : null;
  const outputChars = finiteNumber(check.outputChars) ?? 0;
  return {
    kind,
    label: typeof check.label === "string" && check.label.trim() ? check.label : kind,
    status,
    ...(typeof check.failure === "string" && check.failure ? { failure: check.failure as SshTriageFailure } : {}),
    exitCode,
    ...(typeof check.reason === "string" && check.reason ? { reason: check.reason } : {}),
    ...(finiteNumber(check.durationMs) !== undefined ? { durationMs: Math.round(finiteNumber(check.durationMs)!) } : {}),
    outputChars: Math.max(0, Math.round(outputChars)),
    ...(check.truncated === true ? { truncated: true } : {}),
    ...(safeToken(check.log, LOG_NAME_PATTERN) ? { log: safeToken(check.log, LOG_NAME_PATTERN)! } : {})
  };
}

function normalizeStoredHost(raw: unknown): SshTriageStoredHost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const host = raw as Record<string, unknown>;
  const snapshotRaw = (host.snapshot ?? {}) as Record<string, unknown>;
  const hostId = typeof snapshotRaw.hostId === "string" ? snapshotRaw.hostId.trim() : "";
  const address = typeof snapshotRaw.host === "string" ? snapshotRaw.host.trim() : "";
  const username = typeof snapshotRaw.username === "string" ? snapshotRaw.username.trim() : "";
  const port = finiteNumber(snapshotRaw.port);
  if (!hostId || !address || !username || port === undefined) return undefined;
  const status = HOST_STATUSES.find((item) => item === host.status) ?? "error";
  const checks = Array.isArray(host.checks)
    ? host.checks.map(normalizeStoredCheck).filter((item): item is SshTriageStoredCheck => item !== undefined)
    : [];
  return {
    snapshot: {
      hostId,
      displayName: typeof snapshotRaw.displayName === "string" && snapshotRaw.displayName.trim() ? snapshotRaw.displayName.trim() : `${username}@${address}`,
      host: address,
      port: Math.round(port),
      username
    },
    status,
    ...(typeof host.reason === "string" && host.reason ? { reason: host.reason } : {}),
    ...(finiteNumber(host.startedAt) !== undefined ? { startedAt: Math.round(finiteNumber(host.startedAt)!) } : {}),
    ...(finiteNumber(host.endedAt) !== undefined ? { endedAt: Math.round(finiteNumber(host.endedAt)!) } : {}),
    checksDone: finiteNumber(host.checksDone) ?? checks.filter((check) => check.status !== "pending" && check.status !== "running").length,
    checksTotal: finiteNumber(host.checksTotal) ?? checks.length,
    checks
  };
}

function normalizeStoredBatch(raw: unknown): SshTriageStoredBatch | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const batch = raw as Record<string, unknown>;
  const id = safeToken(batch.id, BATCH_ID_PATTERN);
  if (!id) return undefined;
  const createdAt = finiteNumber(batch.createdAt);
  if (createdAt === undefined) return undefined;
  const checks = normalizeCheckRequests(batch.checks);
  const hosts = Array.isArray(batch.hosts)
    ? batch.hosts.map(normalizeStoredHost).filter((item): item is SshTriageStoredHost => item !== undefined)
    : [];
  const status = BATCH_STATUSES.find((item) => item === batch.status) ?? "finished";
  return {
    id,
    title: typeof batch.title === "string" && batch.title.trim() ? batch.title.trim().slice(0, 80) : "排查批次",
    status,
    createdAt: Math.round(createdAt),
    ...(finiteNumber(batch.endedAt) !== undefined ? { endedAt: Math.round(finiteNumber(batch.endedAt)!) } : {}),
    checks,
    ...(typeof batch.sourceBatchId === "string" && safeToken(batch.sourceBatchId, BATCH_ID_PATTERN) ? { sourceBatchId: batch.sourceBatchId } : {}),
    hosts
  };
}

function checkLabelsOf(batch: Pick<SshTriageStoredBatch, "checks">): string[] {
  return batch.checks.map(describeSshTriageCheck);
}

/** 批次摘要（共享形状）：hosts 的 checks 明细不带，进度用 checksDone/Total。 */
export function batchSummaryOf(batch: SshTriageStoredBatch, storeError?: string): SshTriageBatchSummary {
  return {
    id: batch.id,
    title: batch.title,
    status: batch.status,
    createdAt: batch.createdAt,
    ...(batch.endedAt !== undefined ? { endedAt: batch.endedAt } : {}),
    checks: batch.checks,
    checkLabels: checkLabelsOf(batch),
    hosts: batch.hosts.map((host) => ({
      hostId: host.snapshot.hostId,
      displayName: host.snapshot.displayName,
      endpoint: sshEndpointKey(host.snapshot),
      status: host.status,
      ...(host.reason !== undefined ? { reason: host.reason } : {}),
      ...(host.startedAt !== undefined ? { startedAt: host.startedAt } : {}),
      ...(host.endedAt !== undefined ? { endedAt: host.endedAt } : {}),
      checksDone: host.checksDone,
      checksTotal: host.checksTotal
    })),
    ...(batch.sourceBatchId ? { sourceBatchId: batch.sourceBatchId } : {}),
    ...(storeError ? { storeError } : {})
  };
}

/** 递归统计目录体积（裁剪口径用；只在小目录上调用）。 */
function dirBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirBytes(full);
      else total += statSync(full).size;
    } catch {
      // 并发删除/权限问题：不计入即可
    }
  }
  return total;
}

export function createSshTriageStore(deps: {
  dir: string;
  limits?: SshTriageStoreLimits;
  /** 写盘失败上报（面板单独提示，绝不打断采集）。 */
  onError?: (message: string) => void;
  now?: () => number;
}): SshTriageStore {
  const now = deps.now ?? (() => Date.now());
  const keepBatches = Math.max(1, Math.round(deps.limits?.keepBatches ?? SSH_TRIAGE_KEEP_BATCHES));
  const maxTotalBytes = Math.max(0, Math.round(deps.limits?.maxTotalBytes ?? SSH_TRIAGE_MAX_TOTAL_BYTES));
  const logLimitChars = Math.max(256, Math.round(deps.limits?.logLimitChars ?? SSH_TRIAGE_LOG_LIMIT_CHARS));
  const logFlushMs = Math.max(16, Math.round(deps.limits?.logFlushMs ?? DEFAULT_LOG_FLUSH_MS));
  const indexFlushMs = Math.max(16, Math.round(deps.limits?.indexFlushMs ?? DEFAULT_INDEX_FLUSH_MS));
  const indexPath = join(deps.dir, "index.json");
  const logsRoot = join(deps.dir, "logs");

  const report = (message: string): void => {
    try {
      deps.onError?.(message);
    } catch {
      // 上报本身失败不再递归
    }
  };

  let batches: SshTriageStoredBatch[] = (() => {
    const raw = readJson(indexPath) as { batches?: unknown } | undefined;
    const list = Array.isArray(raw?.batches) ? raw!.batches : [];
    return list.map(normalizeStoredBatch).filter((item): item is SshTriageStoredBatch => item !== undefined);
  })();

  const logCache = new Map<string, string>();
  const dirtyLogs = new Set<string>();
  const dirtyBatches = new Set<string>();
  let indexDirty = false;
  let logTimer: ReturnType<typeof setTimeout> | undefined;
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const logPath = (batchId: string, name: string): string | undefined => {
    const safeBatch = safeToken(batchId, BATCH_ID_PATTERN);
    const safeName = safeToken(name, LOG_NAME_PATTERN);
    if (!safeBatch || !safeName) return undefined;
    return join(logsRoot, safeBatch, safeName);
  };

  const capText = (text: string): string => (text.length > logLimitChars ? text.slice(text.length - logLimitChars) : text);

  const writeIndex = (): void => {
    indexDirty = false;
    try {
      writeAtomic(indexPath, JSON.stringify({ version: INDEX_VERSION, batches }, null, 2));
    } catch (error) {
      report(`排查记录落盘失败（不影响采集与连接）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const writeDirtyLogs = (): void => {
    if (dirtyLogs.size === 0) return;
    const pending = [...dirtyLogs];
    dirtyLogs.clear();
    for (const key of pending) {
      const [batchId, name] = key.split("\u0000");
      const target = batchId && name ? logPath(batchId, name) : undefined;
      if (!target) continue;
      try {
        writeAtomic(target, logCache.get(key) ?? "");
      } catch (error) {
        report(`排查日志落盘失败（连接与采集照常）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const scheduleLogFlush = (): void => {
    if (disposed || logTimer) return;
    logTimer = setTimeout(() => {
      logTimer = undefined;
      writeDirtyLogs();
    }, logFlushMs);
    logTimer.unref?.();
  };

  const scheduleIndexFlush = (): void => {
    if (disposed || indexTimer) return;
    indexTimer = setTimeout(() => {
      indexTimer = undefined;
      if (indexDirty) writeIndex();
    }, indexFlushMs);
    indexTimer.unref?.();
  };

  const markBatchDirty = (batchId: string): void => {
    dirtyBatches.add(batchId);
    indexDirty = true;
    scheduleIndexFlush();
  };

  /**
   * 启动归档：上一个进程留下的 `running` 批次一律改判为「应用中断」。
   * 状态只陈述已经确认的事实——我们无法知道那台机器在断电/退出后还在不在跑，
   * 所以既不补跑，也不谎称成功，只标明「未完成」并保留已采集的部分。
   */
  const archiveInterrupted = (): void => {
    const timestamp = now();
    let changed = false;
    for (const batch of batches) {
      if (batch.status !== "running") continue;
      changed = true;
      batch.status = "interrupted";
      batch.endedAt = batch.endedAt ?? timestamp;
      for (const host of batch.hosts) {
        if (host.status === "running") {
          host.status = "interrupted";
          host.reason = "应用退出/重启，采集被中断（已保留已采集的输出）";
          host.endedAt = host.endedAt ?? timestamp;
          for (const check of host.checks) {
            if (check.status === "running") {
              check.status = "error";
              check.failure = "disconnected";
              check.reason = "应用退出，该项未完成";
            } else if (check.status === "pending") {
              check.status = "skipped";
              check.reason = "应用退出，未执行";
            }
          }
        } else if (host.status === "queued") {
          host.status = "not-run";
          host.reason = "应用退出，未执行";
          for (const check of host.checks) {
            if (check.status === "running" || check.status === "pending") {
              check.status = "skipped";
              check.reason = "应用退出，未执行";
            }
          }
        }
        host.checksDone = host.checks.filter((check) => check.status !== "pending" && check.status !== "running").length;
      }
    }
    if (changed) writeIndex();
  };

  archiveInterrupted();
  batches.sort((a, b) => b.createdAt - a.createdAt);

  return {
    dir: deps.dir,
    list(): SshTriageStoredBatch[] {
      return batches;
    },
    get(id: string): SshTriageStoredBatch | undefined {
      return batches.find((batch) => batch.id === id);
    },
    put(batch: SshTriageStoredBatch): void {
      const index = batches.findIndex((item) => item.id === batch.id);
      if (index >= 0) batches[index] = batch;
      else {
        batches.unshift(batch);
        batches.sort((a, b) => b.createdAt - a.createdAt);
      }
      markBatchDirty(batch.id);
    },
    logName(_batchId: string, hostIndex: number, checkIndex: number): string {
      return `h${hostIndex}-${checkIndex}.log`;
    },
    appendLog(batchId: string, name: string, chunk: string): void {
      if (!chunk) return;
      const key = `${batchId}\u0000${name}`;
      const previous = logCache.get(key) ?? this.readLog(batchId, name) ?? "";
      const next = capText(previous + chunk);
      if (next === previous) return;
      logCache.set(key, next);
      dirtyLogs.add(key);
      scheduleLogFlush();
    },
    writeLog(batchId: string, name: string, text: string): void {
      const key = `${batchId}\u0000${name}`;
      const next = capText(text);
      logCache.set(key, next);
      dirtyLogs.add(key);
      scheduleLogFlush();
    },
    readLog(batchId: string, name: string): string | undefined {
      const key = `${batchId}\u0000${name}`;
      const cached = logCache.get(key);
      if (cached !== undefined) return cached;
      const target = logPath(batchId, name);
      if (!target) return undefined;
      try {
        return existsSync(target) ? readFileSync(target, "utf8") : undefined;
      } catch {
        return undefined;
      }
    },
    flush(): void {
      if (logTimer) {
        clearTimeout(logTimer);
        logTimer = undefined;
      }
      if (indexTimer) {
        clearTimeout(indexTimer);
        indexTimer = undefined;
      }
      writeDirtyLogs();
      if (indexDirty) writeIndex();
      dirtyBatches.clear();
    },
    prune(): void {
      this.flush();
      const sorted = [...batches].sort((a, b) => b.createdAt - a.createdAt);
      const keep: SshTriageStoredBatch[] = [];
      let history = 0;
      for (const batch of sorted) {
        const active = batch.status === "running";
        if (active) {
          // 活动批次永不被「最近 N 批」这条规则裁掉。
          keep.push(batch);
          continue;
        }
        if (history < keepBatches) {
          history += 1;
          keep.push(batch);
        }
      }
      const keptIds = new Set(keep.map((batch) => batch.id));
      let changed = false;
      for (const batch of batches) {
        if (keptIds.has(batch.id)) continue;
        changed = true;
        try {
          rmSync(join(logsRoot, batch.id), { recursive: true, force: true });
        } catch {
          // 删除失败就留给下次
        }
      }
      if (changed) {
        batches = keep;
        batches.sort((a, b) => b.createdAt - a.createdAt);
        indexDirty = true;
      }
      // 总量上限：从最旧的已结束批次开始淘汰（活动批次永不裁）。
      const sizeOf = (batchId: string): number => dirBytes(join(logsRoot, batchId));
      const sizes = new Map<string, number>(keep.map((batch) => [batch.id, sizeOf(batch.id)]));
      let total = [...sizes.values()].reduce((sum, value) => sum + value, 0);
      if (total > maxTotalBytes) {
        for (let i = keep.length - 1; i >= 0 && total > maxTotalBytes; i -= 1) {
          const batch = keep[i]!;
          if (batch.status === "running") continue;
          const size = sizes.get(batch.id) ?? 0;
          try {
            rmSync(join(logsRoot, batch.id), { recursive: true, force: true });
          } catch {
            continue;
          }
          sizes.delete(batch.id);
          keep.splice(i, 1);
          total -= size;
          changed = true;
        }
        if (changed) {
          batches = keep;
          batches.sort((a, b) => b.createdAt - a.createdAt);
          indexDirty = true;
        }
      }
      const surviving = new Set(batches.map((batch) => batch.id));
      for (const key of logCache.keys()) {
        const batchId = key.split("\u0000", 1)[0];
        if (!batchId || !surviving.has(batchId)) logCache.delete(key);
      }
      if (indexDirty) writeIndex();
    },
    dispose(): void {
      if (disposed) return;
      this.flush();
      disposed = true;
    }
  };
}

// ——— 主机卡片（常用远端目录 + 排查摘要） ———

/** 卡片文件里的记录：`dismissedFor` 表示「用户已拒绝在这个端点转用一次」，不再提示。 */
interface StoredCard extends SshTriageCard {
  dismissedFor?: string;
}

export interface SshTriageCardSaveInput {
  hostId: string;
  endpoint: string;
  revision: number;
  directories: SshTriageCardDirectory[];
  summaries: SshTriageCardSummary[];
}

export interface SshTriageCardStore {
  get(hostId: string, endpoint: string): { card: SshTriageCard; stale?: SshTriageCard };
  /** revision 不一致返回 ok:false（绝不静默覆盖另一个窗口刚存的内容）。 */
  save(input: SshTriageCardSaveInput): { ok: true; card: SshTriageCard } | { ok: false; card: SshTriageCard };
  adopt(input: { hostId: string; fromEndpoint: string; toEndpoint: string; accept: boolean }): { card: SshTriageCard; stale?: SshTriageCard };
  flush(): void;
}

function sanitizeDirectories(raw: unknown): SshTriageCardDirectory[] {
  if (!Array.isArray(raw)) return [];
  const result: SshTriageCardDirectory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const path = typeof entry.path === "string" ? entry.path.trim() : "";
    // 只接受远端绝对路径（计划：名字 + 远端绝对路径；点目录时直接开 SFTP 到该路径）。
    if (!path.startsWith("/") || /[\u0000\n\r]/.test(path)) continue;
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim().slice(0, 64) : `dir-${result.length + 1}`;
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, SSH_TRIAGE_CARD_LIMITS.directoryLabelChars) : path;
    if (result.some((directory) => directory.id === id)) continue;
    result.push({ id, label, path: path.slice(0, 512) });
    if (result.length >= SSH_TRIAGE_CARD_LIMITS.directories) break;
  }
  return result;
}

function sanitizeSummaries(raw: unknown, now: () => number): SshTriageCardSummary[] {
  if (!Array.isArray(raw)) return [];
  const timestamp = now();
  const result: SshTriageCardSummary[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title.trim().slice(0, SSH_TRIAGE_CARD_LIMITS.titleChars) : "";
    const body = typeof entry.body === "string" ? entry.body.trim().slice(0, SSH_TRIAGE_CARD_LIMITS.bodyChars) : "";
    if (!title && !body) continue;
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim().slice(0, 64) : `sum-${result.length + 1}`;
    if (result.some((summary) => summary.id === id)) continue;
    const createdAt = finiteNumber(entry.createdAt);
    const updatedAt = finiteNumber(entry.updatedAt);
    result.push({
      id,
      title,
      body,
      createdAt: Math.min(timestamp, Math.round(createdAt ?? timestamp)),
      updatedAt: Math.min(timestamp, Math.round(updatedAt ?? createdAt ?? timestamp)),
      ...(typeof entry.batchId === "string" && entry.batchId.trim() ? { batchId: entry.batchId.trim() } : {}),
      ...(typeof entry.hostId === "string" && entry.hostId.trim() ? { hostId: entry.hostId.trim() } : {})
    });
    if (result.length >= SSH_TRIAGE_CARD_LIMITS.summaries) break;
  }
  // 新→旧（界面按时间倒序展示）。
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizeStoredCard(raw: unknown): StoredCard | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const card = raw as Record<string, unknown>;
  const hostId = typeof card.hostId === "string" ? card.hostId.trim() : "";
  const endpoint = typeof card.endpoint === "string" ? card.endpoint.trim() : "";
  if (!hostId || !endpoint) return undefined;
  return {
    hostId,
    endpoint,
    revision: Math.max(0, Math.round(finiteNumber(card.revision) ?? 0)),
    updatedAt: Math.round(finiteNumber(card.updatedAt) ?? 0),
    directories: sanitizeDirectories(card.directories),
    summaries: sanitizeSummaries(card.summaries, () => Date.now()),
    ...(typeof card.dismissedFor === "string" && card.dismissedFor.trim() ? { dismissedFor: card.dismissedFor.trim() } : {})
  };
}

function publicCard(card: StoredCard): SshTriageCard {
  const { dismissedFor: _dismissed, ...rest } = card;
  return rest;
}

function emptyCard(hostId: string, endpoint: string): SshTriageCard {
  return { hostId, endpoint, revision: 0, updatedAt: 0, directories: [], summaries: [] };
}

/**
 * 主机卡片存储：`<userData>/pidesktop-ssh-triage/cards.json`。
 *
 * 归属键是 `(hostId, endpoint)`——主机改名不影响（hostId 不变），改地址/端口/用户名
 * 就是另一张卡：旧卡留在文件里，读取时作为 `stale` 返回，由用户确认「转用」或「不转用」。
 * 保存走 revision 乐观并发：带上读到的 revision，不一致就返回冲突与最新内容，绝不
 * 静默覆盖（两个窗口同时开着卡片编辑是常态）。
 */
export function createSshTriageCardStore(deps: { filePath: string; onError?: (message: string) => void; now?: () => number }): SshTriageCardStore {
  const now = deps.now ?? (() => Date.now());
  const report = (message: string): void => {
    try {
      deps.onError?.(message);
    } catch {
      // 上报失败不再递归
    }
  };
  let cards: StoredCard[] = (() => {
    const raw = readJson(deps.filePath) as { cards?: unknown } | undefined;
    const list = Array.isArray(raw?.cards) ? raw!.cards : [];
    return list.map(normalizeStoredCard).filter((item): item is StoredCard => item !== undefined);
  })();

  const persist = (next: StoredCard[]): void => {
    try {
      writeAtomic(deps.filePath, JSON.stringify({ version: CARDS_VERSION, cards: next }, null, 2));
      cards = next;
    } catch (error) {
      const message = `主机卡片落盘失败：${error instanceof Error ? error.message : String(error)}`;
      report(message);
      throw new Error(message);
    }
  };

  const findIndex = (hostId: string, endpoint: string): number => cards.findIndex((card) => card.hostId === hostId && card.endpoint === endpoint);

  const liveCard = (hostId: string, endpoint: string): { card: SshTriageCard; stale?: SshTriageCard } => {
    if (!endpoint) {
      // 主机已从库里删除：按 hostId 取最近更新的那张卡（历史记录仍可读）。
      const latest = cards.filter((item) => item.hostId === hostId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return { card: latest ? publicCard(latest) : emptyCard(hostId, "") };
    }
    const index = findIndex(hostId, endpoint);
    const card = index >= 0 ? publicCard(cards[index]!) : emptyCard(hostId, endpoint);
    // 旧端点资料：同 hostId、端点不同、且用户没在当前端点拒绝过转用。
    const staleRecord = cards
      .filter((item) => item.hostId === hostId && item.endpoint !== endpoint && item.dismissedFor !== endpoint)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return { card, ...(staleRecord ? { stale: publicCard(staleRecord) } : {}) };
  };

  const trimCards = (next: StoredCard[]): StoredCard[] => next
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SSH_TRIAGE_CARD_LIMITS.cards);

  return {
    get: liveCard,
    save: saveCard,
    adopt(input) {
      const timestamp = now();
      const staleIndex = findIndex(input.hostId, input.fromEndpoint);
      if (staleIndex < 0) return liveCard(input.hostId, input.toEndpoint);
      if (!input.accept) {
        // 不转用：只记「这个端点别再问我」，旧资料不删（万一用户又改回去）。
        const next = [...cards];
        next[staleIndex] = { ...cards[staleIndex]!, dismissedFor: input.toEndpoint };
        persist(next);
        return liveCard(input.hostId, input.toEndpoint);
      }
      const stale = cards[staleIndex]!;
      const liveIndex = findIndex(input.hostId, input.toEndpoint);
      const current = cards[liveIndex];
      const revision = (current?.revision ?? 0) + 1;
      const merged: StoredCard = {
        hostId: input.hostId,
        endpoint: input.toEndpoint,
        revision,
        updatedAt: timestamp,
        directories: sanitizeDirectories([...(current?.directories ?? []), ...stale.directories]),
        summaries: sanitizeSummaries([...(current?.summaries ?? []), ...stale.summaries], now)
      };
      const next = cards.filter((_, index) => index !== liveIndex && index !== staleIndex);
      persist(trimCards([merged, ...next]));
      return liveCard(input.hostId, input.toEndpoint);
    },
    flush(): void {
      // 卡片保存已经同步落盘，无需在退出时重复写。
    }
  };

  function saveCard(input: SshTriageCardSaveInput): { ok: true; card: SshTriageCard } | { ok: false; card: SshTriageCard } {
    const hostId = input.hostId.trim();
    const endpoint = input.endpoint.trim();
    if (!hostId || !endpoint) throw new Error("保存卡片缺少主机或端点标识");
    const index = findIndex(hostId, endpoint);
    const currentRevision = index >= 0 ? cards[index]!.revision : 0;
    const requested = Math.round(input.revision);
    if (requested !== currentRevision) {
      const current = index >= 0 ? publicCard(cards[index]!) : emptyCard(hostId, endpoint);
      return { ok: false, card: current };
    }
    const card: StoredCard = {
      hostId,
      endpoint,
      revision: currentRevision + 1,
      updatedAt: now(),
      directories: sanitizeDirectories(input.directories),
      summaries: sanitizeSummaries(input.summaries, now)
    };
    const next = cards.filter((_, position) => position !== index);
    persist(trimCards([card, ...next]));
    return { ok: true, card: publicCard(card) };
  }
}
