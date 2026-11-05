import { Activity, Archive, ArchiveRestore, Brain, Check, FileText, LoaderCircle, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MemoryHealthIssue, MemoryLayer, MemoryTopicSummary } from "../../shared/protocol";
import { MemoryCard } from "./components/MemoryCard";
import { MemoryHealthPane } from "./components/MemoryHealthPane";
import { MEMORY_LAYER_LABEL, compareMemoryTopics, formatMemoryChars, memoryLayerOf, parseMemoryTriggers } from "./lib/memory-format";
import { useDesktopStore } from "./store";

type SortMode = "updated" | "size" | "title";
type DetailTab = "topic" | "index" | "health";

interface MemoryDraft {
  layer: MemoryLayer;
  description: string;
  summary: string;
  triggers: string;
}

function sortTopics(topics: MemoryTopicSummary[], mode: SortMode): MemoryTopicSummary[] {
  const sorted = [...topics].sort(compareMemoryTopics);
  if (mode === "size") return sorted.sort((left, right) => right.contentChars - left.contentChars);
  if (mode === "title") return sorted.sort((left, right) => left.title.localeCompare(right.title, "zh"));
  return sorted;
}

/**
 * 记忆中心：卡片墙 + 详情编辑 + 「模型实际看到的索引」预览。
 *
 * 与面板的分工：面板是窄条（快速筛选/归档），中心是宽页（看全貌、改分层与要点、
 * 核对索引预算）。卡片与面板共用 `MemoryCard`，正文仍在右侧预览窗口打开，
 * 这里不重复实现 markdown 编辑器。
 */
