import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import type { MemoryTopic, MemoryTopicSummary } from "../shared/protocol.js";
import {
  MEMORY_SEARCH_LIMIT,
  MEMORY_SEARCH_LIMIT_MAX,
  MEMORY_SNAPSHOT_DESC_COMPACT,
  MEMORY_SNAPSHOT_DESC_MAX
} from "../shared/memory.js";
import { appendToMemoryContent, splitMemorySections, type MemorySection } from "./memory-sections.js";

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
const SNIPPET_BEFORE = 70;
const SNIPPET_AFTER = 150;
const SNAPSHOT_FOOTER_RESERVE = 100;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface MemorySaveInput {
  title: string;
  description: string;
  content: string;
  /** 绑定到该工作区路径（对已有主题即改绑）；缺省保留既有绑定，新主题为全局。 */
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
  /** 按 title upsert：命中则整主题替换（保留 id/createdAt/既有工作区绑定）。 */
  save(input: MemorySaveInput): MemoryTopic;
  /** 按节/文末追加，不覆盖既有正文；未命中且非纯数字时新建节。 */
  append(input: MemoryAppendInput): MemoryAppendOutcome;
  remove(topic: string): boolean;
  /** 派生全量索引（写 MEMORY.md / 供人浏览）；workspace 给定时只含可见主题。 */
  indexMarkdown(workspace?: string): string;
  /** 会话注入用的预算索引：超出 maxChars 时压缩描述/省略主题并写脚注。 */
  snapshotMarkdown(workspace: string | undefined, maxChars: number): string;
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
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/gu, "");
    if (key && value) result[key] = value;
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
  return {
    id,
    title,
    description,
    ...(meta.workspace?.trim() ? { workspace: meta.workspace.trim() } : {}),
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
    ...(topic.workspace ? [`workspace: ${topic.workspace}`] : []),
    `createdAt: ${topic.createdAt}`,
    `updatedAt: ${topic.updatedAt}`,
    "---",
    ""
  ].join("\n");
  return `${frontmatter}\n${topic.content.trim()}\n`;
}

function summaryOf(topic: MemoryTopic): MemoryTopicSummary {
  return {
    id: topic.id,
    title: topic.title,
    description: topic.description,
    ...(topic.workspace ? { workspace: topic.workspace } : {}),
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
  return `- ${topic.title} — ${topic.description}`;
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
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + SNIPPET_AFTER);
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

  function snapshotMarkdownFrom(topics: readonly MemoryTopic[], maxChars: number): string {
    if (topics.length === 0) return "";
    const lines: string[] = [];
    let used = 0;
    let omitted = 0;
    let compacted = false;
    const visibleTopics = sortTopics(topics);

    for (const group of groupTopics(visibleTopics)) {
      const heading = group.header ? `## 工作区：${group.header}` : "## 全局";
      let headingAdded = false;
      for (const topic of group.topics) {
        const candidates = [
          { text: `- ${topic.title} — ${truncateDescription(topic.description, MEMORY_SNAPSHOT_DESC_MAX)}`, compact: false },
          { text: `- ${topic.title} — ${truncateDescription(topic.description, MEMORY_SNAPSHOT_DESC_COMPACT)}`, compact: true },
          { text: `- ${topic.title}`, compact: true }
        ];
        let chosen: { text: string; compact: boolean } | undefined;
        for (const candidate of candidates) {
          const cost = candidate.text.length + (headingAdded ? 0 : heading.length + 1) + (lines.length > 0 ? 1 : 0);
          if (used + cost <= maxChars - SNAPSHOT_FOOTER_RESERVE) {
            chosen = candidate;
            break;
          }
        }
        if (!chosen) {
          omitted += 1;
          continue;
        }
        if (!headingAdded) {
          lines.push(heading);
          used += heading.length + 1;
          headingAdded = true;
        }
        lines.push(chosen.text);
        used += chosen.text.length + 1;
        if (chosen.compact || topic.description.length > MEMORY_SNAPSHOT_DESC_MAX) compacted = true;
      }
      if (headingAdded) lines.push("");
    }

    if (lines.length === 0) {
      return `（共 ${topics.length} 个主题；用 memory_search 检索，memory_list 可看全量）`;
    }
    if (omitted > 0) {
      lines.push(`（共 ${topics.length} 个主题；另有 ${omitted} 个未列出，用 memory_search 检索，memory_list 可看全量）`);
    } else if (compacted) {
      lines.push("（索引超预算，部分描述已压缩）");
    }
    return lines.join("\n").trim();
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
      const summaryText = `${topic.title}\n${topic.description}`;
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
      const title = singleLine(input.title);
      const description = singleLine(input.description);
      const content = input.content.trim();
      if (!title) throw new Error("记忆主题标题不能为空");
      if (!description) throw new Error("记忆主题描述不能为空（一句话索引行）");
      if (!content) throw new Error("记忆主题正文不能为空");

      return withStoreLock(() => {
        const topics = loadAll();
        const existing = findTopic(topics, title);
        const id = existing?.id ?? uniqueSlug(topics, slugify(title) || `topic-${Date.now()}`);
        const workspace = input.bindWorkspace ?? existing?.workspace;
        const nextTopic: MemoryTopic = existing
          ? {
              ...existing,
              title,
              description,
              content,
              updatedAt: today(),
              contentChars: content.length,
              contentRevision: hashContent(content),
              ...(workspace ? { workspace } : {})
            }
          : {
              id,
              title,
              description,
              content,
              createdAt: today(),
              updatedAt: today(),
              contentChars: content.length,
              contentRevision: hashContent(content),
              ...(workspace ? { workspace } : {})
            };
        const filePath = join(topicsDir, `${id}.md`);
        writeFileAtomic(filePath, serializeTopic(nextTopic));
        rememberWritten(filePath, nextTopic);
        const nextTopics = existing
          ? topics.map((topic) => (topic.id === id ? nextTopic : topic))
          : [...topics, nextTopic];
        commit(nextTopics);
        return nextTopic;
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

      const topicSignals = new Map<string, { titleHits: number; descriptionHits: number; summaryMatched: number; summaryMatchedIdf: number; phrase: boolean }>();
      for (const topic of visibleTopics) {
        if (options.topic && !topicFilterMatches(topic, options.topic)) continue;
        const titleLower = topic.title.normalize("NFKC").toLowerCase();
        const descriptionLower = topic.description.normalize("NFKC").toLowerCase();
        const summaryHaystack = `${titleLower} ${descriptionLower}`;
        topicSignals.set(topic.id, {
          titleHits: queryTokens.filter((token) => titleLower.includes(token)).length,
          descriptionHits: queryTokens.filter((token) => descriptionLower.includes(token)).length,
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
        const boost = (signal?.titleHits ?? 0) * 3 + (signal?.descriptionHits ?? 0) * 2 + (signal?.phrase ? 1.5 : 0);
        const coverage = 0.6 + 0.4 * (matched / queryTokens.length);
        const score = (bm25 + boost) * coverage;
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
        const score = signal.titleHits * 3 + signal.descriptionHits * 2 + (signal.phrase ? 1.5 : 0);
        if (score <= 0) continue;
        const doc = summaryDocs.get(topicId);
        if (doc) hits.push({ doc, score });
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

/** 未启用记忆时目录是否存在（保留给诊断/清理用，普通流程不需要）。 */
export function memoryDirExists(dir: string): boolean {
  return existsSync(join(dir, "topics")) || existsSync(join(dir, "MEMORY.md"));
}
