import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shell, WebContentsView, type BrowserWindow, type Rectangle, type Session } from "electron";
import type { BrowserElementPick, BrowserPreviewBounds, BrowserPreviewCommand, BrowserPreviewState, BrowserTabsEvent } from "../shared/protocol.js";
import { MAX_TAB_DOWNLOADS, sanitizeDownloadName } from "./browser-downloads.js";
import { NAVIGATE_BUDGET_MS, resolveNavigateOutcome, withNavigationBudget } from "./browser-navigate.js";
import { isSeedPhase } from "./browser-preview-seed.js";
import { parseElementPickMessage } from "./browser-preview-pick.js";
import { normalizeBrowserUrl } from "./browser-preview-url.js";

const DEFAULT_TAB_ID = "default";

/** 自动化操作返回前等待「本次触发的下载」落盘的上限。 */
export const DOWNLOAD_SETTLE_TIMEOUT_MS = 3_000;
/** 上述等待的轮询间隔。 */
export const DOWNLOAD_SETTLE_POLL_MS = 25;

/**
 * 预置空白文档的等待上限。空白页是本地即时文档（实测几十毫秒），这个预算只用于
 * 极端情况兜底；超时后照旧发真实导航，不让内部准备阻塞用户操作。
 */
export const SEED_SETTLE_TIMEOUT_MS = 2_000;
/** 预置文档「彻底静下来」的轮询间隔。 */
export const SEED_POLL_MS = 20;

/**
 * 一次下载事件（预览控制器 → 自动化控制器）。
 *
 * `status`：cancelled=已取消；started=已定向落盘但尚未完成（done 事件未到）；
 * saved=已完成落盘；failed=保存中断。回执只渲染终态（started 只用于等 done）。
 */
export interface DownloadInfo {
  tabId: string;
  /** 页面给出的原始文件名；保存路径用的是清洗后的名字。 */
  filename: string;
  url: string;
  status: "cancelled" | "started" | "saved" | "failed";
  /** cancelled/failed 的原因：limit=超出每标签页上限；prepare-failed=目录/路径准备失败。 */
  reason?: "limit" | "prepare-failed";
  /** 触发了每标签页上限（此后本次导航内不再保存下载）。 */
  limitReached?: boolean;
  /** started/saved/failed 时的落盘绝对路径与目录。 */
  filePath?: string;
  directory?: string;
  /** saved 时的字节数。 */
  bytes?: number;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BrowserTabView {
  view: WebContentsView;
  bounds?: Rectangle;
  visible: boolean;
  state: BrowserPreviewState;
  /**
   * 只装过「建标签时预置的空白文档」，尚未发生任何真实导航。为 true 时文档类事件
   * 不写进 state——否则这次内部准备会被当成一次真实导航（面板会显示 attached +
   * about:blank，并把空白页的视口尺寸当成页面内容宽去算缩放）。navigateTab 会把它
   * 置回 false，之后一切照旧。
   */
  seeded?: boolean;
  /**
   * 预置空白文档的完成承诺（resolve 时隔离已结束、它的事件都已派发干净）。
   * navigateTab 必须先等它：否则两次 `loadURL` 会在同一标签上互相抢占（真 Electron
   * 探针实测：被抢占的那次以 ERR_ABORTED 结束，且标签 `getURL()` 会短暂留在旧地址
   * 上），首个导航的回执就会报出上一个地址（about:blank）而显得「地址对不上」。
   */
  seed?: Promise<unknown>;
  /** 内容尺寸量测防抖定时器（resize/zoom 后延迟量测）。 */
  measureTimer?: ReturnType<typeof setTimeout>;
  /** 最近一次量测并已推送的内容尺寸（1px 死带去重）。 */
  measuredContent?: { width: number; height: number };
  /**
   * 渲染端声明的一次性导航意图（作品「运行」）。它不由主进程消费，而是推给
   * 渲染端由 BrowserPreview 在挂载/切回时消费一次（见该组件的 initialUrl effect）。
   */
  meta?: { initialUrl?: string; galleryId?: string };
}

export class BrowserPreviewController {
  private readonly tabs = new Map<string, BrowserTabView>();
  /** 最近一次被置为可见的标签页（用户切到该标签 / AI 首次操作自动绑定的前台标签）。 */
  private lastActivatedTabId = DEFAULT_TAB_ID;
  /** AI operations that just finished: short window where CDP click pick messages may still arrive. */
  private readonly automationEndedAt = new Map<string, number>();
  private readonly downloadGuardSessions = new Set<Session>();
  /** 每个标签页当前导航轮已保存的下载数（导航时重置，防恶意页面刷满磁盘）。 */
  private readonly downloadCounts = new Map<string, number>();
  /** 每个标签页「已定向落盘但 done 未到」的下载 id（操作返回前等它们收敛）。 */
  private readonly downloadStarts = new Map<string, Set<string>>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly publish: (state: BrowserPreviewState, tabId: string) => void,
    /** 标签创建/关闭时的生命周期通知（渲染端同步预览面板用）。 */
    private readonly onTabLifecycle?: (event: BrowserTabsEvent) => void,
    /** 页面 preload 捕获的手动元素选择结果（转发给应用渲染端）。 */
    private readonly onPickResult?: (pick: BrowserElementPick) => void,
    /**
     * 下载策略（按标签页判定）：返回 "cancel" 取消并只报告（预览页默认的安全
     * 姿态）；返回 { dir } 则把下载定向到该目录（自动化会话已绑定该标签页且
     * navigate 过带工作区的目录时）。缺省返回 = cancel；未提供该钩子时全部取消
     * （保持原行为，向后兼容）。
     */
    private readonly downloadPolicy?: (tabId: string) => "cancel" | { dir: string } | undefined,
    /** 下载事件回调（saved 表示是否真的落盘）。自动化控制器据此给模型回执。 */
    private readonly onDownload?: (info: DownloadInfo) => void
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

