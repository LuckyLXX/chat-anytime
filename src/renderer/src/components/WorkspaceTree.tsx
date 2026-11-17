import { AlertCircle, ChevronRight, FileCode2, File as FileIcon, FileText, Folder, FolderOpen, Image as ImageIcon, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceDirectoryEntry } from "../../../shared/protocol";
import { useDesktopStore } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ExitWrap, useExitPresenceValue } from "./Presence";
import { useOverlayLayer } from "../lib/overlay-layers";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"];
const CODE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "cjs", "mjs", "json", "jsonc", "css", "scss", "less", "html", "htm", "py", "go", "rs", "java", "c", "cpp", "cc", "h", "hpp", "cs", "rb", "php", "sh", "bash", "zsh", "yml", "yaml", "toml", "sql", "xml"];

function entryIcon(name: string): ReactNode {
  const ext = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  if (IMAGE_EXTENSIONS.includes(ext)) return <ImageIcon size={14} />;
  if (ext === "md" || ext === "markdown" || ext === "mdx") return <FileText size={14} />;
  if (CODE_EXTENSIONS.includes(ext)) return <FileCode2 size={14} />;
  return <FileIcon size={14} />;
}

type EntryKind = "file" | "directory" | "root";

/**
 * 新建成功后的「定位」信息：`dir` 需要自动展开（右键的是折叠目录时，
 * 不展开就完全看不到新建结果——用户会以为没生效），`path` 是新建条目的
 * 相对路径，用于一次性高亮与滚动到可见。
 */
type CreatedEntry = { dir: string; path: string };

/** 新建条目高亮时长（与 styles.css 的 workspace-row-created 动画时长一致）。 */
const CREATED_HIGHLIGHT_MS = 1600;

/** 父目录相对路径（根 = 空串）。 */
function parentDirectory(relativePath: string): string {
  return relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
}

/** ref 回调：把新建行滚进可视区（只动最近的滚动容器 `.workspace-tree`）。 */
function scrollRowIntoView(element: HTMLButtonElement | null): void {
  element?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// 展示用绝对路径：跟随工作区根路径自身的分隔符风格（根路径来自主进程真实路径）。
function joinWorkspacePath(workspace: string, relativePath: string): string {
  const base = workspace.replace(/[\\/]+$/u, "");
  if (!relativePath) return base;
  const sep = workspace.includes("\\") ? "\\" : "/";
  return `${base}${sep}${relativePath.split("/").join(sep)}`;
}

interface DirectoryRowProps {
  workspace: string;
  relativePath: string;
  name: string;
  depth: number;
  reloadToken: number;
  created?: CreatedEntry;
  onOpenFile(relativePath: string): void;
  onContextMenu(relativePath: string, name: string, kind: EntryKind, x: number, y: number): void;
}

function DirectoryRow({ workspace, relativePath, name, depth, reloadToken, created, onOpenFile, onContextMenu }: DirectoryRowProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<WorkspaceDirectoryEntry[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const expandedByCreateRef = useRef<CreatedEntry>(undefined);
  const highlighted = created?.path === relativePath;

  const load = useCallback(async (withSpinner: boolean): Promise<void> => {
    if (withSpinner) setLoading(true);
    setError(undefined);
    try {
      const listing = await window.piDesktop.listWorkspaceDirectory(workspace, relativePath || undefined);
      setEntries(listing.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取目录");
    } finally {
      if (withSpinner) setLoading(false);
    }
  }, [relativePath, workspace]);

  // 首次展开时加载（带加载指示）。
  useEffect(() => {
    if (expanded) void load(true);
  }, [expanded, load]);

  // 刷新令牌变化时静默重载（仅对已展开目录生效）。
  useEffect(() => {
    if (expanded && reloadToken > 0) void load(false);
  }, [expanded, reloadToken, load]);

  // 新建发生在自己身上时自动展开：右键折叠目录创建完，不展开就等于什么都没发生。
  // 用 ref 记住已处理的那次新建（`created` 对象每次新建都是新的，同一对象不重复展开，
  // 用户手动收起后也不会被反复拉开）。
  useEffect(() => {
    if (!created || created === expandedByCreateRef.current) return;
    expandedByCreateRef.current = created;
    if (created.dir === relativePath) setExpanded(true);
  }, [created, relativePath]);

  return (
    <div>
      <button
        className={`workspace-tree-row${expanded ? " expanded" : ""}${highlighted ? " just-created" : ""}`}
        ref={highlighted ? scrollRowIntoView : undefined}
        type="button"
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={() => setExpanded((current) => !current)}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(relativePath, name, "directory", event.clientX, event.clientY); }}
        aria-expanded={expanded}
      >
        <ChevronRight size={13} className={expanded ? "rotated" : ""} />
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{name}</span>
        {loading && <LoaderCircle size={12} className="spinning" />}
      </button>
      {expanded && (
        <div className="workspace-tree-children">
          {error
            ? <div className="workspace-tree-status">读取失败：{error}</div>
            : !entries
              ? null
              : entries.length === 0
                ? <div className="workspace-tree-status">空目录</div>
                : entries.map((entry) => entry.kind === "directory"
                  ? <DirectoryRow key={entry.relativePath} workspace={workspace} relativePath={entry.relativePath} name={entry.name} depth={depth + 1} reloadToken={reloadToken} created={created} onOpenFile={onOpenFile} onContextMenu={onContextMenu} />
                  : <button key={entry.relativePath} className={`workspace-tree-row file${created?.path === entry.relativePath ? " just-created" : ""}`} ref={created?.path === entry.relativePath ? scrollRowIntoView : undefined} type="button" title={entry.relativePath} style={{ paddingLeft: 6 + (depth + 1) * 13 + 13 }} onClick={() => onOpenFile(entry.relativePath)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(entry.relativePath, entry.name, "file", event.clientX, event.clientY); }}>
                    {entryIcon(entry.name)}
                    <span>{entry.name}</span>
                  </button>)}
        </div>
      )}
    </div>
  );
}

