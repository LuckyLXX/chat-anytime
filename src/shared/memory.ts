/**
 * 长期记忆的跨进程常量（main / utility / renderer 共用）。
 *
 * 这些阈值是「token 预算」的一部分，不是随手可调的装饰值。v4（2026-11-05）
 * 把预算从「一个阈值」拆成四段，对应四种召回形态：
 * - 索引快照（会话创建时冻结）：2,000 字，按 core / standard / archive 分账；
 * - 默认读取（不带 section）：≤1,300 字（要点 + 目录），小主题 ≤1,200 字直接全文；
 * - 单节读取：≤4,000 字（与分节 chunk 一致）；
 * - 全文读取（section="*"）：≤12,000 字，超出显式截断并给续读路径。
 *
 * 检索侧另有三条上限：单条命中 260 字、单次结果 1,200 字、默认 5 条。
 * 会话内去重只做兜底（实测同会话重复读同一节极少），TTL 20 分钟、40 条。
 */
export type MemoryLayer = "core" | "standard" | "archive";

export const MEMORY_LAYERS: readonly MemoryLayer[] = ["core", "standard", "archive"];

/** 会话创建时注入的索引快照总预算（字符）。 */
export const MEMORY_SNAPSHOT_BUDGET_CHARS = 2000;
/** 标准主题在索引里的描述上限（core 用要点、archive 不进索引）。 */
export const MEMORY_SNAPSHOT_DESC_MAX = 24;
export const MEMORY_SNAPSHOT_DESC_COMPACT = 12;
/** core 主题在索引里的要点：最多几条、总字数上限。 */
export const MEMORY_SNAPSHOT_CORE_BULLETS = 4;
export const MEMORY_SNAPSHOT_CORE_CHARS = 120;

/** 主题正文超过这个字数，写入回执提示拆分/下沉（软提示）。 */
export const MEMORY_TOPIC_WARN_CHARS = 8000;
/** 超过这个字数，索引里自动降级为「只有标题」一行，避免挤占预算。 */
export const MEMORY_TOPIC_INDEX_DEGRADE_CHARS = 12000;

/** 要点层（summary）单行化的总字数上限。 */
export const MEMORY_SUMMARY_MAX_CHARS = 400;
/** 卡片/列表里展示的要点预览长度。 */
export const MEMORY_SUMMARY_PREVIEW_CHARS = 80;
/** 触发词：单个长度、数量上限。 */
export const MEMORY_TRIGGER_MAX_CHARS = 12;
export const MEMORY_TRIGGER_MAX_COUNT = 3;

/** 默认读取：正文不超过这个字数直接给全文。 */
export const MEMORY_READ_SMALL_TOPIC_CHARS = 1200;
/** 默认读取（要点 + 目录）的总字数上限。 */
export const MEMORY_READ_DEFAULT_MAX_CHARS = 1300;
/** 单节读取上限（分节 chunk 上限）。 */
export const MEMORY_READ_SECTION_MAX_CHARS = 4000;
/** 无标题/超大节自动切片的字符上限（memory-sections 使用）。 */
export const MEMORY_SECTION_CHUNK_CHARS = 4000;
/** section="*" 的硬上限：超出即截断并给续读路径。 */
export const MEMORY_READ_FULL_CAP_CHARS = 12000;
/** 默认读取里目录最多列多少节、每节预览多少字。 */
export const MEMORY_READ_OUTLINE_SECTIONS = 12;
export const MEMORY_OUTLINE_PREVIEW_CHARS = 80;

/** 检索：默认条数、上限、单条上限、总上限。 */
export const MEMORY_SEARCH_LIMIT = 5;
export const MEMORY_SEARCH_LIMIT_MAX = 10;
export const MEMORY_SEARCH_HIT_MAX_CHARS = 260;
export const MEMORY_SEARCH_TOTAL_MAX_CHARS = 1200;
/** 检索片段：命中点前后保留的字数。 */
export const MEMORY_SEARCH_SNIPPET_BEFORE = 70;
export const MEMORY_SEARCH_SNIPPET_AFTER = 150;

/** 列表默认条数与单行展示上限。 */
export const MEMORY_LIST_LIMIT = 30;
export const MEMORY_LIST_LIMIT_MAX = 200;

/** 目录（memory_read 无 section）最多列多少节。 */
export const MEMORY_OUTLINE_MAX_SECTIONS = 40;

/** 会话内已读表：容量与 TTL（只用于返回「已读过」回执，不影响正确性）。 */
export const MEMORY_DEDUPE_MAX_ENTRIES = 40;
export const MEMORY_DEDUPE_TTL_MS = 20 * 60 * 1000;

/** 检索排序的新近度：30 天半衰、下限 0.5；7 天内更新的主题免疫。 */
export const MEMORY_RECENCY_HALF_LIFE_DAYS = 30;
export const MEMORY_RECENCY_MIN = 0.5;
export const MEMORY_RECENCY_IMMUNE_DAYS = 7;
