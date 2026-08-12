import { shell, WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import type { BrowserPreviewBounds, BrowserPreviewCommand, BrowserPreviewState } from "../shared/protocol.js";
import { normalizeBrowserUrl } from "./browser-preview-url.js";

const DEFAULT_TAB_ID = "default";

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

interface BrowserTabView {
  view: WebContentsView;
  bounds?: Rectangle;
  visible: boolean;
  state: BrowserPreviewState;
}

export class BrowserPreviewController {
  private readonly tabs = new Map<string, BrowserTabView>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly publish: (state: BrowserPreviewState, tabId: string) => void
  ) {}

  snapshot(tabId: string): BrowserPreviewState {
    return this.tabs.get(tabId)?.state ?? emptyBrowserState();
  }

  async handle(command: BrowserPreviewCommand): Promise<BrowserPreviewState> {
    const tabId = command.tabId ?? DEFAULT_TAB_ID;
    switch (command.type) {
      case "bounds":
        this.getOrCreate(tabId).bounds = normalizedBounds(command.bounds);
        this.layoutTab(tabId);
        break;
      case "visible":
        this.getOrCreate(tabId).visible = command.visible;
        this.layoutTab(tabId);
        break;
      case "navigate":
        await this.navigateTab(tabId, command.url);
        break;
      case "back":
        this.tryCommand(tabId, (contents) => { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); });
        break;
      case "forward":
        this.tryCommand(tabId, (contents) => { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); });
        break;
      case "reload":
        this.tryCommand(tabId, (contents) => contents.reload());
        break;
      case "stop":
        this.tryCommand(tabId, (contents) => contents.stop());
        break;
      case "open-external": {
        const state = this.tabs.get(tabId)?.state;
        if (state?.url) await shell.openExternal(normalizeBrowserUrl(state.url));
        break;
      }
      case "close":
        this.disposeTab(tabId);
        break;
    }
    return this.snapshot(tabId);
  }

  dispose(): void {
    for (const tabId of Array.from(this.tabs.keys())) {
      this.disposeTab(tabId);
    }
  }

  private getOrCreate(tabId: string): BrowserTabView {
    let tab = this.tabs.get(tabId);
    if (tab) return tab;
    tab = this.createTab(tabId);
    return tab;
  }

  private createTab(tabId: string): BrowserTabView {
    const state = emptyBrowserState();
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
    view.setBackgroundColor("#ffffff");
    this.window.contentView.addChildView(view);

    const wrapper: BrowserTabView = { view, visible: true, state };
    this.tabs.set(tabId, wrapper);

    const contents = view.webContents;
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.setWindowOpenHandler(({ url }) => {
      void this.navigateTab(tabId, url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      try {
        normalizeBrowserUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    contents.on("did-start-loading", () => this.updateState(tabId, { loading: true, error: undefined }));
    contents.on("did-stop-loading", () => this.refreshState(tabId, { loading: false }));
    contents.on("did-navigate", (_event, url) => this.refreshState(tabId, { url, error: undefined }));
    contents.on("did-navigate-in-page", (_event, url) => this.refreshState(tabId, { url, error: undefined }));
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      this.updateState(tabId, { title });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      this.refreshState(tabId, { loading: false, url: validatedURL, error: errorDescription });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.updateState(tabId, { loading: false, error: `页面渲染进程已停止：${details.reason}` });
    });
    this.layoutTab(tabId);
    return wrapper;
  }

  private async navigateTab(tabId: string, input: string): Promise<void> {
    const url = normalizeBrowserUrl(input);
    const wrapper = this.getOrCreate(tabId);
    this.updateState(tabId, { attached: true, url, title: "", loading: true, error: undefined });
    try {
      await wrapper.view.webContents.loadURL(url);
    } catch (error) {
      this.refreshState(tabId, {
        loading: false,
        url,
        error: error instanceof Error ? error.message : "网页加载失败"
      });
    }
  }

  private disposeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      this.publish(emptyBrowserState(), tabId);
      return;
    }
    this.tabs.delete(tabId);
    const { view } = tab;
    view.setVisible(false);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    this.publish(emptyBrowserState(), tabId);
  }

  private tryCommand(tabId: string, fn: (contents: Electron.WebContents) => void): void {
    const wrapper = this.tabs.get(tabId);
    const contents = wrapper?.view.webContents;
    if (contents) fn(contents);
  }

  private layoutTab(tabId: string): void {
    const wrapper = this.tabs.get(tabId);
    if (!wrapper) return;
    if (wrapper.bounds) wrapper.view.setBounds(wrapper.bounds);
    wrapper.view.setVisible(wrapper.visible && Boolean(wrapper.bounds));
  }

  private refreshState(tabId: string, update: Partial<BrowserPreviewState> = {}): void {
    const wrapper = this.tabs.get(tabId);
    if (!wrapper) return;
    const contents = wrapper.view.webContents;
    this.updateState(tabId, {
      attached: Boolean(contents && !contents.isDestroyed()),
      url: contents?.getURL() || wrapper.state.url,
      title: contents?.getTitle() || wrapper.state.title,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      ...update
    });
  }

  private updateState(tabId: string, update: Partial<BrowserPreviewState>): void {
    const wrapper = this.tabs.get(tabId);
    if (!wrapper) return;
    wrapper.state = { ...wrapper.state, ...update };
    this.publish(wrapper.state, tabId);
  }
}