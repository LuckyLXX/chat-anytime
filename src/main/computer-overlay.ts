// Computer-use overlay: a tiny always-on-top, click-through banner shown at
// the bottom-right of the primary work area whenever a computer_* tool is
// about to activate/click/type into a desktop window. The user's focus is on
// the TARGET window (not on ChatAnyTime), so an in-app toast would be
// invisible exactly when it matters — the only effective surface is the
// screen itself. Pure helpers (html construction with escaping, placement
// math) are exported for unit tests; the BrowserWindow half is main-only.

import { BrowserWindow, screen } from "electron";

export interface OverlayPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Overlay size; compact enough to never cover meaningful UI for long. */
export const OVERLAY_SIZE = { width: 300, height: 44 } as const;
export const OVERLAY_MARGIN = 16;
/** Auto-hide delay; a follow-up operation within the window renews it. */
export const OVERLAY_AUTO_HIDE_MS = 2500;

/** Compute the placement at the bottom-right of a work area. */
export function computeOverlayPlacement(workArea: { x: number; y: number; width: number; height: number }): OverlayPlacement {
  return {
    x: workArea.x + workArea.width - OVERLAY_SIZE.width - OVERLAY_MARGIN,
    y: workArea.y + workArea.height - OVERLAY_SIZE.height - OVERLAY_MARGIN,
    width: OVERLAY_SIZE.width,
    height: OVERLAY_SIZE.height
  };
}

/** Escape arbitrary text (window titles) for safe embedding in the overlay HTML. */
export function escapeOverlayText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

/** Build the overlay document. The text node is updated in place later. */
export function buildOverlayHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  .bar {
    box-sizing: border-box; height: 100%; display: flex; align-items: center; gap: 9px;
    padding: 0 14px; border-radius: 10px;
    background: rgba(15, 23, 42, 0.88); color: #f8fafc;
    font: 500 13px/1.2 "Segoe UI", "Microsoft YaHei", sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    white-space: nowrap; overflow: hidden;
  }
  .dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; background: #34d399; animation: pulse 1.1s ease-in-out infinite; }
  .text { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
</head>
<body><div class="bar"><span class="dot"></span><span class="text" id="t"></span></div></body>
</html>`;
}

/**
 * Owns the lazily-created overlay window. `show(text)` places it at the
 * bottom-right of the primary display, updates the label and resets the
 * auto-hide timer; `hide()` hides it immediately (app quit / session end).
 */
export class ComputerOverlayController {
  private win: BrowserWindow | undefined;
  private hideTimer: NodeJS.Timeout | undefined;

  constructor(private readonly autoHideMs: number = OVERLAY_AUTO_HIDE_MS) {}

  show(text: string): void {
    const label = String(text ?? "").trim().slice(0, 120);
    if (!label) return;
    try {
      if (!this.win || this.win.isDestroyed()) {
        this.win = new BrowserWindow({
          ...computeOverlayPlacement(screen.getPrimaryDisplay().workArea),
          frame: false,
          transparent: true,
          resizable: false,
          movable: false,
          focusable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          show: false,
          hasShadow: false,
          webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
        });
        this.win.setIgnoreMouseEvents(true, { forward: false });
        this.win.setAlwaysOnTop(true, "screen-saver");
        this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml())}`);
      }
      const win = this.win;
      win.setBounds(computeOverlayPlacement(screen.getPrimaryDisplay().workArea));
      const apply = (): void => {
        win.webContents.executeJavaScript(`document.getElementById('t').textContent = ${JSON.stringify(escapeOverlayText(label))};`).catch(() => undefined);
        if (!win.isVisible()) win.showInactive();
      };
      if (win.webContents.isLoadingMainFrame()) {
        win.webContents.once("did-finish-load", apply);
      } else {
        apply();
      }
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        if (this.win && !this.win.isDestroyed()) this.win.hide();
      }, this.autoHideMs);
      if (typeof this.hideTimer.unref === "function") this.hideTimer.unref();
    } catch {
      // overlay is cosmetic; never let it break a tool call
    }
  }

  hide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
  }
}
