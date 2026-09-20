import { Hammer, LayoutGrid, Plus, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GALLERY_KIND_LABELS, type GalleryApp } from "../../../shared/gallery";

/**
 * 顶栏「作品」下拉：清单的**常驻主入口**。
 *
 * 为什么必须在顶栏而不是只放在空态作品墙：空态只在「有工作区 + 无消息 + 非生成中」
 * 出现（ConversationPane 的 landing 判定），聊过一句就再也回不去了——作品入口
 * 一旦只挂在那里，历史作品实际是不可达的。
 *
 * 开合骨架与 BrowserBookmarksMenu / PreviewDeviceMenu 一致（外部 pointerdown +
 * capture 相 Escape 关闭、rootRef.contains 判定、aria-haspopup/expanded）。
 */

interface GalleryMenuProps {
  apps: GalleryApp[];
  /** 运行一个作品（App 负责分流：静态走静态服务、服务型走终端/浏览器）。 */
  onRun(app: GalleryApp): void;
  /** 「继续开发」：把作品上下文注入当前会话输入框。 */
  onDevelop(app: GalleryApp): void;
  /** 打开完整作品墙（空态主区域）。 */
  onOpenWall(): void;
  /** 登记新作品（打开轻量对话框）。 */
  onPublish(): void;
  onMenuOpenChange?(open: boolean): void;
}

function recentLabel(app: GalleryApp): string {
  if (!app.lastRunAt) return GALLERY_KIND_LABELS[app.kind];
  const minutes = Math.floor((Date.now() - app.lastRunAt) / 60_000);
  if (minutes < 1) return `${GALLERY_KIND_LABELS[app.kind]} · 刚刚运行`;
  if (minutes < 60) return `${GALLERY_KIND_LABELS[app.kind]} · ${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${GALLERY_KIND_LABELS[app.kind]} · ${hours} 小时前`;
  return `${GALLERY_KIND_LABELS[app.kind]} · ${Math.floor(hours / 24)} 天前`;
}

export function GalleryMenu({ apps, onRun, onDevelop, onOpenWall, onPublish, onMenuOpenChange }: GalleryMenuProps): ReactNode {
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
    // toggle 每次渲染重建；open 变化才会真正重挂监听，无需进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const top = apps.slice(0, 6);

  return (
    <div className="gallery-menu-shell" data-pane="gallery-menu" ref={rootRef}>
      <button
        className="icon-button gallery-toggle"
        data-control="gallery-toggle"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="作品"
        title={apps.length > 0 ? `作品（${apps.length}）` : "作品：AI 做出来的成果都在这里，可运行、可继续开发"}
        onClick={() => toggle(!open)}
      >
        <LayoutGrid size={18} />
        {apps.length > 0 && <span className="gallery-toggle-count">{apps.length}</span>}
      </button>
      {open && (
        <div className="gallery-pop" role="menu" aria-label="作品">
          <div className="gallery-pop-head">
            <span>作品</span>
            <small>{apps.length > 0 ? `${apps.length} 个` : "还没有"}</small>
          </div>
          {apps.length === 0 ? (
            <div className="gallery-pop-empty">
              <Sparkles size={15} />
              <span>AI 做完东西后点「发布」，就会出现在这里</span>
            </div>
          ) : (
            <div className="gallery-pop-list">
              {top.map((app) => (
                <div className="gallery-pop-row" key={app.id} role="menuitem" data-gallery-id={app.id}>
                  <button type="button" className="gallery-pop-main" data-control="gallery-run" title={`运行「${app.title}」`} onClick={() => { toggle(false); onRun(app); }}>
                    <strong>{app.title}</strong>
                    <span className="gallery-pop-meta">{recentLabel(app)}</span>
                  </button>
                  <button type="button" className="gallery-pop-develop" data-control="gallery-develop" title={`继续开发「${app.title}」`} aria-label={`继续开发 ${app.title}`} onClick={() => { toggle(false); onDevelop(app); }}>
                    <Hammer size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="gallery-pop-actions">
            <button type="button" data-control="gallery-open-wall" onClick={() => { toggle(false); onOpenWall(); }}>
              <LayoutGrid size={13} />打开作品墙
            </button>
            <button type="button" data-control="gallery-publish" onClick={() => { toggle(false); onPublish(); }}>
              <Plus size={13} />登记新作品
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
