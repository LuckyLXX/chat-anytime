import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { MemoryHealth, MemoryLayer, MemoryOverview, MemoryOverviewAgent, MemorySnapshotEntry, MemoryTopicSummary } from "../../../shared/protocol";
import {
  MEMORY_LAYER_LABEL,
  compareMemoryTopics,
  formatMemoryChars,
  memoryCardText,
  memoryLayerOf,
  memoryScopeLabel,
  memoryTopicLarge,
  type MemoryLayerFilter
} from "../lib/memory-format";

export interface MemoryGraphSelection {
  agentId: string;
  topicId: string;
}

export interface MemoryGraphProps {
  overview?: MemoryOverview;
  /** 当前会话的助手：只有它显示「当前」徽标，排序也优先。 */
  currentAgentId?: string;
  /** "all" 或某个 agentId。 */
  agentFilter: string;
  /** "all" | 某一层。 */
  layerFilter: MemoryLayerFilter;
  /** "all" | ""（全局）| 工作区绝对路径。 */
  scopeFilter: string;
  /** 搜索词：命中节点高亮，其余变淡（不隐藏结构）。 */
  query: string;
  selected?: MemoryGraphSelection;
  onSelect(agentId: string, topic: MemoryTopicSummary): void;
}

const LANES: readonly MemoryLayer[] = ["core", "standard", "archive"];

const LANE_HINT: Record<MemoryLayer, string> = {
  core: "每会话在场 · 带要点进索引",
  standard: "按需查 · 描述进索引，超预算会被压缩/省略",
  archive: "不进索引 · 仍可检索"
};

interface Badge {
  label: string;
  tone: "warn" | "info" | "muted";
  title: string;
}

function badgesFor(topic: MemoryTopicSummary, entry: MemorySnapshotEntry | undefined, health: MemoryHealth): Badge[] {
  const badges: Badge[] = [];
  if (memoryTopicLarge(topic)) badges.push({ label: "偏大", tone: "warn", title: "正文超过 8,000 字：建议拆分，或把已解细节下沉到归档" });
  if (health.issues.some((issue) => issue.kind === "stale" && issue.topicId === topic.id)) badges.push({ label: "陈旧", tone: "info", title: "90 天未更新：确认是否还准确，或下沉归档" });
  if (health.issues.some((issue) => issue.kind === "core-no-summary" && issue.topicId === topic.id)) badges.push({ label: "缺要点", tone: "warn", title: "核心主题没有要点层：索引只能用正文摘要" });
  if (health.duplicates.some((group) => group.ids.includes(topic.id))) badges.push({ label: "疑似重复", tone: "warn", title: "标题/描述与另一个主题高度相似：考虑合并" });
  if (entry?.omitted) badges.push({ label: "索引省略", tone: "warn", title: "预算不足，这条标准主题没进索引：靠 memory_search 到达" });
  else if (entry?.compacted && entry.placed) badges.push({ label: "索引压缩", tone: "info", title: "进索引了，但描述/要点被截短" });
  return badges;
}

function laneTopics(agent: MemoryOverviewAgent, layer: MemoryLayer, scopeFilter: string): MemoryTopicSummary[] {
  return agent.topics
    .filter((topic) => memoryLayerOf(topic) === layer)
    .filter((topic) => scopeFilter === "all" || (scopeFilter === "" ? !topic.workspace : topic.workspace === scopeFilter))
    .sort(compareMemoryTopics);
}

/** 连线粗细按「该主题在索引里占多少字」映射：1.5–4px。 */
function linkWeight(entry: MemorySnapshotEntry | undefined): number {
  if (!entry?.placed) return 0;
  return Math.min(4, 1.5 + entry.chars / 60);
}

function MemoryNode({
  agent,
  topic,
  entry,
  health,
  matched,
  selected,
  onSelect
}: {
  agent: MemoryOverviewAgent;
  topic: MemoryTopicSummary;
  entry: MemorySnapshotEntry | undefined;
  health: MemoryHealth;
  matched: boolean;
  selected: boolean;
  onSelect(agentId: string, topic: MemoryTopicSummary): void;
}): ReactNode {
  const layer = memoryLayerOf(topic);
  const placed = entry?.placed === true;
  const status = layer === "archive" ? "archive" : placed ? (entry?.compacted ? "compacted" : "indexed") : entry?.omitted ? "omitted" : "absent";
  const badges = badgesFor(topic, entry, health);
  return (
    <article
      className={`mg-node ${status}${matched ? "" : " dimmed"}${selected ? " selected" : ""}`}
      data-memory-node
      data-topic-id={topic.id}
      data-agent-id={agent.agentId}
      data-layer={layer}
      data-index-status={status}
      style={placed ? { ["--mg-link" as string]: `${linkWeight(entry)}px` } : undefined}
    >
      <button type="button" className="mg-node-body" onClick={() => onSelect(agent.agentId, topic)} title={`${topic.title} · 查看详情`}>
        <span className="mg-node-main">
          <span className="mg-node-title-row">
            <span className="mg-node-title">{topic.title}</span>
            {badges.map((badge) => (
              <span key={badge.label} className={`mg-badge ${badge.tone}`} title={badge.title}>{badge.label}</span>
            ))}
          </span>
          <span className="mg-node-text">{memoryCardText(topic)}</span>
        </span>
        <span className="mg-node-tags">
          {/* 归属只在「与区块主工作区不同」时标注：全局记忆、或别的工作区专属记忆。 */}
          {(!topic.workspace || topic.workspace.toLowerCase() !== agent.workspace?.toLowerCase()) && (
            <span className={`mg-chip scope${topic.workspace ? " other" : " global"}`} title={topic.workspace ?? "全局记忆：所有工作区都可见"}>
              {memoryScopeLabel(topic.workspace)}
            </span>
          )}
        </span>
        <span className="mg-node-meta">
          <span>{formatMemoryChars(topic.contentChars)}</span>
          <span>{topic.updatedAt}</span>
          {placed ? (
            <span className="mg-index-size" title="该主题的索引行占用（含换行，与会话注入同一预算）">索引 {entry!.chars} 字</span>
          ) : (
            <span className="mg-index-size none">{layer === "archive" ? "不进索引" : "未入索引"}</span>
          )}
        </span>
      </button>
    </article>
  );
}

