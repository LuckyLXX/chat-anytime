import html2canvas from "html2canvas-pro";

const shareExcludedSelectors = [".action-timeline", ".message-timing", ".inline-error"].join(",");

/**
 * 分享取景判据。回复里只要渲染出了 Div 气泡（`<assistant_html>` 或裸 HTML 片段
 * 都会落到 `.html-bubble`），就只截这一张卡片：卡片外的 Markdown 说明、交付产物
 * 面板、时间线都不进图（用户口径：气泡外的 md 一律不带）。没有气泡时退回整块
 * 回复内容，与旧行为一致。
 *
 * 多气泡（同一回复里出现多个 `<assistant_html>`）取第一个：与「一轮回复一张卡片」
 * 的输出约定一致，多张卡片拼一张图反而不可读。
 */
export function resolveShareTarget(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>(".html-bubble") ?? root;
}

/**
 * 从计算样式拷贝属性到元素上。属性名必须用连字符名（`font-family`），不能写
 * `fontFamily`——`style.setProperty()` 只认连字符名，驼峰名会被静默忽略。旧实现用
 * 驼峰拷贝 fontFamily/fontSize/lineHeight/borderRadius，实际一个都没生效，只有
 * 单字属性（background/color/padding）生效。
 */
function applyComputedStyle(target: HTMLElement, style: CSSStyleDeclaration, properties: string[]): void {
  for (const property of properties) {
    const value = style.getPropertyValue(property);
    if (value) target.style.setProperty(property, value);
  }
}

/** 整块回复分支要复刻的聊天气泡外框（卡片分支不要外框，紧贴卡片）。 */
const BUBBLE_FRAME_PROPERTIES = ["background-color", "background-image", "border", "border-radius", "box-shadow"];

function copyCanvasPixels(source: HTMLElement, clone: HTMLElement): void {
  const sourceCanvases = Array.from(source.querySelectorAll("canvas"));
  const clonedCanvases = Array.from(clone.querySelectorAll("canvas"));
  sourceCanvases.forEach((sourceCanvas, index) => {
    const clonedCanvas = clonedCanvases[index];
    if (!clonedCanvas) return;
    try {
      const context = clonedCanvas.getContext("2d");
      if (context) context.drawImage(sourceCanvas, 0, 0);
    } catch {
      // A tainted or non-2D canvas should not prevent the rest of the bubble
      // from being shared.
    }
  });
}

async function waitForImages(root: HTMLElement): Promise<void> {
  await Promise.all(Array.from(root.querySelectorAll("img")).map((image) => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    });
  }));
}

function createCaptureSurface(): HTMLElement {
  const surface = document.createElement("div");
  surface.className = "assistant-share-capture";
  surface.style.position = "fixed";
  surface.style.left = "-100000px";
  surface.style.top = "0";
  surface.style.zIndex = "-1";
  surface.style.display = "inline-block";
  surface.style.overflow = "visible";
  surface.style.maxWidth = "none";
  surface.style.margin = "0";
  return surface;
}

/**
 * 复刻气泡外框并返回横向占位（padding + border 宽度和）。返回的宽度用于给外壳加宽，
 * 因为克隆体自己只负责内容宽度、padding 收在 border-box 里。
 */
function copyBubbleFrame(source: HTMLElement, surface: HTMLElement): number {
  const bubble = source.closest<HTMLElement>(".message-assistant .message-bubble");
  const frameStyle = getComputedStyle(bubble ?? source);
  applyComputedStyle(surface, frameStyle, BUBBLE_FRAME_PROPERTIES);
  applyComputedStyle(surface, frameStyle, ["padding"]);
  const horizontalFrame = Number.parseFloat(frameStyle.paddingLeft) + Number.parseFloat(frameStyle.paddingRight) + Number.parseFloat(frameStyle.borderLeftWidth) + Number.parseFloat(frameStyle.borderRightWidth);
  return Number.isFinite(horizontalFrame) ? horizontalFrame : 0;
}

