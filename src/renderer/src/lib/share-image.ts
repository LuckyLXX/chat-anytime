import html2canvas from "html2canvas-pro";

const shareExcludedSelectors = [".thinking-block", ".tool-call-group", ".message-timing", ".inline-error"].join(",");

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

function copyBubbleSurfaceStyle(source: HTMLElement, surface: HTMLElement): number {
  const bubble = source.closest<HTMLElement>(".message-assistant .message-bubble");
  const sourceStyle = getComputedStyle(bubble ?? source);
  ["background", "backgroundColor", "border", "borderRadius", "boxShadow", "boxSizing", "color", "fontFamily", "fontSize", "lineHeight", "padding"].forEach((property) => {
    surface.style.setProperty(property, sourceStyle.getPropertyValue(property));
  });
  surface.style.display = "inline-block";
  surface.style.overflow = "visible";
  surface.style.maxWidth = "none";
  surface.style.margin = "0";
  const horizontalFrame = Number.parseFloat(sourceStyle.paddingLeft) + Number.parseFloat(sourceStyle.paddingRight) + Number.parseFloat(sourceStyle.borderLeftWidth) + Number.parseFloat(sourceStyle.borderRightWidth);
  return Number.isFinite(horizontalFrame) ? horizontalFrame : 0;
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

export async function shareElementAsImage(source: HTMLElement): Promise<void> {
  if (!source.isConnected) throw new Error("找不到可分享的气泡内容");

  const sourceRect = source.getBoundingClientRect();
  const contentWidth = Math.max(1, Math.ceil(sourceRect.width));
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(shareExcludedSelectors).forEach((element) => element.remove());
  copyCanvasPixels(source, clone);
  clone.style.width = `${contentWidth}px`;
  clone.style.maxWidth = `${contentWidth}px`;
  clone.style.minWidth = `${contentWidth}px`;
  clone.style.margin = "0";
  clone.style.padding = "0";
  clone.style.boxSizing = "border-box";

  const surface = document.createElement("div");
  surface.className = "assistant-share-capture";
  surface.style.position = "fixed";
  surface.style.left = "-100000px";
  surface.style.top = "0";
  surface.style.zIndex = "-1";
  const horizontalFrame = copyBubbleSurfaceStyle(source, surface);
  surface.style.width = `${Math.max(1, Math.ceil(contentWidth + horizontalFrame))}px`;
  surface.appendChild(clone);
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