type TreeDialog =
  | { kind: "prompt"; title: string; label: string; placeholder: string; initial: string; submitLabel: string; onSubmit(name: string): Promise<void> }
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; onConfirm(): Promise<void> };

function TreeDialogView({ dialog, onClose }: { dialog: TreeDialog; onClose(): void }): ReactNode {
  const [name, setName] = useState(dialog.kind === "prompt" ? dialog.initial : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  // 全屏弹层登记：预览面板里的内置浏览器是原生 WebContentsView，永远浮在 DOM 之上。
  // 本弹窗虽然只在侧栏触发，但遮罩/弹窗落在窗口中央，面板很宽或全屏时会与它重叠。
  useOverlayLayer(true);

  useEffect(() => {
    if (dialog.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [dialog.kind]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (dialog.kind === "prompt") {
    const submit = (event: FormEvent): void => {
      event.preventDefault();
      const value = name.trim();
      if (!value || busy) return;
      void run(() => dialog.onSubmit(value));
    };
    return (
      <div className="modal-backdrop permission-backdrop in-chat" onClick={() => { if (!busy) onClose(); }}>
        <div className="permission-dialog extension-ui-dialog" role="dialog" aria-modal="true" aria-label={dialog.title} onClick={(event) => event.stopPropagation()}>
          <header><div className="risk-icon"><Pencil size={20} /></div><div><h2>{dialog.title}</h2></div></header>
          <form onSubmit={submit}>
            <div className="field"><label>{dialog.label}</label><input ref={inputRef} value={name} placeholder={dialog.placeholder} disabled={busy} onChange={(event) => setName(event.target.value)} /></div>
            {error && <div className="form-error">{error}</div>}
            <footer><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? "处理中…" : dialog.submitLabel}</button></footer>
          </form>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop permission-backdrop in-chat" onClick={() => { if (!busy) onClose(); }}>
      <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label={dialog.title} onClick={(event) => event.stopPropagation()}>
        <header><div className="risk-icon outside-workspace"><Trash2 size={20} /></div><div><h2>{dialog.title}</h2><p>{dialog.message}</p></div></header>
        {error && <div className="form-error">{error}</div>}
        <footer><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="danger-button" type="button" disabled={busy} onClick={() => void run(dialog.onConfirm)}>{busy ? "处理中…" : dialog.confirmLabel}</button></footer>
      </div>
    </div>
  );
}

// 目录树自动刷新周期：轮询间隔 + 窗口聚焦时立即刷新。
const AUTO_REFRESH_INTERVAL_MS = 3000;

export function WorkspaceTree({ workspace, onOpenFile, onAddToChat, onError, onPublish, refreshSignal }: { workspace: string; onOpenFile(relativePath: string): void; onAddToChat(relativePath: string): void; onError(message: string): void; /** 发布为作品（文件 = 入口文件；目录 = 服务型项目目录）。 */ onPublish?(relativePath: string, name: string, kind: "file" | "directory"): void; refreshSignal?: number }): ReactNode {
  const [entries, setEntries] = useState<WorkspaceDirectoryEntry[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<TreeDialog | null>(null);
  // 新建成功后的定位（展开目标目录 + 高亮新条目），1.6s 后清掉高亮。
  const [createdEntry, setCreatedEntry] = useState<CreatedEntry>();
  const createdTimerRef = useRef<number | undefined>(undefined);
  // 重命名/新建确认弹窗的关闭退场（styles.css permission-dialog 退场 160ms）。
  const dialogPresence = useExitPresenceValue(dialog, 160);

  const refresh = useCallback((): void => setReloadToken((token) => token + 1), []);

  /**
   * 新建成功：刷新目录树，并把结果「指出来」——把所在目录展开、把新条目滚进
   * 可视区并高亮一小会儿。只刷新不定位时，右键折叠目录创建完屏幕上毫无变化
   *（用户 2026-11-17 报「右键新建文件夹好像没生效」），或新条目排在长列表
   * 可视区之外，同样看起来像失败。
   */
  const revealCreated = useCallback((relativePath: string): void => {
    setCreatedEntry({ dir: parentDirectory(relativePath), path: relativePath });
    refresh();
    window.clearTimeout(createdTimerRef.current);
    createdTimerRef.current = window.setTimeout(() => setCreatedEntry(undefined), CREATED_HIGHLIGHT_MS);
  }, [refresh]);

  useEffect(() => () => window.clearTimeout(createdTimerRef.current), []);

  const load = useCallback(async (withSpinner: boolean): Promise<void> => {
    if (withSpinner) setLoading(true);
    setError(undefined);
    try {
      const listing = await window.piDesktop.listWorkspaceDirectory(workspace);
      setEntries(listing.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取目录");
    } finally {
      if (withSpinner) setLoading(false);
    }
  }, [workspace]);

  // 挂载或切换工作区时首次加载。
  useEffect(() => { void load(true); }, [load]);

  // 内部刷新令牌（轮询/聚焦/手动按钮）变化时静默重载。
  useEffect(() => { if (reloadToken > 0) void load(false); }, [reloadToken, load]);

  // 外部刷新信号（文件视图头部刷新按钮）变化时静默重载。
  useEffect(() => { if (refreshSignal && refreshSignal > 0) void load(false); }, [refreshSignal, load]);

  // 轮询 + 窗口聚焦：捕获 AI 之外的外部文件变动（删除、重命名、外部编辑器等）。
  useEffect(() => {
    const interval = window.setInterval(refresh, AUTO_REFRESH_INTERVAL_MS);
    const onFocus = (): void => refresh();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  // AI 写文件即时刷新：快照中出现新的带 changedFile / 产物列表的工具执行时立刻重载。
  // 选择器返回原始值（id:status 字符串），zustand 仅在变化时触发重渲染。
  const lastChangedExecutionKey = useDesktopStore((state) => {
    const executions = state.snapshot.executions;
    for (let index = executions.length - 1; index >= 0; index -= 1) {
      const execution = executions[index];
      if (execution && (execution.changedFile || (execution.changedFiles?.length ?? 0) > 0)) return `${execution.id}:${execution.status}`;
    }
    return undefined;
  });
  const lastChangedExecutionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastChangedExecutionKey && lastChangedExecutionKey !== lastChangedExecutionRef.current) {
      lastChangedExecutionRef.current = lastChangedExecutionKey;
      refresh();
    }
  }, [lastChangedExecutionKey, refresh]);

  const openRowMenu = useCallback((relativePath: string, name: string, kind: EntryKind, x: number, y: number): void => {
    // 新建落点：目录行 = 该目录内；根 = 工作区根；文件行 = 该文件的同级目录
    // （资源管理器/VS Code 同口径）——不在文件路径下硬建，那只会得到一条
    // 「ENOTDIR: not a directory」的原始报错。
    const createBase = kind === "file" ? parentDirectory(relativePath) : relativePath;
    const prefix = createBase ? `${createBase}/` : "";
    const copyText = (text: string): void => {
      navigator.clipboard.writeText(text).catch((error) => onError(error instanceof Error ? error.message : "复制失败"));
    };
    const items: ContextMenuItem[] = [
      ...(kind === "file" ? [
        { label: "打开预览", onClick: () => onOpenFile(relativePath) },
        { label: "添加到聊天", onClick: () => onAddToChat(relativePath) }
      ] : []),
      // 发布入口（用户点名的实体按钮之一）：文件 → 网页型作品（入口=该文件）；
      // 目录 → 服务型作品（入口=该目录，需补启动命令）。root 不发布（工作区整体不是作品）。
      ...(onPublish && kind !== "root" ? [
        { label: kind === "directory" ? "发布为作品（服务型）" : "发布为作品", onClick: () => onPublish(relativePath, name, kind) }
      ] : []),
      {
        label: "在资源管理器中打开",
        onClick: () => {
          window.piDesktop.revealInExplorer(workspace, kind === "root" ? undefined : relativePath).catch((error) => onError(error instanceof Error ? error.message : "打开失败"));
        }
      },
      { label: "复制绝对路径", onClick: () => copyText(joinWorkspacePath(workspace, kind === "root" ? "" : relativePath)) },
      ...(kind !== "root" ? [{ label: "复制相对路径", onClick: () => copyText(relativePath) }] : []),
      {
        label: "新建文件",
        onClick: () => setDialog({
          kind: "prompt", title: "新建文件", label: "文件名", placeholder: "如 notes.md", initial: "", submitLabel: "创建",
          onSubmit: async (fileName) => { const result = await window.piDesktop.createWorkspaceFile(workspace, `${prefix}${fileName}`); revealCreated(result.relativePath); }
        })
      },
      {
        label: "新建文件夹",
        onClick: () => setDialog({
          kind: "prompt", title: "新建文件夹", label: "文件夹名称", placeholder: "如 src", initial: "", submitLabel: "创建",
          onSubmit: async (folderName) => { const result = await window.piDesktop.createWorkspaceDirectory(workspace, `${prefix}${folderName}`); revealCreated(result.relativePath); }
        })
      },
      { label: "刷新", onClick: refresh },
      ...(kind !== "root" ? [
        {
          label: "重命名",
          onClick: () => setDialog({
            kind: "prompt", title: "重命名", label: "新名称", placeholder: name, initial: name, submitLabel: "确定",
            onSubmit: async (newName) => { await window.piDesktop.renameWorkspaceEntry(workspace, relativePath, newName); refresh(); }
          })
        },
        {
          label: "删除", danger: true,
          onClick: () => setDialog({
            kind: "confirm",
            title: `删除${kind === "directory" ? "文件夹" : "文件"}「${name}」？`,
            message: kind === "directory" ? "文件夹及其中的所有内容将被永久删除，此操作不可恢复。" : "文件将被永久删除，此操作不可恢复。",
            confirmLabel: "删除",
            onConfirm: async () => { await window.piDesktop.deleteWorkspaceEntry(workspace, relativePath); refresh(); }
          })
        }
      ] : [])
    ];
    setMenu({ x, y, items });
  }, [onAddToChat, onError, onOpenFile, onPublish, refresh, revealCreated, workspace]);

  const openBackgroundMenu = useCallback((x: number, y: number): void => {
    openRowMenu("", "", "root", x, y);
  }, [openRowMenu]);

  return (
    <>
      <nav className="workspace-tree" aria-label="工作区文件" onContextMenu={(event) => { event.preventDefault(); openBackgroundMenu(event.clientX, event.clientY); }}>
        {error
          ? <div className="workspace-tree-status error"><AlertCircle size={14} />读取失败：{error}</div>
          : loading
            ? <div className="workspace-tree-status"><LoaderCircle size={14} className="spinning" />正在读取工作区…</div>
            : !entries || entries.length === 0
              ? <div className="workspace-tree-status">工作区为空</div>
              : entries.map((entry) => entry.kind === "directory"
                ? <DirectoryRow key={entry.relativePath} workspace={workspace} relativePath={entry.relativePath} name={entry.name} depth={0} reloadToken={reloadToken} created={createdEntry} onOpenFile={onOpenFile} onContextMenu={openRowMenu} />
                : <button key={entry.relativePath} className={`workspace-tree-row file${createdEntry?.path === entry.relativePath ? " just-created" : ""}`} ref={createdEntry?.path === entry.relativePath ? scrollRowIntoView : undefined} type="button" title={entry.relativePath} style={{ paddingLeft: 19 }} onClick={() => onOpenFile(entry.relativePath)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openRowMenu(entry.relativePath, entry.name, "file", event.clientX, event.clientY); }}>
                  {entryIcon(entry.name)}
                  <span>{entry.name}</span>
                </button>)}
      </nav>
      {/* 菜单与弹窗必须通过 Portal 挂到 body：.sidebar 处于 .desktop-shell > * 的
          z-index:1 堆叠上下文中，fixed 浮层会被主区域盖住导致“右键没反应”。 */}
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />, document.body)}
      {dialogPresence.rendered && (() => { const dialog = dialogPresence.value; if (!dialog) return null; return createPortal(<ExitWrap exiting={dialogPresence.exiting}><TreeDialogView dialog={dialog} onClose={() => setDialog(null)} /></ExitWrap>, document.body); })()}
    </>
  );
}
