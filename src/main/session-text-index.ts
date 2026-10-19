import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { sessionPathKey } from "./session-scope.js";
import { writeJsonAtomic } from "./settings-store.js";

/**
 * 会话正文索引：把 JSONL 里「用户/助手真正说过的话」抽成一份可检索的小文本库。
 *
 * 为什么值得持久化：实测本机会话库 941.8 MB，而 user + assistant 的 text 块
 * 合计只有 **4.84 MB**（图片 base64 550 MB、工具输出 110 MB）。每次搜索都去
 * 读这 941 MB 要 6 秒；把 4.84 MB 文本落一份索引，冷启动几十毫秒，之后按
 * mtime+size 增量更新即可。
 *
 * 纪律（与 session-summary-cache 同口径，但更强）：
 * - 索引是派生数据：坏文件 / 旧版本 / 字段非法一律降级为空索引，绝不报错、绝不
 *   影响会话本身；删掉它只会让下一次搜索重扫一遍。
 * - Pi 的会话文件是追加写的：文件只是变大时从 `parsedBytes` 读尾部；变小（重写/
 *   回滚）才整文件重读。不做「同尺寸原地改写」的防御——与摘要缓存接受同一假设。
 * - 只索引 user/assistant 的 text 块：thinking、toolCall 参数、toolResult、图片
 *   都不进正文索引（它们是会话体积的 99%，且不是人回想的对象）。
 */

export const SESSION_TEXT_INDEX_VERSION = 1;
/** 单条消息进入索引的最大字符数：足够命中与截片段，又不会被一条巨型回复撑爆。 */
export const MAX_DOC_CHARS = 20_000;
/** 索引总字符上限；超出时按 mtime 淘汰最旧的文件（防御异常增长）。 */
export const MAX_INDEX_CHARS = 32_000_000;

export interface SessionTextDoc {
  timestamp: number;
  role: "user" | "assistant";
  text: string;
}

export interface SessionTextEntry {
  mtimeMs: number;
  size: number;
  /** 已解析到的字节偏移（追加读的起点，永远落在行边界上）。 */
  parsedBytes: number;
  /** 最近一次扫描时刻：淘汰按它排序，避免把刚重扫的旧文件当成最旧条目。 */
  lastUsedAt?: number;
  docs: SessionTextDoc[];
}

export interface SessionTextIndex {
  version: number;
  updatedAt: number;
  files: Record<string, SessionTextEntry>;
}

export function createEmptySessionTextIndex(): SessionTextIndex {
  return { version: SESSION_TEXT_INDEX_VERSION, updatedAt: 0, files: {} };
}

function normalizeDoc(value: unknown): SessionTextDoc | undefined {
  if (!value || typeof value !== "object") return undefined;
  const doc = value as Record<string, unknown>;
  if (doc.role !== "user" && doc.role !== "assistant") return undefined;
  if (typeof doc.text !== "string") return undefined;
  const text = doc.text.slice(0, MAX_DOC_CHARS);
  if (!text.trim()) return undefined;
  const timestamp = typeof doc.timestamp === "number" && Number.isFinite(doc.timestamp) && doc.timestamp > 0 ? doc.timestamp : 0;
  return { timestamp, role: doc.role, text };
}

function normalizeEntry(value: unknown): SessionTextEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  // 磁盘上的索引可能被外部改坏：非有限数/负数的 size 会让 readSync 用负 position
  // 抛错，而本次搜索的 catch 又会把它变成「永远不重建」。一律按无效条目丢弃。
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!finite(entry.mtimeMs) || !finite(entry.size) || !finite(entry.parsedBytes)) return undefined;
  if (!Array.isArray(entry.docs)) return undefined;
  const docs = entry.docs.map(normalizeDoc).filter((doc): doc is SessionTextDoc => Boolean(doc));
  return {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    parsedBytes: Math.min(entry.parsedBytes, entry.size),
    ...(finite(entry.lastUsedAt) ? { lastUsedAt: entry.lastUsedAt } : {}),
    docs
  };
}

/**
 * 读取索引文件。任何异常（缺失、半写、版本不符、字段非法）都返回空索引——
 * 派生数据坏了只该重扫，不该让搜索不可用。
 */
export function loadSessionTextIndex(filePath: string): SessionTextIndex {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return createEmptySessionTextIndex();
    const source = parsed as { version?: unknown; updatedAt?: unknown; files?: unknown };
    if (source.version !== SESSION_TEXT_INDEX_VERSION || !source.files || typeof source.files !== "object") {
      return createEmptySessionTextIndex();
    }
    const files: Record<string, SessionTextEntry> = {};
    for (const [key, value] of Object.entries(source.files as Record<string, unknown>)) {
      const entry = normalizeEntry(value);
      if (entry) files[key] = entry;
    }
    return {
      version: SESSION_TEXT_INDEX_VERSION,
      updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : 0,
      files
    };
  } catch {
    return createEmptySessionTextIndex();
  }
}

