import { Database, LayoutGrid, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { GALLERY_PANEL_MODE_LABELS, PANEL_MODES, type GalleryApp, type GalleryDataUsage, type GalleryDraft, type GalleryKind, type GalleryPanelEdge, type GalleryPanelMode, type GalleryPanelOptions } from "../../../shared/gallery";
import { GalleryWall } from "./GalleryWall";
import { useOverlayLayer } from "../lib/overlay-layers";

/**
 * 作品墙弹窗 + 「登记新作品」对话框。
 *
 * 为什么需要弹窗版本：空态 landing 只在「有工作区 + 无消息 + 非生成中」出现，
 * 聊过一句就再也回不去 —— 如果作品墙只挂在那里，历史作品实际不可达。弹窗让
 * 顶栏下拉的「打开作品墙」在任何时刻都能打开同一份内容（同一个 GalleryWall）。
 */

export function GalleryWallDialog({ apps, workspace, onRun, onDevelop, onRemove, onReveal, onData, onPublish, onClose }: {
  apps: GalleryApp[];
  workspace?: string;
  onRun(app: GalleryApp): void;
  onDevelop(app: GalleryApp): void;
  onRemove(app: GalleryApp): void;
  onReveal(app: GalleryApp): void;
  onData(app: GalleryApp): void;
  onPublish(): void;
  onClose(): void;
}): ReactNode {
  // 全屏弹层登记：预览面板里的内置浏览器是原生 WebContentsView，永远浮在 DOM 之上。
  useOverlayLayer(true);
  return (
    <div className="modal-backdrop gallery-wall-backdrop" onClick={onClose}>
      <div className="gallery-wall-dialog" role="dialog" aria-modal="true" aria-label="作品墙" onClick={(event) => event.stopPropagation()}>
        <header className="gallery-wall-dialog-head">
          <LayoutGrid size={17} />
          <h2>作品墙</h2>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭作品墙" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="gallery-wall-dialog-body">
          <GalleryWall apps={apps} workspace={workspace} embedded onRun={onRun} onDevelop={onDevelop} onPublish={onPublish} onRemove={onRemove} onReveal={onReveal} onData={onData} />
        </div>
      </div>
    </div>
  );
}

/** 字节数展示：作品数据的量级从 KB 到 GB，统一一位小数就够读。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * 「作品数据」对话框（仅面板作品）：数据在哪、占多少、怎么清。
 *
 * 为什么需要它：面板数据落在 Chromium profile 的固定 origin
 * `pidesktop-file://w-<作品>` 里（自 2026-10-10 面板改由自定义协议承载后），
 * 用户看不见也摸不到——没有这个面板，他们只能看着作品目录却找不到数据。
 * 量测由主进程做（复用在开的面板窗口，否则开临时隐藏窗口），量不到就如实说，
 * 不把「未知」画成一个 0。
 */
export function GalleryDataDialog({ app, onClose }: { app: GalleryApp; onClose(): void }): ReactNode {
  const [usage, setUsage] = useState<GalleryDataUsage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [round, setRound] = useState(0);
  useOverlayLayer(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void window.piDesktop.galleryDataMeasure(app.id)
      .then((result) => {
        if (cancelled) return;
        setLoading(false);
        if (result.ok) setUsage(result.usage);
        else setError(result.message);
      })
      .catch((reason) => {
        if (cancelled) return;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : "量测失败");
      });
    return () => { cancelled = true; };
  }, [app.id, round]);

  const clear = useCallback((): void => {
    setClearing(true);
    setNotice(undefined);
    void window.piDesktop.galleryDataClear(app.id)
      .then((result) => {
        setClearing(false);
        setConfirming(false);
        if (!result.ok) {
          setNotice(result.message);
          return;
        }
        setNotice("已清空。面板窗口（若开着）已重载。");
        setRound((value) => value + 1);
      })
      .catch((reason) => {
        setClearing(false);
        setNotice(reason instanceof Error ? reason.message : "清空失败");
      });
  }, [app.id]);

  return (
    <div className="modal-backdrop permission-backdrop" onClick={onClose}>
      <div className="gallery-data-dialog" role="dialog" aria-modal="true" aria-label={`${app.title} 的数据`} onClick={(event) => event.stopPropagation()}>
        <header>
          <Database size={17} />
          <h2>作品数据</h2>
          <span className="gallery-data-title" title={app.title}>{app.title}</span>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭作品数据" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="gallery-data-body">
          <p className="gallery-data-hint">
            面板作品的数据存在自己的固定 origin 里（<code>{usage?.origin ?? `pidesktop-file://w-${app.id}`}</code>）：
            没有端口、跨启动不丢、与其他作品互不干扰。它不在工作区目录里，因此只能在这里查看与清理。
          </p>
          {loading && <p className="gallery-data-status"><Loader2 size={14} className="spinning" /> 正在量测…</p>}
          {!loading && error && <p className="gallery-data-status">量测失败：{error}</p>}
          {!loading && usage && (
            <>
              <div className="gallery-data-grid">
                <div><span>localStorage</span><strong>{formatBytes(usage.localStorageBytes)}</strong><em>{usage.keys.length} 项键值</em></div>
                <div><span>IndexedDB / 缓存</span><strong>{usage.storageBytes === undefined ? "—" : formatBytes(usage.storageBytes)}</strong><em>Chromium 估算</em></div>
                <div><span>配额上限</span><strong>{usage.quotaBytes === undefined ? "—" : formatBytes(usage.quotaBytes)}</strong><em>{usage.persisted ? "已持久化" : "由浏览器调度"}</em></div>
              </div>
              {usage.keys.length > 0 && (
                <ul className="gallery-data-keys">
                  {usage.keys.map((entry) => (
                    <li key={entry.key}><code title={entry.key}>{entry.key}</code><span>{formatBytes(entry.bytes)}</span></li>
                  ))}
                </ul>
              )}
              {usage.databaseNames && usage.databaseNames.length > 0 && (
                <p className="gallery-data-db">IndexedDB 库：{usage.databaseNames.join("、")}</p>
              )}
            </>
          )}
          {notice && <p className="gallery-data-notice">{notice}</p>}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={() => setRound((value) => value + 1)} disabled={loading || clearing}><RefreshCw size={13} />刷新</button>
          <span className="gallery-data-spacer" />
          {confirming
            ? <>
                <span className="gallery-data-warn">清空后无法恢复，确定？</span>
                <button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={clearing}>取消</button>
                <button type="button" className="danger-button" data-control="gallery-data-clear" onClick={clear} disabled={clearing}>{clearing ? "清空中…" : "确认清空"}</button>
              </>
            : <button type="button" className="danger-button" data-control="gallery-data-clear" onClick={() => setConfirming(true)} disabled={loading || clearing}>清空数据</button>}
        </footer>
      </div>
    </div>
  );
}

