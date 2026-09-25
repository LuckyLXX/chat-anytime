import { Check, Download, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserDownloadPrefs } from "../../../shared/protocol";

/**
 * 浏览器预览的下载设置菜单：显示/更改默认保存位置 + 「每次下载都询问保存位置」开关。
 *
 * 骨架与 BrowserBookmarksMenu 一致（rootRef + open state + 外部 pointerdown /
 * Escape 关闭 + onMenuOpenChange），浏览器预览借该回调在面板打开时临时隐藏
 * native WebContentsView——它悬浮在所有 DOM 之上，会盖住下拉项。
 * 配置的读写由主进程负责（浏览器面板只是入口），因此这里只上报意图。
 */
export function BrowserDownloadMenu({ prefs, onSetPrefs, onMenuOpenChange }: {
  prefs?: BrowserDownloadPrefs;
  onSetPrefs(patch: { ask?: boolean; chooseDir?: boolean }): void;
  onMenuOpenChange?(open: boolean): void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  function toggle(next: boolean): void {
    setOpen(next);
    onMenuOpenChange?.(next);
  }

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) toggle(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        toggle(false);
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  const ask = prefs?.ask !== false;

  return (
    <div className="browser-download-menu" ref={rootRef}>
      <button
        type="button"
        data-control="browser-download-toggle"
        title="下载设置"
        aria-label="下载设置"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => toggle(!open)}
      >
        <Download size={15} />
      </button>
      {open && (
        <div className="browser-download-pop" role="menu" aria-label="下载设置">
          <div className="browser-download-dir" title={prefs?.dir ?? ""}>
            <span>保存位置</span>
            <strong>{prefs?.dir ?? "读取中…"}</strong>
          </div>
          <button type="button" role="menuitem" className="browser-download-choose" onClick={() => onSetPrefs({ chooseDir: true })}>
            <FolderOpen size={14} />
            <span>更改保存位置…</span>
          </button>
          <div className="browser-download-sep" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={ask}
            className="browser-download-ask"
            onClick={() => onSetPrefs({ ask: !ask })}
          >
            <span className={`browser-download-check${ask ? " on" : ""}`} aria-hidden="true">{ask && <Check size={12} />}</span>
            <span>每次下载都询问保存位置</span>
          </button>
        </div>
      )}
    </div>
  );
}
