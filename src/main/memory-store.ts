import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import type { MemoryTopic, MemoryTopicSummary } from "../shared/protocol.js";
import {
  MEMORY_LAYERS,
  MEMORY_RECENCY_HALF_LIFE_DAYS,
  MEMORY_RECENCY_IMMUNE_DAYS,
  MEMORY_RECENCY_MIN,
  MEMORY_SEARCH_LIMIT,
  MEMORY_SEARCH_LIMIT_MAX,
  MEMORY_SEARCH_SNIPPET_AFTER,
  MEMORY_SEARCH_SNIPPET_BEFORE,
  MEMORY_SNAPSHOT_CORE_CHARS,
  MEMORY_SNAPSHOT_DESC_COMPACT,
  MEMORY_SNAPSHOT_DESC_MAX,
  MEMORY_SUMMARY_MAX_CHARS,
  MEMORY_SUMMARY_PREVIEW_CHARS,
  MEMORY_TOPIC_INDEX_DEGRADE_CHARS,
  MEMORY_TRIGGER_MAX_CHARS,
  MEMORY_TRIGGER_MAX_COUNT,
  type MemoryLayer,
  type MemorySnapshot,
  type MemorySnapshotEntry
} from "../shared/memory.js";
import { appendToMemoryContent, deriveMemoryDigest, splitMemorySections, truncateMemoryText, type MemorySection } from "./memory-sections.js";

/**
 * Markdown-backed 长期记忆库（原子 tmp+rename 写）。布局：
 *
 *   <dir>/topics/<id>.md   每主题一个文件：扁平 frontmatter（title/description/
 *                          workspace?/createdAt/updatedAt）+ markdown 正文
 *   <dir>/MEMORY.md        派生索引：store 每次变更自动再生成，供人浏览；
 *                          模型不维护索引（无同步漂移），注入用 snapshotMarkdown()
 *
 * 主题按 title 定位（读取/替换/删除），id 只是稳定文件名，不随语义变化。
 * 同助手多个并发会话共享同一目录：写操作经 <dir>/.write.lock 串行化；
 * 读操作按 mtime+size 增量缓存，外部改动在下一次调用可见。
 *
 * v3（2026-10-18）：正文不再随列表下发；search 按分节建 BM25 风格索引；
 * snapshotMarkdown 按字符预算压缩；append 按节追加，避免整篇重写。
 */

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;
const INDEX_HEADER = "# 长期记忆索引（store 自动生成，勿手改；正文见 topics/）";
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const SEARCH_K1 = 1.2;
const SEARCH_B = 0.75;
const SEARCH_MAX_SECTIONS_PER_TOPIC = 2;
const SNAPSHOT_FOOTER_RESERVE = 100;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface MemorySaveInput {
  title: string;
  description: string;
  content: string;
  /** 分层：core 常驻要点 / standard 按需 / archive 不进索引。缺省保留既有值，新主题 standard。 */
  layer?: MemoryLayer;
  /** 要点层（多行会压成 ` · ` 连接的单行）；缺省保留既有值。 */
  summary?: string;
  /** 反直觉触发词（≤3 个，每个 ≤12 字）。 */
  triggers?: string[];
  /** 绑定到该工作区路径（对已有主题即改绑）；缺省保留既有绑定，新主题为全局。 */
  bindWorkspace?: string;
}

/** 面板/命令的部分更新：未传的字段保持原值。 */
export interface MemoryUpdateInput {
  title?: string;
  description?: string;
  content?: string;
  layer?: MemoryLayer;
  summary?: string;
  triggers?: string[];
  bindWorkspace?: string;
}

export interface MemoryAppendInput {
  topic: string;
  /** 既有节标题/编号；未命中且不是纯数字时新建 `## section`；缺省追加到文末。 */
  section?: string;
  content: string;
}

export interface MemoryAppendOutcome {
  topic: MemoryTopic;
  label: string;
  created: boolean;
  /** 实际新增的字符数（含分隔换行）。 */
  addedChars: number;
}

export interface MemorySearchOptions {
  /** 默认 5，最多 10。 */
  limit?: number;
  /** 只在这个主题内检索（标题或文件名 id，不区分大小写）。 */
  topic?: string;
}

export interface MemorySearchHit {
  topic: MemoryTopicSummary;
  /** 命中的分节标签；主题级命中（只命中标题/描述）时缺省。 */
  section?: string;
  sectionIndex?: number;
  sectionChars: number;
  snippet: string;
}

export interface MemoryStore {
  list(): MemoryTopic[];
  /** 列表/资源目录/推送用的摘要投影（不含正文）。 */
  summaries(): MemoryTopicSummary[];
  /** 按 title（不区分大小写）或文件名 id 定位主题。 */
  read(topic: string): MemoryTopic | undefined;
  /** 按标题 upsert：命中则整主题替换（保留 id/createdAt/既有工作区绑定）。 */
  save(input: MemorySaveInput): MemoryTopic;
  /** 部分更新（面板改层/要点/触发词，不需要重写正文）。 */
  update(topic: string, patch: MemoryUpdateInput): MemoryTopic;
  /** 按节/文末追加，不覆盖既有正文；未命中且非纯数字时新建节。 */
  append(input: MemoryAppendInput): MemoryAppendOutcome;
  remove(topic: string): boolean;
  /** 派生全量索引（写 MEMORY.md / 供人浏览）；workspace 给定时只含可见主题。 */
  indexMarkdown(workspace?: string): string;
  /** 会话注入用的预算索引：超出 maxChars 时压缩描述/省略主题并写脚注。 */
  snapshotMarkdown(workspace: string | undefined, maxChars: number): string;
  /**
   * 同一份注入索引的结构化版本：逐条给出「有没有进索引 / 占多少字 /
   * 被压缩还是被省略」。记忆中心图谱用它画连线与预算，不再解析文本。
   */
  snapshotDetailed(workspace: string | undefined, maxChars: number): MemorySnapshot;
  /** 本地词法检索（中文 bigram + BM25 风格排序）；workspace 过滤口径同 indexMarkdown。 */
  search(query: string, workspace?: string, options?: MemorySearchOptions): MemorySearchHit[];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  topic: MemoryTopic;
}

