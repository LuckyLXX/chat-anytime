import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MarkdownHeading } from "../lib/content-pipeline";
import { BLOCK_OBSERVER_MARGIN, estimateMarkdownBlockHeight, initialMountCount, type MarkdownBlock } from "../lib/markdown-blocks";
import { createTimelineObserver, type TimelineObserver } from "../lib/timeline-window";

/**
 * 大文档预览的窗口化渲染（2026-11-02，参考 deepseek-harness 的块冻结）。
 *
 * **做法**：块由 lib/markdown-blocks.ts 规划（切分规则与不变量都在那边），这里只负责
 * 「哪一块现在挂载」——首屏同步挂载前几块，其余是等高占位；IntersectionObserver 在
 * 块进入视口上下 1.2 屏时挂载。**挂载后永不卸载**：不重解析、不丢滚动位置，也不
 * 需要实测高度缓存（聊天窗口化的那套 tombstone 逻辑这里用不上）。
 *
 * **实测**（301KB 文档，SSR 口径）：整篇 1672ms；首 2 块 52ms、首 3 块 83ms；
 * 全部块逐个渲染合计 1584ms ≈ 整篇——窗口化省的是"打开时的一次性成本"。
 *
 * **四个必须保留的不变量**：
 * 1. **观察器注册要重放**：块的 ref 回调早于本组件的 useLayoutEffect 执行，观察器尚未
 *    创建时的 register 会被静默丢弃；`elementsRef` 持有全部占位元素，观察器创建后立刻
 *    重放（聊天窗口化曾在同一条上栽过：整段历史变空白，滚也滚不出来）。
 * 2. **挂载补偿**：占位高度是估算值；若某块在视口上方挂载并变高，`scrollTop` 要补
 *    差值，否则正在读的内容会被顶走。
 * 3. **Ctrl+F / Ctrl+A 展开全部**：块没挂载时文本不在 DOM 里，浏览器页内查找与全选
 *    都看不到它。监听这两个键（不 preventDefault，浏览器自己的行为照常），一次性
 *    挂载全部块——等于回到今天的整篇渲染，但由用户主动触发。
 * 4. **块包装零样式**：`.markdown-block` 不能加 padding/border/overflow/contain，
 *    否则块间外边距不再折叠，标题与段落的间距会翻倍（styles.css 有注释钉死）。
 */
export interface MarkdownBlocksProps {
  /** 已规划的块（父级 useMemo 一次，保证块引用稳定）。 */
  blocks: readonly MarkdownBlock[];
  /** 块起始偏移 → 该块负责的大纲条目（父级按文档顺序切片后传入）。 */
  headingsByBlock?: Map<number, MarkdownHeading[]>;
  /** 渲染一个已挂载的块；`headings` 是该块的标题切片（可为空）。 */
  renderBlock(block: MarkdownBlock, headings: MarkdownHeading[] | undefined): ReactNode;
  /** 把「滚到某个大纲标题」的能力交给父级（大纲栏点击用）。 */
  onRegisterReveal?(reveal: (heading: MarkdownHeading) => void): void;
}

/** 占位块的固定类名（测试与样式都认它）。 */
export const MARKDOWN_BLOCK_PLACEHOLDER = "markdown-block is-placeholder";

function MountedBlock({ block, estimated, children }: { block: MarkdownBlock; estimated: number; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const scroller = element.closest<HTMLElement>(".preview-scroll");
    if (!scroller) return;
    const delta = element.offsetHeight - estimated;
    if (delta === 0) return;
    const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    // 只有「挂载发生在视口上方」才补偿：下方挂载变高只影响之后的内容，不该动当前视口。
    if (top < 0) scroller.scrollTop += delta;
  }, [estimated]);
  return <div className="markdown-block" data-md-block={block.start} ref={ref}>{children}</div>;
}

