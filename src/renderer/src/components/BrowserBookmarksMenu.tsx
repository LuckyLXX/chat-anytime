import { Star, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { addBrowserBookmark, bookmarkGlyph, bookmarkHost, removeBrowserBookmark, storedBrowserBookmarks, type BrowserBookmark } from "../lib/browser-bookmarks";

/**
 * 浏览器预览书签菜单：首项为「收藏/取消收藏当前页」，其下为书签列表（点击导航、
 * hover 显现删除）。骨架与 PreviewDeviceMenu 一致（rootRef + open state + 外部
 * pointerdown / Escape 关闭 + onMenuOpenChange），浏览器预览借该回调在面板打开时
 * 临时隐藏 native WebContentsView——它悬浮在所有 DOM 之上，会盖住下拉项。
 */
export function BrowserBookmarksMenu({ currentUrl, currentTitle, onNavigate, onMenuOpenChange }: {
  currentUrl: string;
  currentTitle: string;
  onNavigate(url: string): void;
  onMenuOpenChange?(open: boolean): void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>(() => storedBrowserBookmarks());
  const rootRef = useRef<HTMLDivElement>(null);

  function toggle(next: boolean): void {
    setOpen(next);
    // 打开时重读：其他浏览器标签可能刚加过书签。
    if (next) setBookmarks(storedBrowserBookmarks());
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

  const bookmarked = currentUrl ? bookmarks.find((item) => item.url === currentUrl) : undefined;

  function toggleCurrent(): void {
    if (!currentUrl) return;
    if (bookmarked) removeBrowserBookmark(bookmarked.id);
    else addBrowserBookmark(currentUrl, currentTitle);
    setBookmarks(storedBrowserBookmarks());
  }

  function openBookmark(url: string): void {
    onNavigate(url);
    toggle(false);
  }

  function removeBookmark(id: string): void {
    removeBrowserBookmark(id);
    setBookmarks(storedBrowserBookmarks());
  }

  return (
    <div className="browser-bookmarks-menu" ref={rootRef}>
      <button
        type="button"
        className={bookmarked ? "active" : ""}
        title={bookmarked ? "书签（当前页已收藏）" : "书签"}
        aria-label="书签"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => toggle(!open)}
      >
        <Star size={15} />
      </button>
      {open && (
        <div className="browser-bookmarks-pop" role="menu" aria-label="书签">
          <button
            type="button"
            role="menuitem"
            className={`browser-bookmarks-current${bookmarked ? " active" : ""}`}
            disabled={!currentUrl}
            title={currentUrl ? (bookmarked ? `取消收藏 ${bookmarkHost(currentUrl) || currentUrl}` : `收藏 ${bookmarkHost(currentUrl) || currentUrl}`) : "先打开一个页面"}
            onClick={toggleCurrent}
          >
            <Star size={14} />
            <span>{bookmarked ? "取消收藏此页" : "收藏当前页"}</span>
            {!currentUrl && <em>先打开一个页面</em>}
          </button>
          <div className="browser-bookmarks-sep" role="separator" />
          {bookmarks.length === 0 ? (
            <div className="browser-bookmarks-empty">还没有书签，先收藏一个页面吧</div>
          ) : (
            <div className="browser-bookmarks-list">
              {bookmarks.map((bookmark) => {
                const glyph = bookmarkGlyph(bookmark.url);
                const host = bookmarkHost(bookmark.url);
                return (
                  <div className="browser-bookmark-row" key={bookmark.id}>
                    <button
                      type="button"
                      role="menuitem"
                      className="browser-bookmark-main"
                      title={bookmark.url}
                      onClick={() => openBookmark(bookmark.url)}
                    >
                      <span className="browser-bookmark-glyph" style={{ background: `hsl(${glyph.hue} 45% 45%)` }} aria-hidden="true">{glyph.letter}</span>
                      <span className="browser-bookmark-copy">
                        <strong>{bookmark.title}</strong>
                        {host && <small>{host}</small>}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="browser-bookmark-remove"
                      title="删除书签"
                      aria-label={`删除书签 ${bookmark.title}`}
                      onClick={() => removeBookmark(bookmark.id)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
