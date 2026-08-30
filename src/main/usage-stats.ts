// 用量统计：跨助手扫描会话 JSONL，聚合 token 用量（设置页「用量统计」tab 的
// 数据源）。扫描是纯读操作；按文件做（mtimeMs+size）键控缓存，历史会话只在
// 内容变化时重新解析（全量 168MB 首扫秒级，之后增量）。user 行只用于提取
// 会话标题兜底（首条 user 文本前 60 字符），不落任何会话内容。

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import createReadline from "node:readline";
import type { UsageAgentEntry, UsageDayEntry, UsageModelEntry, UsageSessionEntry, UsageStats, UsageTotals } from "../shared/protocol.js";

/** workspaceHash 目录名格式（session-scope.ts 的 20 位 sha256 前缀）；其余目录（todos/plans）不进扫描。 */
const WORKSPACE_DIR_PATTERN = /^[0-9a-f]{20}$/;

/** 单条 assistant 消息的精简用量记录（缓存与聚合的最小单元）。 */
export interface UsageScanEntry {
  /** 消息时间戳（毫秒）；缺失时整条跳过。 */
  ts: number;
  /** 本地时区日期 YYYY-MM-DD。 */
  date: string;
  model: string;
  provider: string;
  agentId: string;
  /** 会话 JSONL 绝对路径（按会话聚合的键）。 */
  sessionPath: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cost: number;
}

/** 单个会话文件的扫描产物：用量记录 + 标题兜底。 */
export interface UsageFileScan {
  entries: UsageScanEntry[];
  /** 首条 user 消息文本前 60 字符；无 user 消息时 undefined（由文件名兜底）。 */
  title?: string;
}

/** 本地时区 YYYY-MM-DD（与用户日历对齐，不用 UTC）。 */
export function localDateFromTs(ts: number): string {
  const date = new Date(ts);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 会话文件名（去扩展名）作标题兜底。 */
export function sessionTitleFromPath(sessionPath: string): string {
  const base = sessionPath.split(/[\\/]/).pop() ?? sessionPath;
  return base.replace(/\.jsonl$/i, "");
}

/** 从 user 消息 content（string | blocks 数组）提取纯文本。 */
function userTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

/** 压缩空白并截断到 60 字符（标题用）。 */
export function compactTitle(text: string, maxLength = 60): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  return compacted.length <= maxLength ? compacted : `${compacted.slice(0, maxLength)}…`;
}

interface RawAssistantMessage {
  role?: unknown;
  stopReason?: unknown;
  model?: unknown;
  provider?: unknown;
  content?: unknown;
  usage?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    reasoning?: unknown;
    cost?: { total?: unknown } | null;
  } | null;
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 时间戳兼容两种形态：顶层 envelope 是 ISO 8601 字符串（Pi SessionManager
 * 序列化格式），message 内是毫秒数；解析不出（≤0）整条跳过。
 */
