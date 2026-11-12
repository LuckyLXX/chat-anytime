import { AppWindow, Cat, Database, FolderOpen, FolderSearch, Hammer, LayoutGrid, PanelRight, Play, Plus, Server, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { GALLERY_KIND_LABELS, GALLERY_PANEL_MODE_LABELS, galleryServiceLive, panelMode, workspaceLabel, type GalleryApp, type GalleryServiceRecord } from "../../../shared/gallery";
import { GalleryServiceBadge, GalleryServicesBoard } from "./GalleryServicesBoard";
import { workspaceKey } from "../lib/session-groups";

/**
 * 作品墙：空会话主区域里的作品卡片网格（landing 的替代内容）。
 *
 * 它是「AI 做完的东西」的可见形态：缩略图 + 标题 + 类型 + 入口路径 + 运行/继续开发。
 * 空清单时退回原「今天想开发什么？」文案 + 一句引导，保持既有空态语义。
 *
 * 顶部还有一块「运行中的服务」看板（2026-11-12）：服务型作品的进程跑在主进程后台，
 * 那之后它不占任何标签页，这里就是它唯一的出口（看日志 / 停止 / 重启 / 打开页面）。
 * 清单为空时看板也照常显示——作品被删掉之后那个进程还在跑，不能让它变成隐形进程。
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
  /** 在系统文件管理器中定位作品入口（文件选中 / 目录进入）。 */
  onReveal(app: GalleryApp): void;
  /** 「数据…」：面板作品的持久化数据在哪里、占多少、怎么清（仅 panel 显示入口）。 */
  onData(app: GalleryApp): void;
  /** 后台服务看板的数据与动作（进程在主进程里，这里是唯一可见入口）。 */
  services: GalleryServiceRecord[];
  onOpenServicePage(service: GalleryServiceRecord): void;
  onStopService(service: GalleryServiceRecord): void;
  onRestartService(service: GalleryServiceRecord): void;
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

function GalleryCard({ app, workspace, runningServices, onRun, onDevelop, onReveal, onRemove, onData }: { app: GalleryApp; runningServices: number } & Omit<GalleryWallProps, "apps" | "onPublish" | "services" | "onOpenServicePage" | "onStopService" | "onRestartService">): ReactNode {
  const thumb = useThumb(app);
  // 作品清单全局跨工作区：卡片必须自己说明「它在哪」，否则跨工作区的作品
  // 只能靠悬停看全路径（2026-10-28 用户「找不到源文件在哪个工作区」）。
  const elsewhere = Boolean(workspace) && workspaceKey(workspace!) !== workspaceKey(app.workspace);
  return (
    <div className="gallery-card" data-gallery-id={app.id}>
      <button type="button" className="gallery-card-thumb" data-control="gallery-run" title={`运行「${app.title}」`} onClick={() => onRun(app)}>
        {thumb
          ? <img src={thumb} alt="" />
          : <span className="gallery-card-placeholder">{app.kind === "server" ? <Server size={22} /> : app.kind === "panel" ? (panelMode(app.panel) === "pet" ? <Cat size={22} /> : panelMode(app.panel) === "drawer" ? <PanelRight size={22} /> : <AppWindow size={22} />) : <LayoutGrid size={22} />}</span>}
        <span className="gallery-card-badge">{app.kind === "panel" && panelMode(app.panel) !== "window" ? `面板 · ${GALLERY_PANEL_MODE_LABELS[panelMode(app.panel)]}` : GALLERY_KIND_LABELS[app.kind]}</span>
      </button>
      <div className="gallery-card-body">
        <strong className="gallery-card-title" title={app.title}>{app.title}</strong>
        {app.description && <p className="gallery-card-desc">{app.description}</p>}
        <span className="gallery-card-entry" title={`${app.workspace}/${app.entry}`}>
          <FolderOpen size={11} />
          <span
            className={`gallery-card-workspace${elsewhere ? " is-other" : ""}`}
            title={elsewhere ? `作品在另一个工作区（当前：${workspace}）：${app.workspace}` : `工作区：${app.workspace}`}
          >
            {workspaceLabel(app.workspace)}
          </span>
          <span className="gallery-card-path">{compact(app.entry)}</span>
        </span>
        {/* 这个作品此刻有没有服务在后台跑（2026-11-12）：运行中的服务不再占标签页，
            卡片是用户执行「运行」的地方，所以它必须能回答「我点过之后现在什么状态」。 */}
        <GalleryServiceBadge count={runningServices} />
        {/* 带本地服务的面板：点运行会先起服务再开窗（2026-10-11）。纯展示标记，
            刻意不带 data-control——它是说明，不是开关，不该进主题钩子契约。 */}
        {app.kind === "panel" && app.command && (
          <span className="gallery-card-service" title={`运行会先执行「${app.command}」拉起本地服务，探活通过再开窗；窗口关闭时服务自动停止`}>
            <Server size={11} />本地服务
          </span>
        )}
        <div className="gallery-card-actions">
          <button type="button" className="primary-button" data-control="gallery-run" onClick={() => onRun(app)}><Play size={13} />运行</button>
          <button type="button" data-control="gallery-develop" onClick={() => onDevelop(app)}><Hammer size={13} />继续开发</button>
          {/* 数据入口只给面板：file / server 作品的存储不在作品自己的 origin 上（每次运行都是另一个端口）。 */}
          {app.kind === "panel" && (
            <button type="button" className="gallery-card-data" data-control="gallery-data" title={`「${app.title}」的持久化数据`} onClick={() => onData(app)}><Database size={13} />数据…</button>
          )}
          <button type="button" className="gallery-card-reveal" data-control="gallery-reveal" title={`在资源管理器中打开「${app.title}」所在位置`} aria-label={`打开 ${app.title} 所在文件夹`} onClick={() => onReveal(app)}><FolderSearch size={13} /></button>
          <button type="button" className="gallery-card-remove" data-control="gallery-remove" title="从作品墙移除" aria-label={`移除 ${app.title}`} onClick={() => onRemove(app)}><Trash2 size={13} /></button>
        </div>
      </div>
    </div>
  );
}

export function GalleryWall({ apps, workspace, embedded = false, services, onRun, onDevelop, onPublish, onRemove, onReveal, onData, onOpenServicePage, onStopService, onRestartService }: GalleryWallProps): ReactNode {
  const board = (
    <GalleryServicesBoard
      services={services}
      onOpenPage={onOpenServicePage}
      onStop={onStopService}
      onRestart={onRestartService}
    />
  );
  if (apps.length === 0) {
    return (
      <div className="empty-conversation gallery-wall-empty" data-pane="landing">
        <div className="empty-icon"><Sparkles size={27} /></div>
        <h1>今天想开发什么？</h1>
        <span className="gallery-wall-hint">还没有作品。让 AI 做完一个东西后点「发布」，它就会出现在这里——可反复运行、可继续开发。</span>
        <button type="button" className="gallery-wall-publish" data-control="gallery-publish" onClick={onPublish}><Plus size={14} />登记已有作品</button>
        {board}
      </div>
    );
  }
  return (
    <div className={`gallery-wall${embedded ? " gallery-wall-embedded" : " gallery-wall-landing"}`} data-pane="gallery-wall">
      {board}
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
        {apps.map((app) => (
          <GalleryCard
            key={app.id}
            app={app}
            workspace={workspace}
            runningServices={services.filter((service) => service.appId === app.id && galleryServiceLive(service)).length}
            onRun={onRun}
            onDevelop={onDevelop}
            onReveal={onReveal}
            onRemove={onRemove}
            onData={onData}
          />
        ))}
      </div>
    </div>
  );
}
