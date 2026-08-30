import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Checkpoint 快照存储：AI 每次 write/edit（及 bash 显式输出路径）动手前，
 * 把目标文件的「改之前」状态追加进会话级 JSONL，供用户按消息回滚。
 * 布局跟随 todos/plans：`chatanytime-sessions/<agentId>/checkpoints/<sessionId>.jsonl`。
 *
 * 清理原则（三层）：读路径永不过滤（用户显式回滚老消息时，条目还在就照常回滚）；
 * ① 会话删除/工作区移除即时删文件（pi-runtime 侧，随 todos/plans 先例）；
 * ② 追加写路径的惰性压缩（单文件行数超阈值时丢弃过期条目并截尾）；
 * ③ utility 启动时一次全局清扫（mtime 过期删文件、总容量超限从旧到新删）。
 */

export interface CheckpointEntry {
  /** ISO 时间戳（快照时刻，即工具动手前）。 */
  ts: string;
  toolCallId: string;
  toolName: string;
  /** 工作区相对路径（写入时已解析校验）。 */
  relativePath: string;
  /** 快照时文件是否存在；false = AI 新建，回滚语义为删除。 */
  existed: boolean;
  /** 改之前的文件内容；existed=false 或超限时缺省。 */
  content?: string;
  /** 文件超 CHECKPOINT_FILE_LIMIT 时只记存在性不存内容，回滚时跳过并报告。 */
  truncated?: boolean;
}

/** 单文件快照内容上限：超过只记 truncated，不存内容。 */
export const CHECKPOINT_FILE_LIMIT = 5 * 1024 * 1024;
/** 条目过期天数：惰性压缩时丢弃更早的条目（回滚价值随时间衰减）。 */
export const RETAIN_DAYS = 14;
/** 单会话快照文件的压缩触发行数。 */
export const COMPRESS_THRESHOLD_LINES = 1000;
/** 压缩后仍超过此行数时，保留最近 N 条。 */
export const COMPRESS_KEEP_LINES = 500;
/** 全局清扫：checkpoints 目录总字节数预算。 */
export const GLOBAL_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** 全局清扫：整个快照文件 mtime 超过此天数即删除。 */
export const SWEEP_FILE_AGE_DAYS = 30;

export function checkpointPathFor(agentSessionRoot: string, sessionId: string): string {
  return join(agentSessionRoot, "checkpoints", `${sessionId}.jsonl`);
}

export function formatCheckpointEntry(entry: CheckpointEntry): string {
  return JSON.stringify(entry);
}

export function parseCheckpointEntry(line: string): CheckpointEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const entry = parsed as Record<string, unknown>;
    if (typeof entry.ts !== "string" || typeof entry.toolCallId !== "string"
      || typeof entry.toolName !== "string" || typeof entry.relativePath !== "string"
      || typeof entry.existed !== "boolean") return undefined;
    return {
      ts: entry.ts,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      relativePath: entry.relativePath,
      existed: entry.existed,
      ...(typeof entry.content === "string" ? { content: entry.content } : {}),
      ...(entry.truncated === true ? { truncated: true } : {})
    };
  } catch {
    return undefined;
  }
}

export async function readCheckpoints(filePath: string): Promise<CheckpointEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    return trimmed ? [parseCheckpointEntry(trimmed)].filter((entry): entry is CheckpointEntry => Boolean(entry)) : [];
  });
}

/**
 * 回滚计划：对每个目标（文件 + 该回复内涉及它的全部调用 id），从快照条目中取
 * 「relativePath 精确匹配且 toolCallId ∈ 集合」的最早一条（JSONL 行序即时间序
 * = 该文件在本回复动手前的状态）。单文件粒度：每个目标至多产出一条计划。
 */
export function selectRollbackPlan(entries: readonly CheckpointEntry[], targets: readonly { relativePath: string; toolCallIds: readonly string[] }[]): CheckpointEntry[] {
  const plan: CheckpointEntry[] = [];
  for (const target of targets) {
    const wanted = new Set(target.toolCallIds);
    const earliest = entries.find((entry) => entry.relativePath === target.relativePath && wanted.has(entry.toolCallId));
    if (earliest) plan.push(earliest);
  }
  return plan;
}

/**
 * 压缩规则：先丢弃 RETAIN_DAYS 前的过期条目，若仍超过 keepLines 再保留
 * 最近 keepLines 条（尾部为最新）。纯函数，供惰性压缩与单测共用。
 */