function toTimestampMs(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return candidate;
    if (typeof candidate === "string" && candidate) {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return 0;
}

/**
 * 解析一行会话 JSONL：assistant 消息 → 用量记录；user 消息 → 标题候选；
 * 其余（toolCall/压缩边界/解析失败）→ undefined。无效 assistant（aborted/
 * error、usage 全零）跳过，与 runtime-context-usage 的口径一致。
 */
export function parseUsageLine(line: string, agentId: string, sessionPath: string): { entry?: UsageScanEntry; userText?: string } {
  if (!line.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const envelope = parsed as { timestamp?: unknown; message?: unknown };
  const message = (envelope.message ?? envelope) as RawAssistantMessage;
  if (message.role === "user") {
    const text = userTextFromContent(message.content);
    return text ? { userText: text } : {};
  }
  if (message.role !== "assistant") return {};
  if (message.stopReason === "aborted" || message.stopReason === "error") return {};
  const usage = message.usage;
  if (!usage) return {};
  const input = toCount(usage.input);
  const output = toCount(usage.output);
  const cacheRead = toCount(usage.cacheRead);
  const cacheWrite = toCount(usage.cacheWrite);
  if (input + output + cacheRead + cacheWrite <= 0) return {};
  const ts = toTimestampMs(envelope.timestamp, (message as { timestamp?: unknown }).timestamp);
  if (ts <= 0) return {};
  const reasoning = toCount(usage.reasoning);
  const cost = toCount(usage.cost?.total);
  return {
    entry: {
      ts,
      date: localDateFromTs(ts),
      model: typeof message.model === "string" && message.model ? message.model : "未知模型",
      provider: typeof message.provider === "string" && message.provider ? message.provider : "未知服务商",
      agentId,
      sessionPath,
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(reasoning > 0 ? { reasoning } : {}),
      cost
    }
  };
}

/** 扫描整份会话 JSONL 内容（测试直喂字符串；生产走流式 collect）。 */
export function scanSessionContent(content: string, agentId: string, sessionPath: string): UsageFileScan {
  const entries: UsageScanEntry[] = [];
  let title: string | undefined;
  for (const line of content.split("\n")) {
    const { entry, userText } = parseUsageLine(line, agentId, sessionPath);
    if (entry) entries.push(entry);
    if (!title && userText) title = compactTitle(userText);
  }
  return { entries, ...(title ? { title } : {}) };
}

// ─── 聚合 ───

interface MutableAmount {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

function zeroAmount(): MutableAmount {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
}

function addAmount(target: MutableAmount, entry: UsageScanEntry): void {
  target.requests += 1;
  target.input += entry.input;
  target.output += entry.output;
  target.cacheRead += entry.cacheRead;
  target.cacheWrite += entry.cacheWrite;
  target.reasoning += entry.reasoning ?? 0;
  target.cost += entry.cost;
}

function toAmount(amount: MutableAmount): { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; cost: number } {
  return {
    requests: amount.requests,
    input: amount.input,
    output: amount.output,
    cacheRead: amount.cacheRead,
    cacheWrite: amount.cacheWrite,
    ...(amount.reasoning > 0 ? { reasoning: amount.reasoning } : {}),
    cost: amount.cost
  };
}

function totalsFrom(amount: MutableAmount, entries: readonly UsageScanEntry[]): UsageTotals {
  const promptTokens = amount.input + amount.cacheRead + amount.cacheWrite;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  for (const entry of entries) {
    if (firstAt === undefined || entry.ts < firstAt) firstAt = entry.ts;
    if (lastAt === undefined || entry.ts > lastAt) lastAt = entry.ts;
  }
  return {
    ...toAmount(amount),
    cacheHitRate: promptTokens > 0 ? (amount.cacheRead / promptTokens) * 100 : null,
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {})
  };
}

const SESSION_LIST_LIMIT = 60;

/** 全量聚合：按天（升序）/按模型/按助手（各按输出降序）/最近会话（lastAt 降序截前 60）+ 总览。 */
export function aggregateUsage(entries: readonly UsageScanEntry[], meta: { scannedFiles: number; scanMs: number; generatedAt: number }): UsageStats {
  const total = zeroAmount();
  const byDay = new Map<string, MutableAmount>();
  const byModel = new Map<string, { amount: MutableAmount; provider: string; lastAt: number }>();
  const byAgent = new Map<string, MutableAmount>();
  const bySession = new Map<string, { amount: MutableAmount; agentId: string; title: string; lastAt: number }>();

  for (const entry of entries) {
    addAmount(total, entry);
    const day = byDay.get(entry.date) ?? zeroAmount();
    addAmount(day, entry);
    byDay.set(entry.date, day);
    const modelKey = `${entry.provider}\u0000${entry.model}`;
    const model = byModel.get(modelKey) ?? { amount: zeroAmount(), provider: entry.provider, lastAt: entry.ts };
    addAmount(model.amount, entry);
    model.lastAt = Math.max(model.lastAt, entry.ts);
    byModel.set(modelKey, model);
    const agent = byAgent.get(entry.agentId) ?? zeroAmount();
    addAmount(agent, entry);
    byAgent.set(entry.agentId, agent);
    const session = bySession.get(entry.sessionPath) ?? { amount: zeroAmount(), agentId: entry.agentId, title: "", lastAt: entry.ts };
    addAmount(session.amount, entry);
    session.lastAt = Math.max(session.lastAt, entry.ts);
    bySession.set(entry.sessionPath, session);
  }

  const dayEntries: UsageDayEntry[] = [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, amount]) => ({ date, ...toAmount(amount) }));

  const modelEntries: UsageModelEntry[] = [...byModel.entries()]
    .map(([modelKey, value]) => {
      const model = modelKey.split("\u0000")[1] ?? "未知模型";
      return { model, ...toAmount(value.amount), provider: value.provider, lastAt: value.lastAt };
    })
    .sort((left, right) => right.output - left.output);

  const agentEntries: UsageAgentEntry[] = [...byAgent.entries()]
    .map(([agentId, amount]) => ({ agentId, ...toAmount(amount) }))
    .sort((left, right) => right.output - left.output);

  const sessionEntries: UsageSessionEntry[] = [...bySession.entries()]
    .map(([sessionPath, value]) => ({
      sessionPath,
      agentId: value.agentId,
      title: value.title || sessionTitleFromPath(sessionPath),
      lastAt: value.lastAt,
      ...toAmount(value.amount)
    }))
    .sort((left, right) => right.lastAt - left.lastAt)
    .slice(0, SESSION_LIST_LIMIT);

  return {
    generatedAt: meta.generatedAt,
    scannedFiles: meta.scannedFiles,
    scanMs: meta.scanMs,
    total: totalsFrom(total, entries),
    byDay: dayEntries,
    byModel: modelEntries,
    byAgent: agentEntries,
    bySession: sessionEntries
  };
}

