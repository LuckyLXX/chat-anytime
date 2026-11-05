import type { MemoryLayer, MemoryTopicSummary } from "./protocol.js";
import {
  MEMORY_SNAPSHOT_BUDGET_CHARS,
  MEMORY_TOPIC_INDEX_DEGRADE_CHARS,
  MEMORY_TOPIC_WARN_CHARS
} from "./memory.js";

/**
 * 记忆库健康检查（纯函数，无 IO）。
 *
 * 目的：把「记忆会自然变脏」这件事变成可显示、可行动的清单——过大的主题、
 * 没有要点的核心主题、九十天没动过的项目知识、标题/描述高度重叠的重复主题、
 * 快顶满的索引预算、内容过短的空壳。它只给建议，不自动改数据：
 * 分类与删除仍由人（面板）或模型（memory_* 工具）决定。
 */
export type MemoryHealthIssueKind =
  | "index-pressure"
  | "large"
  | "index-degraded"
  | "core-no-summary"
  | "stale"
  | "tiny"
  | "duplicate";

export interface MemoryHealthIssue {
  kind: MemoryHealthIssueKind;
  severity: "warn" | "info";
  /** 主题级问题时给出；索引级问题（index-pressure）没有。 */
  topicId?: string;
  title?: string;
  message: string;
  suggestion: string;
}

export interface MemoryDuplicateGroup {
  titles: string[];
  ids: string[];
  /** 标题 + 描述的 Jaccard 相似度（0–1）。 */
  score: number;
}

export interface MemoryHealth {
  topics: number;
  chars: number;
  layers: Record<MemoryLayer, number>;
  indexChars: number;
  indexBudget: number;
  issues: MemoryHealthIssue[];
  duplicates: MemoryDuplicateGroup[];
  checkedAt: number;
}

export interface MemoryHealthInput {
  /** 当前工作区可见主题的索引快照字数（与会话注入同一函数）。 */
  indexChars: number;
  indexBudget?: number;
  now?: number;
}

const STALE_DAYS = 90;
const DUPLICATE_THRESHOLD = 0.55;
const TINY_CHARS = 50;

function tokenize(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]+|[\u3400-\u9fff]+/gu)) {
    const run = match[0]!;
    if (/^[a-z0-9]+$/u.test(run)) {
      tokens.add(run);
      continue;
    }
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function daysSince(date: string, now: number): number {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((now - timestamp) / 86_400_000));
}

function layerOf(topic: Pick<MemoryTopicSummary, "layer">): MemoryLayer {
  return topic.layer ?? "standard";
}

export function analyzeMemoryHealth(topics: readonly MemoryTopicSummary[], input: MemoryHealthInput): MemoryHealth {
  const budget = input.indexBudget ?? MEMORY_SNAPSHOT_BUDGET_CHARS;
  const now = input.now ?? Date.now();
  const layers: Record<MemoryLayer, number> = { core: 0, standard: 0, archive: 0 };
  for (const topic of topics) layers[layerOf(topic)] += 1;
  const chars = topics.reduce((sum, topic) => sum + topic.contentChars, 0);
  const issues: MemoryHealthIssue[] = [];

  if (input.indexChars > budget * 0.9) {
    issues.push({
      kind: "index-pressure",
      severity: "warn",
      message: `索引 ${input.indexChars.toLocaleString("en-US")} / ${budget.toLocaleString("en-US")} 字，已用超过 90%。`,
      suggestion: "把已解细节下沉到归档，或合并相近主题；标准主题的描述会先被压缩。"
    });
  }

  const seen: Array<{ topic: MemoryTopicSummary; tokens: Set<string> }> = [];
  const duplicates: MemoryDuplicateGroup[] = [];
  const reported = new Set<string>();

  for (const topic of topics) {
    const layer = layerOf(topic);
    if (topic.contentChars > MEMORY_TOPIC_WARN_CHARS) {
      issues.push({
        kind: "large",
        severity: "warn",
        topicId: topic.id,
        title: topic.title,
        message: `正文 ${topic.contentChars.toLocaleString("en-US")} 字，超过 ${MEMORY_TOPIC_WARN_CHARS.toLocaleString("en-US")} 字提醒线。`,
        suggestion: "拆成子主题，或把已解细节用 memory_append 下沉到归档主题。"
      });
    }
    if (topic.contentChars > MEMORY_TOPIC_INDEX_DEGRADE_CHARS) {
      issues.push({
        kind: "index-degraded",
        severity: "warn",
        topicId: topic.id,
        title: topic.title,
        message: `索引里已降级为只有标题（正文超过 ${MEMORY_TOPIC_INDEX_DEGRADE_CHARS.toLocaleString("en-US")} 字）。`,
        suggestion: "拆分主题是唯一能恢复「标题 + 描述」索引的办法。"
      });
    }
    if (layer === "core" && !topic.summaryChars) {
      issues.push({
        kind: "core-no-summary",
        severity: "warn",
        topicId: topic.id,
        title: topic.title,
        message: "核心主题没有要点，索引里只有标题，模型每次都要整篇读。",
        suggestion: "在记忆中心补 3–8 行要点（≤400 字）。"
      });
    }
    if (layer === "standard" && topic.updatedAt) {
      const age = daysSince(topic.updatedAt, now);
      if (age >= STALE_DAYS) {
        issues.push({
          kind: "stale",
          severity: "info",
          topicId: topic.id,
          title: topic.title,
          message: `${age} 天没有更新。`,
          suggestion: "确认是否仍然有效：还有用就补一句现状，过时了就移到归档。"
        });
      }
    }
    if (topic.contentChars < TINY_CHARS) {
      issues.push({
        kind: "tiny",
        severity: "info",
        topicId: topic.id,
        title: topic.title,
        message: `正文只有 ${topic.contentChars} 字，可能是空壳。`,
        suggestion: "补全内容，或合并进相关主题后删除。"
      });
    }

    const tokens = tokenize(`${topic.title}\n${topic.description}`);
    for (const other of seen) {
      const score = jaccard(tokens, other.tokens);
      if (score < DUPLICATE_THRESHOLD) continue;
      const key = [topic.id, other.topic.id].sort().join("|");
      if (reported.has(key)) continue;
      reported.add(key);
      duplicates.push({ titles: [other.topic.title, topic.title], ids: [other.topic.id, topic.id], score: Math.round(score * 100) / 100 });
      issues.push({
        kind: "duplicate",
        severity: "info",
        topicId: topic.id,
        title: topic.title,
        message: `标题/描述与「${other.topic.title}」高度重叠（相似度 ${Math.round(score * 100)}%）。`,
        suggestion: "合并成一个主题（保留更准确的标题），或给各自补上区分的触发词。"
      });
    }
    seen.push({ topic, tokens });
  }

  issues.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === "warn" ? -1 : 1));
  return {
    topics: topics.length,
    chars,
    layers,
    indexChars: input.indexChars,
    indexBudget: budget,
    issues,
    duplicates,
    checkedAt: now
  };
}
