import { AlertCircle, ArrowLeft, ArrowRight, Crosshair, Download, ExternalLink, Globe2, Info, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { BrowserElementPick, BrowserPreviewBounds, BrowserPreviewCommand, BrowserPreviewState } from "../../../shared/protocol";
import { layoutDeviceFrame, storedPreviewDevice, storedPreviewFit, storePreviewDevice, storePreviewFit, type PreviewDeviceId } from "../lib/preview-device";
import { saveBrowserAddress, storedBrowserAddress } from "../lib/browser-address";
import { BrowserBookmarksMenu } from "./BrowserBookmarksMenu";
import { BrowserDownloadMenu } from "./BrowserDownloadMenu";
import { PreviewDeviceMenu } from "./PreviewDeviceMenu";

/** 下载卡片上的大小文案（与 SSH 文件面板同口径：整数 + 单位）。 */
function formatDownloadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 0; index < units.length; index += 1) {
    if (value < 1024 || index === units.length - 1) {
      unit = units[index]!;
      break;
    }
    value /= 1024;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

const emptyState: BrowserPreviewState = {
  attached: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false
};

interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function BrowserPreview({ suspended = false, tabId = "default", onPickSend, onStateChange }: { suspended?: boolean; tabId?: string; onPickSend?: (pick: BrowserElementPick, note: string) => void; onStateChange?: (state: BrowserPreviewState) => void }): ReactNode {
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressFocusedRef = useRef(false);
  const lastZoomRef = useRef(1);
  const [address, setAddress] = useState(() => storedBrowserAddress(tabId));
  const [state, setState] = useState<BrowserPreviewState>(emptyState);
  const [localError, setLocalError] = useState<string>();
  const [pickMode, setPickMode] = useState(false);
  // 设备视口：responsive=填满面板（原行为）；设备预设=固定宽度框，超宽时靠
  // zoom factor 等比缩小，「原始尺寸」则 1:1 封顶容器宽。
  const [device, setDevice] = useState<PreviewDeviceId>(() => storedPreviewDevice());
  const [fit, setFit] = useState(() => storedPreviewFit());
  const [viewportRect, setViewportRect] = useState<ViewportRect>();
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [bookmarksMenuOpen, setBookmarksMenuOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  /** 已被本地计时隐藏的提示时刻（主进程不会为「隐藏」再发一帧）。 */
  const [hiddenNoticeAt, setHiddenNoticeAt] = useState<number>();
  /** 决策卡片倒计时的重渲触发器（只有卡片存在时才跑）。 */
  const [, setTick] = useState(0);

  async function send(command: BrowserPreviewCommand): Promise<BrowserPreviewState | undefined> {
    const payload: BrowserPreviewCommand = { ...command, tabId };
    try {
      const next = await window.piDesktop.browserPreview(payload);
      setState(next);
      setLocalError(undefined);
      return next;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "浏览器操作失败");
      return undefined;
    }
  }

  async function navigate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await navigateTo(address);
  }

  // 导航的唯一实现：地址栏表单提交与书签点击共用（成功后同步地址栏与该标签页
  // 的记忆地址）。
  async function navigateTo(url: string): Promise<void> {
    const next = await send({ type: "navigate", url });
    if (!next?.url) return;
    setAddress(next.url);
    saveBrowserAddress(tabId, next.url);
  }

  async function cancelAutomation(): Promise<void> {
    try {
      await window.piDesktop.browserAutomationCancel(tabId);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "取消浏览器操作失败");
    }
  }

  function togglePickMode(): void {
    const next = !pickMode;
    setPickMode(next);
    void send({ type: "pick-mode", enabled: next });
  }

  function changeDevice(id: PreviewDeviceId): void {
    setDevice(id);
    storePreviewDevice(id);
  }

  function changeFit(next: boolean): void {
    setFit(next);
    storePreviewFit(next);
  }

  /** 人工下载决策（保存 / 另存为… / 取消）——落盘与搬移全在主进程。 */
  async function decideDownload(id: string, action: "save" | "save-as" | "cancel"): Promise<void> {
    await send({ type: "download-decision", id, action });
  }

  function setDownloadPrefs(patch: { ask?: boolean; chooseDir?: boolean }): void {
    void send({ type: "download-prefs-set", ...patch });
  }

  function toggleDownloadMenu(open: boolean): void {
    setDownloadMenuOpen(open);
    // 打开时读回真值：配置由主进程持有（设置页保存不会覆盖它）。
    if (open) void send({ type: "download-prefs" });
  }

  useEffect(() => window.piDesktop.onBrowserPreviewState(tabId, (next) => {
    setState(next);
    if (next.url && !addressFocusedRef.current) setAddress(next.url);
      onStateChange?.(next);
  }), [tabId]);

  // 手动元素选择结果（页面 preload 的就地输入卡确认后 → main 转发，note 已随行）：
  // 直接交给上层写入聊天输入框——渲染端不再有自己的确认卡片。
  useEffect(() => window.piDesktop.onBrowserElementPicked((next) => {
    if (next.tabId !== tabId) return;
    setPickMode(false);
    onPickSend?.(next, next.note ?? "");
  }), [tabId, onPickSend]);

  // Browser→browser tab switches reuse this component instance (only tabId
  // changes): reset the stale address/state of the previous tab until the
  // controller pushes the new tab's snapshot.
  useEffect(() => {
    setState(emptyState);
    setLocalError(undefined);
    setAddress(storedBrowserAddress(tabId));
    setPickMode(false);
  }, [tabId]);

  // 作品「运行」的一次性导航：主进程通过 tab-meta 下达 initialUrl，本组件负责
  // 消费一次。这里**主动读回**（而不是从 state 推送上读）以免与上面的 tabId 重置
  // effect 竞争（同一 commit 内第二 effect 看到的还是上一帧的 state）。
  // sessionStorage 标记保证切标签/折叠面板/重渲染都不会重复导航，也不会把用户
  // 后来的手动导航冲掉。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snapshot = await send({ type: "tab-meta" });
      const target = snapshot?.initialUrl;
      if (!target || cancelled) return;
      const key = `pidesktop.gallery-started-${tabId}`;
      try {
        if (window.sessionStorage.getItem(key) === target) return;
        window.sessionStorage.setItem(key, target);
      } catch {
        // 演示环境等 storage 不可用：宁可重复一次也不卡死
      }
      const next = await send({ type: "navigate", url: target });
      if (next?.url) {
        setAddress(next.url);
        saveBrowserAddress(tabId, next.url);
      }
    })();
    return () => { cancelled = true; };
    // send 是每次渲染重建的局部函数：依赖它会让 effect 每渲染都跑；只依赖 tabId，
    // 消费标记已保证幂等（重新发布时新挂载的面板会重新读回新值）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useEffect(() => {
    void send({ type: "visible", visible: !suspended && !deviceMenuOpen && !bookmarksMenuOpen && !downloadMenuOpen });
    // 面板挂起（切到其他标签/面板收起）时退出选择模式，避免用户回来时误点；
    // pick-mode off 同时会让页面内已打开的就地输入卡关闭。设备/书签/下载菜单张开时
    // 也临时隐藏 native 视图——它悬浮在所有 DOM 之上，会盖住下拉项。
    if (suspended) {
      setPickMode(false);
      void window.piDesktop.browserPreview({ type: "pick-mode", enabled: false, tabId });
    }
  }, [suspended, tabId, deviceMenuOpen, bookmarksMenuOpen, downloadMenuOpen]);

  // 决策卡片的倒计时：只在有卡片时跑（每秒重渲一次，无卡片时零成本）。
  useEffect(() => {
    if (!state.pendingDownloads?.length) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [state.pendingDownloads?.[0]?.id]);

  // 一次性提示（已保存到…/另存为失败…）4 秒后本地隐藏。
  useEffect(() => {
    const notice = state.downloadNotice;
    if (!notice) return;
    const timer = window.setTimeout(() => setHiddenNoticeAt(notice.at), 4000);
    return () => window.clearTimeout(timer);
  }, [state.downloadNotice?.at]);

  useLayoutEffect(() => () => {
    // Deactivation (tab switch, panel collapse) must NOT destroy the loaded
    // page: hide the native view instead, so switching back restores it
    // instantly. Real tab removal is closed explicitly by the preview owner.
    void window.piDesktop.browserPreview({ type: "visible", visible: false, tabId });
    void window.piDesktop.browserPreview({ type: "pick-mode", enabled: false, tabId });
  }, [tabId]);

  // 量测视口矩形（含窗口内位置）：设备框布局与 bounds 上报都从它推导。
  //
  // ⚠️ 首帧量测必须**同步**做，不能只挂在 requestAnimationFrame 上：主窗口被别的应用
  // 完全遮挡或最小化时页面是 hidden，**rAF 与 ResizeObserver 回调都不会再触发**
  //（2026-09-24 真机探针 p6 实测：hidden 时 rAF 3 秒不落、RO 只回 stall），而布局仍可
  // 强制计算（同探针：隐藏页 getBoundingClientRect 照常返回真实尺寸）。首帧若走 rAF，
  // 面板打开后永远不会回送 bounds，AI 的 browser_screenshot 会一直卡在「标签页未能变为
  // 可见」8 秒超时；后续尺寸变化（拖分隔条 / 切设备框）仍走 rAF 节流路径。
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    let retryTimer = 0;
    let retries = 0;
    let cancelled = false;
    const commit = (bounds: DOMRect): boolean => {
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      setViewportRect((prev) => prev && prev.left === bounds.left && prev.top === bounds.top && prev.width === bounds.width && prev.height === bounds.height ? prev : { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
      return true;
    };
    // 尺寸还没落定时（面板入场首帧）用 setTimeout 补几次：定时器在隐藏页里仍会跑（会被
    // 节流到 ~1s，但不会像 rAF 那样完全停摆），所以这也是遮挡/最小化下的兜底。
    const measureNow = (): void => {
      if (cancelled) return;
      if (commit(viewport.getBoundingClientRect())) return;
      if (retries >= 5) return;
      retries += 1;
      retryTimer = window.setTimeout(measureNow, 120);
    };
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => commit(viewport.getBoundingClientRect()));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    window.addEventListener("resize", measure);
    measureNow();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(retryTimer);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tabId]);

  const layout = useMemo(
    () => (viewportRect ? layoutDeviceFrame(viewportRect, device, { fit, clampWidth: true, contentWidth: state.contentWidth }) : undefined),
    [viewportRect, device, fit, state.contentWidth]
  );

  // zoom 换新视图时从 1 重新起步（先于下方 effects 执行），老标签的缩放值不串台。
  useLayoutEffect(() => {
    lastZoomRef.current = 1;
  }, [tabId]);

  // 设备框变化 → 上报 frame 矩形为 native 视图 bounds（先建/定位），再套
  // 缩放系数（适应窗口按实测内容宽把超宽页面整体缩小）。量测推送驱动的
  // 重算带 0.2% 死带，配合主进程 1px 量测死带，收敛不振荡。
  useLayoutEffect(() => {
    if (!layout || !viewportRect) return;
    const bounds: BrowserPreviewBounds = {
      x: viewportRect.left + layout.offsetX,
      y: viewportRect.top,
      width: layout.frameWidth,
      height: layout.frameHeight
    };
    void send({ type: "bounds", bounds });
    if (Math.abs(layout.scale - lastZoomRef.current) > 0.002) {
      lastZoomRef.current = layout.scale;
      void send({ type: "zoom", factor: layout.scale });
    }
    // layout/viewportRect 均由 useMemo/量测节流保证值不变时引用稳定。
  }, [layout, viewportRect, tabId]);

  const error = localError ?? state.error;
  const pendingDownloads = state.pendingDownloads ?? [];
  const pending = pendingDownloads[0];
  const notice = state.downloadNotice && state.downloadNotice.at !== hiddenNoticeAt ? state.downloadNotice : undefined;
  const secondsLeft = pending ? Math.max(0, Math.ceil((pending.deadlineAt - Date.now()) / 1000)) : 0;
  const showDeviceFrame = device !== "responsive" && layout !== undefined && layout.offsetX > 0;
  return (
    <div className="browser-preview">
      {/* 横幅统一收进一个容器：grid 的行定义只需认容器，多条横幅（AI 操作中 /
          选择元素 / 下载提示 / 下载决策）同时存在也不会把工具栏挤到隐式行上。 */}
      {(state.automating !== undefined || pickMode || notice !== undefined || pending !== undefined) && (
        <div className="browser-preview-banners">
      {state.automating && (
        <div className="browser-automating-banner" role="status" aria-live="polite">
          <LoaderCircle className="spinning" size={14} />
          <span>AI 正在操作浏览器：{state.automating}</span><button type="button" className="browser-automating-cancel" title="取消本次浏览器操作" aria-label="取消本次浏览器操作" onClick={() => void cancelAutomation()}><X size={13} />取消</button>
        </div>
      )}
      {pickMode && (
        <div className="browser-pick-hint" role="status">
          <Crosshair size={13} />
          <span>点击页面中的元素以选取，或再次点击工具栏按钮取消</span>
        </div>
      )}
      {notice && (
        <div className={`browser-download-notice${notice.tone === "error" ? " error" : ""}`} role="status" aria-live="polite">
          {notice.tone === "error" ? <AlertCircle size={13} /> : <Info size={13} />}
          <span title={notice.text}>{notice.text}</span>
        </div>
      )}
      {pending && (
        <div className="browser-download-prompt" role="dialog" aria-label="保存下载文件">
          <div className="browser-download-head">
            <Download size={14} />
            <span className="browser-download-copy">
              <strong title={pending.filename}>{pending.filename}</strong>
              <small title={pending.filePath}>
                {[
                  pending.source ? `来自 ${pending.source}` : "",
                  pending.totalBytes ? formatDownloadSize(pending.totalBytes) : "",
                  pending.downloaded ? "已下载完成" : "下载中",
                  `保存到 ${pending.directory}`
                ].filter(Boolean).join(" · ")}
              </small>
            </span>
            {pendingDownloads.length > 1 && <em className="browser-download-count">另有 {pendingDownloads.length - 1} 个待处理</em>}
          </div>
          <div className="browser-download-actions">
            <button type="button" className="primary" onClick={() => void decideDownload(pending.id, "save")}>保存</button>
            <button type="button" onClick={() => void decideDownload(pending.id, "save-as")}>另存为…</button>
            <button type="button" onClick={() => void decideDownload(pending.id, "cancel")}>取消</button>
            <em className="browser-download-timer">{secondsLeft} 秒后自动保存</em>
          </div>
        </div>
      )}
        </div>
      )}
      <form className="browser-preview-toolbar" onSubmit={(event) => void navigate(event)}>
        <button type="button" title="后退" aria-label="后退" disabled={!state.canGoBack} onClick={() => void send({ type: "back" })}><ArrowLeft size={15} /></button>
        <button type="button" title="前进" aria-label="前进" disabled={!state.canGoForward} onClick={() => void send({ type: "forward" })}><ArrowRight size={15} /></button>
        <button type="button" title={state.loading ? "停止加载" : "刷新"} aria-label={state.loading ? "停止加载" : "刷新"} disabled={!state.attached} onClick={() => void send({ type: state.loading ? "stop" : "reload" })}>{state.loading ? <X size={15} /> : <RefreshCw size={15} />}</button>
        <PreviewDeviceMenu device={device} fit={fit} scalePercent={(layout?.scale ?? 1) * 100} onDeviceChange={changeDevice} onFitChange={changeFit} onMenuOpenChange={setDeviceMenuOpen} />
        <label className="browser-address"><Globe2 size={14} /><input value={address} aria-label="浏览器地址" placeholder="输入网址，或用 browser_navigate 让 AI 打开页面" spellCheck={false} onFocus={() => { addressFocusedRef.current = true; }} onBlur={() => { addressFocusedRef.current = false; }} onChange={(event) => setAddress(event.target.value)} /></label>
        <BrowserBookmarksMenu currentUrl={state.url} currentTitle={state.title} onNavigate={(url) => void navigateTo(url)} onMenuOpenChange={setBookmarksMenuOpen} />
        <BrowserDownloadMenu prefs={state.downloadPrefs} onSetPrefs={setDownloadPrefs} onMenuOpenChange={toggleDownloadMenu} />
        <button type="button" className={pickMode ? "active" : ""} data-control="browser-pick" title={pickMode ? "取消元素选择" : "选择页面元素（可发送到聊天框）"} aria-label={pickMode ? "取消元素选择" : "选择页面元素"} aria-pressed={pickMode} disabled={!state.attached} onClick={togglePickMode}><Crosshair size={15} /></button>
        <button type="button" title="在系统浏览器中打开" aria-label="在系统浏览器中打开" disabled={!state.url} onClick={() => void send({ type: "open-external" })}><ExternalLink size={15} /></button>
      </form>
        {state.attached && error && (
          <div className="browser-preview-error" role="alert">
            <AlertCircle size={14} />
            <span>{error}</span>
            <button type="button" onClick={() => void send({ type: "reload" })}>重试</button>
          </div>
        )}
      <div className={`browser-preview-viewport${showDeviceFrame ? " letterboxed" : ""}`} ref={viewportRef}>
          {suspended && state.attached && !error && <div className="browser-preview-empty"><LoaderCircle className="spinning" size={24} /><strong>浏览器预览已临时暂停</strong></div>}
        {!state.attached && <div className={`browser-preview-empty${error ? " error" : ""}`}>{state.loading ? <LoaderCircle className="spinning" size={24} /> : <Globe2 size={28} />}<strong>{error ?? "新标签页"}</strong></div>}
        {showDeviceFrame && layout && <div className="browser-device-frame" style={{ left: layout.offsetX, width: layout.frameWidth, height: layout.frameHeight }} aria-hidden="true" />}
      </div>
    </div>
  );
}
