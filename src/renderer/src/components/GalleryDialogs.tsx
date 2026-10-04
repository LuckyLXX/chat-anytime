import { LayoutGrid, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { GALLERY_PANEL_MODE_LABELS, PANEL_MODES, type GalleryApp, type GalleryDraft, type GalleryKind, type GalleryPanelEdge, type GalleryPanelMode, type GalleryPanelOptions } from "../../../shared/gallery";
import { GalleryWall } from "./GalleryWall";
import { useOverlayLayer } from "../lib/overlay-layers";

/**
 * 作品墙弹窗 + 「登记新作品」对话框。
 *
 * 为什么需要弹窗版本：空态 landing 只在「有工作区 + 无消息 + 非生成中」出现，
 * 聊过一句就再也回不去 —— 如果作品墙只挂在那里，历史作品实际不可达。弹窗让
 * 顶栏下拉的「打开作品墙」在任何时刻都能打开同一份内容（同一个 GalleryWall）。
 */

export function GalleryWallDialog({ apps, workspace, onRun, onDevelop, onRemove, onPublish, onClose }: {
  apps: GalleryApp[];
  workspace?: string;
  onRun(app: GalleryApp): void;
  onDevelop(app: GalleryApp): void;
  onRemove(app: GalleryApp): void;
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
          <GalleryWall apps={apps} workspace={workspace} embedded onRun={onRun} onDevelop={onDevelop} onPublish={onPublish} onRemove={onRemove} />
        </div>
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
  // 面板窗口的形态/贴边/初始尺寸/置顶。空串 = 用缺省（420×560、不置顶），不强制用户填。
  const [panelMode, setPanelMode] = useState<GalleryPanelMode>("window");
  const [panelEdge, setPanelEdge] = useState<GalleryPanelEdge>("right");
  const [panelWidth, setPanelWidth] = useState("");
  const [panelHeight, setPanelHeight] = useState("");
  const [panelOnTop, setPanelOnTop] = useState(false);
  // 全屏弹层登记：预览面板里的内置浏览器是原生 WebContentsView，永远浮在 DOM 之上。
  useOverlayLayer(true);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!title.trim() || !path.trim()) return;
    const draft: GalleryDraft = { title: title.trim(), kind, path: path.trim() };
    if (command.trim()) draft.command = command.trim();
    if (url.trim()) draft.url = url.trim();
    if (description.trim()) draft.description = description.trim();
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
