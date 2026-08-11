import { shell, WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import type { BrowserPreviewBounds, BrowserPreviewCommand, BrowserPreviewState } from "../shared/protocol.js";
import { normalizeBrowserUrl } from "./browser-preview-url.js";

const emptyBrowserState = (): BrowserPreviewState => ({
  attached: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false
});

function normalizedBounds(bounds: BrowserPreviewBounds): Rectangle {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every(Number.isFinite)) throw new Error("浏览器预览区域无效");
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  };
}

export class BrowserPreviewController {
  private view?: WebContentsView;
  private bounds?: Rectangle;
  private visible = true;
  private state = emptyBrowserState();

  constructor(
    private readonly window: BrowserWindow,
    private readonly publish: (state: BrowserPreviewState) => void
  ) {}

  snapshot(): BrowserPreviewState {
    return { ...this.state };
  }

  async handle(command: BrowserPreviewCommand): Promise<BrowserPreviewState> {
    switch (command.type) {
      case "bounds":
        this.bounds = normalizedBounds(command.bounds);
        this.layout();
        break;
      case "visible":
        this.visible = command.visible;
        this.layout();
        break;
      case "navigate":
        await this.navigate(command.url);
        break;
      case "back":
        if (this.view?.webContents.navigationHistory.canGoBack()) this.view.webContents.navigationHistory.goBack();
        break;
      case "forward":
        if (this.view?.webContents.navigationHistory.canGoForward()) this.view.webContents.navigationHistory.goForward();
        break;
      case "reload":
        this.view?.webContents.reload();
        break;
      case "stop":
        this.view?.webContents.stop();
        break;
      case "open-external":
        if (this.state.url) await shell.openExternal(normalizeBrowserUrl(this.state.url));
        break;
      case "close":
        this.dispose();
        break;
    }
    return this.snapshot();
  }

  dispose(): void {
    const view = this.view;
    this.view = undefined;
    if (view) {
      view.setVisible(false);
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    this.state = emptyBrowserState();
    this.publishState();
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition: "persist:pidesktop-browser"
      }
    });
    this.view = view;
    view.setBackgroundColor("#ffffff");
    this.window.contentView.addChildView(view);

    const contents = view.webContents;
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.setWindowOpenHandler(({ url }) => {
      void this.navigate(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      try {
        normalizeBrowserUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    contents.on("did-start-loading", () => this.updateState({ loading: true, error: undefined }));
    contents.on("did-stop-loading", () => this.refreshState({ loading: false }));
    contents.on("did-navigate", (_event, url) => this.refreshState({ url, error: undefined }));
    contents.on("did-navigate-in-page", (_event, url) => this.refreshState({ url, error: undefined }));
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      this.updateState({ title });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      this.refreshState({ loading: false, url: validatedURL, error: errorDescription });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.updateState({ loading: false, error: `页面渲染进程已停止：${details.reason}` });
    });
    this.layout();
    return view;
  }

  private async navigate(input: string): Promise<void> {
    const url = normalizeBrowserUrl(input);
    const contents = this.ensureView().webContents;
    this.updateState({ attached: true, url, title: "", loading: true, error: undefined });
    try {
      await contents.loadURL(url);
    } catch (error) {
      this.refreshState({
        loading: false,
        url,
        error: error instanceof Error ? error.message : "网页加载失败"
      });
    }
  }

  private layout(): void {
    if (!this.view) return;
    if (this.bounds) this.view.setBounds(this.bounds);
    this.view.setVisible(this.visible && Boolean(this.bounds));
  }

  private refreshState(update: Partial<BrowserPreviewState> = {}): void {
    const contents = this.view?.webContents;
    this.updateState({
      attached: Boolean(contents),
      url: contents?.getURL() || this.state.url,
      title: contents?.getTitle() || this.state.title,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      ...update
    });
  }

  private updateState(update: Partial<BrowserPreviewState>): void {
    this.state = { ...this.state, ...update };
    this.publishState();
  }

  private publishState(): void {
    this.publish(this.snapshot());
  }
}