// ─── 按文件缓存与目录扫描 ───

interface CachePayload {
  mtimeMs: number;
  size: number;
  scan: UsageFileScan;
}

export interface UsageStatsCache {
  /** 命中返回缓存扫描产物并刷新键；未命中返回 undefined。 */
  get(path: string, mtimeMs: number, size: number): UsageFileScan | undefined;
  set(path: string, mtimeMs: number, size: number, scan: UsageFileScan): void;
  /** 清空全部（删除会话后口径收敛；utility 生命周期内存态即可）。 */
  clear(): void;
}

export function createUsageStatsCache(): UsageStatsCache {
  const store = new Map<string, CachePayload>();
  return {
    get(path, mtimeMs, size) {
      const cached = store.get(path);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.scan;
      return undefined;
    },
    set(path, mtimeMs, size, scan) {
      if (store.size > 5_000) store.clear();
      store.set(path, { mtimeMs, size, scan });
    },
    clear() {
      store.clear();
    }
  };
}

/** 流式读单份 JSONL（大文件不整读进内存）；读失败按空产物处理（best-effort）。 */
async function scanSessionFile(path: string, agentId: string): Promise<UsageFileScan> {
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const reader = createReadline.createInterface({ input: stream, crlfDelay: Infinity });
    const entries: UsageScanEntry[] = [];
    let title: string | undefined;
    for await (const line of reader) {
      const { entry, userText } = parseUsageLine(line, agentId, path);
      if (entry) entries.push(entry);
      if (!title && userText) title = compactTitle(userText);
    }
    return { entries, ...(title ? { title } : {}) };
  } catch {
    return { entries: [] };
  }
}

/** 小文件直读（readline 启动开销大于内容本身）。 */
const SMALL_FILE_LIMIT = 256 * 1024;

async function scanSessionFileBest(path: string, agentId: string, size: number): Promise<UsageFileScan> {
  if (size <= SMALL_FILE_LIMIT) {
    try {
      return scanSessionContent(await readFile(path, "utf8"), agentId, path);
    } catch {
      return { entries: [] };
    }
  }
  return scanSessionFile(path, agentId);
}

/**
 * 扫描 chatanytime-sessions/ 下全部助手的会话文件并聚合。agentId 缺省
 * 聚合全部；传入时只过滤参与聚合的记录（缓存仍按文件全量，切换筛选零重扫）。
 */
export async function collectUsageStats(sessionsRoot: string, cache: UsageStatsCache, agentId?: string): Promise<UsageStats> {
  const startedAt = Date.now();
  const all: UsageScanEntry[] = [];
  const titles = new Map<string, string>();
  let scannedFiles = 0;

  let agentDirs: Awaited<ReturnType<typeof readdir>>;
  try {
    agentDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    agentDirs = [];
  }
  for (const agentDir of agentDirs) {
    if (!agentDir.isDirectory()) continue;
    let workspaceDirs: Awaited<ReturnType<typeof readdir>>;
    try {
      workspaceDirs = await readdir(join(sessionsRoot, agentDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const workspaceDir of workspaceDirs) {
      if (!workspaceDir.isDirectory() || !WORKSPACE_DIR_PATTERN.test(workspaceDir.name)) continue;
      const directory = join(sessionsRoot, agentDir.name, workspaceDir.name);
      let files: Awaited<ReturnType<typeof readdir>>;
      try {
        files = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const path = join(directory, file.name);
        let stats;
        try {
          stats = await stat(path);
        } catch {
          continue;
        }
        let scan = cache.get(path, stats.mtimeMs, stats.size);
        if (!scan) {
          scan = await scanSessionFileBest(path, agentDir.name, stats.size);
          cache.set(path, stats.mtimeMs, stats.size, scan);
          scannedFiles += 1;
        }
        if (scan.title && !titles.has(path)) titles.set(path, scan.title);
        all.push(...scan.entries);
      }
    }
  }

  const filtered = agentId ? all.filter((entry) => entry.agentId === agentId) : all;
  const stats = aggregateUsage(filtered, { scannedFiles, scanMs: Date.now() - startedAt, generatedAt: Date.now() });
  // 标题按会话回填（聚合纯函数不感知 titles，兜底已是文件名）。
  for (const session of stats.bySession) {
    const title = titles.get(session.sessionPath);
    if (title) session.title = title;
  }
  return stats;
}