  /**
   * 等该标签页的预置空白文档落定（每标签页只付一次）。文档类 CDP 命令在一个没有文档
   * 的 renderer 上永不回包（见 createTab 注释），所以任何**要碰页面**的操作都应先过
   * 这一关；纯内存操作（列表/绑定/读标签地址）不应为页面健康买单——它们直接由主进程
   * 状态回答，能立即返回（2026-09-15 事故的直接教训）。
   */
  async ensurePageReady(tabId: string): Promise<void> {
    const wrapper = this.tabs.get(tabId);
    if (!wrapper?.seed) return;
    const seed = wrapper.seed;
    // 先清再等：与 downloadStarts / dialogWatch 同一纪律，已经付过的不重复付。
    wrapper.seed = undefined;
    await Promise.race([seed, sleep(SEED_SETTLE_TIMEOUT_MS + 500)]);
  }

  /**
   * 标签页的 native 视图当前是否真的在渲染（可见 + 已拿到布局矩形）。
   * 截图（Page.captureScreenshot fromSurface）只对在渲染的表面有产出；
   * 隐藏视图（面板关闭/其他标签前台/弹窗挂起）不出帧，截图会悬挂。
   */
  isTabRendered(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    return Boolean(tab && tab.visible && tab.bounds);
  }

  /** 宿主窗口当前能否出帧：最小化/隐藏的窗口会被合成器暂停渲染。 */
  isWindowRenderable(): boolean {
    return !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized();
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
        // 面板尺寸变化会改变页面 CSS 视口（zoom 固定时），延迟重测内容宽。
        this.scheduleContentMeasure(tabId, 300);
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
      case "tab-meta": {
        // 读（不传任何字段）：只回现成的元信息，**绝不 getOrCreate、绝不推送**——
        // BrowserPreview 每次挂载都会读回一次，让它顺带建标签/推状态是纯粹的副作用。
        if (command.initialUrl === undefined && command.galleryId === undefined) {
          const existing = this.tabs.get(tabId);
          if (!existing) break;
          this.updateStateQuietly(tabId, { initialUrl: existing.meta?.initialUrl, galleryId: existing.meta?.galleryId });
          break;
        }
        const tab = this.getOrCreate(tabId);
        const next = { ...tab.meta };
        if (command.initialUrl !== undefined) next.initialUrl = command.initialUrl || undefined;
        if (command.galleryId !== undefined) next.galleryId = command.galleryId || undefined;
        tab.meta = next;
        // 显式 set 才推送（渲染端只消费一次 initialUrl）。每次 set 都重推一帧：
        // 重新发布时即使值恰好相同，也要让新挂载的面板看到它。
        this.updateState(tabId, { initialUrl: next.initialUrl, galleryId: next.galleryId });
        break;
      }
      case "close":
        this.disposeTab(tabId);
        break;
      case "zoom": {
        // 设备视口「适应窗口」：缩小系数让超宽设备布局完整落入 bounds。
        // 非有限值/越界一律回落 1（原始尺寸），渲染端计算错误不放大成页面损坏。
        const factor = Number.isFinite(command.factor) ? Math.min(3, Math.max(0.25, command.factor)) : 1;
        this.tryCommand(tabId, (contents) => {
          if (!contents.isDestroyed()) contents.setZoomFactor(factor);
        });
        // zoom 改变页面 CSS 视口（视口宽 = bounds 宽 / factor），重测内容宽收敛。
        this.scheduleContentMeasure(tabId, 200);
        break;
      }
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

    const wrapper: BrowserTabView = { view, visible: true, state, seeded: true };
    this.tabs.set(tabId, wrapper);

    const contents = view.webContents;
    // 预置一个空文档（2026-09-16）：全新的 renderer 没有任何文档时，CDP 的
    // 文档类命令（Page.enable / Runtime.enable / Runtime.evaluate / DOM.enable /
    // DOM.getDocument / Accessibility.enable）**永不回包**（真 Electron 探针实测），
    // 于是「自动化刚建的标签页上的第一个操作」会挂到看门狗（真实事故：
    // browser_navigate 110 秒超时、面板一直显示空白页）。about:blank 会立刻建出
    // 文档，整个 CDP 面恢复正常（探针：seed 后上述命令全部毫秒级）。
    //
    // seeded 标记让这次内部准备不进 state：否则面板会把「初始空白」当成真实地址，
    // 这正是旧版地址栏伪造 http://localhost:3000 的同类错误。承诺存在 wrapper 上，
    // 供 navigateTab 在发真实导航前等它落定（避免两次导航互相抢占）。
    //
    // 等待口径是「隔离结束」而不是「loadURL resolve」：后者在 did-finish-load 时
    // 就返回，did-stop-loading 可能稍后才到——那一条晚到的事件会在真实导航开始后
    // 被当成真实事件，把加载中指示器提前抹掉。
    wrapper.seed = this.seedBlankDocument(contents);
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
      contents.session.on("will-download", (event, item, webContents) => this.handleDownload(event, item, webContents));
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
    contents.on("did-start-loading", () => { if (this.isSeedPhase(tabId)) return; this.updateState(tabId, { loading: true, error: undefined }); });
    contents.on("did-stop-loading", () => {
      if (this.isSeedPhase(tabId)) return;
      this.refreshState(tabId, { loading: false });
      this.scheduleContentMeasure(tabId, 250);
    });
    contents.on("did-navigate", (_event, url) => { if (this.isSeedPhase(tabId)) return; this.refreshState(tabId, { url, error: undefined }); });
    contents.on("did-navigate-in-page", (_event, url) => { if (this.isSeedPhase(tabId)) return; this.refreshState(tabId, { url, error: undefined }); });
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      if (this.isSeedPhase(tabId)) return;
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

  /**
   * 预置空白文档并等到它彻底静下来（loadURL 落定 + 不再 loading）。
   * 失败/超时都不抛：预置只是为了让 CDP 的文档类命令能回包，目标导航不能被它拖住。
   */
  private async seedBlankDocument(contents: Electron.WebContents): Promise<void> {
    try {
      await contents.loadURL("about:blank");
    } catch {
      // 极罕发：即使本次 loadURL 失败，renderer 通常也已拿到文档；直接交给调用方继续。
      return;
    }
    const deadline = Date.now() + SEED_SETTLE_TIMEOUT_MS;
    while (!contents.isDestroyed() && contents.isLoading() && Date.now() < deadline) {
      await sleep(SEED_POLL_MS);
    }
  }

  /**
   * 该标签页是否仍处于「只有预置空白文档」的阶段（见 BrowserTabView.seeded）。
   * 只抑制空白页自身的加载事件；navigateTab 一开始就把 seeded 置 false，因此真实
   * 导航（包括用户在地址栏里输入触发的）事件一律不受影响。
   */
  private isSeedPhase(tabId: string): boolean {
    const wrapper = this.tabs.get(tabId);
    if (!wrapper) return false;
    const contents = wrapper.view.webContents;
    if (contents.isDestroyed()) return false;
    return isSeedPhase(wrapper.seeded, contents.getURL());
  }

  /** 反查某个 WebContents 属于哪个标签页（下载事件按标签页定策略）。 */
  private tabIdFor(contents: Electron.WebContents): string | undefined {
    for (const [tabId, tab] of this.tabs) {
      if (tab.view.webContents === contents) return tabId;
    }
    return undefined;
  }

  /**
   * 下载守卫：按 session 只注册一次，按标签页决定策略。
   *
   * 实测结论（Electron 43，探针脚本见 docs/迭代记录/2026-09.md 的 2026-09-13 A3 条目）：
   * - `event.preventDefault()` 会让 `item.setSavePath()` **完全失效**（done 事件
   *   直接是 cancelled、不产生任何文件）——取消只能取消，保存只能保存；
   * - 不 preventDefault + setSavePath → done: completed，目录不存在时 Electron
   *   会递归自建；
   * - 第三个参数 webContents 非空且能定位到具体标签页，`item.getFilename()` 拿到的
   *   是 Chromium 反穿越后的名字（`../../../evil.csv` → `_.._.._evil.csv`）。
   */
  private handleDownload(event: Electron.Event, item: Electron.DownloadItem, webContents: Electron.WebContents): void {
    const tabId = webContents && !webContents.isDestroyed() ? this.tabIdFor(webContents) : undefined;
    const filename = item.getFilename();
    const url = item.getURL();
    const policy = tabId ? this.downloadPolicy?.(tabId) : undefined;
    // 预览页（用户自己浏览的标签）默认安全姿态：一个字节都不落盘；但自动化
    // 标签页上的取消必须回执，否则模型会把「点击成功」当成「文件已导出」。
    if (!tabId || !policy || policy === "cancel") {
      item.cancel();
      this.onDownload?.({ tabId: tabId ?? "", filename, url, status: "cancelled" });
      return;
    }
    const planned = (this.downloadCounts.get(tabId) ?? 0) + 1;
    this.downloadCounts.set(tabId, planned);
    if (planned > MAX_TAB_DOWNLOADS) {
      item.cancel();
      this.onDownload?.({ tabId, filename, url, status: "cancelled", reason: "limit", limitReached: true });
      return;
    }
    const safeName = sanitizeDownloadName(filename);
    const filePath = join(policy.dir, safeName);
    try {
      mkdirSync(policy.dir, { recursive: true });
      item.setSavePath(filePath);
    } catch {
      item.cancel();
      this.onDownload?.({ tabId, filename: safeName, url, status: "failed", reason: "prepare-failed" });
      return;
    }
    // 先把「已定向落盘、终态未到」报出去：done 事件要等字节收完（实测 100ms~秒级），
    // 自动化操作会为它多等一拍，从而在回执里给出文件名与大小。
    this.onDownload?.({ tabId, filename: safeName, url, status: "started", filePath, directory: policy.dir });
    const downloadId = `${filePath}#${Date.now()}#${Math.random().toString(36).slice(2, 8)}`;
    const running = this.downloadStarts.get(tabId) ?? new Set<string>();
    running.add(downloadId);
    this.downloadStarts.set(tabId, running);
    item.on("done", (_event, state) => {
      const pending = this.downloadStarts.get(tabId);
      pending?.delete(downloadId);
      if (pending && pending.size === 0) this.downloadStarts.delete(tabId);
      const completed = state === "completed";
      this.onDownload?.({
        tabId,
        filename: safeName,
        url,
        status: completed ? "saved" : "failed",
        ...(completed ? { bytes: item.getReceivedBytes() } : {}),
        filePath,
        directory: policy.dir
      });
    });
  }

  /**
   * 等到该标签页上没有「已落盘但终态未到」的下载（自动化操作返回前调用）。
   * 普通点击不触发下载 → 立即返回；导出类点击最多等一个下载完成的时间，
   * 换来回执里的文件名与大小。
   */
  async awaitDownloadsSettled(tabId: string): Promise<void> {
    const deadline = Date.now() + DOWNLOAD_SETTLE_TIMEOUT_MS;
    while ((this.downloadStarts.get(tabId)?.size ?? 0) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_SETTLE_POLL_MS));
    }
  }

