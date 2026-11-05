import { LayoutGrid, Plus, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { MemoryLayer, MemoryTopicSummary } from "../../shared/protocol";
import { MEMORY_LAYER_LABEL, compareMemoryTopics, formatMemoryChars, memoryLayerOf } from "./lib/memory-format";
import { MemoryCard } from "./components/MemoryCard";
import { useDesktopStore } from "./store";

export { formatMemoryChars } from "./lib/memory-format";

interface TopicDraft {
  title: string;
  description: string;
  summary: string;
  content: string;
  layer: MemoryLayer;
  scoped: boolean;
}

const emptyDraft: TopicDraft = { title: "", description: "", summary: "", content: "", layer: "standard", scoped: false };

/**
 * 记忆页内容（由 PanelDock 的 tab 承载）。卡片列表是「记忆中心」的紧凑版：
 * 按层标注、可筛选、可直接归档/恢复/删除；正文仍在右侧预览窗口查看与编辑。
 * 窄面板里不做内联正文编辑，复用同一张 MemoryCard 保证两处口径一致。
 */
export function MemoryPanelContent({ onOpenTopic, onOpenCenter }: { onOpenTopic(topic: MemoryTopicSummary): void; onOpenCenter?: () => void }): ReactNode {
  const memory = useDesktopStore((state) => state.memory);
  const workspace = useDesktopStore((state) => state.snapshot.workspace);
  const activeAgentId = useDesktopStore((state) => state.snapshot.agentId);
  const settings = useDesktopStore((state) => state.settings);
  const memoryEnabled = settings.memory?.enabled !== false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TopicDraft>(emptyDraft);
  const [filter, setFilter] = useState("");
  const [layer, setLayer] = useState<"all" | MemoryLayer>("all");

  async function run(command: Parameters<typeof window.piDesktop.send>[0]): Promise<boolean> {
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

  function toggleEnabled(): void {
    const next = !memoryEnabled;
    // 乐观更新本地设置视图；落盘由主进程 updateSettings 完成。
    useDesktopStore.setState({ settings: { ...settings, memory: { enabled: next } } });
    void run({ type: "memory.save", memory: { enabled: next } });
  }

  async function removeTopic(topic: MemoryTopicSummary): Promise<void> {
    const done = await run({ type: "memory.delete", topic: topic.title });
    if (done) setConfirmDeleteId(undefined);
  }

  function toggleArchive(topic: MemoryTopicSummary): void {
    const current = memoryLayerOf(topic);
    void run({ type: "memory.update", topic: topic.title, layer: current === "archive" ? "standard" : "archive" });
  }

  async function createTopic(): Promise<void> {
    const done = await run({
      type: "memory.create",
      topic: draft.title,
      description: draft.description,
      content: draft.content,
      layer: draft.layer,
      ...(draft.summary.trim() ? { summary: draft.summary } : {}),
      ...(draft.scoped && workspace ? { workspaceScoped: true } : {})
    });
    if (done) {
      setCreating(false);
      setDraft(emptyDraft);
    }
  }

  const needle = filter.trim().toLowerCase();
  const topics = useMemo(() => {
    const matched = memory.filter((topic) => (layer === "all" || memoryLayerOf(topic) === layer)
      && (!needle || topic.title.toLowerCase().includes(needle) || topic.description.toLowerCase().includes(needle) || (topic.summaryPreview ?? "").toLowerCase().includes(needle)));
    return [...matched].sort(compareMemoryTopics);
  }, [memory, layer, needle]);

  const counts = useMemo(() => {
    const result: Record<MemoryLayer, number> = { core: 0, standard: 0, archive: 0 };
    for (const topic of memory) result[memoryLayerOf(topic)] += 1;
    return result;
  }, [memory]);
  const totalChars = useMemo(() => memory.reduce((sum, topic) => sum + topic.contentChars, 0), [memory]);

  return (
    <div className="memory-panel" data-pane="memory-panel">
      <div className="memory-panel-toolbar">
        <small>{memory.length} 个主题 · {formatMemoryChars(totalChars)} · {settings.agents.find((agent) => agent.id === activeAgentId)?.name ?? "当前助手"}</small>
        <label className="memory-panel-enabled" title="停用后不注入索引快照、memory_* 工具拒绝执行；面板编辑仍可用">
          <input type="checkbox" checked={memoryEnabled} onChange={toggleEnabled} />
          <span>启用</span>
        </label>
      </div>
      <div className="memory-panel-filter">
        <Search size={12} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选标题、描述或要点…" aria-label="筛选记忆主题" />
        {needle && <span className="memory-panel-match">{topics.length} / {memory.length}</span>}
      </div>
      <div className="memory-panel-layers" role="group" aria-label="按层筛选">
        <button type="button" className={layer === "all" ? "active" : ""} data-control="memory-layer-filter" onClick={() => setLayer("all")}>全部 {memory.length}</button>
        {(["core", "standard", "archive"] as MemoryLayer[]).map((item) => (
          <button key={item} type="button" className={layer === item ? "active" : ""} data-control="memory-layer-filter" title={`${MEMORY_LAYER_LABEL[item]}层`} onClick={() => setLayer(item)}>
            {MEMORY_LAYER_LABEL[item]} {counts[item]}
          </button>
        ))}
      </div>
      {!memoryEnabled && <p className="memory-panel-notice">记忆已停用：不注入索引，memory_* 工具将拒绝执行。此处的人工编辑仍会保存，重新启用后生效。</p>}
      {error && <p className="task-panel-error">{error}</p>}
      <div className="memory-panel-list">
        {memory.length === 0 && !creating && (
          <p className="task-panel-empty">暂无记忆主题。对话中说“记住 …”让助手写入，或点下方“新建主题”手动添加。</p>
        )}
        {memory.length > 0 && topics.length === 0 && !creating && (
          <p className="task-panel-empty">没有匹配当前筛选的主题。</p>
        )}
        {topics.map((topic) => (
          <MemoryCard
            key={topic.id}
            topic={topic}
            onOpen={onOpenTopic}
            onToggleArchive={toggleArchive}
            onDelete={(item) => setConfirmDeleteId(confirmDeleteId === item.id ? undefined : item.id)}
          />
        ))}
        {confirmDeleteId && (() => {
          const target = memory.find((topic) => topic.id === confirmDeleteId);
          if (!target) return null;
          return (
            <div className="memory-panel-confirm" role="alert">
              <span>删除「{target.title}」？不可恢复。</span>
              <button type="button" className="danger" disabled={busy} onClick={() => void removeTopic(target)}>确认删除</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDeleteId(undefined)}>取消</button>
            </div>
          );
        })()}
        {creating && (
          <section className="memory-topic-editor creating">
            <h4>新建主题</h4>
            <label>
              <span>标题</span>
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="如：用户偏好 / 项目名 协作约定" />
            </label>
            <label>
              <span>索引描述</span>
              <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="一句话索引行（≤45 字）" />
            </label>
            <label>
              <span>分层</span>
              <select value={draft.layer} onChange={(event) => setDraft({ ...draft, layer: event.target.value as MemoryLayer })}>
                <option value="core">核心（每会话在场，带要点）</option>
                <option value="standard">标准（按需查）</option>
                <option value="archive">归档（不进索引，可检索）</option>
              </select>
            </label>
            <label>
              <span>要点（可选，3–8 行）</span>
              <textarea value={draft.summary} rows={2} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="一行一条结论；core 主题会进索引" />
            </label>
            <label>
              <span>正文</span>
              <textarea value={draft.content} rows={5} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="markdown 正文" />
            </label>
            {workspace && (
              <label className="memory-panel-check">
                <input type="checkbox" checked={draft.scoped} onChange={(event) => setDraft({ ...draft, scoped: event.target.checked })} />
                <span>仅绑定当前工作区</span>
              </label>
            )}
            <div className="memory-topic-editor-actions">
              <button className="memory-panel-primary" type="button" disabled={busy || !draft.title.trim() || !draft.description.trim() || !draft.content.trim()} onClick={() => void createTopic()}>保存</button>
              <button type="button" disabled={busy} onClick={() => { setCreating(false); setDraft(emptyDraft); }}>取消</button>
            </div>
          </section>
        )}
      </div>
      <footer className="memory-panel-footer">
        <button className="memory-panel-new" type="button" disabled={busy} onClick={() => { setCreating(!creating); setDraft(emptyDraft); setConfirmDeleteId(undefined); }}>
          <Plus size={12} />
          <span>新建主题</span>
        </button>
        {onOpenCenter && (
          <button className="memory-panel-center" type="button" data-control="memory-center-open" title="打开记忆中心（卡片墙 + 索引预览）" onClick={onOpenCenter}>
            <LayoutGrid size={12} />
            <span>记忆中心</span>
          </button>
        )}
      </footer>
    </div>
  );
}
