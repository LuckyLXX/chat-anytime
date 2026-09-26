import { useEffect, useSyncExternalStore } from "react";

/**
 * 全屏 DOM 弹层的全局计数（2026-09-26）。
 *
 * 为什么需要它：内置浏览器的预览标签是 Electron **原生 `WebContentsView`**
 *（`src/main/browser-preview.ts`），原生视图永远画在窗口的所有 DOM 之上——
 * z-index 对它无效。于是右侧预览面板里的网页会盖住任何 DOM 弹层：气泡图片
 * 放大、Mermaid 放大图、各种对话框都躲不过（`AGENTS.md` 里「设备/书签/下载
 * 下拉菜单张开时必须临时隐藏 native 视图」是同一条事实的早期版本）。
 *
 * 现有通路是 `browserSuspended`（App → ArtifactPreview → BrowserPreview →
 * 主进程 `visible:false`），但它原来只覆盖设置页/权限弹窗/拖拽分隔条那几个
 * 由 App 直接持有的状态。放大层这类**深层组件内部**的弹层（消息气泡里的
 * `<ImageLightbox>`、RichContent 里的 Mermaid 弹窗）没有把状态提升到 App，
 * 所以在这里用「谁开谁登记」的方式让它们也能挂上同一条通路。
 *
 * 为什么是计数而不是布尔：弹层可以并存、也可以嵌套（分屏时两个 ConversationPane
 * 各有自己的 lightbox 实例，退场动画窗口里还会短暂重叠）。计数 + 幂等的 release
 * 让「最后一个关掉的」负责归零，谁先关都不影响。
 *
 * ⚠️ 只登记**全屏/浮层**类弹层，不要拿它标记普通的下拉菜单（那些各自有既有通路，
 * 重复登记只会让原生视图无辜地被藏起来）。
 */

let openLayers = 0;
let lastReported = false;
const listeners = new Set<() => void>();

/** 只在「有没有弹层」这个布尔真的翻转时通知订阅者，避免每层进出都重渲 App。 */
function notify(): void {
  const open = openLayers > 0;
  if (open === lastReported) return;
  lastReported = open;
  for (const listener of listeners) listener();
}

/**
 * 登记一个已打开的弹层，返回幂等的释放函数（React effect cleanup 会重复调用，
 * 或者弹层走两条关闭路径时也可能重复调用，重复释放必须不把计数减成负数）。
 */
export function pushOverlayLayer(): () => void {
  openLayers += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openLayers = Math.max(0, openLayers - 1);
    notify();
  };
}

/** 当前是否有弹层打开（非 React 侧读取）。 */
export function overlayLayersOpen(): boolean {
  return openLayers > 0;
}

/** 订阅「有没有弹层」的变化（`useSyncExternalStore` 的 subscribe）。 */
export function subscribeOverlayLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 组件侧登记：`active` 为真期间该弹层计入总数（effect cleanup 自动释放）。 */
export function useOverlayLayer(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return pushOverlayLayer();
  }, [active]);
}

/** 读取「是否有弹层打开」，变化时重渲（App 用它驱动 `browserSuspended`）。 */
export function useOverlayLayersOpen(): boolean {
  return useSyncExternalStore(subscribeOverlayLayers, overlayLayersOpen, () => false);
}