export function compressEntries(entries: readonly CheckpointEntry[], now: number, retainDays: number = RETAIN_DAYS, keepLines: number = COMPRESS_KEEP_LINES): CheckpointEntry[] {
  const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
  const fresh = entries.filter((entry) => {
    const ts = Date.parse(entry.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  return fresh.length > keepLines ? fresh.slice(fresh.length - keepLines) : fresh;
}

interface AppendQueueState {
  queue: Promise<void>;
  /** 进程内行数计数，避免每次追加都 stat 文件。 */
  lineCount: number;
}

const appendStates = new Map<string, AppendQueueState>();

function stateFor(filePath: string): AppendQueueState {
  let state = appendStates.get(filePath);
  if (!state) {
    state = { queue: Promise.resolve(), lineCount: 0 };
    appendStates.set(filePath, state);
  }
  return state;
}

export interface AppendCheckpointOptions {
  filePath: string;
  entry: CheckpointEntry;
  warn: (message: string) => void;
  now?: number;
  /** 压缩触发行数；缺省用模块常量（测试注入小值验证压缩路径）。 */
  compressThreshold?: number;
}

/**
 * 追加一条快照（串行化防 JSONL 行交错），并在行数超阈值时惰性压缩：
 * 同一队列内读全文件 → compressEntries → 原子重写。任何失败只 warn，
 * 绝不影响工具执行（快照是 best-effort）。
 */
export async function appendCheckpoint(options: AppendCheckpointOptions): Promise<void> {
  const { filePath, entry, warn, now = Date.now(), compressThreshold = COMPRESS_THRESHOLD_LINES } = options;
  const state = stateFor(filePath);
  state.queue = state.queue.then(async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${formatCheckpointEntry(entry)}\n`, "utf8");
    state.lineCount += 1;
    if (state.lineCount <= compressThreshold) return;
    const entries = await readCheckpoints(filePath);
    const compressed = compressEntries(entries, now);
    if (compressed.length >= entries.length) {
      // 没有可丢弃的条目（例如短时间高频写入）：截尾保底，防无限膨胀。
      const trimmed = entries.slice(entries.length - COMPRESS_KEEP_LINES);
      await rewriteCheckpoints(filePath, trimmed);
      state.lineCount = trimmed.length;
      return;
    }
    await rewriteCheckpoints(filePath, compressed);
    state.lineCount = compressed.length;
  }).catch((error: unknown) => {
    warn(`checkpoint 快照写入失败：${error instanceof Error ? error.message : String(error)}`);
  });
  return state.queue;
}

async function rewriteCheckpoints(filePath: string, entries: readonly CheckpointEntry[]): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, entries.map(formatCheckpointEntry).join("\n") + (entries.length ? "\n" : ""), "utf8");
  await rename(tempPath, filePath);
}

/** 测试与 dispose 用：丢弃某会话文件的进程内队列状态。 */
export function resetCheckpointState(filePath?: string): void {
  if (filePath) appendStates.delete(filePath);
  else appendStates.clear();
}

/**
 * 全局清扫（utility 启动时调用一次，异步不阻塞）：遍历所有
 * chatanytime-sessions 下各 agent 的 checkpoints 目录——mtime 超过
 * SWEEP_FILE_AGE_DAYS 的整文件删除；目录总字节数超 GLOBAL_MAX_TOTAL_BYTES
 * 时按 mtime 从旧到新删整文件直到达标。返回删除的文件数。
 * 阈值可注入（测试用）；缺省用模块常量。
 */
export async function sweepCheckpoints(agentDir: string, now: number, warn: (message: string) => void, thresholds?: { fileAgeDays?: number; maxTotalBytes?: number }): Promise<number> {
  const fileAgeDays = thresholds?.fileAgeDays ?? SWEEP_FILE_AGE_DAYS;
  const maxTotalBytes = thresholds?.maxTotalBytes ?? GLOBAL_MAX_TOTAL_BYTES;
  const sessionsRoot = join(agentDir, "chatanytime-sessions");
  let agentIds: string[];
  try {
    agentIds = await readdir(sessionsRoot);
  } catch {
    return 0;
  }
  const files: { path: string; mtime: number; size: number }[] = [];
  for (const agentId of agentIds) {
    const dir = join(sessionsRoot, agentId, "checkpoints");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        files.push({ path, mtime: info.mtimeMs, size: info.size });
      } catch {
        // 文件可能在扫描间隙被删除
      }
    }
  }
  let removed = 0;
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const fileAgeLimit = now - fileAgeDays * 24 * 60 * 60 * 1000;
  for (const file of [...files].sort((left, right) => left.mtime - right.mtime)) {
    const expired = file.mtime < fileAgeLimit;
    const overBudget = totalBytes > maxTotalBytes;
    if (!expired && !overBudget) break;
    try {
      await unlink(file.path);
      removed += 1;
      totalBytes -= file.size;
    } catch (error: unknown) {
      warn(`checkpoint 清扫删除失败（${file.path}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (removed > 0) warn(`checkpoint 清扫：已删除 ${removed} 个过期/超额快照文件`);
  return removed;
}
