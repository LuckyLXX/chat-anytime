import { Activity, Archive, ArchiveRestore, Brain, Check, FileText, LoaderCircle, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MemoryLayer, MemoryOverviewAgent, MemoryTopicSummary } from "../../shared/protocol";
import { MemoryGraph, type MemoryGraphSelection } from "./components/MemoryGraph";
import { MemoryHealthPane } from "./components/MemoryHealthPane";
import { MEMORY_LAYER_LABEL, formatMemoryChars, memoryCacheKey, memoryLayerOf, memoryRequestTarget, memoryScopeLabel, parseMemoryTriggers, type MemoryLayerFilter } from "./lib/memory-format";
import { useDesktopStore } from "./store";

type DetailTab = "topic" | "index" | "health";

interface MemoryDraft {
  layer: MemoryLayer;
  description: string;
  summary: string;
  triggers: string;
}

/**
 * 记忆中心：分层图谱 + 详情编辑 + 「模型实际看到的索引」预览。
 *
 * v5（2026-11-06，用户反馈「没有区分用户、平铺无法整理」）：
 * - 按助手分区块（记忆本来就按助手分目录存放），区块顶部是它会话里真正注入的
 *   索引节点，下面三层泳道，进索引的主题从主干接线到节点；
 * - 归属（全局 / 工作区）标在节点上，可筛选；
 * - 索引快照来自主进程的结构化投影（逐条占多少字、压缩还是省略），不解析文本；
 * - 详情里的编辑/归档/删除都带 agentId，跨助手浏览时不会写错库。
 *
 * 与面板的分工不变：面板是窄条（快速筛选/归档），中心是宽页（看全貌、整理）。
 */