export function MarkdownBlocks({ blocks, headingsByBlock, renderBlock, onRegisterReveal }: MarkdownBlocksProps): ReactNode {
  const [mounted, setMounted] = useState<Set<number>>(() => new Set(blocks.slice(0, initialMountCount(blocks)).map((block) => block.start)));
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const elementsRef = useRef(new Map<number, HTMLElement>());
  const observerRef = useRef<TimelineObserver | null>(null);
  const headingsRef = useRef(headingsByBlock);
  headingsRef.current = headingsByBlock;
  /** 规划签名：内容被替换（AI 改写 / 分页重读）时重置挂载状态。 */
  const signature = `${blocks.length}:${blocks[0]?.start ?? 0}:${blocks.at(-1)?.end ?? 0}`;
  const signatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (signatureRef.current === null) {
      signatureRef.current = signature;
      return;
    }
    if (signatureRef.current === signature) return;
    signatureRef.current = signature;
    elementsRef.current.clear();
    // 内容被改写（AI 编辑 / 重新加载）时保留「已挂载的块数」而不是缩回首屏预算：
    // 否则用户正读到中间时整篇会塌回占位、滚动位置大幅跳动。
    setMounted((previous) => new Set(
      blocks.slice(0, Math.min(blocks.length, Math.max(initialMountCount(blocks), previous.size))).map((block) => block.start)
    ));
  }, [blocks, signature]);

  const mount = useCallback((start: number): void => {
    setMounted((previous) => (previous.has(start) ? previous : new Set(previous).add(start)));
  }, []);

  // 观察器：块进入视口上下 1.2 屏即挂载。创建后必须重放已有的 ref 注册（不变量 1）。
  useLayoutEffect(() => {
    const container = containerRef.current;
    const scroller = container?.closest<HTMLElement>(".preview-scroll");
    if (!container || !scroller) return;
    const observer = createTimelineObserver({
      root: scroller,
      margin: BLOCK_OBSERVER_MARGIN,
      onChange: (key, visible) => {
        if (!visible) return;
        const start = Number(key);
        if (!Number.isFinite(start)) return;
        setMounted((previous) => (previous.has(start) ? previous : new Set(previous).add(start)));
      }
    });
    observerRef.current = observer;
    for (const [start, element] of elementsRef.current) observer.register(String(start), element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  // Ctrl/Cmd+F 页内查找、Ctrl/Cmd+A 全选：先把全部块挂载出来（不 preventDefault）。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "f" || key === "a") setExpanded(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    setMounted(new Set(blocks.map((block) => block.start)));
  }, [expanded, blocks]);

  // 大纲跳转：找到该标题所属的块 → 挂载 → 等两帧让真实高度落位后滚过去。
  useEffect(() => {
    onRegisterReveal?.((heading: MarkdownHeading) => {
      const target = blocks.find((block) => (headingsRef.current?.get(block.start) ?? []).some((item) => item.id === heading.id));
      if (!target) return;
      mount(target.start);
      const scrollTo = (): void => {
        const element = containerRef.current?.querySelector<HTMLElement>(`[data-md-block="${target.start}"] [id="${CSS.escape(heading.id)}"]`);
        element?.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      // 第一帧等 React 提交挂载，第二帧等布局（块可能比估算高，位置会再挪一次）。
      window.requestAnimationFrame(() => window.requestAnimationFrame(scrollTo));
    });
  }, [blocks, mount, onRegisterReveal]);

  return (
    <div className="markdown-blocks" ref={containerRef}>
      {blocks.map((block) => {
        if (mounted.has(block.start)) {
          const estimated = estimateMarkdownBlockHeight(block.text);
          return (
            <MountedBlock key={block.start} block={block} estimated={estimated}>
              {renderBlock(block, headingsRef.current?.get(block.start))}
            </MountedBlock>
          );
        }
        return (
          <div
            key={block.start}
            className={MARKDOWN_BLOCK_PLACEHOLDER}
            data-md-block-placeholder={block.start}
            aria-hidden
            style={{ height: estimateMarkdownBlockHeight(block.text) }}
            ref={(element) => {
              if (element) {
                elementsRef.current.set(block.start, element);
                observerRef.current?.register(String(block.start), element);
                return;
              }
              elementsRef.current.delete(block.start);
              observerRef.current?.register(String(block.start), null);
            }}
          />
        );
      })}
    </div>
  );
}
