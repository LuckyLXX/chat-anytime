import type { ChatMessage } from "../../../shared/protocol";

/**
 * 时间线窗口化（T10，2026-09-26）。
 *
 * **实测规模**（探针，happy-dom；400 条消息按真实长度分布 p50 56 / p90 206 / p99 3244 字符）：
 * 全量渲染 = **16,612 个 DOM 节点 / 挂载 1,747 ms**；只保留最近 12 条真实内容、
 * 其余等高占位 = **3,472 节点 / 404 ms**（节点 -79%、挂载 4.3×）。长会话「切过去
 * 要等一下」主要就是这 1.7 s 级的 markdown 解析——DOM 本身只占约 17–25 MB，不是
 * renderer 内存的大头（这点曾经被我误判，别再拿内存当这项的理由）。
 *
 * **为什么是「墓碑 + 等高占位」而不是完整虚拟化**（只渲染视口内 + 用估算高度撑
 * 滚动条）：
 * - 占位高度来自**实测缓存**：条目一旦渲染过就记住真实高度，折叠/展开不产生滚动跳动；
 *   从未渲染过的区域（往上翻很远）才用估算 —— 而实测 p50 只有 56 字符，绝大多数
 *   条目很短，估算误差集中在长回复上。
 * - 主题钩子与 `offsetTop` 语义保持：占位元素仍然占位，`data-turn-key` 锚点仍在，
 *   缩略导航与 `.timeline > .message` 的 CSS 关系都不变。
 * - 完整虚拟化要「估算高度 + 滚动补偿 + 跳转近似」三件套，回归面大得多；本模块把
 *   风险收在「可折叠 = 已实测高度」这一点上。
 *
 * **已知取舍**（明确记录）：
 * 1. 折叠区域的文本不在 DOM 里 → 浏览器「页内查找」找不到。缓解：Pane 监听 Ctrl/Cmd+F
 *    （**不 preventDefault**，只把所有条目临时展开），用户开始输入时内容已就位。
 * 2. 从未渲染过的区域滚动刻度是估算值，访问后才变准。
 * 3. 远处条目被折叠后其内部状态（展开的详情、播放中的媒体）会丢失——只对**远离视口**
 *    的条目生效（默认 ±1 屏），且尾部若干条与流式中的那条永不折叠。
 */

/** 尾部永不折叠的条数（最新内容 + 流式消息都在这里）。 */
export const TIMELINE_LIVE_TAIL = 8;
/** 视口上下各扩展多少（IntersectionObserver rootMargin）：live 区 = 约 3 屏。 */
export const TIMELINE_LIVE_MARGIN = "100% 0px";
/** 消息总数低于此值完全不启用窗口化（绝大多数会话不受影响）。 */
export const TIMELINE_WINDOW_MIN_MESSAGES = 40;

/** 单条消息的文本字符数（窗口化的估算输入）。 */
export function messageTextLength(message: ChatMessage): number {
  let total = 0;
  for (const block of message.blocks) {
    if (block.type === "text") total += block.text.length;
    else if (block.type === "image") total += 240; // 图片块按一行缩略图估
  }
  return total;
}

/**
 * 估算单条消息的高度（px）。仅在条目**从未渲染过**时使用；单位为「一行约 46 个中文字」
 * 的气泡宽度估算，刻意保守（宁可高估一点，滚动条刻度偏大比跳位好）。
 */
export function estimateMessageHeight(message: ChatMessage): number {
  const chars = messageTextLength(message);
  const lines = Math.max(1, Math.ceil(chars / 46));
  return Math.min(4000, Math.max(64, 56 + lines * 26));
}

export interface TimelineLiveInput {
  index: number;
  total: number;
  /** IntersectionObserver 判定「在 ±1 屏内」。 */
  visible: boolean;
  /** 用户按了 Ctrl/Cmd+F（临时全部展开，保证页内查找能用）。 */
  expandAll: boolean;
  /** 缩略导航要跳转的目标轮次（先展开再滚，避免滚到估算位置）。 */
  pinned: boolean;
}

/** 该条目是否要渲染真实内容（false = 只留等高占位）。 */
export function shouldRenderLive(input: TimelineLiveInput): boolean {
  if (input.expandAll) return true;
  if (input.pinned) return true;
  if (input.visible) return true;
  return input.index >= input.total - TIMELINE_LIVE_TAIL;
}

/** 占位高度：优先用实测缓存，没有才用估算。 */
export function placeholderHeightFor(cached: number | undefined, estimate: number): number {
  return cached && cached > 0 ? cached : estimate;
}

export interface TimelineObserverEntryLike {
  target: Element;
  isIntersecting: boolean;
}

export interface TimelineObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface TimelineObserverOptions {
  root: HTMLElement;
  margin: string;
  onChange: (key: string, visible: boolean) => void;
  /** 注入点：测试传假 observer（happy-dom 不派发真实的 IntersectionObserver 回调）。 */
  createObserver?: (callback: (entries: readonly TimelineObserverEntryLike[]) => void, options: { root: HTMLElement; rootMargin: string }) => TimelineObserverLike;
}

export interface TimelineObserver {
  /** 注册/注销一个条目元素（传 null 表示注销）。 */
  register(key: string, element: HTMLElement | null): void;
  /** 取当前映射的元素（折叠前量真实高度用）。 */
  elementFor(key: string): HTMLElement | undefined;
  disconnect(): void;
}

/**
 * 包一层 IntersectionObserver：把「哪个元素」映射回「哪条消息的 key」，并保证
 * 同一 key 换元素时先 unobserve 旧的（React key 复用时会出现这种情况）。
 */
export function createTimelineObserver(options: TimelineObserverOptions): TimelineObserver {
  const byKey = new Map<string, Element>();
  const keyByElement = new Map<Element, string>();
  const createObserver = options.createObserver ?? ((callback, settings) => new IntersectionObserver((entries) => {
    callback(entries.map((entry) => ({ target: entry.target, isIntersecting: entry.isIntersecting })));
  }, settings));
  const observer = createObserver((entries) => {
    for (const entry of entries) {
      const key = keyByElement.get(entry.target);
      if (key) options.onChange(key, entry.isIntersecting);
    }
  }, { root: options.root, rootMargin: options.margin });

  return {
    register(key, element) {
      const previous = byKey.get(key);
      if (previous === element) return;
      if (previous) {
        observer.unobserve(previous);
        keyByElement.delete(previous);
        byKey.delete(key);
      }
      if (!element) return;
      byKey.set(key, element);
      keyByElement.set(element, key);
      observer.observe(element);
    },
    elementFor(key) {
      return byKey.get(key) as HTMLElement | undefined;
    },
    disconnect() {
      byKey.clear();
      keyByElement.clear();
      observer.disconnect();
    }
  };
}
