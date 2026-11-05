import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { MemoryTopicSummary } from "../../../shared/protocol";
import { formatMemoryChars, memoryCardText, memoryLayerLabel, memoryLayerOf, memoryTopicLarge } from "../lib/memory-format";

export interface MemoryCardProps {
  topic: MemoryTopicSummary;
  /** 中心里选中态；面板里可不用。 */
  active?: boolean;
  /** 点击卡片主体：缺省 = 打开正文；中心里传「选中详情」。 */
  onSelect?(topic: MemoryTopicSummary): void;
  onOpen(topic: MemoryTopicSummary): void;
  onToggleArchive?(topic: MemoryTopicSummary): void;
  onDelete?(topic: MemoryTopicSummary): void;
}

function workspaceName(path: string | undefined): string {
  if (!path) return "全局";
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * 记忆卡片：面板（窄，单列）与记忆中心（宽，网格）共用同一份结构。
 * 主题钩子：`data-memory-card` / `data-layer` / `data-topic-id`，便于主题与测试定位。
 */
export function MemoryCard({ topic, active, onSelect, onOpen, onToggleArchive, onDelete }: MemoryCardProps): ReactNode {
  const layer = memoryLayerOf(topic);
  const label = memoryLayerLabel(topic);
  const large = memoryTopicLarge(topic);
  const archived = layer === "archive";

  return (
    <article className={`memory-card${active ? " active" : ""}${archived ? " archived" : ""}`} data-memory-card data-layer={layer} data-topic-id={topic.id}>
      <button
        className="memory-card-main"
        type="button"
        title={onSelect ? "查看详情" : "在预览窗口打开正文"}
        onClick={() => (onSelect ? onSelect(topic) : onOpen(topic))}
      >
        <span className="memory-card-head">
          <strong>{topic.title}</strong>
          <span className={`memory-layer-chip ${layer}`}>{label}</span>
          {large && <span className="memory-card-large" title="正文偏大：建议拆分或把已解细节下沉到归档">偏大</span>}
        </span>
        <span className="memory-card-text">{memoryCardText(topic)}</span>
        <span className="memory-card-meta">
          <span>{formatMemoryChars(topic.contentChars)}</span>
          <span>{topic.updatedAt}</span>
          <span className={topic.workspace ? "scope" : undefined}>{workspaceName(topic.workspace)}</span>
          {topic.summaryChars ? <span className="memory-card-summary-mark" title="已维护要点层">要点</span> : null}
        </span>
      </button>
      {(onToggleArchive || onDelete) && (
        <div className="memory-card-actions">
          {onToggleArchive && (
            <button
              type="button"
              title={archived ? "移出归档（回到标准层）" : "归档：不进常驻索引，仍可检索"}
              aria-label={archived ? `恢复 ${topic.title}` : `归档 ${topic.title}`}
              onClick={() => onToggleArchive(topic)}
            >
              {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            </button>
          )}
          {onDelete && (
            <button type="button" className="danger" title={`删除 ${topic.title}`} aria-label={`删除记忆主题 ${topic.title}`} onClick={() => onDelete(topic)}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      )}
    </article>
  );
}
