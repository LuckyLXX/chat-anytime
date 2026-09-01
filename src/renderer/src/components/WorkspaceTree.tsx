import { AlertCircle, ChevronRight, FileCode2, File as FileIcon, FileText, Folder, FolderOpen, Image as ImageIcon, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceDirectoryEntry } from "../../../shared/protocol";
import { useDesktopStore } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

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
  onOpenFile(relativePath: string): void;
  onContextMenu(relativePath: string, name: string, kind: EntryKind, x: number, y: number): void;
}

function DirectoryRow({ workspace, relativePath, name, depth, reloadToken, onOpenFile, onContextMenu }: DirectoryRowProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<WorkspaceDirectoryEntry[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

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

  return (
    <div>
      <button
        className={`workspace-tree-row${expanded ? " expanded" : ""}`}
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
                  ? <DirectoryRow key={entry.relativePath} workspace={workspace} relativePath={entry.relativePath} name={entry.name} depth={depth + 1} reloadToken={reloadToken} onOpenFile={onOpenFile} onContextMenu={onContextMenu} />
                  : <button key={entry.relativePath} className="workspace-tree-row file" type="button" title={entry.relativePath} style={{ paddingLeft: 6 + (depth + 1) * 13 + 13 }} onClick={() => onOpenFile(entry.relativePath)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(entry.relativePath, entry.name, "file", event.clientX, event.clientY); }}>
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
      <div className="modal-backdrop permission-backdrop" onClick={() => { if (!busy) onClose(); }}>
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
    <div className="modal-backdrop permission-backdrop" onClick={() => { if (!busy) onClose(); }}>
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

export function WorkspaceTree({ workspace, onOpenFile, onAddToChat, onError, refreshSignal }: { workspace: string; onOpenFile(relativePath: string): void; onAddToChat(relativePath: string): void; onError(message: string): void; refreshSignal?: number }): ReactNode {
  const [entries, setEntries] = useState<WorkspaceDirectoryEntry[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<TreeDialog | null>(null);

  const refresh = useCallback((): void => setReloadToken((token) => token + 1), []);

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
    const prefix = relativePath ? `${relativePath}/` : "";
    const copyText = (text: string): void => {
      navigator.clipboard.writeText(text).catch((error) => onError(error instanceof Error ? error.message : "复制失败"));
    };
    const items: ContextMenuItem[] = [
      ...(kind === "file" ? [
        { label: "打开预览", onClick: () => onOpenFile(relativePath) },
        { label: "添加到聊天", onClick: () => onAddToChat(relativePath) }
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
          onSubmit: async (fileName) => { await window.piDesktop.createWorkspaceFile(workspace, `${prefix}${fileName}`); refresh(); }
        })
      },
      {
        label: "新建文件夹",
        onClick: () => setDialog({
          kind: "prompt", title: "新建文件夹", label: "文件夹名称", placeholder: "如 src", initial: "", submitLabel: "创建",
          onSubmit: async (folderName) => { await window.piDesktop.createWorkspaceDirectory(workspace, `${prefix}${folderName}`); refresh(); }
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
  }, [onAddToChat, onError, onOpenFile, refresh, workspace]);

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
                ? <DirectoryRow key={entry.relativePath} workspace={workspace} relativePath={entry.relativePath} name={entry.name} depth={0} reloadToken={reloadToken} onOpenFile={onOpenFile} onContextMenu={openRowMenu} />
                : <button key={entry.relativePath} className="workspace-tree-row file" type="button" title={entry.relativePath} style={{ paddingLeft: 19 }} onClick={() => onOpenFile(entry.relativePath)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openRowMenu(entry.relativePath, entry.name, "file", event.clientX, event.clientY); }}>
                  {entryIcon(entry.name)}
                  <span>{entry.name}</span>
                </button>)}
      </nav>
      {/* 菜单与弹窗必须通过 Portal 挂到 body：.sidebar 处于 .desktop-shell > * 的
          z-index:1 堆叠上下文中，fixed 浮层会被主区域盖住导致“右键没反应”。 */}
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />, document.body)}
      {dialog && createPortal(<TreeDialogView dialog={dialog} onClose={() => setDialog(null)} />, document.body)}
    </>
  );
}