export function GalleryPublishDialog({ initial, workspace, onSubmit, onClose }: {
  /** 预填（从文件树/预览/产物行发起时带上入口路径）。 */
  initial?: { path?: string; title?: string; kind?: GalleryKind };
  workspace?: string;
  onSubmit(draft: GalleryDraft): void;
  onClose(): void;
}): ReactNode {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [kind, setKind] = useState<GalleryKind>(initial?.kind ?? "file");
  const [path, setPath] = useState(initial?.path ?? "");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  // 封面：留空 = 自动（入口截图 / 服务页截图 / 占位）；填了就用工作区里的这张图。
  const [cover, setCover] = useState("");
  const [coverPreview, setCoverPreview] = useState<{ data?: string; error?: string } | undefined>(undefined);
  // 面板窗口的形态/贴边/初始尺寸/置顶。空串 = 用缺省（420×560、不置顶），不强制用户填。
  const [panelMode, setPanelMode] = useState<GalleryPanelMode>("window");
  const [panelEdge, setPanelEdge] = useState<GalleryPanelEdge>("right");
  const [panelWidth, setPanelWidth] = useState("");
  const [panelHeight, setPanelHeight] = useState("");
  const [panelOnTop, setPanelOnTop] = useState(false);
  // 全屏弹层登记：预览面板里的内置浏览器是原生 WebContentsView，永远浮在 DOM 之上。
  useOverlayLayer(true);

  // 封面预览：输入停 300ms 后读工作区图片（与文件树添加附件同一条只读通道）。
  // 读失败只提示、不拦提交——发布时主进程还会再校验一次。
  useEffect(() => {
    const relativePath = cover.trim();
    if (!relativePath || !workspace) {
      setCoverPreview(undefined);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.piDesktop.readWorkspaceFile(relativePath, workspace)
        .then((file) => {
          if (cancelled) return;
          setCoverPreview(file.kind === "image" && file.data ? { data: file.data } : { error: "不是可预览的图片" });
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setCoverPreview({ error: reason instanceof Error ? reason.message : "读不到这张图片" });
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cover, workspace]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!title.trim() || !path.trim()) return;
    const draft: GalleryDraft = { title: title.trim(), kind, path: path.trim() };
    if (command.trim()) draft.command = command.trim();
    if (url.trim()) draft.url = url.trim();
    if (description.trim()) draft.description = description.trim();
    if (cover.trim()) draft.cover = cover.trim();
    if (kind === "panel") {
      const panel: GalleryPanelOptions = {};
      const width = Number.parseInt(panelWidth, 10);
      const height = Number.parseInt(panelHeight, 10);
      if (Number.isFinite(width) && width > 0) panel.width = width;
      if (Number.isFinite(height) && height > 0) panel.height = height;
      // 桌宠/抽屉显式写置顶布尔（生效缺省：桌宠置顶、抽屉不置顶）；普通窗口保持
      // 旧语义（不勾就不写字段，走平台缺省的不置顶）。
      if (panelMode !== "window") panel.alwaysOnTop = panelOnTop;
      else if (panelOnTop) panel.alwaysOnTop = true;
      if (panelMode !== "window") panel.mode = panelMode;
      if (panelMode === "drawer") panel.edge = panelEdge;
      if (Object.keys(panel).length > 0) draft.panel = panel;
    }
    onSubmit(draft);
    onClose();
  }

  return (
    <div className="modal-backdrop permission-backdrop" onClick={onClose}>
      <form className="gallery-publish-dialog" role="dialog" aria-modal="true" aria-label="登记新作品" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <header>
          <LayoutGrid size={17} />
          <h2>登记新作品</h2>
        </header>
        <div className="gallery-publish-body">
          <label>作品名<input value={title} placeholder="如：收纳整理 App 原型" autoFocus onChange={(event) => setTitle(event.target.value)} /></label>
          <label>类型
            <select value={kind} onChange={(event) => setKind(event.target.value as GalleryKind)}>
              <option value="file">网页（入口文件，单文件 HTML 等）</option>
              <option value="server">服务（项目目录 + 启动命令）</option>
              <option value="panel">面板（入口网页开成独立小窗口，主界面关了也在）</option>
            </select>
          </label>
          <label>{kind === "server" ? "项目目录" : kind === "panel" ? "入口网页" : "入口文件"}
            <input value={path} placeholder={workspace ? `工作区相对路径，如 ${kind === "server" ? "apps/demo" : kind === "panel" ? "panels/status/index.html" : "designs/exports/demo.html"}` : "工作区相对路径"} onChange={(event) => setPath(event.target.value)} />
          </label>
          {kind === "panel" && (
            <div className="gallery-panel-options">
              <label>形态
                <select value={panelMode} onChange={(event) => {
                  const next = event.target.value as GalleryPanelMode;
                  setPanelMode(next);
                  // 桌宠缺省置顶（不置顶的桌宠会被普通窗口吞没），选中即预勾上。
                  if (next === "pet") setPanelOnTop(true);
                }}>
                  {PANEL_MODES.map((mode) => <option key={mode} value={mode}>{GALLERY_PANEL_MODE_LABELS[mode]}（{mode === "window" ? "系统边框窗口" : mode === "pet" ? "透明无边框，页面自绘形状可拖动" : "贴屏幕边缘，窄条点击展开"}）</option>)}
                </select>
              </label>
              {panelMode === "drawer" && (
                <label>贴边
                  <select value={panelEdge} onChange={(event) => setPanelEdge(event.target.value as GalleryPanelEdge)}>
                    <option value="right">右缘</option>
                    <option value="left">左缘</option>
                    <option value="top">顶缘</option>
                    <option value="bottom">底缘</option>
                  </select>
                </label>
              )}
              <label>窗口宽（可选）<input type="number" min={240} max={1600} value={panelWidth} placeholder="420" onChange={(event) => setPanelWidth(event.target.value)} /></label>
              <label>窗口高（可选）<input type="number" min={200} max={1400} value={panelHeight} placeholder="560" onChange={(event) => setPanelHeight(event.target.value)} /></label>
              <label className="gallery-panel-ontop"><input type="checkbox" checked={panelOnTop} onChange={(event) => setPanelOnTop(event.target.checked)} /> 窗口置顶{panelMode === "pet" ? "（桌宠建议置顶）" : ""}</label>
            </div>
          )}
          {kind === "server" && (
            <>
              <label>启动命令（可选）<input value={command} placeholder="如：npm run dev" onChange={(event) => setCommand(event.target.value)} /></label>
              <label>服务地址（可选）<input value={url} placeholder="如：http://localhost:5173" onChange={(event) => setUrl(event.target.value)} /></label>
            </>
          )}
          {/* 面板也能带一个本地服务（2026-10-11）：面板页没有 preload 也跑不了外部命令，
              需要本地数据源（跑 git / 读数据库 / 访问本机文件）的面板就靠它——点运行时
              先在作品目录里起这个服务、探活通过再开窗，窗口关闭时服务自动停止。 */}
          {kind === "panel" && (
            <>
              <label>本地服务启动命令（可选）<input value={command} placeholder="如：node bridge.mjs（在入口所在目录执行）" onChange={(event) => setCommand(event.target.value)} /></label>
              <label>服务探活地址（可选）<input value={url} placeholder="如：http://127.0.0.1:8791/api/health" onChange={(event) => setUrl(event.target.value)} /></label>
              <span className="gallery-dialog-hint">两个都填才会自动起服务：点「运行」先拉服务、探活通过再开窗，窗口关闭时服务自动停止。</span>
            </>
          )}
          <label>封面图片（可选）<input value={cover} placeholder="工作区相对路径，如 outputs/cover.png；留空自动截图/生成占位" onChange={(event) => setCover(event.target.value)} /></label>
          {cover.trim() && (
            <div className="gallery-cover-field">
              {coverPreview?.data
                ? <img className="gallery-cover-preview" src={coverPreview.data} alt="封面预览" />
                : <span className="gallery-cover-preview gallery-cover-empty" aria-hidden="true" />}
              {coverPreview?.error
                ? <span className="gallery-cover-error">{coverPreview.error}</span>
                : <span className="gallery-dialog-hint">留空时自动截入口页；server 型在服务跑着时截服务页，仍拿不到画面会生成占位封面。</span>}
            </div>
          )}
          <label>说明（可选）<input value={description} placeholder="一句话说明这个作品是什么" onChange={(event) => setDescription(event.target.value)} /></label>
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={!title.trim() || !path.trim()}>发布</button>
        </footer>
      </form>
    </div>
  );
}