/** 原子落盘（tmp+rename；失败时 writeJsonAtomic 自行降级直写）。 */
export function saveSessionTextIndex(filePath: string, index: SessionTextIndex): void {
  writeJsonAtomic(filePath, index);
}

/** 正文提取：只收 text 块；字符串形式的 user content 也算。 */
export function extractSearchText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

interface ParsedLine {
  doc: SessionTextDoc;
}

/**
 * 解析一行 JSONL。只在这里付出 JSON.parse 的代价，所以先用字节级/字符串级
 * 预筛把 toolResult（可能带几十 MB base64）挡在外面。
 */
export function parseSessionTextLine(line: string): ParsedLine | undefined {
  if (!line) return undefined;
  const hasUserRole = line.includes('"role":"user"') || line.includes('"role": "user"');
  const hasAssistantRole = line.includes('"role":"assistant"') || line.includes('"role": "assistant"');
  if (!hasUserRole && !hasAssistantRole) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  // 会话头 / session_info / 自定义控制项都不是消息；只有 {type:"message", message}
  // 或裸消息（兼容手工写入的测试文件）才继续。
  if (typeof record.type === "string" && record.type !== "message") return undefined;
  const message = (record.message ?? record) as Record<string, unknown>;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = extractSearchText(message.content).slice(0, MAX_DOC_CHARS);
  if (!text.trim()) return undefined;
  const rawTimestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(record.timestamp ?? ""));
  return {
    doc: {
      timestamp: Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? rawTimestamp : 0,
      role,
      text
    }
  };
}

/**
 * 从字节偏移 `from` 起读出完整的行并解析成 docs。
 * 返回值里的 `nextOffset` 只推进到最后一个完整行之后——半行（写入进行中）
 * 会在下次搜索时重新读到，不会被吞掉。
 */
function readDocsFrom(filePath: string, from: number, size: number): { docs: SessionTextDoc[]; bytesRead: number; nextOffset: number } {
  const length = Math.max(0, size - from);
  if (length === 0) return { docs: [], bytesRead: 0, nextOffset: from };
  const buffer = Buffer.alloc(length);
  let read = 0;
  const fd = openSync(filePath, "r");
  try {
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, from + read);
      if (chunk <= 0) break;
      read += chunk;
    }
  } finally {
    closeSync(fd);
  }
  const docs: SessionTextDoc[] = [];
  let start = 0;
  for (let index = 0; index < read; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const line = buffer.subarray(start, index).toString("utf8").replace(/\r$/u, "");
    const parsed = parseSessionTextLine(line);
    if (parsed) docs.push(parsed.doc);
    start = index + 1;
  }
  return { docs, bytesRead: read, nextOffset: from + start };
}

/**
 * 更新一个会话文件的索引条目；返回是否有变化。
 * - 未变（mtime+size 相同）：零 I/O。
 * - 变大：只读尾部（Pi 的追加写常态）。
 * - 变小 / 首次：整文件重读。
 * - 文件不存在：返回 false（会话可能刚被删）。
 */
export function updateSessionTextEntry(index: SessionTextIndex, filePath: string): boolean {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const key = sessionPathKey(filePath);
  const existing = index.files[key];
  if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) return false;

  const append = Boolean(existing && stat.size > existing.parsedBytes && stat.size >= existing.size);
  const from = append && existing ? existing.parsedBytes : 0;
  const { docs, bytesRead, nextOffset } = readDocsFrom(filePath, from, stat.size);
  index.files[key] = {
    mtimeMs: stat.mtimeMs,
    // 以实际读到的字节为准：读取期间文件继续增长时，下一轮会从 nextOffset 续读，
    // 而不是把这轮的 size 当成已解析位置。
    size: from + bytesRead,
    parsedBytes: nextOffset,
    lastUsedAt: Date.now(),
    docs: append && existing ? [...existing.docs, ...docs] : docs
  };
  index.updatedAt = Date.now();
  return true;
}

/** 索引总字符数（淘汰与诊断用）。 */
export function sessionTextIndexChars(index: SessionTextIndex): number {
  let total = 0;
  for (const entry of Object.values(index.files)) {
    for (const doc of entry.docs) total += doc.text.length;
  }
  return total;
}

/**
 * 总字符超出上限时按文件 mtime 淘汰最旧的条目。只影响搜索缓存，不影响会话文件。
 * 返回是否发生了淘汰。
 */
export function pruneSessionTextIndex(index: SessionTextIndex, maxChars = MAX_INDEX_CHARS): boolean {
  let total = sessionTextIndexChars(index);
  if (total <= maxChars) return false;
  const keys = Object.keys(index.files).sort((left, right) =>
    (index.files[left]?.lastUsedAt ?? index.files[left]?.mtimeMs ?? 0) - (index.files[right]?.lastUsedAt ?? index.files[right]?.mtimeMs ?? 0)
  );
  let removed = false;
  for (const key of keys) {
    if (total <= maxChars) break;
    const entry = index.files[key];
    if (!entry) continue;
    total -= entry.docs.reduce((sum, doc) => sum + doc.text.length, 0);
    delete index.files[key];
    removed = true;
  }
  return removed;
}
