import { useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { MemoryTopic, RuntimeCommand } from "../../shared/protocol";
import { useDesktopStore } from "./store";

interface TopicDraft {
  title: string;
  description: string;
  content: string;
  scoped: boolean;
}

const emptyDraft: TopicDraft = { title: "", description: "", content: "", scoped: false };

/**
 * 记忆页内容（由 PanelDock 的 tab 承载）。与只读的待办页不同，这里是用户的
 * 治理入口：主题列表 + 删除/新建 + 启用总开关；点击主题标题把正文 markdown
 * 打开到右侧预览窗口查看/编辑（编辑器保存走 memory.update，悬浮面板里不再
 * 塞内联编辑器）。面板写走 IPC 直改 store（不经过模型上下文，也不碰会话内
 * 已冻结的索引快照——手改从下一个会话起生效）。模型侧的写入经 memory_write
 * 工具，同样落到这份 store。
 */
export function MemoryPanelContent({ onOpenTopic }: { onOpenTopic(topic: MemoryTopic): void }): ReactNode {
  const memory = useDesktopStore((state) => state.memory);
  const workspace = useDesktopStore((state) => state.snapshot.workspace);
  const settings = useDesktopStore((state) => state.settings);
  const memoryEnabled = settings.memory?.enabled !== false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TopicDraft>(emptyDraft);

  async function run(command: RuntimeCommand): Promise<boolean> {
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

  async function removeTopic(topic: MemoryTopic): Promise<void> {
    const done = await run({ type: "memory.delete", topic: topic.title });
    if (done) setConfirmDeleteId(undefined);
  }

  async function createTopic(): Promise<void> {
    const done = await run({ type: "memory.create", topic: draft.title, description: draft.description, content: draft.content, workspaceScoped: draft.scoped || undefined });
    if (done) {
      setCreating(false);
      setDraft(emptyDraft);
    }
  }

  const globalTopics = memory.filter((topic) => !topic.workspace);
  const currentTopics = workspace ? memory.filter((topic) => topic.workspace === workspace) : [];
  const otherTopics = memory.filter((topic) => topic.workspace && topic.workspace !== workspace);

  const renderTopic = (topic: MemoryTopic, group: "current" | "other"): ReactNode => {
    const confirming = confirmDeleteId === topic.id;
    return (
      <div className="memory-topic" key={topic.id}>
        <div className="memory-topic-head">
          <button className="memory-topic-title" type="button" title="在预览窗口打开（可查看与编辑）" onClick={() => onOpenTopic(topic)}>
            <strong>{topic.title}</strong>
          </button>
          {group === "current" && <span className="memory-topic-scope">本工作区</span>}
          {group === "other" && <span className="memory-topic-scope other" title={topic.workspace}>{workspaceBasename(topic.workspace!)}</span>}
          <small>{topic.updatedAt}</small>
          {confirming
            ? <button className="memory-topic-delete confirming" type="button" disabled={busy} title="再次点击确认删除（不可恢复）" onClick={() => void removeTopic(topic)}>确认删除</button>
            : <button className="memory-topic-delete" type="button" disabled={busy} title={`删除 ${topic.title}`} aria-label={`删除记忆主题 ${topic.title}`} onClick={() => setConfirmDeleteId(topic.id)}><Trash2 size={12} /></button>}
        </div>
        {!confirming && <p className="memory-topic-description">{topic.description}</p>}
      </div>
    );
  };

  return (
    <div className="memory-panel" data-pane="memory-panel">
      <div className="memory-panel-toolbar">
        <small>{memory.length} 个主题 · {settings.agents.find((agent) => agent.id === settings.currentAgentId)?.name ?? "当前助手"}</small>
        <label className="memory-panel-enabled" title="停用后不注入索引快照、memory_* 工具拒绝执行；面板编辑仍可用">
          <input type="checkbox" checked={memoryEnabled} onChange={toggleEnabled} />
          <span>启用</span>
        </label>
      </div>
      {!memoryEnabled && <p className="memory-panel-notice">记忆已停用：不注入索引，memory_* 工具将拒绝执行。此处的人工编辑仍会保存，重新启用后生效。</p>}
      {error && <p className="task-panel-error">{error}</p>}
      <div className="memory-panel-list">
        {memory.length === 0 && !creating && (
          <p className="task-panel-empty">暂无记忆主题。对话中说“记住 …”让助手写入，或点下方“新建主题”手动添加。</p>
        )}
        {globalTopics.length > 0 && (
          <section className="memory-panel-group">
            <h4>全局</h4>
            {globalTopics.map((topic) => renderTopic(topic, "current"))}
          </section>
        )}
        {currentTopics.length > 0 && (
          <section className="memory-panel-group">
            <h4>当前工作区</h4>
            {currentTopics.map((topic) => renderTopic(topic, "current"))}
          </section>
        )}
        {otherTopics.length > 0 && (
          <section className="memory-panel-group">
            <h4>其他工作区</h4>
            {otherTopics.map((topic) => renderTopic(topic, "other"))}
          </section>
        )}
        {creating && (
          <section className="memory-panel-group creating">
            <h4>新建主题</h4>
            <div className="memory-topic-editor">
              <label>
                <span>标题</span>
                <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="如：用户偏好 / 项目名 协作约定" />
              </label>
              <label>
                <span>索引描述</span>
                <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="一句话索引行" />
              </label>
              <label>
                <span>正文</span>
                <textarea value={draft.content} rows={6} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="markdown 正文" />
              </label>
              {workspace && (
                <label className="memory-panel-check">
                  <input type="checkbox" checked={draft.scoped} onChange={(event) => setDraft({ ...draft, scoped: event.target.checked })} />
                  <span>仅绑定当前工作区（{workspaceBasename(workspace)}）</span>
                </label>
              )}
              <div className="memory-topic-editor-actions">
                <button className="memory-panel-primary" type="button" disabled={busy || !draft.title.trim() || !draft.description.trim() || !draft.content.trim()} onClick={() => void createTopic()}>保存</button>
                <button type="button" disabled={busy} onClick={() => { setCreating(false); setDraft(emptyDraft); }}>取消</button>
              </div>
            </div>
          </section>
        )}
      </div>
      <footer className="memory-panel-footer">
        <button className="memory-panel-new" type="button" disabled={busy} onClick={() => { setCreating(!creating); setDraft(emptyDraft); setConfirmDeleteId(undefined); }}>
          <Plus size={12} />
          <span>新建主题</span>
        </button>
      </footer>
    </div>
  );
}

function workspaceBasename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
