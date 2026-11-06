import { Activity, Archive, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { MemoryHealth, MemoryTopicSummary } from "../../../shared/protocol";
import { formatMemoryChars } from "../lib/memory-format";
import { useDesktopStore } from "../store";

const KIND_LABEL: Record<string, string> = {
  "index-pressure": "索引预算",
  large: "偏大",
  "index-degraded": "索引降级",
  "core-no-summary": "核心缺要点",
  stale: "陈旧",
  tiny: "空壳",
  duplicate: "疑似重复"
};

/**
 * 记忆中心「健康」页：只给建议、不自动改数据。
 *
 * 它回答「这套记忆库现在哪里需要整理」：过大的主题、没有要点的核心、
 * 九十天没更新的项目知识、标题重叠的重复主题、接近预算的索引、过短的空壳。
 * 每条建议都带下一步动作（查看 / 归档），真正的合并与删除仍由人确认。
 */
export function MemoryHealthPane({ health, topics, onRefresh, onSelect, onArchive }: {
  health: MemoryHealth | undefined;
  /** 这批 health 对应的主题（跨助手时由调用方给；缺省 = 当前助手）。 */
  topics?: MemoryTopicSummary[];
  onRefresh(): void;
  onSelect(topic: MemoryTopicSummary): void;
  onArchive(topic: MemoryTopicSummary): void;
}): ReactNode {
  const currentMemory = useDesktopStore((state) => state.memory);
  const memory = topics ?? currentMemory;
  if (!health) {
    return (
      <div className="memory-center-health">
        <div className="memory-center-health-head"><span>正在检查记忆库…</span><button type="button" onClick={onRefresh}><RefreshCw size={12} />刷新</button></div>
      </div>
    );
  }
  const warns = health.issues.filter((issue) => issue.severity === "warn").length;
  const issues = health.issues.slice(0, 50);
  return (
    <div className="memory-center-health">
      <div className="memory-center-health-head">
        <span><Activity size={13} />{health.issues.length === 0 ? "未发现需要处理的问题" : `${health.issues.length} 条建议（警告 ${warns}）`}</span>
        <button type="button" onClick={onRefresh}><RefreshCw size={12} />刷新</button>
      </div>
      <p className="memory-center-index-note">只给建议、不自动改：拆分 / 归档 / 合并由你决定；当前会话的索引已冻结，改动下个会话生效。</p>
      <div className="memory-center-health-totals">
        <span>{health.topics} 个主题</span>
        <span>{formatMemoryChars(health.chars)}</span>
        <span>索引 {health.indexChars.toLocaleString("en-US")} / {health.indexBudget.toLocaleString("en-US")} 字</span>
        <span>核心 {health.layers.core} · 标准 {health.layers.standard} · 归档 {health.layers.archive}</span>
      </div>
      {issues.length === 0 ? (
        <p className="memory-center-empty">记忆库很干净：没有过大、无要点、陈旧或重复的主题。</p>
      ) : (
        <ul className="memory-center-health-list">
          {issues.map((issue, index) => {
            const topic = issue.topicId ? memory.find((item) => item.id === issue.topicId) : undefined;
            return (
              <li key={`${issue.kind}-${issue.topicId ?? "index"}-${index}`} className={`memory-health-item ${issue.severity}`}>
                <div className="memory-health-head">
                  <span className="memory-health-kind">{KIND_LABEL[issue.kind] ?? issue.kind}</span>
                  <strong>{issue.title ?? "索引预算"}</strong>
                </div>
                <p>{issue.message}</p>
                <p className="memory-health-suggestion">{issue.suggestion}</p>
                {topic && (
                  <div className="memory-health-actions">
                    <button type="button" onClick={() => onSelect(topic)}>查看</button>
                    {topic.layer !== "archive" && <button type="button" onClick={() => onArchive(topic)}><Archive size={11} />归档</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {health.duplicates.length > 0 && (
        <p className="memory-health-footnote">
          重复组：{health.duplicates.map((group) => `${group.titles.join(" ↔ ")}（${Math.round(group.score * 100)}%）`).join("；")}
        </p>
      )}
      <p className="memory-health-footnote">检查口径：正文 &gt;8,000 / &gt;12,000 字、核心无要点、标准主题 90 天未更新、正文 &lt;50 字、标题与描述相似度 ≥55%、索引占用 &gt;90%。</p>
    </div>
  );
}