function MemoryLane({
  agent,
  layer,
  topics,
  entries,
  health,
  needle,
  selected,
  onSelect
}: {
  agent: MemoryOverviewAgent;
  layer: MemoryLayer;
  topics: MemoryTopicSummary[];
  entries: Map<string, MemorySnapshotEntry>;
  health: MemoryHealth;
  needle: string;
  selected?: MemoryGraphSelection;
  onSelect(agentId: string, topic: MemoryTopicSummary): void;
}): ReactNode {
  if (topics.length === 0) return null;
  const indexed = topics.filter((topic) => entries.get(topic.id)?.placed).length;
  const missing = layer === "archive" ? 0 : topics.length - indexed;
  return (
    <section className="mg-lane" data-memory-lane={layer}>
      <header className="mg-lane-head" title={LANE_HINT[layer]}>
        <span className={`mg-lane-dot ${layer}`} aria-hidden />
        <strong>{MEMORY_LAYER_LABEL[layer]}</strong>
        <span className="mg-lane-count">{topics.length} 个</span>
        {layer !== "archive" && <span className="mg-lane-indexed">{indexed} 条进索引</span>}
        {missing > 0 && <span className="mg-lane-missing">{missing} 条未入</span>}
      </header>
      <div className="mg-lane-nodes">
        {topics.map((topic) => (
          <MemoryNode
            key={topic.id}
            agent={agent}
            topic={topic}
            entry={entries.get(topic.id)}
            health={health}
            matched={!needle || topic.title.toLowerCase().includes(needle) || topic.description.toLowerCase().includes(needle) || (topic.summaryPreview ?? "").toLowerCase().includes(needle)}
            selected={selected?.agentId === agent.agentId && selected?.topicId === topic.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function MemoryAgentBlock({
  agent,
  layerFilter,
  scopeFilter,
  needle,
  selected,
  isCurrent,
  collapsed,
  onToggleCollapse,
  onSelect
}: {
  agent: MemoryOverviewAgent;
  layerFilter: MemoryLayerFilter;
  scopeFilter: string;
  needle: string;
  selected?: MemoryGraphSelection;
  isCurrent: boolean;
  collapsed: boolean;
  onToggleCollapse(): void;
  onSelect(agentId: string, topic: MemoryTopicSummary): void;
}): ReactNode {
  const entries = new Map(agent.index.entries.map((entry) => [entry.topicId, entry]));
  const lanes = LANES
    .filter((layer) => layerFilter === "all" || layer === layerFilter)
    .map((layer) => ({ layer, topics: laneTopics(agent, layer, scopeFilter) }));
  const visible = lanes.filter((lane) => lane.topics.length > 0);
  if (visible.length === 0) return null;
  const mainLanes = visible.filter((lane) => lane.layer !== "archive");
  const archiveLane = visible.find((lane) => lane.layer === "archive");
  const hasTrunk = mainLanes.some((lane) => lane.topics.some((topic) => entries.get(topic.id)?.placed));
  const placed = agent.index.entries.filter((entry) => entry.placed).length;
  const usedPct = agent.index.budget > 0 ? Math.min(100, Math.round((agent.index.characters / agent.index.budget) * 100)) : 0;
  return (
    <section className={`mg-agent${hasTrunk ? " has-trunk" : ""}`} data-memory-agent data-agent-id={agent.agentId}>
      <header className="mg-index" data-memory-index title={`${agent.agentName} 在新会话里会注入的索引快照（按${agent.workspace ? `「${memoryScopeLabel(agent.workspace)}」` : "全局"}口径计算）`}>
        <div className="mg-index-head">
          <button type="button" className="mg-collapse" aria-expanded={!collapsed} title={collapsed ? "展开这个助手的泳道" : "收起这个助手的泳道"} onClick={onToggleCollapse}>
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          <Brain size={14} />
          <strong>{agent.agentName}</strong>
          {isCurrent && <span className="mg-index-current">当前</span>}
          <span className="mg-index-scope" title={agent.workspace ?? "该助手的主题全部是全局记忆"}>{agent.workspace ? `按「${memoryScopeLabel(agent.workspace)}」口径` : "全局口径"}</span>
          <span className="mg-index-figures">{agent.index.characters.toLocaleString("en-US")} / {agent.index.budget.toLocaleString("en-US")} 字</span>
        </div>
        <div className="mg-index-bar" role="img" aria-label={`索引预算已用 ${usedPct}%`}>
          <span style={{ width: `${usedPct}%` }} />
        </div>
        <div className="mg-index-meta">
          <span>{agent.topics.length} 个主题</span>
          <span>核心 {agent.health.layers.core} · 标准 {agent.health.layers.standard} · 归档 {agent.health.layers.archive}</span>
          <span>{placed} 条进索引</span>
          {agent.index.omitted > 0 && <span className="warn">{agent.index.omitted} 条被省略</span>}
          {agent.index.compacted && <span className="info">部分压缩</span>}
        </div>
      </header>
      {!collapsed && <div className="mg-lanes">
        {mainLanes.map((lane) => (
          <MemoryLane
            key={lane.layer}
            agent={agent}
            layer={lane.layer}
            topics={lane.topics}
            entries={entries}
            health={agent.health}
            needle={needle}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </div>}
      {!collapsed && archiveLane && (
        <div className="mg-lanes mg-lanes-archive">
          <MemoryLane
            agent={agent}
            layer="archive"
            topics={archiveLane.topics}
            entries={entries}
            health={agent.health}
            needle={needle}
            selected={selected}
            onSelect={onSelect}
          />
        </div>
      )}
    </section>
  );
}

/**
 * 记忆中心的「分层图谱」：每个助手一个区块，顶部是它会话里真正注入的
 * 索引节点（预算条），下面三层泳道；进了索引的主题从索引节点沿左侧主干
 * 接线到节点，线宽 = 该行在索引里占的字数。归档层不进索引，单独排在
 * 主干之外，所以「看得见 / 看不见」在结构上一眼可辨。
 *
 * 连线是纯 CSS 画的（左侧主干 + 每节点一段端口横线），不测量布局：
 * 泳道内是单列节点，宽度变化不会让线错位。
 */
export function MemoryGraph({ overview, currentAgentId, agentFilter, layerFilter, scopeFilter, query, selected, onSelect }: MemoryGraphProps): ReactNode {
  const needle = query.trim().toLowerCase();
  const agents = (overview?.agents ?? []).filter((agent) => agentFilter === "all" || agent.agentId === agentFilter);
  // 归属 collapsed[agentId]：未显式点过时，当前助手展开、其余收起（六个助手全展开太长）；
  // 一旦有搜索或层/归属筛选，说明用户在找东西，默认全部展开（手动收起仍然优先）。
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const autoExpand = query.trim() !== "" || scopeFilter !== "all" || layerFilter !== "all";
  const isCollapsed = (agentId: string): boolean => collapsedMap[agentId] ?? (agentFilter === "all" && agentId !== currentAgentId && !autoExpand);
  if (!overview) {
    return <p className="memory-center-empty">正在读取各助手的记忆库…</p>;
  }
  if (agents.length === 0) {
    return <p className="memory-center-empty">{overview.agents.length === 0 ? "还没有记忆主题。对话里说「记住 …」让助手写入，或在面板里新建。" : "没有匹配当前筛选的助手。"}</p>;
  }
  const blocks = agents.map((agent) => (
    <MemoryAgentBlock
      key={agent.agentId}
      agent={agent}
      layerFilter={layerFilter}
      scopeFilter={scopeFilter}
      needle={needle}
      selected={selected}
      isCurrent={agent.agentId === currentAgentId}
      collapsed={isCollapsed(agent.agentId)}
      onToggleCollapse={() => setCollapsedMap((value) => ({ ...value, [agent.agentId]: !isCollapsed(agent.agentId) }))}
      onSelect={onSelect}
    />
  ));
  const allExpanded = agents.every((agent) => !isCollapsed(agent.agentId));
  return (
    <div className="mg" data-role="memory-graph">
      {agents.length > 1 && (
        <div className="mg-toolbar">
          <span>{agents.length} 个助手 · 点左上角箭头展开/收起某个助手</span>
          <button
            type="button"
            className="mg-toggle-all"
            onClick={() => setCollapsedMap(Object.fromEntries(agents.map((agent) => [agent.agentId, allExpanded])))}
          >
            {allExpanded ? "全部收起" : "全部展开"}
          </button>
        </div>
      )}
      {blocks.some(Boolean) ? blocks : <p className="memory-center-empty">没有匹配当前筛选的主题（放宽层 / 归属或清空搜索词）。</p>}
    </div>
  );
}
