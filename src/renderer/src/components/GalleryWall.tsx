import { FolderOpen, Hammer, LayoutGrid, Play, Plus, Server, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { GALLERY_KIND_LABELS, type GalleryApp } from "../../../shared/gallery";

/**
 * 作品墙：空会话主区域里的作品卡片网格（landing 的替代内容）。
 *
 * 它是「AI 做完的东西」的可见形态：缩略图 + 标题 + 类型 + 入口路径 + 运行/继续开发。
 * 空清单时退回原「今天想开发什么？」文案 + 一句引导，保持既有空态语义。
 *
 * 缩略图在全局 agentDir（工作区外），所以经 galleryThumb IPC 拿 data URL；
 * 按文件名缓存，同一张图不会反复传输。
 */

interface GalleryWallProps {
  apps: GalleryApp[];
  /** 当前工作区（用于缩短展示路径与标记「不在当前工作区」）。 */
  workspace?: string;
  /**
   * 弹窗内渲染：隐藏自己的「作品墙」标题与计数（容器头部已经有），只留
   * 「登记新作品」动作，避免同屏出现两个同名标题。
   */
  embedded?: boolean;
  onRun(app: GalleryApp): void;
  onDevelop(app: GalleryApp): void;
  onPublish(): void;
  onRemove(app: GalleryApp): void;
}

const thumbCache = new Map<string, string>();

function compact(entry: string): string {
  if (entry === ".") return "（工作区根目录）";
  const parts = entry.split("/");
  return parts.length <= 2 ? entry : `…/${parts.slice(-2).join("/")}`;
}

/** 缩略图异步拉取 + 进程内缓存（文件名即缓存键，同图不重复传）。 */
function useThumb(app: GalleryApp): string | undefined {
  const [src, setSrc] = useState<string | undefined>(() => (app.thumb ? thumbCache.get(app.thumb) : undefined));
  useEffect(() => {
    if (!app.thumb) {
      setSrc(undefined);
      return;
    }
    const cached = thumbCache.get(app.thumb);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    void window.piDesktop.galleryThumb(app.thumb)
      .then((data) => {
        if (cancelled || !data) return;
        thumbCache.set(app.thumb!, data);
        setSrc(data);
      })
      .catch(() => {
        // 缩略图缺失不是错误：卡片降级为类型图标。
      });
    return () => { cancelled = true; };
  }, [app.thumb]);
  return src;
}

function GalleryCard({ app, workspace, onRun, onDevelop, onRemove }: { app: GalleryApp } & Omit<GalleryWallProps, "apps" | "onPublish">): ReactNode {
  const thumb = useThumb(app);
  const elsewhere = Boolean(workspace) && workspace!.toLowerCase() !== app.workspace.toLowerCase();
  return (
    <div className="gallery-card" data-gallery-id={app.id}>
      <button type="button" className="gallery-card-thumb" data-control="gallery-run" title={`运行「${app.title}」`} onClick={() => onRun(app)}>
        {thumb
          ? <img src={thumb} alt="" />
          : <span className="gallery-card-placeholder">{app.kind === "server" ? <Server size={22} /> : <LayoutGrid size={22} />}</span>}
        <span className="gallery-card-badge">{GALLERY_KIND_LABELS[app.kind]}</span>
      </button>
      <div className="gallery-card-body">
        <strong className="gallery-card-title" title={app.title}>{app.title}</strong>
        {app.description && <p className="gallery-card-desc">{app.description}</p>}
        <span className="gallery-card-entry" title={`${app.workspace}/${app.entry}`}>
          <FolderOpen size={11} />
          {compact(app.entry)}
          {elsewhere && <em title={app.workspace}>另一工作区</em>}
        </span>
        <div className="gallery-card-actions">
          <button type="button" className="primary-button" data-control="gallery-run" onClick={() => onRun(app)}><Play size={13} />运行</button>
          <button type="button" data-control="gallery-develop" onClick={() => onDevelop(app)}><Hammer size={13} />继续开发</button>
          <button type="button" className="gallery-card-remove" data-control="gallery-remove" title="从作品墙移除" aria-label={`移除 ${app.title}`} onClick={() => onRemove(app)}><Trash2 size={13} /></button>
        </div>
      </div>
    </div>
  );
}

export function GalleryWall({ apps, workspace, embedded = false, onRun, onDevelop, onPublish, onRemove }: GalleryWallProps): ReactNode {
  if (apps.length === 0) {
    return (
      <div className="empty-conversation gallery-wall-empty" data-pane="landing">
        <div className="empty-icon"><Sparkles size={27} /></div>
        <h1>今天想开发什么？</h1>
        <span className="gallery-wall-hint">还没有作品。让 AI 做完一个东西后点「发布」，它就会出现在这里——可反复运行、可继续开发。</span>
        <button type="button" className="gallery-wall-publish" data-control="gallery-publish" onClick={onPublish}><Plus size={14} />登记已有作品</button>
      </div>
    );
  }
  return (
    <div className={`gallery-wall${embedded ? " gallery-wall-embedded" : " gallery-wall-landing"}`} data-pane="gallery-wall">
      <header className="gallery-wall-head">
        {!embedded && (
          <div>
            <h1>作品墙</h1>
            <span>{apps.length} 个作品 · 点击运行，或让 AI 接着改</span>
          </div>
        )}
        {embedded && <span className="gallery-wall-count">{apps.length} 个作品 · 点击运行，或让 AI 接着改</span>}
        <button type="button" className="gallery-wall-publish" data-control="gallery-publish" onClick={onPublish}><Plus size={14} />登记新作品</button>
      </header>
      <div className="gallery-wall-grid">
        {apps.map((app) => <GalleryCard key={app.id} app={app} workspace={workspace} onRun={onRun} onDevelop={onDevelop} onRemove={onRemove} />)}
      </div>
    </div>
  );
}
