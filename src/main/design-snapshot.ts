// Offscreen snapshot controller (main process): first built for design_export —
// the tool hands the model a finished HTML file, and the visual-check loop that
// follows (browser_navigate → wait → screenshot_full → recognize_images, ×6
// rounds in one real session) costs more tool calls than building the design
// did. This controller closes the loop into the receipt itself: an offscreen
// hidden BrowserWindow loads the HTML file, paints it without ever appearing on
// screen, capturePage grabs the frame, and the PNG rides back to the utility
// process as an image part on the tool result (or is written to a caller-chosen
// directory for the gallery wall).
//
// Two persistence modes, chosen by the request:
// - default: `<workspace>/.pidesktop/screenshots/` via saveBrowserScreenshot
//   (shared retention, so text-only models also get a workspace path to feed
//   recognize_images) — the design_export behaviour, byte-for-byte unchanged;
// - `thumbDir` set (gallery): write `<thumbDir>/<thumbPrefix>-<ts>.png` directly
//   and return the ABSOLUTE path — gallery thumbs live in the global agentDir
//   (cross-workspace, and deliberately NOT under the 20-file screenshot
//   retention that would evict them).
//
// The utility process reaches it through the design-snapshot.request /
// design-snapshot.result message pair (same bypass-the-command-queue RPC
// semantics as browser automation). Failures degrade to ok:false — the export
// itself already succeeded, so a missing thumbnail must never fail the tool.
//
// Electron runtime imports are dynamic (inside capture) so unit tests can
// import this module's pure helpers without pulling Electron into vitest.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { galleryThumbName } from "../shared/gallery.js";
import type { DesignSnapshotRequest, DesignSnapshotResult } from "../shared/protocol.js";
import { saveBrowserScreenshot } from "./browser-screenshot.js";

/** 缩略视口上限：导出内容按比例缩进这个视口（zoom < 1 时内容整体缩小完整呈现）。 */
const MAX_VIEW_SIZE = 1600;
/** 回传图像的宽度上限（token 预算；标题层级在 1024 宽下仍可辨认）。 */
const THUMBNAIL_MAX_WIDTH = 1024;
/** 默认加载超时；请求可覆盖（外部资源多的页面给更长预算）。 */
const LOAD_TIMEOUT_MS = 12_000;
const CAPTURE_TIMEOUT_MS = 6_000;

/** 画布∪内容尺寸 → 离屏视口尺寸与缩放（纯函数，测试用）。 */
export function fitViewport(contentWidth: number, contentHeight: number): { width: number; height: number; zoom: number } {
  const width = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 1440;
  const height = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 900;
  const zoom = Math.min(1, MAX_VIEW_SIZE / width, MAX_VIEW_SIZE / height);
  return {
    width: Math.max(320, Math.ceil(width * zoom)),
    height: Math.max(240, Math.ceil(height * zoom)),
    zoom: Math.round(zoom * 1000) / 1000
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * 把缩略图 PNG 写进调用方指定的目录（作品墙用），返回**绝对路径**。
 * 与 saveBrowserScreenshot 的分工：那条路走工作区 `.pidesktop/screenshots/`（保留
 * 最近 20 张、返回工作区相对路径）；作品缩略图存全局 agentDir，不能被那套保留
 * 策略挤掉，所以这里直写自建目录，文件名与截图同风格（`<prefix>-<时间戳>.png`）。
 */
function writeGalleryThumbFile(dir: string, prefix: string, png: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const name = prefix === "gallery" ? galleryThumbName() : `${prefix}-${Date.now()}.png`;
  const target = join(dir, name);
  writeFileSync(target, png);
  return target;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolveWith, rejectWith) => {
    const timer = setTimeout(() => rejectWith(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolveWith(value); },
      (error) => { clearTimeout(timer); rejectWith(error); }
    );
  });
}

/**
 * 单飞串行：离屏窗口是真实的渲染器进程，排队避免并发导出时同时拉起多个。
 * handle 永不 reject（内部兜底成 ok:false），调用方无需再 catch。
 */
export class DesignSnapshotController {
  private queue: Promise<unknown> = Promise.resolve();

  handle(request: DesignSnapshotRequest): Promise<DesignSnapshotResult> {
    const run = this.queue.then(() => this.capture(request)).catch((error: unknown): DesignSnapshotResult => {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async capture(request: DesignSnapshotRequest): Promise<DesignSnapshotResult> {
    const { BrowserWindow } = await import("electron");
    const fit = fitViewport(request.contentWidth, request.contentHeight);
    let win: ElectronBrowserWindow;
    try {
      win = new BrowserWindow({
        show: false,
        useContentSize: true,
        width: fit.width,
        height: fit.height,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
          offscreen: true,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
    } catch (error) {
      return { ok: false, error: `离屏窗口创建失败：${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      const contents = win.webContents;
      await new Promise<void>((resolveLoad, rejectLoad) => {
        const timer = setTimeout(() => rejectLoad(new Error("加载导出页超时")), request.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
        contents.once("did-finish-load", () => { clearTimeout(timer); resolveLoad(); });
        contents.once("did-fail-load", (_event, code, description) => {
          clearTimeout(timer);
          rejectLoad(new Error(`加载导出页失败（${code} ${description}）`));
        });
        void contents.loadURL(pathToFileURL(request.htmlPath).href).catch(() => undefined);
      });
      if (fit.zoom !== 1) {
        contents.setZoomFactor(fit.zoom);
        await delay(350);
      }
      // 字体/布局稳定后取帧；离屏偶发首帧为空，invalidate 后重取一次。
      await delay(250);
      let image = await withTimeout(contents.capturePage(), CAPTURE_TIMEOUT_MS, "截图超时");
      if (image.isEmpty()) {
        contents.invalidate();
        await delay(400);
        image = await withTimeout(contents.capturePage(), CAPTURE_TIMEOUT_MS, "截图超时");
      }
      if (image.isEmpty()) return { ok: false, error: "离屏渲染未出帧（capturePage 返回空图）" };
      const sized = image.getSize();
      const thumbnail = sized.width > THUMBNAIL_MAX_WIDTH ? image.resize({ width: THUMBNAIL_MAX_WIDTH }) : image;
      const png = thumbnail.toPNG();
      const savedPath = request.thumbDir
        ? writeGalleryThumbFile(request.thumbDir, request.thumbPrefix ?? "gallery", png)
        : await saveBrowserScreenshot(request.workspace, png.toString("base64"), "image/png", "design");
      const out = thumbnail.getSize();
      return { ok: true, data: png.toString("base64"), width: out.width, height: out.height, mimeType: "image/png", savedPath };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}
