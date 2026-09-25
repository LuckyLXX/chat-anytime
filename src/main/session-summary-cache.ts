import { closeSync, openSync, readSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * 会话摘要缓存（2026-09-25 性能 P0）。
 *
 * 为什么必须有这个模块：`refreshSessions` 原来每轮都调 Pi 的
 * `SessionManager.listAll`，而它的 `buildSessionInfo` 对**每个**会话文件整读 +
 * 逐行 `JSON.parse`（还把全部消息文本拼成 `allMessagesText`——本项目从不消费），
 * 且**没有 mtime/size 缓存**。实测本机一个助手 179 文件 / 264 MB、单次扫描
 * 2056 ms（全 439 文件 5159 ms），而这笔钱**每轮对话都要付一次**
 * （`pi-runtime.ts` 在每条 assistant 消息与每个生命周期事件后触发 500 ms 防抖刷新），
 * 就压在流式输出与工具 RPC 的事件循环上。
 *
 * 这里的做法：
 * 1. 每目录 `readdir` + 逐文件 `stat`（几毫秒）；
 * 2. `mtimeMs + size` 缓存命中 → 复用摘要，**不读文件**（负缓存同样生效：非会话
 *    文件与空文件一次判定、永久跳过）；
 * 3. 未命中 → 先**有界读首行**（≤256 KB）廉价拒绝非会话文件（`tool-audit.jsonl`
 *    13.4 MB、`checkpoints/*.jsonl` 36 MB 都在同一批目录里）；首行确认是 Pi 会话
 *    头之后才 `SessionManager.open`（该文件本来就变了，这一次读不可避免）；
 * 4. 调用方传入 `liveSummaries`（内存中已有记录的摘要）→ 当前正在写的那个会话
 *    **零 I/O**。
 *
 * 失效口径：`mtimeMs + size`。Pi 追加写同时改二者；`pin`/`rename` 走
 * `appendSessionInfo`（文件变了）→ 正确重解析；删除 → prune。**假设**不存在
 * 「mtime 与 size 都没变但内容变了」的写法（Pi 是 append-only）；若将来出现，
 * 表现是列表标题滞后，不是数据损坏。
 *
 * 与 Pi 的字段口径**必须逐字段对齐**（`src/main/session-summary-cache.test.ts`
 * 直接与 `SessionManager.listAll` 在同一夹具目录上对拍）：`messageCount` 数
 * `type === "message"` 的所有消息；`modified` 取 message 活动时间最大值 → 回退
 * 头时间戳 → 回退 `stat.mtime`；`firstMessage` 取第一条 role 为 user 且文本非空
 * 的消息（content 兼容字符串与 parts 数组），空则 `"(no messages)"`；`name` 取
 * 最后一个 `session_info`（含显式清空）。
 */

/** 会话文件摘要 = Pi `SessionInfo` 去掉本应用从不消费的 `allMessagesText`/`parentSessionPath`。 */
export interface SessionFileSummary {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

/** 会话文件首行的有界读结果（session.open 的决策输入）。 */
export interface SessionHeaderLine {
  id: string;
  /** 头部 cwd；缺失/非字符串时为空串。 */
  cwd: string;
  /** 头部原始时间戳（ISO 字符串）。 */
  timestamp?: string;
  /** `Date.parse(timestamp)`；缺失/非法为 undefined。 */
  createdAt?: number;
}

interface CachedSessionSummary {
  mtimeMs: number;
  size: number;
  /** null = 已判定为非会话文件（负缓存：不再重读首行）。 */
  summary: SessionFileSummary | null;
}

/** 注入点：fs、首行读、会话打开（测试用来计数与造夹具）。 */
export interface SessionSummaryDeps {
  readdir?: (directory: string) => Promise<string[]>;
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number; mtime: Date }>;
  readHeader?: (path: string) => SessionHeaderLine | undefined;
  openSession?: (path: string) => SessionEntrySource;
  /** 已在内存的会话摘要（按路径覆盖磁盘结果，零 I/O）。 */
  liveSummaries?: readonly SessionFileSummary[];
  /** 缓存实例（缺省用模块级共享缓存；测试传自己的 Map 以隔离）。 */
  cache?: Map<string, CachedSessionSummary>;
}

export interface SessionEntrySource {
  getEntries(): readonly SessionEntry[];
  getSessionId(): string;
}

const HEADER_SCAN_BYTES = 256 * 1024;

const sharedCache = new Map<string, CachedSessionSummary>();

function cacheKey(path: string): string {
  return resolve(path).toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * 有界读会话文件首行（≤256 KB）判身份。
 *
 * - 空行 / 坏 JSON 行跳过，与 Pi `buildSessionInfo` 的行循环同口径；
 * - 第一条可解析的行必须是 `type === "session"` 且 `id` 是字符串，否则不是会话文件；
 * - 窗口内没有换行且已读满窗口 → 放弃（真会话的头部只有几百字节；放弃的后果只是
 *   这个文件不进侧边栏，而 Pi 的 `SessionManager.open` 遇到它会直接抛错，
 *   绝不能靠它兜底）；
 * - 文件小于窗口且没有换行时，整个内容就是第一行（用不用最后一个换行符都算完整行）。
 */
export function readSessionHeaderLine(path: string): SessionHeaderLine | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(HEADER_SCAN_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return undefined;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    // 读满窗口时最后一段可能是被截断的半行——丢掉，只认完整行。
    if (bytesRead >= HEADER_SCAN_BYTES) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainRecord(parsed) || parsed.type !== "session" || typeof parsed.id !== "string") return undefined;
      const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
      const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
      const createdAt = timestamp !== undefined ? Date.parse(timestamp) : undefined;
      return { id: parsed.id, cwd, timestamp, ...(createdAt !== undefined && !Number.isNaN(createdAt) ? { createdAt } : {}) };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 消息活动时间：优先 message.timestamp（数字），否则回退条目时间戳（与 Pi 同口径）。 */
function messageActivityTime(entry: SessionEntry, message: Record<string, unknown>): number | undefined {
  if (typeof message.timestamp === "number") return message.timestamp;
  const parsed = Date.parse(String(entry.timestamp));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Pi `extractTextContent`：字符串原样，parts 数组只拼 text 块（用空格连接）。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (isPlainRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join(" ");
}

/**
 * 从 entries 算 `messageCount` / `firstMessage` / `modified` / `name`（与 Pi
 * `buildSessionInfo` 的同名字段逐字段对齐）。
 */
export function summarizeEntries(
  entries: readonly SessionEntry[],
  header: { timestamp?: unknown } | undefined,
  stats?: { mtime?: Date }
): Omit<SessionFileSummary, "path" | "id" | "cwd"> {
  let name: string | undefined;
  let messageCount = 0;
  let lastActivity: number | undefined;
  let firstMessage = "";
  for (const entry of entries) {
    if (entry.type === "session_info") {
      // 最新一条赢（显式的空名字=清空标题，同样生效）。
      const trimmed = typeof entry.name === "string" ? entry.name.trim() : "";
      name = trimmed || undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    messageCount++;
    const message = entry.message as unknown as Record<string, unknown>;
    if (typeof message.role !== "string" || !("content" in message)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const activity = messageActivityTime(entry, message);
    if (typeof activity === "number") lastActivity = Math.max(lastActivity ?? 0, activity);
    const text = extractText(message.content);
    if (!text) continue;
    if (!firstMessage && message.role === "user") firstMessage = text;
  }
  const headerTime = typeof header?.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
  const fallback = stats?.mtime ?? new Date(0);
  const modified = typeof lastActivity === "number" && lastActivity > 0
    ? new Date(lastActivity)
    : !Number.isNaN(headerTime)
      ? new Date(headerTime)
      : fallback;
  return {
    ...(name !== undefined ? { name } : {}),
    // 与 Pi 的 `new Date(header.timestamp)` 同口径：头部时间戳缺失/非法 → Invalid Date。
    created: new Date(headerTime),
    modified,
    messageCount,
    firstMessage: firstMessage || "(no messages)"
  };
}

/**
 * 内存中已有会话的摘要（调用方从 live record 的 `sessionManager.getEntries()`
 * 直接算，**零 I/O**）。`fallbackTime` 用于极端情况（文件已落盘但没有任何消息
 * 活动）——传 record 的激活时间即可。
 */
export function summarizeLiveSession(input: {
  path: string;
  id: string;
  cwd: string;
  entries: readonly SessionEntry[];
  fallbackTime?: number;
}): SessionFileSummary {
  return {
    path: input.path,
    id: input.id,
    cwd: input.cwd,
    ...summarizeEntries(input.entries, undefined, { mtime: input.fallbackTime !== undefined ? new Date(input.fallbackTime) : new Date(0) })
  };
}

function readSummary(
  path: string,
  info: { mtime: Date },
  deps: Required<Pick<SessionSummaryDeps, "readHeader" | "openSession">>
): SessionFileSummary | null {
  const header = deps.readHeader(path);
  if (!header) return null;
  const manager = deps.openSession(path);
  const entries = manager.getEntries();
  return {
    path,
    id: manager.getSessionId(),
    // cwd 取头部原值（与 Pi `buildSessionInfo` 同源）：`SessionManager.getCwd()` 会
    // 再走一次 resolvePath 归一（Windows 上把 / 换成 \），侧边栏分组是按字符串
    // 匹配的，两边口径必须一致。
    cwd: header.cwd,
    ...summarizeEntries(entries, { timestamp: header.timestamp }, { mtime: info.mtime })
  };
}

/**
 * 列出给定目录下的会话摘要。目录不存在的直接跳过（与 Pi `listAll` 同口径）。
 * 每轮结束把本次没见到的路径从缓存里 prune（删除的会话不留下永久缓存）。
 */
export async function listSessionSummaries(directories: readonly string[], deps: SessionSummaryDeps = {}): Promise<SessionFileSummary[]> {
  const readdirImpl = deps.readdir ?? readdir;
  const statImpl = deps.stat ?? stat;
  const readHeader = deps.readHeader ?? readSessionHeaderLine;
  const openSession = deps.openSession ?? ((path: string) => SessionManager.open(path));
  const cache = deps.cache ?? sharedCache;
  const liveByPath = new Map<string, SessionFileSummary>();
  for (const summary of deps.liveSummaries ?? []) liveByPath.set(cacheKey(summary.path), summary);

  const seen = new Set<string>();
  const summaries: SessionFileSummary[] = [];
  for (const directory of directories) {
    let names: string[];
    try {
      names = await readdirImpl(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".jsonl")) continue;
      const path = join(directory, name);
      const key = cacheKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      // live 会话（内存里就是权威）直接复用，连 stat 都不做。
      const live = liveByPath.get(key);
      if (live) {
        summaries.push(live);
        continue;
      }
      let info: { mtimeMs: number; size: number; mtime: Date };
      try {
        info = await statImpl(path);
      } catch {
        continue;
      }
      const cached = cache.get(key);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        if (cached.summary) summaries.push(cached.summary);
        continue;
      }
      const summary = readSummary(path, info, { readHeader, openSession });
      cache.set(key, { mtimeMs: info.mtimeMs, size: info.size, summary });
      if (summary) summaries.push(summary);
    }
  }
  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
  return summaries;
}
