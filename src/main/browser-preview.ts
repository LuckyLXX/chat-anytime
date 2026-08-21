import { join } from "node:path";
import { shell, WebContentsView, type BrowserWindow, type Rectangle, type Session } from "electron";
import type { BrowserElementPick, BrowserPreviewBounds, BrowserPreviewCommand, BrowserPreviewState, BrowserTabsEvent } from "../shared/protocol.js";
import { parseElementPickMessage } from "./browser-preview-pick.js";
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
  /** 最近一次被置为可见的标签页（用户切到该标签 / AI 首次操作自动绑定的前台标签）。 */
  private lastActivatedTabId = DEFAULT_TAB_ID;
  /** AI operations that just finished: short window where CDP click pick messages may still arrive. */
  private readonly automationEndedAt = new Map<string, number>();
  private readonly downloadGuardSessions = new Set<Session>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly publish: (state: BrowserPreviewState, tabId: string) => void,
    /** 标签创建/关闭时的生命周期通知（渲染端同步预览面板用）。 */
    private readonly onTabLifecycle?: (event: BrowserTabsEvent) => void,
    /** 页面 preload 捕获的手动元素选择结果（转发给应用渲染端）。 */
    private readonly onPickResult?: (pick: BrowserElementPick) => void
  ) {}

  snapshot(tabId: string): BrowserPreviewState {
    return this.tabs.get(tabId)?.state ?? emptyBrowserState();
  }

  /** 现有标签页 id 列表（不新建）。 */
  tabIds(): string[] {
    return Array.from(this.tabs.keys());
  }

  /** 供浏览器自动化复用标签页的 WebContents；不存在时返回 undefined。 */
  webContentsFor(tabId: string): Electron.WebContents | undefined {
    const tab = this.tabs.get(tabId);
    return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : undefined;
  }

  /** 取或创建标签页（自动化开新标签用；创建时广播 created 事件）。 */
  ensureTab(tabId: string): BrowserTabView {
    const existed = this.tabs.has(tabId);
    const tab = this.getOrCreate(tabId);
    if (!existed) this.onTabLifecycle?.({ action: "created", tabId, url: "" });
    return tab;
  }

  /** 最近前台标签页 id；无标签时返回默认 id。 */
  foregroundTab(): string {
    return this.tabs.has(this.lastActivatedTabId) ? this.lastActivatedTabId : DEFAULT_TAB_ID;
  }

  /** 标记/清除某标签页上的 AI 操作指示（渲染端横幅）。 */
  setAutomating(tabId: string, description: string | undefined): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const automating = description?.trim() || undefined;
    if (!automating && tab.state.automating) this.automationEndedAt.set(tabId, Date.now());
    if (tab.state.automating === automating) return;
    this.updateState(tabId, { automating });
  }

  /** Whether a pick-result is too close to an AI input dispatch to be trusted as a human pick. */
  private isRecentAutomationPick(tabId: string): boolean {
    const endedAt = this.automationEndedAt.get(tabId);
    return endedAt !== undefined && Date.now() - endedAt <= 250;
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
        if (command.visible) this.lastActivatedTabId = tabId;
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
      case "pick-mode":
        this.tryCommand(tabId, (contents) => {
          if (!contents.isDestroyed()) contents.send("browser-preview:pick-mode", command.enabled);
        });
        break;
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
        partition: "persist:pidesktop-browser",
        // 手动元素选择桥：hover 高亮 + 点击捕获，结果经 ipc-message 回传。
        preload: join(__dirname, "../preload/browser-pick.cjs")
      }
    });
    view.setBackgroundColor("#ffffff");
    this.window.contentView.addChildView(view);

    const wrapper: BrowserTabView = { view, visible: true, state };
    this.tabs.set(tabId, wrapper);

    const contents = view.webContents;
    contents.on("ipc-message", (_event, channel, payload) => {
      if (channel !== "browser-preview:pick-result") return;
      // CDP 合成输入在 Electron 里同样是 isTrusted（页面侧无法区分），AI 正在
      // 操作该标签页时的 pick-result 一律视为 AI 点击，不当作用户手选。
      if (this.tabs.get(tabId)?.state.automating || this.isRecentAutomationPick(tabId)) return;
      const message = parseElementPickMessage(payload, contents.getURL() || "");
      if (!message) return;
      this.onPickResult?.({ tabId, ...message });
    });
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      if (!this.downloadGuardSessions.has(contents.session)) {
        this.downloadGuardSessions.add(contents.session);
        contents.session.on("will-download", (_event, item) => item.cancel());
      }
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
    this.onTabLifecycle?.({ action: "closed", tabId });
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