/**
 * 克隆体必须活在**与屏幕一致的类名上下文**里，否则后代选择器失配，截图会与屏幕不同：
 * - `.rich-content ...` 提供标题字号（h3 = 15px）、段落边距（.65em）、表格字号（12px）
 *   与标题行高——缺了它表格会按 14px 基准撑高、卡片比屏幕上高一截；
 * - `.message-body` 提供正文基准字号 14px 与**无单位**行高 1.65——行高必须来自样式表
 *   而不是拷贝计算值：算出来的 23.1px 会被 12px 的表格文字继承，而屏幕上它是按
 *   1.65 × 12px = 19.8px 重新计算的（真机探针：表格行 40px vs 37px）。
 *
 * 类名放在外壳内部的一层 div 上（而不是外壳本身），这样它不会把聊天气泡的背景/内距
 * 规则一并带出来——`.message-assistant .message-body` 这个复合选择器在外壳里不匹配。
 */
function createStyleContext(bubbleOnly: boolean): HTMLElement {
  const context = document.createElement("div");
  context.className = bubbleOnly ? "message-body rich-content" : "message-body";
  return context;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("截图结果为空"));
    }, "image/png");
  });
}

export async function copyPngToClipboard(blob: Blob): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前环境不支持图片剪贴板");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/**
 * 把回复分享成图片（写入剪贴板）。取景由 resolveShareTarget 决定：有 Div 气泡就
 * 只截气泡本体，否则截整块回复内容。卡片分支下不叠加聊天气泡的 padding/边框/底色，
 * 导出图是「卡片本身」而不是「气泡里的一张卡片」。
 */
export async function shareElementAsImage(root: HTMLElement): Promise<void> {
  if (!root.isConnected) throw new Error("找不到可分享的气泡内容");

  const bubble = resolveShareTarget(root);
  const bubbleOnly = bubble !== root;
  const source = bubbleOnly ? bubble : root;

  const sourceRect = source.getBoundingClientRect();
  const contentWidth = Math.max(1, Math.ceil(sourceRect.width));

  const clone = source.cloneNode(true) as HTMLElement;
  if (!bubbleOnly) clone.querySelectorAll(shareExcludedSelectors).forEach((element) => element.remove());
  copyCanvasPixels(source, clone);
  clone.style.width = `${contentWidth}px`;
  clone.style.maxWidth = `${contentWidth}px`;
  clone.style.minWidth = `${contentWidth}px`;
  clone.style.margin = "0";
  clone.style.boxSizing = "border-box";
  // 整块回复分支由外壳承担气泡内距；卡片分支保留卡片自身 padding——它的 3px 6px 是
  // 屏幕观感的一部分，去掉会让内容贴到卡片边缘。
  if (!bubbleOnly) clone.style.padding = "0";

  const surface = createCaptureSurface();
  if (bubbleOnly) {
    surface.style.width = `${contentWidth}px`;
  } else {
    const horizontalFrame = copyBubbleFrame(source, surface);
    surface.style.width = `${Math.max(1, Math.ceil(contentWidth + horizontalFrame))}px`;
  }

  const context = createStyleContext(bubbleOnly);
  context.appendChild(clone);
  surface.appendChild(context);
  document.body.appendChild(surface);

  try {
    await waitForImages(clone);
    if (document.fonts?.ready) {
      try { await document.fonts.ready; } catch { /* ignore font loading failures */ }
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const captureRect = surface.getBoundingClientRect();
    const canvas = await html2canvas(surface, {
      useCORS: true,
      backgroundColor: null,
      scale: 2,
      x: 0,
      y: 0,
      width: Math.max(1, Math.ceil(captureRect.width)),
      height: Math.max(1, Math.ceil(captureRect.height)),
      scrollX: 0,
      scrollY: 0,
      windowWidth: Math.max(1, Math.ceil(captureRect.width)),
      windowHeight: Math.max(1, Math.ceil(captureRect.height)),
      foreignObjectRendering: false
    });
    await copyPngToClipboard(await canvasToBlob(canvas));
  } finally {
    surface.remove();
  }
}
