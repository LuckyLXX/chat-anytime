import { LayoutGrid, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { GalleryApp, GalleryDraft, GalleryKind } from "../../../shared/gallery";
import { GalleryWall } from "./GalleryWall";

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

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!title.trim() || !path.trim()) return;
    const draft: GalleryDraft = { title: title.trim(), kind, path: path.trim() };
    if (command.trim()) draft.command = command.trim();
    if (url.trim()) draft.url = url.trim();
    if (description.trim()) draft.description = description.trim();
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
            </select>
          </label>
          <label>{kind === "server" ? "项目目录" : "入口文件"}
            <input value={path} placeholder={workspace ? `工作区相对路径，如 ${kind === "server" ? "apps/demo" : "designs/exports/demo.html"}` : "工作区相对路径"} onChange={(event) => setPath(event.target.value)} />
          </label>
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
