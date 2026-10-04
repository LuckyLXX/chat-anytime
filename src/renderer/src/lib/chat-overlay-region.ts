import { useEffect, type RefObject } from "react";

/**
 * 「聊天区遮罩边界」（2026-10-04）。
 *
 * 为什么需要它：内置浏览器的预览标签是 Electron **原生 `WebContentsView`**，
 * 永远画在窗口所有 DOM 之上，z-index 对它无效（`overlay-layers.ts` 记的是同一条
 * 事实）。既有解法是弹层打开时把原生视图临时隐藏（`browserSuspended`），但会话级
 * 确认框（删除话题 / 重命名 / 回滚 / 移除工作区 / 文件树弹窗）是一次性小弹窗，
 * 让整块浏览器面板跟着闪一下不划算。
 *
 * 这里的思路是**让弹窗根本不与预览面板重叠**：把这类弹窗的遮罩左右边界收到会话区
 * 之内，弹窗就在聊天区居中，预览面板再宽也盖不到它。两套机制并存——
 * `browserSuspended` 仍然保留兜底（预览面板**全屏**时原生视图铺满整个窗口，
 * 边界收窄也躲不开）。
 *
 * 为什么用 JS 测量而不是纯 CSS：会话区的横向范围由网格列宽、预览分隔条拖拽、
 * 侧栏折叠、分屏、设计模式共同决定，没有一个纯 CSS 表达式能一次说清；量出来写进
 * `--chat-overlay-left/right/width` 三个变量，CSS 只管用（缺省值即「整窗」，量测
 * 没跑起来时退回旧行为）。
 *
 * ⚠️ 变量写在 `document.documentElement` 上（而不是某个容器）：工作区文件树的弹窗
 * 是 `createPortal` 到 body 的（见 WorkspaceTree 注释），必须靠根变量才能生效。
 */

/** 会话级确认框遮罩的左右边界（视口坐标，px）。 */
export interface ChatOverlayEdges {
  left: number;
  right: number;
}

/** 发布到根节点的 CSS 变量名：`left`/`right` 是**距视口左右边的内缩量**，`width` 是区域宽度。
 *  内缩量而不是坐标，是为了让 CSS 直接写 `left: var(--x)` / `right: var(--x)`。 */
const VAR_LEFT = "--chat-overlay-left";
const VAR_RIGHT = "--chat-overlay-right";
const VAR_WIDTH = "--chat-overlay-width";

/** 会话区窄到这个宽度以下就放弃收窄、退回整窗遮罩（否则遮罩塌成一条缝，装不下确认框）。 */
const MIN_OVERLAY_WIDTH = 240;

/**
 * 由若干会话区矩形算出遮罩边界（纯函数，便于单测）。
 *
 * 取所有会话区矩形的**并集**：分屏时多个 ConversationPane 各占一块，只认第一块会
 * 把弹窗偏到左边；设计模式下会话区在右侧，取并集正好覆盖它。
 *
 * 无可用矩形（会话区未挂载）或宽度不足时退回整窗——宁可全窗居中，也不要给一个
 * 装不下 480px 确认框的窄条。
 */
export function chatOverlayEdges(rects: readonly { left: number; right: number }[], viewportWidth: number): ChatOverlayEdges {
  const usable = rects.filter((rect) => rect.right > rect.left);
  if (usable.length === 0) return { left: 0, right: viewportWidth };
  const left = Math.max(0, Math.min(...usable.map((rect) => rect.left)));
  const right = Math.min(viewportWidth, Math.max(...usable.map((rect) => rect.right)));
  if (right - left < MIN_OVERLAY_WIDTH) return { left: 0, right: viewportWidth };
  return { left, right };
}

/** 会话区容器选择器：走主题钩子 `data-pane="conversation"`，与 styles.css 同源。 */
const PANE_SELECTOR = '[data-pane="conversation"]';

function panes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(PANE_SELECTOR)];
}

/**
 * 持续把会话区边界发布到根 CSS 变量上。
 *
 * 挂在 App（常驻、无条件）：弹窗可能由 App 之外的组件打开（工作区文件树在侧栏里，
 * 用 portal 渲染），谁开谁测会漏。
 *
 * 触发源只认「会改变会话区矩形」的三类，别的一律不碰（流式输出时 timeline 里的消息
 * 每秒变好几次，观察整棵子树会让每帧都白跑一次强制布局）：
 *  ① 会话区尺寸变化（拖分隔条 / 侧栏折叠）→ ResizeObserver；
 *  ② work-area 的**直接**子节点变化（预览面板开合、设计模式、会话区换挂）→
 *     MutationObserver（不递归）；分屏在 split-view 内部增删格子，靠新格子必然改变
 *     原格子宽度这一点由 ① 带出来，并在 ① 的回调里顺带把新格子补进订阅；
 *  ③ 窗口尺寸变化 → resize。
 *
 * 每次发布前都重新收集会话区集合，值没变则不写样式（拖分隔条时每帧写会白触发样式重算）。
 *
 * @param workAreaRef 会话区所在的网格容器（用于侦测直接子节点变化）。
 */
export function useChatOverlayRegion(workAreaRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = document.documentElement;
    const observed = new Set<HTMLElement>();
    let last = "";
    const publish = (): void => {
      const rects = panes().map((pane) => pane.getBoundingClientRect());
      const viewport = window.innerWidth;
      const edges = chatOverlayEdges(rects, viewport);
      const left = Math.round(edges.left);
      const right = Math.round(viewport - edges.right);
      const width = Math.round(edges.right - edges.left);
      const next = `${left}|${right}|${width}`;
      if (next === last) return;
      last = next;
      root.style.setProperty(VAR_LEFT, `${left}px`);
      root.style.setProperty(VAR_RIGHT, `${right}px`);
      root.style.setProperty(VAR_WIDTH, `${width}px`);
    };
    /** 增量对齐订阅集合，再发布一次（会话区可能换了挂载点，新元素不在旧订阅里）。 */
    const rescan = (): void => {
      const current = new Set(panes());
      for (const pane of observed) {
        if (current.has(pane)) continue;
        resizeObserver.unobserve(pane);
        observed.delete(pane);
      }
      for (const pane of current) {
        if (observed.has(pane)) continue;
        resizeObserver.observe(pane);
        observed.add(pane);
      }
      publish();
    };
    // 观察回调也走 rescan：分屏新增的格子未必改变「已订阅格子」以外的任何东西，
    // 顺一次订阅集合才不会漏掉它后续的尺寸变化（已在集合里的元素是幂等跳过）。
    const resizeObserver = new ResizeObserver(rescan);
    const mutations = new MutationObserver(rescan);
    const area = workAreaRef.current;
    if (area) mutations.observe(area, { childList: true });
    rescan();
    window.addEventListener("resize", publish);
    return () => {
      resizeObserver.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty(VAR_LEFT);
      root.style.removeProperty(VAR_RIGHT);
      root.style.removeProperty(VAR_WIDTH);
    };
  }, [workAreaRef]);
}
