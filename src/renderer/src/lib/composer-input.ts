/**
 * Composer 输入框（textarea）的自适应高度。
 *
 * 目标：内容换行/折行后跟随长高；到上限后停止长高，改为 textarea 内部滚动。
 * 上限以 CSS `.composer textarea { max-height }` 为准（主题可覆盖），这里只做
 * 纯计算与 DOM 写入，方便单测。
 */

/** 与 CSS 的兜底值保持一致（读不到 computed max-height 时使用）。 */
export const COMPOSER_TEXTAREA_MIN_HEIGHT = 32;
export const COMPOSER_TEXTAREA_MAX_HEIGHT = 240;
/** scrollHeight 是整数、clientHeight 可能是小数，留 4px 容差判贴底。 */
export const COMPOSER_TEXTAREA_BOTTOM_EPSILON = 4;

export interface ComposerTextareaMetrics {
  /** 内容完整高度（textarea.scrollHeight，含 padding）。 */
  contentHeight: number;
  /** 调整前的滚动位置。 */
  scrollTop: number;
  /** 调整前是否已经贴底（正在末尾输入时保持贴底，不跳回顶部）。 */
  atBottom: boolean;
}

export interface ComposerTextareaPlan {
  /** border-box 高度，直接写入 `style.height`。 */
  height: number;
  /** 超过上限才允许内部滚动。 */
  overflowY: "auto" | "hidden";
  /** 调整后的 scrollTop。 */
  scrollTop: number;
}

export function isComposerTextareaAtBottom(scrollHeight: number, clientHeight: number, scrollTop: number): boolean {
  return scrollHeight - clientHeight - scrollTop <= COMPOSER_TEXTAREA_BOTTOM_EPSILON;
}

/** 计算 textarea 下一步的高度、溢出策略与滚动位置。 */
export function planComposerTextareaSize(
  metrics: ComposerTextareaMetrics,
  maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT,
  minHeight = COMPOSER_TEXTAREA_MIN_HEIGHT
): ComposerTextareaPlan {
  const lowerBound = Math.max(0, minHeight);
  const upperBound = Math.max(lowerBound, maxHeight);
  const contentHeight = Math.max(lowerBound, Math.ceil(metrics.contentHeight));

  if (contentHeight <= upperBound) {
    return { height: contentHeight, overflowY: "hidden", scrollTop: 0 };
  }
  return {
    height: upperBound,
    overflowY: "auto",
    // 贴底编辑（刚敲下的换行总在末尾）保持贴底；在中间编辑则保持用户当前位置。
    scrollTop: metrics.atBottom ? Math.max(0, Math.ceil(metrics.contentHeight)) : Math.max(0, metrics.scrollTop)
  };
}

function readMaxHeight(textarea: HTMLTextAreaElement): number {
  const parsed = Number.parseFloat(getComputedStyle(textarea).maxHeight);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : COMPOSER_TEXTAREA_MAX_HEIGHT;
}

/**
 * 按当前内容重排输入框高度。
 *
 * 先把 height 重置为 auto 再量 scrollHeight：textarea 的 scrollHeight 不会小于当前
 * clientHeight，不重置的话删除内容后无法缩回去。贴底状态在重置前记录。
 */
export function resizeComposerTextarea(textarea: HTMLTextAreaElement, maxHeight = readMaxHeight(textarea)): void {
  const atBottom = isComposerTextareaAtBottom(textarea.scrollHeight, textarea.clientHeight, textarea.scrollTop);
  const previousScrollTop = textarea.scrollTop;
  textarea.style.height = "auto";
  const plan = planComposerTextareaSize(
    { contentHeight: textarea.scrollHeight, scrollTop: previousScrollTop, atBottom },
    maxHeight
  );
  textarea.style.height = `${plan.height}px`;
  textarea.style.overflowY = plan.overflowY;
  textarea.scrollTop = plan.scrollTop;
}