export function MemoryCenter({ onClose, onOpenTopic }: { onClose(): void; onOpenTopic(topic: MemoryTopicSummary, agentId?: string): void }): ReactNode {
  const memory = useDesktopStore((state) => state.memory);
  const contents = useDesktopStore((state) => state.memoryContents);
  const overview = useDesktopStore((state) => state.memoryOverview);
  const snapshotAgentId = useDesktopStore((state) => state.snapshot.agentId);
  const memoryEnabled = useDesktopStore((state) => state.settings.memory?.enabled !== false);

  const [query, setQuery] = useState("");
  const [layer, setLayer] = useState<MemoryLayerFilter>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [selected, setSelected] = useState<MemoryGraphSelection>();
  const [detailTab, setDetailTab] = useState<DetailTab>("topic");
  const [draft, setDraft] = useState<MemoryDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const agents = overview?.agents ?? [];
  const currentAgent = useMemo(() => agents.find((agent) => agent.agentId === snapshotAgentId), [agents, snapshotAgentId]);

  /** 焦点助手：选中项 > 助手筛选 > 当前会话助手 > 第一个有记忆的助手。 */
  const focusAgent: MemoryOverviewAgent | undefined = useMemo(() => {
    if (selected) return agents.find((agent) => agent.agentId === selected.agentId) ?? agents[0];
    if (agentFilter !== "all") return agents.find((agent) => agent.agentId === agentFilter) ?? agents[0];
    return currentAgent ?? agents[0];
  }, [agents, selected, agentFilter, currentAgent]);

  const selectedTopic = useMemo(() => {
    if (!selected) return undefined;
    const owner = agents.find((agent) => agent.agentId === selected.agentId);
    return owner?.topics.find((topic) => topic.id === selected.topicId);
  }, [agents, selected]);
  const selectedAgentId = selected?.agentId;
  const selectedContent = selected ? contents[memoryCacheKey(selected.agentId, selected.topicId)] : undefined;

  function requestOverview(): void {
    void window.piDesktop.send({ type: "memory.overview" });
  }

  useEffect(() => {
    requestOverview();
  }, []);

  // 选中主题时按需拉正文（跨助手也带 agentId；中心只用它的 summary 字段）。
  useEffect(() => {
    if (!selectedTopic || !selectedAgentId) {
      setDraft(undefined);
      setConfirmDelete(false);
      return;
    }
    if (!selectedContent || selectedContent.contentRevision !== selectedTopic.contentRevision) {
      void window.piDesktop.send({ type: "memory.read", topicId: selectedTopic.id, ...memoryRequestTarget(selectedAgentId) });
    }
  }, [selectedTopic?.id, selectedTopic?.contentRevision, selectedContent?.contentRevision, selectedAgentId]);

  // 草稿只在「换了主题 / 正文版本变了」时重置，避免后台推送把正在编辑的要点冲掉。
  useEffect(() => {
    if (!selectedTopic) return;
    setDraft({
      layer: memoryLayerOf(selectedTopic),
      description: selectedTopic.description,
      summary: selectedContent?.summary ?? "",
      triggers: (selectedTopic.triggers ?? []).join(", ")
    });
    setSaved(false);
  }, [selectedTopic?.id, selectedTopic?.contentRevision, selectedContent?.contentRevision]);

  const totals = useMemo(() => {
    const result: Record<MemoryLayer, number> = { core: 0, standard: 0, archive: 0 };
    let chars = 0;
    let topics = 0;
    for (const agent of agents) {
      for (const topic of agent.topics) {
        result[memoryLayerOf(topic)] += 1;
        chars += topic.contentChars;
        topics += 1;
      }
    }
    return { ...result, chars, topics };
  }, [agents]);

  /** 归属筛选的选项：全部 / 全局 / 每个出现过的工作区。 */
  const scopes = useMemo(() => {
    const set = new Map<string, string>();
    for (const agent of agents) {
      for (const topic of agent.topics) {
        if (topic.workspace && !set.has(topic.workspace)) set.set(topic.workspace, memoryScopeLabel(topic.workspace));
      }
    }
    return [...set.entries()].map(([path, label]) => ({ path, label }));
  }, [agents]);
  /** 同一工作区可能出现重名末段，重名时退回完整路径。 */
  const scopeLabel = (path: string): string => {
    const sameName = scopes.filter((scope) => scope.label === memoryScopeLabel(path));
    return sameName.length > 1 ? path : memoryScopeLabel(path);
  };

  const showAgentChips = agents.length > 1 && agentFilter === "all";

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
    if (!selectedTopic || !draft || !selectedAgentId) return;
    const done = await send({
      type: "memory.update",
      topic: selectedTopic.title,
      description: draft.description,
      layer: draft.layer,
      summary: draft.summary,
      triggers: parseMemoryTriggers(draft.triggers),
      ...memoryRequestTarget(selectedAgentId)
    });
    if (done) {
      setSaved(true);
      requestOverview();
    }
  }

  async function toggleArchive(): Promise<void> {
    if (!selectedTopic || !draft || !selectedAgentId) return;
    const next: MemoryLayer = draft.layer === "archive" ? "standard" : "archive";
    const done = await send({ type: "memory.update", topic: selectedTopic.title, layer: next, ...memoryRequestTarget(selectedAgentId) });
    if (done) {
      setDraft({ ...draft, layer: next });
      requestOverview();
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selectedTopic || !selectedAgentId) return;
    const done = await send({ type: "memory.delete", topic: selectedTopic.title, ...memoryRequestTarget(selectedAgentId) });
    if (done) {
      setSelected(undefined);
      setConfirmDelete(false);
      requestOverview();
    }
  }

  const focusIndex = focusAgent?.index;

  return (
    <div className="memory-center" data-pane="memory-center">
      <header className="memory-center-head">
        <div className="memory-center-heading">
          <span className="memory-center-icon"><Brain size={18} /></span>
          <div>
            <h2>记忆中心</h2>
            <p>
              {agents.length} 个助手 · {totals.topics} 个主题 · 核心 {totals.core} / 标准 {totals.standard} / 归档 {totals.archive} · 总 {formatMemoryChars(totals.chars)}
              {focusAgent && focusIndex ? ` · ${focusAgent.agentName} 索引 ${focusIndex.characters.toLocaleString("en-US")}/${focusIndex.budget.toLocaleString("en-US")} 字` : ""}
            </p>
          </div>
        </div>
        <div className="memory-center-head-actions">
          {!memoryEnabled && <span className="memory-center-disabled">记忆已停用</span>}
          <button type="button" data-control="memory-center-refresh" title="刷新各助手记忆库" onClick={requestOverview}><RefreshCw size={14} /></button>
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
            <select className="memory-center-select" value={agentFilter} onChange={(event) => { setAgentFilter(event.target.value); setSelected(undefined); }} aria-label="按助手筛选">
              <option value="all">全部助手（{agents.length}）</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>{agent.agentName}（{agent.topics.length}）{agent.agentId === snapshotAgentId ? " · 当前" : ""}</option>
              ))}
            </select>
            <select className="memory-center-select" value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)} aria-label="按归属筛选">
              <option value="all">全部归属</option>
              <option value="">全局</option>
              {scopes.map((scope) => <option key={scope.path} value={scope.path}>{scopeLabel(scope.path)}</option>)}
            </select>
            <div className="memory-center-tabs" role="group" aria-label="按层筛选">
              <button type="button" className={layer === "all" ? "active" : ""} onClick={() => setLayer("all")}>全部</button>
              {(["core", "standard", "archive"] as MemoryLayer[]).map((item) => (
                <button key={item} type="button" className={layer === item ? "active" : ""} onClick={() => setLayer(item)}>{MEMORY_LAYER_LABEL[item]}</button>
              ))}
            </div>
          </div>

          <MemoryGraph
            overview={overview}
            currentAgentId={snapshotAgentId}
            agentFilter={agentFilter}
            layerFilter={layer}
            scopeFilter={scopeFilter}
            query={query}
            selected={selected}
            onSelect={(agentId, topic) => { setSelected({ agentId, topicId: topic.id }); setDetailTab("topic"); }}
          />
        </section>

        <aside className="memory-center-detail">
          <div className="memory-center-detail-tabs" role="tablist" aria-label="记忆中心视图">
            <button type="button" role="tab" aria-selected={detailTab === "topic"} className={detailTab === "topic" ? "active" : ""} onClick={() => setDetailTab("topic")}><FileText size={13} />主题详情</button>
            <button type="button" role="tab" aria-selected={detailTab === "index"} className={detailTab === "index" ? "active" : ""} onClick={() => { setDetailTab("index"); requestOverview(); }}><Brain size={13} />模型索引</button>
            <button type="button" role="tab" aria-selected={detailTab === "health"} className={detailTab === "health" ? "active" : ""} onClick={() => { setDetailTab("health"); requestOverview(); }}><Activity size={13} />健康</button>
          </div>

          {detailTab === "health" ? (
            <MemoryHealthPane
              health={focusAgent?.health}
              topics={focusAgent?.topics ?? memory}
              onRefresh={requestOverview}
              onSelect={(topic) => { if (focusAgent) setSelected({ agentId: focusAgent.agentId, topicId: topic.id }); setDetailTab("topic"); }}
              onArchive={(topic) => void send({ type: "memory.update", topic: topic.title, layer: "archive", ...memoryRequestTarget(focusAgent?.agentId) }).then(requestOverview)}
            />
          ) : detailTab === "index" ? (
            <div className="memory-center-index">
              <p className="memory-center-index-note">
                {focusAgent
                  ? `这是「${focusAgent.agentName}」在新会话里会注入的索引（与会话注入走同一函数，按${focusAgent.workspace ? `「${scopeLabel(focusAgent.workspace)}」` : "全局"}口径计算）。当前会话的索引在创建时已冻结，改记忆不会影响它；超预算时会按层压缩描述并写脚注。`
                  : "还没有可展示的记忆库。"}
              </p>
              <div className="memory-center-index-meta">
                <span>{focusIndex ? `${focusIndex.characters.toLocaleString("en-US")} / ${focusIndex.budget.toLocaleString("en-US")} 字` : "尚未加载"}</span>
                <button type="button" onClick={requestOverview} disabled={busy}><RefreshCw size={12} />刷新</button>
              </div>
              <pre className="memory-center-index-pre">{focusIndex?.markdown || "（暂无可见主题）"}</pre>
            </div>
          ) : !selectedTopic || !draft || !selectedAgentId ? (
            <p className="memory-center-empty">左侧点一个节点查看详情；节点左侧的连线表示它在模型索引里占了一行。</p>
          ) : (
            <div className="memory-center-meta">
              <div className="memory-center-detail-title">
                <h3>{selectedTopic.title}</h3>
                <span className={`memory-layer-chip ${memoryLayerOf(selectedTopic)}`}>{MEMORY_LAYER_LABEL[memoryLayerOf(selectedTopic)]}</span>
              </div>
              <p className="memory-center-detail-stats">
                {formatMemoryChars(selectedTopic.contentChars)} · {selectedTopic.updatedAt} · {memoryScopeLabel(selectedTopic.workspace)}
                {focusAgent ? ` · ${focusAgent.agentName}` : ""}
              </p>
              {focusIndex && (() => {
                const entry = focusIndex.entries.find((item) => item.topicId === selectedTopic.id);
                if (!entry) return null;
                return (
                  <p className="memory-center-detail-index">
                    {entry.placed
                      ? `模型索引：占 ${entry.chars} 字${entry.compacted ? "（描述/要点被压缩）" : ""}`
                      : memoryLayerOf(selectedTopic) === "archive" ? "模型索引：不进常驻索引（可检索）" : "模型索引：被预算省略（靠 memory_search 到达）"}
                  </p>
                );
              })()}

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
                <button type="button" data-control="memory-center-open" onClick={() => onOpenTopic(selectedTopic, selectedAgentId)}><FileText size={13} />打开正文</button>
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