export function MemoryCenter({ onClose, onOpenTopic }: { onClose(): void; onOpenTopic(topic: MemoryTopicSummary): void }): ReactNode {
  const memory = useDesktopStore((state) => state.memory);
  const contents = useDesktopStore((state) => state.memoryContents);
  const indexPreview = useDesktopStore((state) => state.memoryIndexPreview);
  const health = useDesktopStore((state) => state.memoryHealth);
  const memoryEnabled = useDesktopStore((state) => state.settings.memory?.enabled !== false);

  const [query, setQuery] = useState("");
  const [layer, setLayer] = useState<"all" | MemoryLayer>("all");
  const [sort, setSort] = useState<SortMode>("updated");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [detailTab, setDetailTab] = useState<DetailTab>("topic");
  const [draft, setDraft] = useState<MemoryDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selected = memory.find((topic) => topic.id === selectedId);
  const selectedContent = selected ? contents[selected.id] : undefined;

  function requestIndex(): void {
    void window.piDesktop.send({ type: "memory.indexPreview" });
  }

  function requestHealth(): void {
    void window.piDesktop.send({ type: "memory.health" });
  }

  useEffect(() => {
    requestIndex();
    requestHealth();
  }, []);

  // 选中主题时按需拉正文（面板同款 memory.read；中心只用它的 summary 字段）。
  useEffect(() => {
    if (!selected) {
      setDraft(undefined);
      setConfirmDelete(false);
      return;
    }
    if (!selectedContent || selectedContent.contentRevision !== selected.contentRevision) {
      void window.piDesktop.send({ type: "memory.read", topicId: selected.id });
    }
  }, [selected?.id, selected?.contentRevision, selectedContent?.contentRevision]);

  // 草稿只在「换了主题 / 正文版本变了」时重置，避免后台推送把正在编辑的要点冲掉。
  useEffect(() => {
    if (!selected) return;
    setDraft({
      layer: memoryLayerOf(selected),
      description: selected.description,
      summary: selectedContent?.summary ?? "",
      triggers: (selected.triggers ?? []).join(", ")
    });
    setSaved(false);
  }, [selected?.id, selected?.contentRevision, selectedContent?.contentRevision]);

  const counts = useMemo(() => {
    const result: Record<MemoryLayer, number> = { core: 0, standard: 0, archive: 0 };
    for (const topic of memory) result[memoryLayerOf(topic)] += 1;
    return result;
  }, [memory]);
  const totalChars = useMemo(() => memory.reduce((sum, topic) => sum + topic.contentChars, 0), [memory]);

  const topics = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = memory.filter((topic) => (layer === "all" || memoryLayerOf(topic) === layer)
      && (!needle || topic.title.toLowerCase().includes(needle) || topic.description.toLowerCase().includes(needle) || (topic.summaryPreview ?? "").toLowerCase().includes(needle)));
    return sortTopics(matched, sort);
  }, [memory, layer, query, sort]);

  async function send(command: Parameters<typeof window.piDesktop.send>[0]): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      await window.piDesktop.send(command);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记忆操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveMeta(): Promise<void> {
    if (!selected || !draft) return;
    const done = await send({
      type: "memory.update",
      topic: selected.title,
      description: draft.description,
      layer: draft.layer,
      summary: draft.summary,
      triggers: parseMemoryTriggers(draft.triggers)
    });
    if (done) {
      setSaved(true);
      requestIndex();
      requestHealth();
    }
  }

  async function toggleArchive(): Promise<void> {
    if (!selected || !draft) return;
    const next: MemoryLayer = draft.layer === "archive" ? "standard" : "archive";
    const done = await send({ type: "memory.update", topic: selected.title, layer: next });
    if (done) {
      setDraft({ ...draft, layer: next });
      requestIndex();
      requestHealth();
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selected) return;
    const done = await send({ type: "memory.delete", topic: selected.title });
    if (done) {
      setSelectedId(undefined);
      setConfirmDelete(false);
      requestIndex();
      requestHealth();
    }
  }

  return (
    <div className="memory-center" data-pane="memory-center">
      <header className="memory-center-head">
        <div className="memory-center-heading">
          <span className="memory-center-icon"><Brain size={18} /></span>
          <div>
            <h2>记忆中心</h2>
            <p>
              {memory.length} 个主题 · 总 {formatMemoryChars(totalChars)} · 核心 {counts.core} / 标准 {counts.standard} / 归档 {counts.archive}
              {indexPreview ? ` · 索引 ${indexPreview.characters.toLocaleString("en-US")}/${indexPreview.budget.toLocaleString("en-US")} 字` : ""}
            </p>
          </div>
        </div>
        <div className="memory-center-head-actions">
          {!memoryEnabled && <span className="memory-center-disabled">记忆已停用</span>}
          <button type="button" data-control="memory-center-refresh" title="刷新索引预览" onClick={requestIndex}><RefreshCw size={14} /></button>
          <button type="button" data-control="memory-center-close" title="关闭记忆中心" aria-label="关闭记忆中心" onClick={onClose}><X size={15} /></button>
        </div>
      </header>

      <div className="memory-center-body">
        <section className="memory-center-list">
          <div className="memory-center-toolbar">
            <label className="memory-center-search">
              <Search size={13} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选标题、描述或要点…" aria-label="筛选记忆" />
            </label>
            <div className="memory-center-tabs" role="group" aria-label="按层筛选">
              <button type="button" className={layer === "all" ? "active" : ""} onClick={() => setLayer("all")}>全部</button>
              {(["core", "standard", "archive"] as MemoryLayer[]).map((item) => (
                <button key={item} type="button" className={layer === item ? "active" : ""} onClick={() => setLayer(item)}>{MEMORY_LAYER_LABEL[item]}</button>
              ))}
            </div>
            <select className="memory-center-sort" value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label="排序">
              <option value="updated">按更新</option>
              <option value="size">按字数</option>
              <option value="title">按名称</option>
            </select>
          </div>

          {topics.length === 0 ? (
            <p className="memory-center-empty">{memory.length === 0 ? "还没有记忆主题。对话里说「记住 …」让助手写入。" : "没有匹配当前筛选的主题。"}</p>
          ) : (
            <div className="memory-center-grid">
              {topics.map((topic) => (
                <MemoryCard
                  key={topic.id}
                  topic={topic}
                  active={topic.id === selectedId}
                  onSelect={(item) => { setSelectedId(item.id); setDetailTab("topic"); }}
                  onOpen={onOpenTopic}
                  onToggleArchive={(item) => void send({ type: "memory.update", topic: item.title, layer: memoryLayerOf(item) === "archive" ? "standard" : "archive" }).then(requestIndex)}
                  onDelete={(item) => { setSelectedId(item.id); setConfirmDelete(true); }}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="memory-center-detail">
          <div className="memory-center-detail-tabs" role="tablist" aria-label="记忆中心视图">
            <button type="button" role="tab" aria-selected={detailTab === "topic"} className={detailTab === "topic" ? "active" : ""} onClick={() => setDetailTab("topic")}><FileText size={13} />主题详情</button>
            <button type="button" role="tab" aria-selected={detailTab === "index"} className={detailTab === "index" ? "active" : ""} onClick={() => { setDetailTab("index"); requestIndex(); }}><Brain size={13} />模型索引</button>
            <button type="button" role="tab" aria-selected={detailTab === "health"} className={detailTab === "health" ? "active" : ""} onClick={() => { setDetailTab("health"); requestHealth(); }}><Activity size={13} />健康</button>
          </div>

          {detailTab === "health" ? (
            <MemoryHealthPane health={health} onRefresh={requestHealth} onSelect={(topic) => { setSelectedId(topic.id); setDetailTab("topic"); }} onArchive={(topic) => void send({ type: "memory.update", topic: topic.title, layer: "archive" }).then(() => { requestIndex(); requestHealth(); })} />
          ) : detailTab === "index" ? (
            <div className="memory-center-index">
              <p className="memory-center-index-note">
                这是<b>新会话</b>会注入的索引（与会话注入走同一函数）。当前会话的索引在创建时已冻结，改记忆不会影响它；超预算时会按层压缩描述并写脚注。
              </p>
              <div className="memory-center-index-meta">
                <span>{indexPreview ? `${indexPreview.characters.toLocaleString("en-US")} / ${indexPreview.budget.toLocaleString("en-US")} 字` : "尚未加载"}</span>
                <button type="button" onClick={requestIndex} disabled={busy}><RefreshCw size={12} />刷新</button>
              </div>
              <pre className="memory-center-index-pre">{indexPreview?.markdown || "（暂无可见主题）"}</pre>
            </div>
          ) : !selected || !draft ? (
            <p className="memory-center-empty">左侧选一张卡片查看详情；正文在预览窗口打开。</p>
          ) : (
            <div className="memory-center-meta">
              <div className="memory-center-detail-title">
                <h3>{selected.title}</h3>
                <span className={`memory-layer-chip ${memoryLayerOf(selected)}`}>{MEMORY_LAYER_LABEL[memoryLayerOf(selected)]}</span>
              </div>
              <p className="memory-center-detail-stats">
                {formatMemoryChars(selected.contentChars)} · {selected.updatedAt} · {selected.workspace ? selected.workspace : "全局"}
              </p>

              <label className="memory-center-field">
                <span>分层</span>
                <select value={draft.layer} onChange={(event) => setDraft({ ...draft, layer: event.target.value as MemoryLayer })}>
                  <option value="core">核心（每会话在场，带要点）</option>
                  <option value="standard">标准（按需查）</option>
                  <option value="archive">归档（不进索引，可检索）</option>
                </select>
              </label>
              <label className="memory-center-field">
                <span>索引描述</span>
                <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="一句话索引行（≤45 字）" />
              </label>
              <label className="memory-center-field">
                <span>要点（3–8 行，≤400 字）</span>
                <textarea value={draft.summary} rows={5} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="一行一条结论；core 主题会进索引，默认读取会先给要点" />
              </label>
              <label className="memory-center-field">
                <span>触发词（≤3 个，逗号分隔）</span>
                <input value={draft.triggers} onChange={(event) => setDraft({ ...draft, triggers: event.target.value })} placeholder="反直觉词，如：B站, 账号" />
              </label>

              {error && <p className="memory-center-error">{error}</p>}
              {saved && !busy && <p className="memory-center-saved"><Check size={13} />已保存（新会话生效）</p>}

              <div className="memory-center-actions">
                <button type="button" className="primary" data-control="memory-center-save" disabled={busy} onClick={() => void saveMeta()}><Save size={13} />保存元信息</button>
                <button type="button" data-control="memory-center-open" onClick={() => onOpenTopic(selected)}><FileText size={13} />打开正文</button>
                <button type="button" data-control="memory-center-archive" disabled={busy} onClick={() => void toggleArchive()}>
                  {draft.layer === "archive" ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                  {draft.layer === "archive" ? "恢复" : "归档"}
                </button>
                {confirmDelete ? (
                  <>
                    <button type="button" className="danger" disabled={busy} onClick={() => void removeSelected()}><Trash2 size={13} />确认删除</button>
                    <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
                  </>
                ) : (
                  <button type="button" className="danger ghost" data-control="memory-center-delete" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={13} />删除</button>
                )}
              </div>
              {!selectedContent && <p className="memory-center-loading"><LoaderCircle size={13} className="spinning" />正在读取要点…</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