interface SearchDoc {
  topic: MemoryTopic;
  section?: MemorySection;
  text: string;
  lower: string;
  tokens: Map<string, number>;
  length: number;
}

interface ScoredDoc {
  doc: SearchDoc;
  score: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 单行化并去掉会破坏 frontmatter 的首尾符号；title/description 落盘前必经。 */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim().replace(/^[-#\s]+|[-\s]+$/gu, "");
}

/**
 * 标题 → 安全文件名：保留中文与常用字符，路径分隔符/非法字符一律替换为
 * 连字符（保证 "a/b" 与 "a b" 碰撞后能走去重），折叠连续连字符与点号
 * （杜绝 ".."），长度截断。全符号标题（清洗后为空）由调用方兜底。
 */
function slugify(title: string): string {
  return title.trim()
    .replace(/[\u0000-\u001fu007f]/gu, "")
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/\.{2,}/gu, ".")
    .replace(/^[-.\s]+|[-.\s]+$/gu, "")
    .slice(0, 50);
}

/** 层值容错：任何不认识的取值都退回 standard（老文件零迁移）。 */
function normalizeLayer(value: string | undefined): MemoryLayer {
  const needle = (value ?? "").trim().toLowerCase() as MemoryLayer;
  return MEMORY_LAYERS.includes(needle) ? needle : "standard";
}

/** 要点层：多行压成 ` · ` 连接的单行，受 MEMORY_SUMMARY_MAX_CHARS 约束。 */
function normalizeSummaryText(value: string | undefined): string {
  const lines = (value ?? "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*·•]\s*/u, "").trim())
    .filter(Boolean);
  return truncateMemoryText(lines.join(" · "), MEMORY_SUMMARY_MAX_CHARS);
}

/** 触发词：去重、截长、限个数；不接受空白项。 */
function normalizeTriggers(value: readonly string[] | undefined): string[] {
  const result: string[] = [];
  for (const item of value ?? []) {
    const cleaned = singleLine(String(item)).slice(0, MEMORY_TRIGGER_MAX_CHARS);
    if (!cleaned || result.includes(cleaned)) continue;
    result.push(cleaned);
    if (result.length >= MEMORY_TRIGGER_MAX_COUNT) break;
  }
  return result;
}

/** 新近度：30 天半衰、下限 0.5；7 天内更新的主题免疫（不罚刚写的）。 */
function recencyFactor(updatedAt: string, now = Date.now()): number {
  const timestamp = Date.parse(`${updatedAt}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return 1;
  const days = Math.max(0, (now - timestamp) / 86_400_000);
  if (days <= MEMORY_RECENCY_IMMUNE_DAYS) return 1;
  const factor = 0.5 ** ((days - MEMORY_RECENCY_IMMUNE_DAYS) / MEMORY_RECENCY_HALF_LIFE_DAYS);
  return Math.max(MEMORY_RECENCY_MIN, factor);
}

function normalizeWorkspacePath(path: string): string {
  const resolved = resolve(path);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameWorkspace(left: string, right: string): boolean {
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}

/** 扁平 frontmatter 解析（照 skill-catalog 的模式：值取首个冒号后的整行）。 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = FRONTMATTER_PATTERN.exec(content);
  const result: Record<string, string> = {};
  if (!match?.[1]) return result;
  for (const rawLine of match[1].split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    // 保留原大小写并额外落一份小写别名：序列化写的是 camelCase
    // （createdAt/updatedAt），历史/手写文件可能是全小写；两边都要能读到。
    // （v4 修复：此前一律小写，导致 parseTopicFile 读 meta.createdAt 永远
    //  undefined，重启后所有主题日期被重置成今天。）
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/gu, "");
    if (key && value) {
      result[key] = value;
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

function hashContent(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseTopicFile(raw: string, id: string): MemoryTopic | undefined {
  const meta = parseFrontmatter(raw);
  const title = meta.title?.trim() ?? "";
  const description = meta.description?.trim() ?? "";
  if (!title || !description) return undefined;
  const body = raw.replace(FRONTMATTER_PATTERN, "");
  const content = body.replace(/^\r?\n+/u, "").trimEnd();
  const layer = normalizeLayer(meta.layer);
  const summary = normalizeSummaryText(meta.summary);
  const triggers = normalizeTriggers(meta.triggers?.split(/[,，;；|]/u));
  return {
    id,
    title,
    description,
    ...(meta.workspace?.trim() ? { workspace: meta.workspace.trim() } : {}),
    layer,
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(summary ? { summary } : {}),
    content,
    contentChars: content.length,
    contentRevision: hashContent(content),
    createdAt: /^\d{4}-\d{2}-\d{2}$/u.test(meta.createdAt ?? "") ? meta.createdAt! : today(),
    updatedAt: /^\d{4}-\d{2}-\d{2}$/u.test(meta.updatedAt ?? "") ? meta.updatedAt! : today()
  };
}

function serializeTopic(topic: MemoryTopic): string {
  const frontmatter = [
    "---",
    `title: ${topic.title}`,
    `description: ${topic.description}`,
    ...(topic.layer && topic.layer !== "standard" ? [`layer: ${topic.layer}`] : []),
    ...(topic.summary ? [`summary: ${topic.summary}`] : []),
    ...(topic.triggers?.length ? [`triggers: ${topic.triggers.join(", ")}`] : []),
    ...(topic.workspace ? [`workspace: ${topic.workspace}`] : []),
    `createdAt: ${topic.createdAt}`,
    `updatedAt: ${topic.updatedAt}`,
    "---",
    ""
  ].join("\n");
  return `${frontmatter}\n${topic.content.trim()}\n`;
}

function summaryOf(topic: MemoryTopic): MemoryTopicSummary {
  const summaryText = (topic.summary ?? "").trim();
  const previewSource = summaryText || deriveMemoryDigest(topic.content, MEMORY_SUMMARY_PREVIEW_CHARS);
  return {
    id: topic.id,
    title: topic.title,
    description: topic.description,
    ...(topic.workspace ? { workspace: topic.workspace } : {}),
    layer: topic.layer ?? "standard",
    ...(topic.triggers?.length ? { triggers: topic.triggers } : {}),
    summaryChars: summaryText.length,
    ...(previewSource ? { summaryPreview: truncateMemoryText(previewSource, MEMORY_SUMMARY_PREVIEW_CHARS) } : {}),
    contentChars: topic.contentChars,
    contentRevision: topic.contentRevision,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt
  };
}

function compareTopics(left: MemoryTopic, right: MemoryTopic): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title, "zh");
}

function indexLine(topic: MemoryTopic): string {
  const mark = topic.layer === "core" ? "[核心] " : topic.layer === "archive" ? "[归档] " : "";
  return `- ${mark}${topic.title} — ${truncateDescription(topic.description, 80)}（${topic.contentChars} 字）`;
}

function sortTopics(topics: readonly MemoryTopic[]): MemoryTopic[] {
  return [...topics].sort(compareTopics);
}

function groupTopics(topics: readonly MemoryTopic[]): Array<{ header: string; topics: MemoryTopic[] }> {
  const groups = new Map<string, { header: string; topics: MemoryTopic[] }>();
  for (const topic of sortTopics(topics)) {
    const key = topic.workspace ? normalizeWorkspacePath(topic.workspace) : "";
    const group = groups.get(key) ?? { header: topic.workspace ?? "", topics: [] };
    group.topics.push(topic);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group);
}

/**
 * 该批主题的「主工作区」：绑定主题最多的那个工作区（平票取先出现的，
 * 即 sortTopics 之后更新更近的）。记忆总览用它决定每个助手的索引口径——
 * 用户通常就在这个工作区里和该助手开会话，索引快照因此对得上。
 */
export function primaryMemoryWorkspace(topics: readonly Pick<MemoryTopicSummary, "workspace">[]): string | undefined {
  const counts = new Map<string, { path: string; count: number }>();
  for (const topic of topics) {
    if (!topic.workspace) continue;
    const key = normalizeWorkspacePath(topic.workspace);
    const entry = counts.get(key) ?? { path: topic.workspace, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best: { path: string; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.path;
}

/** 与指定工作区相关的主题：全局恒可见，工作区主题仅在本工作区会话注入。 */
export function memoryTopicVisibleIn(topic: Pick<MemoryTopicSummary, "workspace">, workspace: string | undefined): boolean {
  return !topic.workspace || (workspace !== undefined && sameWorkspace(topic.workspace, workspace));
}

const visibleIn = memoryTopicVisibleIn;

function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}

function truncateDescription(text: string, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[a-z0-9]+|[\u3400-\u9fff]+/gu)) {
    const run = match[0]!;
    if (/^[a-z0-9]+$/u.test(run)) {
      tokens.push(run);
      continue;
    }
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens;
}

function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function stripFirstLine(text: string): string {
  const newline = text.indexOf(String.fromCharCode(10));
  return newline >= 0 ? text.slice(newline + 1) : text;
}

function snippetAround(text: string, query: string, tokens: readonly string[]): string {
  // 片段定位必须在原文下标上做：先 normalize("NFKC") 再 indexOf 会因变长映射
  // （ﬁ→fi、①→1 等）让片段从错误位置切开。这里只用小写化（中英文长度不变），
  // 归一化只参与分词/打分。
  const lower = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  let at = normalizedQuery ? lower.indexOf(normalizedQuery) : -1;
  if (at < 0) {
    for (const token of tokens) {
      const found = lower.indexOf(token.toLowerCase());
      if (found >= 0 && (at < 0 || found < at)) at = found;
    }
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - MEMORY_SEARCH_SNIPPET_BEFORE);
  const end = Math.min(text.length, at + MEMORY_SEARCH_SNIPPET_AFTER);
  const body = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

export function createMemoryStore(dir: string, onChanged: () => void): MemoryStore {
  const topicsDir = join(dir, "topics");
  const indexPath = join(dir, "MEMORY.md");
  const lockPath = join(dir, ".write.lock");

  let cache = new Map<string, CacheEntry>();
  let revision = 0;
  let searchCache: { revision: number; workspaceKey: string; docs: SearchDoc[] } | undefined;
  const warnedCorrupt = new Set<string>();

  function warnCorrupt(name: string, mtimeMs: number): void {
    const key = `${name}:${mtimeMs}`;
    if (warnedCorrupt.has(key)) return;
    warnedCorrupt.add(key);
    console.warn(`[memory] 跳过无法解析的主题文件：${name}`);
  }

  function loadAll(): MemoryTopic[] {
    let names: string[];
    try {
      names = readdirSync(topicsDir).filter((name) => name.toLowerCase().endsWith(".md"));
    } catch {
      if (cache.size > 0) {
        cache = new Map();
        revision += 1;
      }
      return [];
    }

    let changed = cache.size !== names.length;
    const next = new Map<string, CacheEntry>();
    for (const name of names) {
      const filePath = join(topicsDir, name);
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        changed = true;
        continue;
      }
      const existing = cache.get(name);
      if (existing && existing.mtimeMs === stats.mtimeMs && existing.size === stats.size) {
        next.set(name, existing);
        continue;
      }
      try {
        const id = name.slice(0, -3);
        const topic = parseTopicFile(readFileSync(filePath, "utf8"), id);
        if (topic) {
          next.set(name, { mtimeMs: stats.mtimeMs, size: stats.size, topic });
        } else {
          warnCorrupt(name, stats.mtimeMs);
          changed = true;
        }
      } catch {
        warnCorrupt(name, stats.mtimeMs);
        changed = true;
      }
    }
    if (!changed && next.size === cache.size) {
      for (const key of cache.keys()) {
        if (!next.has(key)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      cache = next;
      revision += 1;
    }
    return sortTopics([...next.values()].map((entry) => entry.topic));
  }

  function findTopic(topics: readonly MemoryTopic[], key: string): MemoryTopic | undefined {
    const needle = key.trim();
    return topics.find((topic) => topic.title.toLowerCase() === needle.toLowerCase()) ?? topics.find((topic) => topic.id === needle);
  }

  function uniqueSlug(topics: readonly MemoryTopic[], base: string): string {
    let slug = base;
    let suffix = 2;
    while (topics.some((topic) => topic.id === slug)) slug = `${base}-${suffix++}`;
    return slug;
  }

  function indexMarkdownFrom(topics: readonly MemoryTopic[]): string {
    if (topics.length === 0) return "";
    const groups = groupTopics(topics).map((group) => {
      const heading = group.header ? `## 工作区：${group.header}` : "## 全局";
      return [heading, ...group.topics.map(indexLine)].join("\n");
    });
    return [INDEX_HEADER, ...groups].join("\n\n");
  }

