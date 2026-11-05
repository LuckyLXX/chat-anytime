import type { MemoryLayer, MemoryTopicSummary } from "../../../shared/protocol";
import { MEMORY_TOPIC_WARN_CHARS } from "../../../shared/memory";

/** 面板/中心共用的体积展示：1,234 字 / 12.3k 字（超过 100k 四舍五入到整数 k）。 */
export function formatMemoryChars(chars: number): string {
  if (chars >= 1000) {
    const kilo = chars / 1000;
    return `${kilo >= 100 ? Math.round(kilo) : kilo.toFixed(1).replace(/\.0$/u, "")}k 字`;
  }
  return `${chars} 字`;
}

export type MemoryLayerFilter = "all" | MemoryLayer;

export const MEMORY_LAYER_LABEL: Record<MemoryLayer, string> = {
  core: "核心",
  standard: "标准",
  archive: "归档"
};

export function memoryLayerOf(topic: Pick<MemoryTopicSummary, "layer">): MemoryLayer {
  return topic.layer ?? "standard";
}

export function memoryLayerLabel(topic: Pick<MemoryTopicSummary, "layer">): string {
  return MEMORY_LAYER_LABEL[memoryLayerOf(topic)];
}

/** 排序：核心 → 标准 → 归档，再按更新时间；归档永远沉底。 */
const LAYER_ORDER: Record<MemoryLayer, number> = { core: 0, standard: 1, archive: 2 };

export function compareMemoryTopics(left: MemoryTopicSummary, right: MemoryTopicSummary): number {
  return LAYER_ORDER[memoryLayerOf(left)] - LAYER_ORDER[memoryLayerOf(right)]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.title.localeCompare(right.title, "zh");
}

export function memoryTopicLarge(topic: Pick<MemoryTopicSummary, "contentChars">): boolean {
  return topic.contentChars > MEMORY_TOPIC_WARN_CHARS;
}

/** 卡片正文：优先展示要点预览，没有就退回索引描述。 */
export function memoryCardText(topic: MemoryTopicSummary): string {
  return (topic.summaryPreview ?? "").trim() || topic.description;
}

/** 触发词编辑：逗号/分号/换行分隔，去空白。 */
export function parseMemoryTriggers(value: string): string[] {
  return value
    .split(/[,，;；\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
