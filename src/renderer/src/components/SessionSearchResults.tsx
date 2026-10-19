import type { ReactNode } from "react";
import type { SessionSearchHit } from "../../../shared/protocol";

/**
 * 侧栏内联的会话全文检索结果。
 *
 * 只做展示与点击：搜索触发、防抖与 requestId 生命周期在 App 里（搜索是用户
 * 输入的自然延伸），这里保持纯组件，便于独立渲染测试与主题化。
 *
 * 不新增 `data-pane`：外层已经是 `data-pane="sidebar"`，新增取值会让主题契约
 * （pane 名单五处镜像）多一个未登记项；主题要定制这段用 `.session-search-results`。
 */

const ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/gu;

const escapeRegExp = (value: string): string => value.replace(ESCAPE_PATTERN, "\\$&");

/** 把片段按查询词切开并高亮；查询空白分隔，与检索端的 AND 口径一致。 */
export function highlightSnippet(snippet: string, query: string): ReactNode {
  const terms = [...new Set(
    query.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean)
  )].sort((left, right) => right.length - left.length);
  if (terms.length === 0) return snippet;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
  return snippet.split(pattern).map((part, index) =>
    index % 2 === 1 ? <mark key={`${index}-${part}`}>{part}</mark> : part
  );
}

export function SessionSearchResults({ query, hits, loading, error, scanned, onOpen }: {
  query: string;
  hits: readonly SessionSearchHit[];
  loading: boolean;
  error?: string;
  scanned?: number;
  onOpen(hit: SessionSearchHit): void;
}): ReactNode {
  if (!query.trim()) return null;
  const scannedNote = !loading && typeof scanned === "number" && scanned > 0
    ? `${hits.length} 条 · 扫描 ${scanned} 个会话`
    : undefined;
  return (
    <section className="session-search-results" aria-label="消息内容检索结果">
      <div className="session-search-heading">
        <span>消息内容</span>
        <em>{loading ? "搜索中…" : scannedNote ?? `${hits.length} 条`}</em>
      </div>
      {error ? <p className="session-search-empty">{error}</p> : null}
      {!loading && !error && hits.length === 0 ? <p className="session-search-empty">没有匹配的消息</p> : null}
      {hits.map((hit, index) => (
        <button
          type="button"
          key={`${hit.path}:${String(hit.timestamp)}:${hit.role}:${String(index)}`}
          className="session-search-hit"
          title={`${hit.title} · ${hit.workspace}`}
          onClick={() => onOpen(hit)}
        >
          <span className="session-search-hit-head">
            <strong>{hit.title}</strong>
            <em>{hit.role === "user" ? "你" : "助手"}</em>
            {hit.archived ? <span className="session-search-hit-archived">已归档</span> : null}
          </span>
          <span className="session-search-hit-snippet">{highlightSnippet(hit.snippet, query)}</span>
        </button>
      ))}
    </section>
  );
}