  /**
   * 会话注入索引的唯一实现：文本与逐条状态同源生成（markdown 就是 lines 的拼接），
   * 所以记忆中心的连线、预算与模型真正看到的快照不可能漂移。
   */
  function snapshotFrom(topics: readonly MemoryTopic[], maxChars: number): MemorySnapshot {
    const entries: MemorySnapshotEntry[] = [];
    if (topics.length === 0) return { markdown: "", characters: 0, budget: maxChars, entries, omitted: 0, compacted: false };
    const visible = sortTopics(topics);
    const core = visible.filter((topic) => topic.layer === "core");
    const archive = visible.filter((topic) => topic.layer === "archive");
    const standard = visible.filter((topic) => topic.layer !== "core" && topic.layer !== "archive");
    const lines: string[] = [];
    const limit = maxChars - SNAPSHOT_FOOTER_RESERVE;
    let used = 0;
    let omitted = 0;
    let compacted = false;

    /** 尝试放一行；成功返回该行占用的字符数（含前置换行），失败返回 0。 */
    const push = (text: string): number => {
      const cost = text.length + (lines.length > 0 ? 1 : 0);
      if (used + cost > limit) return 0;
      lines.push(text);
      used += cost;
      return cost;
    };

    // 核心层优先：高频繁主题永远在场，预算再紧也至少保留一行标题。
    if (core.length > 0) {
      push("[核心 · 每会话在场]");
      for (const topic of core) {
        const source = (topic.summary ?? "").trim() || deriveMemoryDigest(topic.content, MEMORY_SNAPSHOT_CORE_CHARS);
        let placedChars = 0;
        let wasCompacted = false;
        for (const cap of [MEMORY_SNAPSHOT_CORE_CHARS, 80, 40]) {
          const body = truncateMemoryText(source, cap);
          const text = body ? `- ${topic.title} — ${body}` : `- ${topic.title}`;
          placedChars = push(text);
          if (placedChars > 0) {
            wasCompacted = cap < MEMORY_SNAPSHOT_CORE_CHARS;
            break;
          }
        }
        if (placedChars === 0) {
          wasCompacted = true;
          placedChars = push(`- ${topic.title}`);
        }
        if (wasCompacted) compacted = true;
        entries.push({ topicId: topic.id, title: topic.title, layer: topic.layer ?? "standard", placed: placedChars > 0, chars: placedChars, compacted: wasCompacted, omitted: false });
      }
    }

    // 标准层：触发器优先，其次 24/12 字描述；超大主题只留标题。
    if (standard.length > 0) {
      push("[项目知识]");
      for (const topic of standard) {
        const hint = topic.triggers?.length ? `（${topic.triggers.join("/")}）` : "";
        const candidates = new Set<string>();
        if (topic.contentChars > MEMORY_TOPIC_INDEX_DEGRADE_CHARS) {
          candidates.add(`- ${topic.title}${hint}`);
        } else if (hint) {
          candidates.add(`- ${topic.title}${hint}`);
        } else {
          candidates.add(`- ${topic.title} — ${truncateDescription(topic.description, MEMORY_SNAPSHOT_DESC_MAX)}`);
          candidates.add(`- ${topic.title} — ${truncateDescription(topic.description, MEMORY_SNAPSHOT_DESC_COMPACT)}`);
          candidates.add(`- ${topic.title}`);
        }
        let placedChars = 0;
        let index = 0;
        for (const text of candidates) {
          placedChars = push(text);
          if (placedChars > 0) break;
          index += 1;
        }
        const placed = placedChars > 0;
        const wasCompacted = placed ? index > 0 : true;
        if (!placed) {
          omitted += 1;
          compacted = true;
        } else if (wasCompacted) {
          compacted = true;
        }
        entries.push({ topicId: topic.id, title: topic.title, layer: topic.layer ?? "standard", placed, chars: placedChars, compacted: wasCompacted, omitted: !placed });
      }
    }

    // 归档层不进索引：只留一行计数，靠 memory_search / memory_list 到达。
    if (archive.length > 0) push(`[归档] ${archive.length} 个：memory_search 可检索（不占常驻索引）`);
    for (const topic of archive) {
      entries.push({ topicId: topic.id, title: topic.title, layer: topic.layer ?? "standard", placed: false, chars: 0, compacted: false, omitted: false });
    }

    if (lines.length === 0) {
      const fallback = `（共 ${topics.length} 个主题；用 memory_search 检索，memory_list 可看全量）`;
      return { markdown: fallback, characters: fallback.length, budget: maxChars, entries, omitted, compacted };
    }
    if (omitted > 0) {
      // 脚注不参与预算：它是「被省略了多少」的唯一出口，宁可超几个字也不能被吞。
      lines.push(`（另有 ${omitted} 个标准主题未列出，用 memory_search 检索）`);
    } else if (compacted) {
      lines.push("（索引超预算，部分描述已压缩）");
    }
    const markdown = lines.join("\n").trim();
    return { markdown, characters: markdown.length, budget: maxChars, entries, omitted, compacted };
  }

