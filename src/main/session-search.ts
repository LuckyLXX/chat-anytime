import type { SessionSearchHit, SessionSummary } from "../shared/protocol.js";
import { sessionPathKey } from "./session-scope.js";
import type { SessionTextIndex } from "./session-text-index.js";

/**
 * 会话正文检索：多词 AND + 可解释打分，不做 BM25。
 *
 * 为什么不用 BM25：消息粒度上词频归一带来的收益很小，而把 2.4 MB 文本先分词
 * 建文档频率表需要额外一遍全量扫描。用户的真实输入通常是「记得的那句话」，
 * 子串命中就是最准的信号；多词查询（空格分隔）要求全部出现，再按标题、近期、
 * 出现次数排序即可。
 */

/** 一次最多返回多少条命中（侧栏内联列表，再多也不好扫）。 */
export const SESSION_SEARCH_LIMIT = 40;
/** 单个会话最多贡献几条命中：避免一个超长会话把整份结果占满。 */
export const SESSION_SEARCH_PER_SESSION = 3;
/** 片段半径：命中词左右各多少字符。 */
const SNIPPET_RADIUS = 60;

export interface SessionSearchOptions {
  limit?: number;
}

export function normalizeSearchQuery(query: string): string {
  return query.normalize("NFKC").toLowerCase().trim();
}

/** 查询拆词：空白分隔，全词要求 AND。 */
export function searchTerms(query: string): string[] {
  return [...new Set(normalizeSearchQuery(query).split(/\s+/u).filter(Boolean))];
}

/**
 * 截取命中附近的片段。用 NFKC 规范化的文本做切片，保证与匹配位置同一坐标系
 * （片段展示的规范化差异只影响全角/兼容字符，可接受）。
 */
export function buildSnippet(text: string, terms: readonly string[], radius = SNIPPET_RADIUS): string {
  const normalized = text.normalize("NFKC");
  const lower = normalized.toLowerCase();
  let position = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (position < 0 || at < position)) position = at;
  }
  if (position < 0) position = 0;
  const start = Math.max(0, position - radius);
  const end = Math.min(normalized.length, position + radius);
  const slice = normalized.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < normalized.length ? "…" : ""}`;
}

function countOccurrences(lower: string, terms: readonly string[], cap: number): number {
  let total = 0;
  for (const term of terms) {
    let at = lower.indexOf(term);
    while (at >= 0 && total < cap) {
      total += 1;
      at = lower.indexOf(term, at + term.length);
    }
    if (total >= cap) break;
  }
  return total;
}

/**
 * 在索引上检索当前助手的会话。返回按分数降序的命中，每条带会话元数据，
 * 点击后可直接 `session.open` + 按 timestamp/role 定位。
 */
export function searchSessionText(
  index: SessionTextIndex,
  sessions: readonly SessionSummary[],
  query: string,
  options: SessionSearchOptions = {}
): SessionSearchHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const limit = Math.max(1, options.limit ?? SESSION_SEARCH_LIMIT);
  const now = Date.now();
  const hits: SessionSearchHit[] = [];

  for (const session of sessions) {
    const entry = index.files[sessionPathKey(session.path)];
    if (!entry || entry.docs.length === 0) continue;
    const title = normalizeSearchQuery(session.title);
    // 标题命中说明整个会话就是讲这个的：同分情况下优先。
    const titleBoost = terms.every((term) => title.includes(term)) ? 8 : 0;
    // 近期会话轻微加权（30 天内线性衰减到 0）：找「上次说过」时时间是强线索。
    const recentBoost = Math.max(0, 1 - (now - session.modifiedAt) / (30 * 24 * 60 * 60 * 1000)) * 6;

    const sessionHits: SessionSearchHit[] = [];
    for (const doc of entry.docs) {
      const normalized = doc.text.normalize("NFKC");
      const lower = normalized.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      const occurrences = countOccurrences(lower, terms, 5);
      sessionHits.push({
        sessionId: session.id,
        path: session.path,
        title: session.title,
        workspace: session.workspace,
        ...(session.archived ? { archived: true } : {}),
        modifiedAt: session.modifiedAt,
        timestamp: doc.timestamp,
        role: doc.role,
        snippet: buildSnippet(normalized, terms),
        score: 10 + titleBoost + recentBoost + occurrences
      });
    }
    if (sessionHits.length === 0) continue;
    sessionHits.sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
    hits.push(...sessionHits.slice(0, SESSION_SEARCH_PER_SESSION));
  }

  hits.sort((left, right) => right.score - left.score || right.modifiedAt - left.modifiedAt || right.timestamp - left.timestamp);
  return hits.slice(0, limit);
}
