/**
 * 长期记忆的跨进程常量（main / utility / renderer 共用）。
 *
 * 这些阈值是「token 预算」的一部分，不是随手可调的装饰值：
 * - 大主题 read 超过 6000 字先返回目录，避免一次把 10–30k 字塞进上下文；
 * - 主题超过 12000 字给偏大提示，引导拆分或下沉归档；
 * - 无标题/超大节按 4000 字自动分段；
 * - 会话快照索引总预算 2000 字（当前 22 个主题的索引约 1600 字，先保证现状不缩水）。
 */
export const MEMORY_READ_FULL_MAX_CHARS = 6000;
export const MEMORY_TOPIC_WARN_CHARS = 12000;
export const MEMORY_SECTION_CHUNK_CHARS = 4000;
export const MEMORY_SNAPSHOT_BUDGET_CHARS = 2000;
export const MEMORY_SNAPSHOT_DESC_MAX = 48;
export const MEMORY_SNAPSHOT_DESC_COMPACT = 24;
export const MEMORY_SEARCH_LIMIT = 5;
export const MEMORY_SEARCH_LIMIT_MAX = 10;
export const MEMORY_LIST_LIMIT = 50;
export const MEMORY_OUTLINE_MAX_SECTIONS = 40;
