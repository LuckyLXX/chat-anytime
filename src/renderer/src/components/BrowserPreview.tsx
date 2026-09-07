import { AlertCircle, ArrowLeft, ArrowRight, Crosshair, ExternalLink, Globe2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { BrowserElementPick, BrowserPreviewBounds, BrowserPreviewCommand, BrowserPreviewState } from "../../../shared/protocol";
import { layoutDeviceFrame, storedPreviewDevice, storedPreviewFit, storePreviewDevice, storePreviewFit, type PreviewDeviceId } from "../lib/preview-device";
import { PreviewDeviceMenu } from "./PreviewDeviceMenu";

const emptyState: BrowserPreviewState = {
  attached: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false
};

function addressStorageKey(tabId: string): string {
  return `pidesktop.browser-preview-url-${tabId}`;
}

function storedBrowserAddress(tabId: string): string {
  try {
    return window.localStorage.getItem(addressStorageKey(tabId)) ?? "http://localhost:3000";
  } catch {
    return "http://localhost:3000";
  }
}

function saveBrowserAddress(tabId: string, address: string): void {
  try { window.localStorage.setItem(addressStorageKey(tabId), address); } catch { /* storage may be unavailable in browser demo */ }
}

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
    const next = await send({ type: "navigate", url: address });
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

  useEffect(() => {
    void send({ type: "visible", visible: !suspended && !deviceMenuOpen });
    // 面板挂起（切到其他标签/面板收起）时退出选择模式，避免用户回来时误点；
    // pick-mode off 同时会让页面内已打开的就地输入卡关闭。设备菜单张开时
    // 也临时隐藏 native 视图——它悬浮在所有 DOM 之上，会盖住下拉项。
    if (suspended) {
      setPickMode(false);
      void window.piDesktop.browserPreview({ type: "pick-mode", enabled: false, tabId });
    }
  }, [suspended, tabId, deviceMenuOpen]);

  useLayoutEffect(() => () => {
    // Deactivation (tab switch, panel collapse) must NOT destroy the loaded
    // page: hide the native view instead, so switching back restores it
    // instantly. Real tab removal is closed explicitly by the preview owner.
    void window.piDesktop.browserPreview({ type: "visible", visible: false, tabId });
    void window.piDesktop.browserPreview({ type: "pick-mode", enabled: false, tabId });
  }, [tabId]);

  // 量测视口矩形（含窗口内位置）：设备框布局与 bounds 上报都从它推导。
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = viewport.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        setViewportRect((prev) => prev && prev.left === bounds.left && prev.top === bounds.top && prev.width === bounds.width && prev.height === bounds.height ? prev : { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
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
  const showDeviceFrame = device !== "responsive" && layout !== undefined && layout.offsetX > 0;
  return (
    <div className="browser-preview">
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
      <form className="browser-preview-toolbar" onSubmit={(event) => void navigate(event)}>
        <button type="button" title="后退" aria-label="后退" disabled={!state.canGoBack} onClick={() => void send({ type: "back" })}><ArrowLeft size={15} /></button>
        <button type="button" title="前进" aria-label="前进" disabled={!state.canGoForward} onClick={() => void send({ type: "forward" })}><ArrowRight size={15} /></button>
        <button type="button" title={state.loading ? "停止加载" : "刷新"} aria-label={state.loading ? "停止加载" : "刷新"} disabled={!state.attached} onClick={() => void send({ type: state.loading ? "stop" : "reload" })}>{state.loading ? <X size={15} /> : <RefreshCw size={15} />}</button>
        <PreviewDeviceMenu device={device} fit={fit} scalePercent={(layout?.scale ?? 1) * 100} onDeviceChange={changeDevice} onFitChange={changeFit} onMenuOpenChange={setDeviceMenuOpen} />
        <label className="browser-address"><Globe2 size={14} /><input value={address} aria-label="浏览器地址" placeholder="输入网址" spellCheck={false} onFocus={() => { addressFocusedRef.current = true; }} onBlur={() => { addressFocusedRef.current = false; }} onChange={(event) => setAddress(event.target.value)} /></label>
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