  private async navigateTab(tabId: string, input: string): Promise<void> {
    // 新页面 = 新的下载额度（上限防的是单个恶意页面，不是整轮会话）。
    this.downloadCounts.delete(tabId);
    const url = normalizeBrowserUrl(input);
    const wrapper = this.getOrCreate(tabId);
    // 先等预置空白文档落定（通常 <100ms）——两次 loadURL 在同一标签上互相抢占会让
    // 本次导航被 abort，而回执仍会报出上一个地址（端到端探针实测：首次导航的回执
    // 曾报 about:blank）。等失败也照旧往下走，目标导航不因内部准备而失败。
    await this.ensurePageReady(tabId);
    // 真实导航开始：预置空白阶段结束，文档事件自此正常写进 state。
    wrapper.seeded = false;
    // 新页面内容未知：先清掉旧量测，等 did-stop-loading 后重测。
    wrapper.measuredContent = undefined;
    this.updateState(tabId, { attached: true, url, title: "", loading: true, error: undefined, contentWidth: undefined, contentHeight: undefined });
    // 导航本身可能永不 settle（服务器不结束响应），也可能被上一次导航 abort 掉：
    // 都不该把「浏览器操作超时」或假 ERR_ABORTED 报给模型（见 browser-navigate.ts）。
    const contents = wrapper.view.webContents;
    let timedOut = false;
    let error: string | undefined;
    try {
      await withNavigationBudget(contents.loadURL(url), () => { timedOut = true; });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : "网页加载失败";
    }
    // 单一判定口径：只看 loadURL 的结果 + 标签此刻的真实 URL/加载态。
    const outcome = resolveNavigateOutcome({
      timedOut,
      error,
      targetUrl: url,
      currentUrl: contents.isDestroyed() ? "" : contents.getURL(),
      loading: !contents.isDestroyed() && contents.isLoading()
    });
    if (outcome === "failed") {
      this.refreshState(tabId, { loading: false, url, error: error ?? "网页加载失败" });
      return;
    }
    // done / still-loading 都以真实状态收尾（still-loading 时 loading 保持 true，
    // 工具栏显示可点的「停止加载」按钮，用户能看到它真的还在加载）。
    this.refreshState(tabId, { loading: outcome === "still-loading" });
    // 超时放行时把 loadURL 的承诺留在后台：它稍后 settle（导航完成/被停）时
    // 只是没人听结果，绝不能泄成 unhandled rejection。
  }

