import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MarkdownHeading } from "../lib/content-pipeline";

/**
 * 文档大纲栏（对标 dock-markdown 的 outline rail）。
 *
 * 三个职责：
 * 1. 按 depth 缩进渲染标题列表（h1–h6）；
 * 2. 点击 → 平滑滚动到对应标题；
 * 3. 滚动时高亮「当前章节」（scroll-spy，rAF 节流）。
 *
 * 与 dock-markdown 的差别在量测口径——预览内容块带 `content-visibility: auto`
 * （长文档只渲染可视区），未渲染区域的几何量测是「估算值」，直接按
 * `getBoundingClientRect().top` 逐项比较会在长文档里跳变。这里：
 * - 主口径 = 每个标题在滚动空间里的偏移（`rect.top - 容器 rect.top + scrollTop`，
 *   与当前滚动位置无关，可一次量好复用）；命中判定用 `scrollTop + 容差` 去比，
 *   不依赖「刚好看得见」这一条件；
 * - 兜底 = 量测拿不满全部标题（大文档被跳过）时，改用 scrollTop 比例估算，
 *   保证高亮仍单调移动、不乱跳（用户在实施前确认的策略）。
 */

/** 判定「当前章节」的容差：标题进入容器顶部下方这么远处即算已到达。 */
const ACTIVE_OFFSET = 24;
/** 量测上限：标题数量超过它时不再逐项量测，直接走比例估算（极端文档保护）。 */
const MEASURE_LIMIT = 600;

interface MarkdownOutlineProps {
  headings: MarkdownHeading[];
  /** 滚动容器（.preview-scroll）：滚动监听与坐标基准都取它。 */
  scrollRef: { current: HTMLDivElement | null };
  /** 内容根节点（.rich-content）：在其内部查标题节点。 */
  contentRef?: { current: HTMLDivElement | null };
  /** 内容变化时它跟着变（如文件路径），用于重新量测并清空高亮。 */
  measureKey?: unknown;
}

/** 按 scrollTop 比例估算当前章节（量测不可信时的兜底）。 */
function estimateActiveIndex(offsets: number[], scrollTop: number): number {
  if (offsets.length === 0) return -1;
  const target = scrollTop + ACTIVE_OFFSET;
  let index = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    if ((offsets[i] ?? 0) <= target) index = i;
    else break;
  }
  return index;
}

export const MarkdownOutline = memo(function MarkdownOutline({ headings, scrollRef, contentRef, measureKey }: MarkdownOutlineProps): ReactNode {
  const [activeId, setActiveId] = useState<string>();
  /** 各标题在滚动空间里的偏移缓存（与测量时的 scrollTop 无关）。 */
  const offsetsRef = useRef<number[]>([]);

  /**
   * 量测全部标题在滚动空间里的偏移；拿不满（被 cv 跳过）返回空数组，调用方走兜底。
   * 公式 `rect.top - 容器 rect.top + scrollTop` 对任意当前滚动位置都成立，
   * 所以不需要先滚到顶部再量（那会造成可见跳动）。
   */
  const measureOffsets = useCallback((): number[] => {
    const scroller = scrollRef.current;
    const root = contentRef?.current ?? scroller;
    if (!scroller || !root || headings.length === 0 || headings.length > MEASURE_LIMIT) return [];
    const containerTop = scroller.getBoundingClientRect().top;
    const wanted = new Set(headings.map((heading) => heading.id));
    const byId = new Map<string, number>();
    for (const node of root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) {
      if (!node.id || !wanted.has(node.id) || byId.has(node.id)) continue;
      byId.set(node.id, node.getBoundingClientRect().top - containerTop + scroller.scrollTop);
    }
    if (byId.size < headings.length) return [];
    // 必须按大纲顺序取（DOM 顺序一般一致，显式按 id 映射更稳）。
    const offsets = headings.map((heading) => byId.get(heading.id)).filter((value): value is number => value !== undefined);
    if (offsets.length !== headings.length) return [];
    // 单调性自检：cv 估算偶尔会让序列出现回退项，这时宁可退回比例估算。
    for (let i = 1; i < offsets.length; i += 1) {
      if ((offsets[i] ?? 0) < (offsets[i - 1] ?? 0)) return [];
    }
    return offsets;
  }, [contentRef, headings, scrollRef]);

  // 滚动高亮：rAF 节流，只在滚动容器上监听（passive）。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || headings.length === 0) return;
    let frame = 0;

    const recompute = (): void => {
      offsetsRef.current = measureOffsets();
    };

    const update = (): void => {
      frame = 0;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const offsets = offsetsRef.current;
      if (offsets.length !== headings.length || offsets.length === 0) {
        // 兜底：无可靠量测时按比例估算（保证高亮仍随滚动单调推进）。
        const ratio = scroller.scrollHeight > scroller.clientHeight
          ? (scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight)) * headings.length
          : 0;
        const estimated = Math.min(headings.length - 1, Math.max(0, Math.floor(ratio)));
        const next = scroller.scrollTop <= 0 ? undefined : headings[estimated]?.id;
        setActiveId((current) => (current === next ? current : next));
        return;
      }
      const index = estimateActiveIndex(offsets, scroller.scrollTop);
      const next = scroller.scrollTop <= 0 ? undefined : headings[index]?.id;
      setActiveId((current) => (current === next ? current : next));
    };

    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(update);
    };

    recompute();
    update();
    // 图片加载 / 字体替换 / 面板宽度变化都会移动标题：观察内容根，重新量测。
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      recompute();
      onScroll();
    });
    observer?.observe(contentRef?.current ?? container);
    const onLoad = (): void => { recompute(); onScroll(); };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("load", onLoad, true);
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("load", onLoad, true);
      observer?.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [contentRef, headings, measureOffsets, scrollRef]);

  // 内容切换（key 变化）时清空量测与高亮，避免用上一份文档的偏移。
  useEffect(() => {
    offsetsRef.current = [];
    setActiveId(undefined);
  }, [measureKey]);

  /** 点击跳转：按 id 找节点并滚到容器顶部（smooth）。 */
  const scrollToHeading = useCallback((id: string): void => {
    const root = contentRef?.current ?? scrollRef.current;
    const target = root?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
  }, [contentRef, scrollRef]);

  if (headings.length === 0) {
    return <div className="markdown-outline is-empty"><span>本文档没有标题结构</span></div>;
  }

  return (
    <nav className="markdown-outline" aria-label="文档大纲" data-pane="markdown-outline">
      <div className="markdown-outline-title">大纲</div>
      <div className="markdown-outline-list">
        {headings.map((heading) => (
          <button
            key={heading.id}
            type="button"
            className={`markdown-outline-item${heading.id === activeId ? " active" : ""}`}
            style={{ paddingLeft: `${6 + (heading.depth - 1) * 10}px` }}
            title={heading.text}
            onClick={() => scrollToHeading(heading.id)}
          >
            {heading.text}
          </button>
        ))}
      </div>
    </nav>
  );
});