  function snapshotMarkdownFrom(topics: readonly MemoryTopic[], maxChars: number): string {
    return snapshotFrom(topics, maxChars).markdown;
  }

  function commit(topics: readonly MemoryTopic[]): void {
    // 磁盘 MEMORY.md 是全量索引（供人浏览所有工作区）；注入用的过滤版走 snapshotMarkdown。
    writeFileAtomic(indexPath, `${indexMarkdownFrom(topics)}\n`);
    onChanged();
  }

  function withStoreLock<T>(operation: () => T): T {
    mkdirSync(dir, { recursive: true });
    const token = `${process.pid}-${randomUUID()}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        // 文件本身是锁内容：写入自己的一次性 token，释放时只有 token 相同才删。
        writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const stats = statSync(lockPath);
          if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
            // rename 是原子的：多个等待者只有一个能把陈旧锁移走，避免删掉别人刚建的新锁。
            const tombstone = `${lockPath}.stale-${randomUUID()}`;
            try {
              renameSync(lockPath, tombstone);
              rmSync(tombstone, { force: true });
            } catch {
              // 另一个等待者已经清理过；重试即可。
            }
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error("记忆主题正被其他会话写入，请稍后重试");
        }
        Atomics.wait(sleepBuffer, 0, 0, LOCK_RETRY_MS);
      }
    }
    try {
      return operation();
    } finally {
      try {
        if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath, { force: true });
      } catch {
        // 锁已被陈旧清理或主动释放；不要误删后来者的锁。
      }
    }
  }

  function rememberWritten(filePath: string, topic: MemoryTopic): void {
    try {
      const stats = statSync(filePath);
      cache.set(basename(filePath), { mtimeMs: stats.mtimeMs, size: stats.size, topic });
    } catch {
      cache.delete(basename(filePath));
    }
    revision += 1;
  }

  function buildSearchDocs(topics: readonly MemoryTopic[]): SearchDoc[] {
    const docs: SearchDoc[] = [];
    for (const topic of topics) {
      // 标题/描述/触发词/要点全部进主题级文档：触发词是「反直觉词」，
      // 它让「B站评论」能命中「黑鱼河的口味」这种标题看不出语义的主题。
      const summaryText = [topic.title, topic.description, ...(topic.triggers ?? []), topic.summary ?? ""]
        .filter(Boolean)
        .join("\n");
      const summaryLower = summaryText.normalize("NFKC").toLowerCase();
      docs.push({
        topic,
        text: summaryText,
        lower: summaryLower,
        tokens: tokenCounts(summaryText),
        length: summaryText.length
      });
      for (const section of splitMemorySections(topic.content)) {
        const text = topic.content.slice(section.start, section.end);
        const lower = text.normalize("NFKC").toLowerCase();
        docs.push({
          topic,
          section,
          text,
          lower,
          tokens: tokenCounts(text),
          length: text.length
        });
      }
    }
    return docs;
  }

  function topicFilterMatches(topic: MemoryTopic, filter: string): boolean {
    const needle = filter.trim().toLowerCase();
    return topic.title.toLowerCase() === needle || topic.id.toLowerCase() === needle;
  }

  /** 写入主题（假定已持锁）；save / update 共用同一条落盘路径。 */
  function saveLocked(input: MemorySaveInput): MemoryTopic {
    const title = singleLine(input.title);
    const description = singleLine(input.description);
    const content = input.content.trim();
    if (!title) throw new Error("记忆主题标题不能为空");
    if (!description) throw new Error("记忆主题描述不能为空（一句话索引行）");
    if (!content) throw new Error("记忆主题正文不能为空");

    const topics = loadAll();
    const existing = findTopic(topics, title);
    const id = existing?.id ?? uniqueSlug(topics, slugify(title) || `topic-${Date.now()}`);
    const workspace = input.bindWorkspace ?? existing?.workspace;
    const layer = input.layer !== undefined ? normalizeLayer(input.layer) : existing?.layer ?? "standard";
    const summary = input.summary !== undefined ? normalizeSummaryText(input.summary) : existing?.summary;
    const triggers = input.triggers !== undefined ? normalizeTriggers(input.triggers) : existing?.triggers;
    const nextTopic: MemoryTopic = {
      id,
      title,
      description,
      content,
      layer,
      ...(summary ? { summary } : {}),
      ...(triggers && triggers.length > 0 ? { triggers } : {}),
      ...(workspace ? { workspace } : {}),
      createdAt: existing?.createdAt ?? today(),
      updatedAt: today(),
      contentChars: content.length,
      contentRevision: hashContent(content)
    };
    const filePath = join(topicsDir, `${id}.md`);
    writeFileAtomic(filePath, serializeTopic(nextTopic));
    rememberWritten(filePath, nextTopic);
    commit(existing ? topics.map((topic) => (topic.id === id ? nextTopic : topic)) : [...topics, nextTopic]);
    return nextTopic;
  }

  return {
    list(): MemoryTopic[] {
      return loadAll();
    },
    summaries(): MemoryTopicSummary[] {
      return loadAll().map(summaryOf);
    },
    read(topic: string): MemoryTopic | undefined {
      return findTopic(loadAll(), topic);
    },
    save(input: MemorySaveInput): MemoryTopic {
      return withStoreLock(() => saveLocked(input));
    },
    update(topic: string, patch: MemoryUpdateInput): MemoryTopic {
      return withStoreLock(() => {
        const topics = loadAll();
        const existing = findTopic(topics, topic);
        if (!existing) throw new Error(`未找到记忆主题「${topic}」；先用 memory_list 确认标题`);
        return saveLocked({
          title: patch.title ?? existing.title,
          description: patch.description ?? existing.description,
          content: patch.content ?? existing.content,
          layer: patch.layer ?? existing.layer,
          summary: patch.summary !== undefined ? patch.summary : existing.summary,
          triggers: patch.triggers !== undefined ? patch.triggers : existing.triggers,
          ...(patch.bindWorkspace !== undefined ? { bindWorkspace: patch.bindWorkspace } : {})
        });
      });
    },
    append(input: MemoryAppendInput): MemoryAppendOutcome {
      return withStoreLock(() => {
        const topics = loadAll();
        const existing = findTopic(topics, input.topic);
        if (!existing) throw new Error(`未找到记忆主题「${input.topic}」；先用 memory_write 创建`);
        const filePath = join(topicsDir, `${existing.id}.md`);
        const fresh = parseTopicFile(readFileSync(filePath, "utf8"), existing.id);
        if (!fresh) throw new Error(`记忆主题「${existing.title}」文件损坏，无法追加`);
        const result = appendToMemoryContent(fresh.content, input.section, input.content);
        const nextTopic: MemoryTopic = {
          ...fresh,
          content: result.content,
          updatedAt: today(),
          contentChars: result.content.length,
          contentRevision: hashContent(result.content)
        };
        writeFileAtomic(filePath, serializeTopic(nextTopic));
        rememberWritten(filePath, nextTopic);
        commit(topics.map((topic) => (topic.id === nextTopic.id ? nextTopic : topic)));
        return {
          topic: nextTopic,
          label: result.label,
          created: result.created,
          addedChars: result.content.length - fresh.content.length
        };
      });
    },
    remove(topic: string): boolean {
      return withStoreLock(() => {
        const topics = loadAll();
        const existing = findTopic(topics, topic);
        if (!existing) return false;
        rmSync(join(topicsDir, `${existing.id}.md`), { force: true });
        cache.delete(`${existing.id}.md`);
        revision += 1;
        commit(topics.filter((item) => item.id !== existing.id));
        return true;
      });
    },
    indexMarkdown(workspace?: string): string {
      return indexMarkdownFrom(loadAll().filter((topic) => visibleIn(topic, workspace)));
    },
    snapshotMarkdown(workspace: string | undefined, maxChars: number): string {
      return snapshotMarkdownFrom(loadAll().filter((topic) => visibleIn(topic, workspace)), maxChars);
    },
    snapshotDetailed(workspace: string | undefined, maxChars: number): MemorySnapshot {
      return snapshotFrom(loadAll().filter((topic) => visibleIn(topic, workspace)), maxChars);
    },
    search(query: string, workspace?: string, options: MemorySearchOptions = {}): MemorySearchHit[] {
      const needle = query.trim();
      if (!needle) return [];
      const queryTokens = [...new Set(tokenize(needle))];
      if (queryTokens.length === 0) return [];

      const visibleTopics = loadAll().filter((topic) => visibleIn(topic, workspace));
      if (visibleTopics.length === 0) return [];
      const workspaceKey = workspace ? normalizeWorkspacePath(workspace) : "";
      if (!searchCache || searchCache.revision !== revision || searchCache.workspaceKey !== workspaceKey) {
        searchCache = { revision, workspaceKey, docs: buildSearchDocs(visibleTopics) };
      }
      const docs = options.topic
        ? searchCache.docs.filter((doc) => topicFilterMatches(doc.topic, options.topic!))
        : searchCache.docs;
      if (docs.length === 0) return [];

      const queryLower = needle.normalize("NFKC").toLowerCase();
      // 长查询至少命中三分之一的词（且不少于 2 个），并用 IDF 覆盖率 50% 过滤
      // 这类查询被「存在」「关键」等常见 bigram 蒙中；短查询（1–2 词）仍允许单词命中。
      const minimumMatched = queryTokens.length <= 2 ? 1 : Math.max(2, Math.ceil(queryTokens.length * 0.34));
      const totalDocs = docs.length;
      const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / totalDocs || 1;
      const documentFrequency = new Map<string, number>();
      for (const token of queryTokens) {
        let count = 0;
        for (const doc of docs) if (doc.tokens.has(token)) count += 1;
        documentFrequency.set(token, count);
      }
      const idfByToken = new Map<string, number>();
      for (const token of queryTokens) {
        const df = documentFrequency.get(token) ?? 0;
        idfByToken.set(token, Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5)));
      }
      const totalIdf = queryTokens.reduce((sum, token) => sum + (idfByToken.get(token) ?? 0), 0) || 1;

      const topicSignals = new Map<string, { titleHits: number; descriptionHits: number; triggerHits: number; summaryMatched: number; summaryMatchedIdf: number; phrase: boolean }>();
      for (const topic of visibleTopics) {
        if (options.topic && !topicFilterMatches(topic, options.topic)) continue;
        const titleLower = topic.title.normalize("NFKC").toLowerCase();
        const descriptionLower = topic.description.normalize("NFKC").toLowerCase();
        const triggerLower = (topic.triggers ?? []).join(" ").normalize("NFKC").toLowerCase();
        const summaryHaystack = [titleLower, descriptionLower, triggerLower, (topic.summary ?? "").normalize("NFKC").toLowerCase()].join(" ");
        topicSignals.set(topic.id, {
          titleHits: queryTokens.filter((token) => titleLower.includes(token)).length,
          descriptionHits: queryTokens.filter((token) => descriptionLower.includes(token)).length,
          triggerHits: triggerLower ? queryTokens.filter((token) => triggerLower.includes(token)).length : 0,
          summaryMatched: queryTokens.filter((token) => summaryHaystack.includes(token)).length,
          summaryMatchedIdf: queryTokens.filter((token) => summaryHaystack.includes(token)).reduce((sum, token) => sum + (idfByToken.get(token) ?? 0), 0),
          phrase: summaryHaystack.includes(queryLower)
        });
      }

      const sectionHits = new Map<string, ScoredDoc[]>();
      const summaryDocs = new Map<string, SearchDoc>();
      for (const doc of docs) {
        if (!doc.section) {
          summaryDocs.set(doc.topic.id, doc);
          continue;
        }
        let bm25 = 0;
        let matchedIdf = 0;
        let matched = 0;
        for (const token of queryTokens) {
          const tf = doc.tokens.get(token) ?? 0;
          if (tf === 0) continue;
          matched += 1;
          const df = documentFrequency.get(token) ?? 0;
          const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
          bm25 += idf * (tf * (SEARCH_K1 + 1)) / (tf + SEARCH_K1 * (1 - SEARCH_B + SEARCH_B * doc.length / averageLength));
          matchedIdf += idf;
        }
        if (bm25 === 0 || matched < minimumMatched || matchedIdf / totalIdf < 0.5) continue;
        const signal = topicSignals.get(doc.topic.id);
        const boost = (signal?.titleHits ?? 0) * 3 + (signal?.descriptionHits ?? 0) * 2 + (signal?.triggerHits ?? 0) * 3 + (signal?.phrase ? 1.5 : 0);
        const coverage = 0.6 + 0.4 * (matched / queryTokens.length);
        // 命中节标题（H2/H3）时加权：召回粒度更接近「真正要读的那一节」。
        const headingHit = queryTokens.some((token) => doc.section!.heading.normalize("NFKC").toLowerCase().includes(token));
        const score = (bm25 + boost) * coverage * (headingHit ? 1.5 : 1) * recencyFactor(doc.topic.updatedAt);
        const list = sectionHits.get(doc.topic.id) ?? [];
        list.push({ doc, score });
        sectionHits.set(doc.topic.id, list);
      }

      const hits: ScoredDoc[] = [];
      for (const list of sectionHits.values()) {
        list.sort((left, right) => right.score - left.score);
        hits.push(...list.slice(0, SEARCH_MAX_SECTIONS_PER_TOPIC));
      }
      for (const [topicId, signal] of topicSignals) {
        if (sectionHits.has(topicId)) continue;
        if (signal.summaryMatched < 1 || signal.summaryMatchedIdf / totalIdf < 0.5) continue;
        const doc = summaryDocs.get(topicId);
        if (!doc) continue;
        const score = (signal.titleHits * 3 + signal.descriptionHits * 2 + signal.triggerHits * 3 + (signal.phrase ? 1.5 : 0)) * recencyFactor(doc.topic.updatedAt);
        if (score <= 0) continue;
        hits.push({ doc, score });
      }

      hits.sort((left, right) => right.score - left.score
        || right.doc.topic.updatedAt.localeCompare(left.doc.topic.updatedAt)
        || left.doc.topic.title.localeCompare(right.doc.topic.title, "zh"));

      const limit = Math.max(1, Math.min(MEMORY_SEARCH_LIMIT_MAX, Math.round(options.limit ?? MEMORY_SEARCH_LIMIT)));
      return hits.slice(0, limit).map(({ doc }) => ({
        topic: summaryOf(doc.topic),
        ...(doc.section ? { section: doc.section.label, sectionIndex: doc.section.index } : {}),
        sectionChars: doc.section?.chars ?? doc.topic.contentChars,
        snippet: doc.section
          ? snippetAround(
              doc.section.level >= 2 && !doc.section.label.includes(" · 片段") ? stripFirstLine(doc.text) : doc.text,
              needle,
              queryTokens
            )
          : doc.topic.description
      }));
    }
  };
}

/** 会话创建时的记忆目录：`<agentDir>/pidesktop-memory/<agentId>/`（跨会话，按助手划分）。 */
export function memoryDirFor(agentDir: string, agentId: string): string {
  return join(agentDir, "pidesktop-memory", agentId);
}

/**
 * 工作区项目记忆库目录（2026-11-09，GitHub issue #2 配套）：
 * `<workspace>/.pidesktop/memory/`。项目知识归项目——任意被派到该工作区的助手
 * 都能接续，不锁在某个助手的目录里。布局与助手库完全同构（topics/ + MEMORY.md），
 * createMemoryStore 直接可用。该子目录沿用 `.pidesktop/` 既有惯例（screenshots/
 * downloads/hooks/skills），仓库侧被 .gitignore 的 `.pidesktop/` 整体覆盖。
 */
export function workspaceMemoryDirFor(workspace: string): string {
  return join(resolve(workspace), ".pidesktop", "memory");
}

/** 未启用记忆时目录是否存在（保留给诊断/清理用，普通流程不需要）。 */
export function memoryDirExists(dir: string): boolean {
  return existsSync(join(dir, "topics")) || existsSync(join(dir, "MEMORY.md"));
}

/** 迁移结果（migrateWorkspaceBoundTopics）：驱动日志与测试断言。 */
export interface MemoryMigrationOutcome {
  /** 扫描过的助手库目录数（含空库）。 */
  agentDirs: number;
  /** 搬走的主题数（绑定工作区且目标目录存在）。 */
  movedTopics: number;
  /** 目标工作区目录已不存在的主题数：保留原地不动，只计入报告。 */
  skippedMissingWorkspace: number;
  /** 目标工作区库内同名标题冲突：保留原地不动（不覆盖用户已写的主题）。 */
  skippedTitleConflict: number;
  /** 搬入的目标工作区（去重后的绝对路径）。 */
  targetWorkspaces: string[];
}

/**
 * 存量迁移（一次性，2026-11-09，GitHub issue #2 配套）：把助手库里 **已绑定工作区**
 * 的主题搬进对应工作区自己的项目库。旧模型里 workspace 只是个可见性标签，物理
 * 文件锁在助手目录；总控分发场景下被派到同一工作区的其他助手读不到它们。
 *
 * 纪律（与 v4 迁移的备份惯例一致）：
 * - 先整库备份 `<agentDir>/pidesktop-memory-backup-<ts>-workspace-split/`（rename 同
 *   卷原子操作）；备份失败直接放弃本次迁移，下次启动重试。
 * - 搬迁按「文件搬家 + 目标 store.save」走：源文件 copy 到备份后从助手库 remove，
 *   目标库用既有 saveLocked 落盘（frontmatter 原样保留，含 workspace 字段——工作区库
 *   内该字段继续有效：它同时也是面板归属筛选的标签）。
 * - 目标工作区目录不存在（用户删了项目）→ 主题原地保留，绝不丢数据。
 * - 目标库已有同名标题 → 原地保留（不覆盖用户数据），只计入 conflict。
 * - 幂等：没有可搬主题时零写入；单主题失败不中断整批（计入日志，下次重试该条）。
 */
export function migrateWorkspaceBoundTopics(
  agentDir: string,
  options: { readdirSync?: (dir: string) => DirentLike[]; now?: () => number } = {}
): MemoryMigrationOutcome {
  const base = join(agentDir, "pidesktop-memory");
  const listDirs = options.readdirSync ?? ((dir: string) => readdirSync(dir, { withFileTypes: true }) as unknown as DirentLike[]);
  const outcome: MemoryMigrationOutcome = { agentDirs: 0, movedTopics: 0, skippedMissingWorkspace: 0, skippedTitleConflict: 0, targetWorkspaces: [] };

  let agentIds: string[];
  try {
    agentIds = listDirs(base).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
  } catch {
    return outcome; // 没有任何记忆库：无事可做。
  }
  outcome.agentDirs = agentIds.length;

  // 第一遍：只读扫描，确认真的存在可搬主题（否则零写入，保持幂等）。
  interface PendingMove { agentId: string; topic: MemoryTopic; targetDir: string; }
  const pending: PendingMove[] = [];
  const targets = new Set<string>();
  for (const agentId of agentIds) {
    const sourceDir = memoryDirFor(agentDir, agentId);
    if (!memoryDirExists(sourceDir)) continue;
    const store = createMemoryStore(sourceDir, () => {});
    for (const topic of store.list()) {
      if (!topic.workspace?.trim()) continue;
      const targetWorkspace = resolve(topic.workspace);
      try {
        if (!statSync(targetWorkspace).isDirectory()) { outcome.skippedMissingWorkspace += 1; continue; }
      } catch {
        outcome.skippedMissingWorkspace += 1;
        continue;
      }
      const targetDir = workspaceMemoryDirFor(targetWorkspace);
      if (existsSync(join(targetDir, "topics"))) {
        const targetStore = createMemoryStore(targetDir, () => {});
        if (targetStore.read(topic.title)) { outcome.skippedTitleConflict += 1; continue; }
      }
      pending.push({ agentId, topic, targetDir });
      targets.add(normalizeWorkspacePath(targetWorkspace));
    }
  }
  if (pending.length === 0) return outcome;

  // 备份：把整个 pidesktop-memory rename 到带时间戳的备份目录（同卷原子）。
  const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/gu, "-");
  const backupDir = join(agentDir, `pidesktop-memory-backup-${stamp}-workspace-split`);
  try {
    mkdirSync(dirname(backupDir), { recursive: true });
    renameSync(base, backupDir);
  } catch {
    return outcome; // 备份失败（并发写/权限）：放弃本次，下次启动重试。
  }
  outcome.targetWorkspaces = [...targets];

  // 第二遍：从备份里的源库搬（在库锁内读源 + 目标落盘 + 源库删除）。
  for (const move of pending) {
    const sourceDir = join(backupDir, move.agentId);
    const targetDir = move.targetDir;
    try {
      const sourceStore = createMemoryStore(sourceDir, () => {});
      const targetStore = createMemoryStore(targetDir, () => {});
      const fresh = sourceStore.read(move.topic.title);
      if (!fresh) continue; // 并发删除：跳过（不失败）。
      targetStore.save({
        title: fresh.title,
        description: fresh.description,
        content: fresh.content,
        layer: fresh.layer,
        ...(fresh.summary ? { summary: fresh.summary } : {}),
        ...(fresh.triggers?.length ? { triggers: fresh.triggers } : {}),
        bindWorkspace: fresh.workspace
      });
      if (sourceStore.remove(fresh.title)) outcome.movedTopics += 1;
    } catch (error) {
      console.warn(`[memory] 迁移工作区主题失败（${move.agentId}/${move.topic.title}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 收尾：把备份目录搬回原名（源库中已搬走的主题在备份里被删掉了；
  // 备份目录本体保留一份副本——不，rename 回去意味着备份不再存在。
  // 折衷：复制回原位（保留备份不动），失败则 rename 回（至少原位恢复）。
  try {
    copyTree(backupDir, base);
  } catch {
    try { renameSync(backupDir, base); } catch { /* 原位缺失且 rename 失败：下次启动重建索引（数据都在备份里） */ }
  }
  return outcome;
}

/** 目录树复制（迁移收尾用）：文件级 copy，目标已存在则跳过（不覆盖新写入）。 */
function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (!existsSync(to)) copyFileSync(from, to);
  }
}

/** readdir Dirent 的最小形状（测试可注入假目录列表）。 */
interface DirentLike { name: string; isDirectory(): boolean; }