  /** 内容尺寸量测防抖：resize 风暴/连续 zoom 只在安静后测一次。 */
  private scheduleContentMeasure(tabId: string, delayMs: number): void {
    const wrapper = this.tabs.get(tabId);
    if (!wrapper) return;
    if (wrapper.measureTimer !== undefined) clearTimeout(wrapper.measureTimer);
    wrapper.measureTimer = setTimeout(() => {
      wrapper.measureTimer = undefined;
      void this.measureContentSize(tabId);
    }, delayMs);
  }

  /**
   * 量测页面 scrollWidth/scrollHeight 并推送（适应窗口按真实内容宽缩放——
   * 多画板导出页远宽于任何设备预设，只按预设宽缩放仍会内部溢出）。
   * executeJavaScript 是特权调用，不受页面 CSP 限制；失败（页面崩溃等）静默。
   */
  private async measureContentSize(tabId: string): Promise<void> {
    const wrapper = this.tabs.get(tabId);
    const contents = wrapper?.view.webContents;
    if (!wrapper || !contents || contents.isDestroyed()) return;
    try {
      const size = await contents.executeJavaScript("(() => { const d = document.documentElement; const b = document.body; return [Math.max(d ? d.scrollWidth : 0, b ? b.scrollWidth : 0), Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0)]; })()", false);
      if (!Array.isArray(size)) return;
      const width = Number(size[0]);
      const height = Number(size[1]);
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height)) return;
      const prev = wrapper.measuredContent;
      if (prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return;
      wrapper.measuredContent = { width, height };
      this.updateState(tabId, { contentWidth: width, contentHeight: height });
    } catch {
      // 渲染进程销毁/页面拒绝执行等——量测不可用，渲染端保持上次值。
    }
  }

  private disposeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      this.publish(emptyBrowserState(), tabId);
      return;
    }
    if (tab.measureTimer !== undefined) clearTimeout(tab.measureTimer);
    this.tabs.delete(tabId);
    this.downloadCounts.delete(tabId);
    this.downloadStarts.delete(tabId);
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

  /**
   * 只改状态、不推送（tab-meta 读路径专用）：元信息镜像本身不是状态变化，
   * 没必要惊醒渲染端；下一次真实推送自然带上它。
   */
  private updateStateQuietly(tabId: string, update: Partial<BrowserPreviewState>): void {
    const wrapper = this.tabs.get(tabId);
    if (!wrapper) return;
    wrapper.state = { ...wrapper.state, ...update };
  }
}