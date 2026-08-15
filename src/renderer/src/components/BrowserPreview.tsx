import { ArrowLeft, ArrowRight, ExternalLink, Globe2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { BrowserPreviewCommand, BrowserPreviewState } from "../../../shared/protocol";

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

export function BrowserPreview({ suspended = false, tabId = "default" }: { suspended?: boolean; tabId?: string }): ReactNode {
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressFocusedRef = useRef(false);
  const [address, setAddress] = useState(() => storedBrowserAddress(tabId));
  const [state, setState] = useState<BrowserPreviewState>(emptyState);
  const [localError, setLocalError] = useState<string>();

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

  useEffect(() => window.piDesktop.onBrowserPreviewState(tabId, (next) => {
    setState(next);
    if (next.url && !addressFocusedRef.current) setAddress(next.url);
  }), [tabId]);

  useEffect(() => {
    void send({ type: "visible", visible: !suspended });
  }, [suspended]);

  useLayoutEffect(() => () => {
    // Deactivation (tab switch, panel collapse) must NOT destroy the loaded
    // page: hide the native view instead, so switching back restores it
    // instantly. Real tab removal is closed explicitly by the preview owner.
    void window.piDesktop.browserPreview({ type: "visible", visible: false, tabId });
  }, [tabId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const updateBounds = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = viewport.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        void send({
          type: "bounds",
          bounds: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }
        });
      });
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(viewport);
    window.addEventListener("resize", updateBounds);
    updateBounds();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, []);

  const error = localError ?? state.error;
  return (
    <div className="browser-preview">
      <form className="browser-preview-toolbar" onSubmit={(event) => void navigate(event)}>
        <button type="button" title="后退" aria-label="后退" disabled={!state.canGoBack} onClick={() => void send({ type: "back" })}><ArrowLeft size={15} /></button>
        <button type="button" title="前进" aria-label="前进" disabled={!state.canGoForward} onClick={() => void send({ type: "forward" })}><ArrowRight size={15} /></button>
        <button type="button" title={state.loading ? "停止加载" : "刷新"} aria-label={state.loading ? "停止加载" : "刷新"} disabled={!state.attached} onClick={() => void send({ type: state.loading ? "stop" : "reload" })}>{state.loading ? <X size={15} /> : <RefreshCw size={15} />}</button>
        <label className="browser-address"><Globe2 size={14} /><input value={address} aria-label="浏览器地址" placeholder="输入网址" spellCheck={false} onFocus={() => { addressFocusedRef.current = true; }} onBlur={() => { addressFocusedRef.current = false; }} onChange={(event) => setAddress(event.target.value)} /></label>
        <button type="button" title="在系统浏览器中打开" aria-label="在系统浏览器中打开" disabled={!state.url} onClick={() => void send({ type: "open-external" })}><ExternalLink size={15} /></button>
      </form>
      <div className="browser-preview-viewport" ref={viewportRef}>
        {!state.attached && <div className={`browser-preview-empty${error ? " error" : ""}`}>{state.loading ? <LoaderCircle className="spinning" size={24} /> : <Globe2 size={28} />}<strong>{error ?? "新标签页"}</strong></div>}
      </div>
    </div>
  );
}
