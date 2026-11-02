/**
 * Markdown 编辑器的节流策略（2026-11-02）。
 *
 * 为什么要按文档大小分档：Vditor 的 `getValue()` 是「整篇 DOM → Markdown」的
 * 全量序列化，MutationObserver 每触发一次就是一次整篇扫描；而 `onContentChange`
 * 会把整篇字符串回写给 App（tab 快照 + 整棵预览树重渲染）。小文档这两件事都只有
 * 零点几毫秒，120ms 节流 + 立即回写是对的；300KB 文档上它们是每键的固定开销，
 * 正是「编辑大文件卡」的来源之一。
 *
 * 分档口径（不是拍脑袋）：120k 字符 ≈ 工作区里最大的几个 md（`迭代记录/2026-09.md`
 * 约 11 万字）。低于它保持原行为（零回归）；高于它把观察器节流放到 500ms、快照
 * 回写防抖到 400ms，并在写盘/切 tab/卸载三处强制 flush，保证不丢最后一次输入。
 *
 * 注意边界：这里只压「我们自己的」开销；Vditor 首次把整篇灌进编辑器的那次解析
 * 不受此控制（见计划 R6），不要指望这两个数能把超长文档的打开成本变成 0。
 */

/** 超过这个字符数才进入「大文档」策略。 */
export const EDITOR_LARGE_DOC_CHARS = 120_000;
/** 小文档的观察器节流（沿用旧值，行为不变）。 */
export const EDITOR_OBSERVER_THROTTLE_MS = 120;
/** 大文档的观察器节流：四次/秒，够跟上输入节奏，又不至于每键整篇序列化。 */
export const EDITOR_LARGE_DOC_OBSERVER_THROTTLE_MS = 500;
/** 大文档的快照回写延迟（0 表示立即回写，即旧行为）。 */
export const EDITOR_LARGE_DOC_SNAPSHOT_DELAY_MS = 400;

/** MutationObserver 兜底同步的最小间隔（ms）。 */
export function editorObserverThrottleMs(contentLength: number): number {
  return contentLength > EDITOR_LARGE_DOC_CHARS ? EDITOR_LARGE_DOC_OBSERVER_THROTTLE_MS : EDITOR_OBSERVER_THROTTLE_MS;
}

/** 乐观快照回写 App 的防抖延迟（ms）；0 表示立即。 */
export function editorContentSnapshotDelayMs(contentLength: number): number {
  return contentLength > EDITOR_LARGE_DOC_CHARS ? EDITOR_LARGE_DOC_SNAPSHOT_DELAY_MS : 0;
}
