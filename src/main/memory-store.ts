import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import type { MemoryTopic } from "../shared/protocol.js";

/**
 * Markdown-backed 长期记忆库（原子 tmp+rename 写）。布局：
 *
 *   <dir>/topics/<id>.md   每主题一个文件：扁平 frontmatter（title/description/
 *                          workspace?/createdAt/updatedAt）+ markdown 正文
 *   <dir>/MEMORY.md        派生索引：store 每次变更自动再生成，供人浏览；
 *                          模型不维护索引（无同步漂移），注入用 indexMarkdown()
 *
 * 主题按 title 定位（读取/替换/删除），id 只是稳定文件名，不随语义变化。
 * 同助手多个并发会话共享同一目录：文件级原子写、最后写赢（与 Proma 一致）。
 */

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;
const INDEX_HEADER = "# 长期记忆索引（store 自动生成，勿手改；正文见 topics/）";

export interface MemorySaveInput {
  title: string;
  description: string;
  content: string;
  /** 绑定到该工作区路径（对已有主题即改绑）；缺省保留既有绑定，新主题为全局。 */
  bindWorkspace?: string;
}

export interface MemorySearchHit {
  topic: MemoryTopic;
  snippet: string;
}

export interface MemoryStore {
  list(): MemoryTopic[];
  /** 按 title（不区分大小写）或文件名 id 定位主题。 */
  read(topic: string): MemoryTopic | undefined;
  /** 按 title upsert：命中则整主题替换（保留 id/createdAt/既有工作区绑定）。 */
  save(input: MemorySaveInput): MemoryTopic;
  remove(topic: string): boolean;
  /** 派生索引；workspace 给定时只含全局 + 该工作区主题，无工作区则仅全局。 */
  indexMarkdown(workspace?: string): string;
  /** 标题命中优先的关键词检索，最多 5 条；workspace 过滤口径同 indexMarkdown。 */
  search(query: string, workspace?: string): MemorySearchHit[];
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

function parseTopicFile(raw: string, id: string): MemoryTopic | undefined {
  const meta = parseFrontmatter(raw);
  const title = meta.title?.trim() ?? "";
  const description = meta.description?.trim() ?? "";
  if (!title || !description) return undefined;
  const body = raw.replace(FRONTMATTER_PATTERN, "");
  return {
    id,
    title,
    description,
    ...(meta.workspace?.trim() ? { workspace: meta.workspace.trim() } : {}),
    content: body.replace(/^\r?\n+/u, "").trimEnd(),
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

function indexLine(topic: MemoryTopic): string {
  return `- ${topic.title} — ${topic.description}`;
}

/** 与指定工作区相关的主题：全局恒可见，工作区主题仅在本工作区会话注入。 */
export function memoryTopicVisibleIn(topic: MemoryTopic, workspace: string | undefined): boolean {
  return !topic.workspace || (workspace !== undefined && sameWorkspace(topic.workspace, workspace));
}

const visibleIn = memoryTopicVisibleIn;

function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}

export function createMemoryStore(dir: string, onChanged: () => void): MemoryStore {
  const topicsDir = join(dir, "topics");
  const indexPath = join(dir, "MEMORY.md");

  function loadAll(): MemoryTopic[] {
    try {
      return readdirSync(topicsDir)
        .filter((name) => name.toLowerCase().endsWith(".md"))
        .map((name) => {
          const id = name.slice(0, -3);
          try {
            return parseTopicFile(readFileSync(join(topicsDir, name), "utf8"), id);
          } catch {
            return undefined; // 单文件损坏/不可读 → 跳过，库整体自愈
          }
        })
        .filter((topic): topic is MemoryTopic => Boolean(topic))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title, "zh"));
    } catch {
      return []; // 目录不存在 → 空库
    }
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
    const groups = new Map<string, { header: string; topics: MemoryTopic[] }>();
    for (const topic of topics) {
      const key = topic.workspace ? normalizeWorkspacePath(topic.workspace) : "";
      const group = groups.get(key) ?? { header: topic.workspace ?? "", topics: [] };
      group.topics.push(topic);
      groups.set(key, group);
    }
    const sections = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => {
      const heading = key ? `## 工作区：${group.header}` : "## 全局";
      return [heading, ...group.topics.map(indexLine)].join("\n");
    });
    return [INDEX_HEADER, ...sections].join("\n\n");
  }

  function commit(topics: readonly MemoryTopic[]): void {
    // 磁盘 MEMORY.md 是全量索引（供人浏览所有工作区）；注入用的过滤版走 indexMarkdown。
    writeFileAtomic(indexPath, `${indexMarkdownFrom(topics)}\n`);
    onChanged();
  }

  return {
    list(): MemoryTopic[] {
      return loadAll();
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
      const topics = loadAll();
      const existing = findTopic(topics, title);
      const workspace = input.bindWorkspace ?? existing?.workspace;
      const topic: MemoryTopic = existing
        ? { ...existing, title, description, content, updatedAt: today(), ...(workspace ? { workspace } : {}) }
        : { id: uniqueSlug(topics, slugify(title) || `topic-${Date.now()}`), title, description, content, createdAt: today(), updatedAt: today(), ...(workspace ? { workspace } : {}) };
      writeFileAtomic(join(topicsDir, `${topic.id}.md`), serializeTopic(topic));
      commit(topics.some((item) => item.id === topic.id) ? topics.map((item) => (item.id === topic.id ? topic : item)) : [...topics, topic]);
      return topic;
    },
    remove(topic: string): boolean {
      const topics = loadAll();
      const existing = findTopic(topics, topic);
      if (!existing) return false;
      rmSync(join(topicsDir, `${existing.id}.md`), { force: true });
      commit(topics.filter((item) => item.id !== existing.id));
      return true;
    },
    indexMarkdown(workspace?: string): string {
      return indexMarkdownFrom(loadAll().filter((topic) => visibleIn(topic, workspace)));
    },
    search(query: string, workspace?: string): MemorySearchHit[] {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      const scored = loadAll()
        .filter((topic) => visibleIn(topic, workspace))
        .map((topic) => {
          const inTitle = topic.title.toLowerCase().includes(needle);
          const inDescription = topic.description.toLowerCase().includes(needle);
          const at = topic.content.toLowerCase().indexOf(needle);
          if (!inTitle && !inDescription && at < 0) return undefined;
          const snippetSource = at >= 0 ? topic.content.slice(Math.max(0, at - 40), at + needle.length + 60) : topic.description;
          const score = (inTitle ? 4 : 0) + (inDescription ? 2 : 0) + (at >= 0 ? 1 : 0);
          return { topic, snippet: snippetSource.replace(/\r?\n/gu, " ").trim(), score };
        })
        .filter((hit): hit is MemorySearchHit & { score: number } => Boolean(hit))
        .sort((left, right) => right.score - left.score || right.topic.updatedAt.localeCompare(left.topic.updatedAt));
      return scored.slice(0, 5).map(({ topic, snippet }) => ({ topic, snippet }));
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
