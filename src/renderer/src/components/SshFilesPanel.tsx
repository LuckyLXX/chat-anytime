import { ArrowUp, Download, File as FileIcon, Folder, FolderOpen, LoaderCircle, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SshEventData, SshRemoteEntry } from "../../../shared/protocol";

/**
 * SSH 远端文件抽屉（寄生在 ssh-terminal 标签内，不是独立 tab）。
 *
 * 定位：**只读浏览 + 单文件上传/下载**。远端的新建/删除/重命名一概不做——
 * 需要改远端文件时用终端敲命令（AI 也能代劳）。这是有意的范围收敛，不是遗漏。
 *
 * 与 WorkspaceTree 的关系：形似而**不复用**。WorkspaceTree 焊死在
 * listWorkspaceDirectory 上、且自带全套本地文件操作，复用它要把能跑的代码
 * 抽象出数据源层；远端还需要额外展示大小/时间/权限。这里新写一个精简的只读列表
 * 更省事也更安全（见实施计划 D 项说明）。
 *
 * 传输进度走 `onSshData(terminalId, …)` 的 transfer 事件（与终端输出同一通道、
 * 不同类型），因此抽屉与 xterm 各自订阅互不干扰。
 */

interface TransferState {
  transferId: string;
  direction: "upload" | "download";
  name: string;
  transferred: number;
  total: number;
  state: "running" | "done" | "error" | "cancelled";
  error?: string;
  /** done 且下载：工作区相对路径（用于「在文件夹中打开」）。 */
  relativePath?: string;
}

export function SshFilesPanel({ terminalId, workspace, onError }: { terminalId: string; workspace?: string; onError(message: string): void }): ReactNode {
  const [path, setPath] = useState<string>("");
  const [home, setHome] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<SshRemoteEntry[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const [busy, setBusy] = useState(false);
  // 传输 id 由渲染端生成（一次操作一个 base id，多文件在主进程拆成 base#N）。
  const transferSeqRef = useRef(0);

  const list = useCallback(async (target?: string): Promise<void> => {
    setLoading(true);
    try {
      const result = await window.piDesktop.ssh({ type: "sftp.list", terminalId, ...(target ? { path: target } : {}) });
      if (result.kind !== "sftp-listing") {
        onError("读取远端目录返回了意外结果");
        return;
      }
      setPath(result.path);
      setHome(result.home);
      setEntries(result.entries);
      setSelected(undefined);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [terminalId, onError]);

  // 首次挂载列 home；terminalId 变化（重连）重新列。
  useEffect(() => {
    void list();
  }, [list]);

  // 传输进度：只认本 terminalId 的 transfer 事件。
  useEffect(() => {
    const unsubscribe = window.piDesktop.onSshData(terminalId, (event: SshEventData) => {
      if (event.type !== "transfer") return;
      setTransfers((current) => {
        const next = current.filter((item) => !matchesTransfer(item.transferId, event.transferId));
        return [...next, {
          transferId: event.transferId,
          direction: event.direction,
          name: event.name,
          transferred: event.transferred,
          total: event.total,
          state: event.state,
          ...(event.error ? { error: event.error } : {}),
          ...(event.relativePath ? { relativePath: event.relativePath } : {})
        }];
      });
      // 完成/失败后刷新列表：远端可能多/少了文件。
      if (event.state !== "running") void list();
    });
    return unsubscribe;
  }, [terminalId, list]);

  const enterDirectory = useCallback((entry: SshRemoteEntry): void => {
    if (entry.kind !== "directory") return;
    void list(joinRemote(path, entry.name));
  }, [list, path]);

  const goParent = useCallback((): void => {
    void list(parentOf(path));
  }, [list, path]);

  const upload = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const files = await window.piDesktop.chooseSshUploadFiles(workspace);
      if (files.length === 0) return;
      const base = `ui-upload-${++transferSeqRef.current}`;
      // 先用文件名占位显示（主进程的 running 事件随后覆盖）。
      setTransfers((current) => [...current, ...files.map((file, index) => ({
        transferId: files.length > 1 ? `${base}#${index + 1}` : base,
        direction: "upload" as const,
        name: baseName(file),
        transferred: 0,
        total: 0,
        state: "running" as const
      }))]);
      await window.piDesktop.ssh({ type: "sftp.upload", terminalId, transferId: base, remoteDir: path, localPaths: files });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [terminalId, path, workspace, onError]);

  const download = useCallback(async (): Promise<void> => {
    if (!selected) return;
    if (!workspace) {
      onError("下载需要一个工作区来确定落盘目录。请先在侧边栏选择或新建一个工作区再试。");
      return;
    }
    setBusy(true);
    try {
      const base = `ui-download-${++transferSeqRef.current}`;
      setTransfers((current) => [...current, { transferId: base, direction: "download", name: selected, transferred: 0, total: 0, state: "running" }]);
      await window.piDesktop.ssh({
        type: "sftp.download",
        terminalId,
        transferId: base,
        remotePaths: [joinRemote(path, selected)],
        // 传工作区而非目标目录：落盘位置（.pidesktop/downloads/）由主进程按
        // 统一下载策略推导（初版漏传该字段 → 下载 100% 报「请先选择工作区」）。
        workspace
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [terminalId, path, selected, workspace, onError]);

  const cancel = useCallback((transferId: string): void => {
    void window.piDesktop.ssh({ type: "sftp.cancel", terminalId, transferId }).catch((error: unknown) => {
      onError(error instanceof Error ? error.message : String(error));
    });
  }, [terminalId, onError]);

  const openInExplorer = useCallback((relativePath: string): void => {
    if (!workspace) return;
    void window.piDesktop.revealInExplorer(workspace, relativePath).catch((error: unknown) => {
      onError(error instanceof Error ? error.message : String(error));
    });
  }, [workspace, onError]);

  const activeTransfers = transfers.filter((item) => item.state === "running");
  const recentTransfers = transfers.filter((item) => item.state !== "running").slice(-3);
  const crumb = useMemo(() => buildBreadcrumb(path, home), [path, home]);

  return (
    <div className="ssh-files" data-pane="ssh-files">
      <div className="ssh-files-toolbar">
        <button type="button" className="ghost-icon" title="上一级" aria-label="上一级" onClick={goParent} disabled={path === "/"}><ArrowUp size={14} /></button>
        <div className="ssh-files-path" title={path}>{crumb.map((segment, index) => (
          <span key={`${segment.target}-${index}`}>
            {index > 0 && <span className="ssh-files-sep">/</span>}
            <button type="button" className="ssh-files-crumb" onClick={() => void list(segment.target)}>{segment.label}</button>
          </span>
        ))}</div>
        <button type="button" className="ghost-icon" title="刷新" aria-label="刷新远端目录" onClick={() => void list(path)} disabled={loading}><RefreshCw size={14} /></button>
      </div>

      <div className="ssh-files-actions">
        <button type="button" className="secondary-button ssh-files-upload" data-control="ssh-upload" onClick={() => void upload()} disabled={busy}>
          {busy ? <LoaderCircle className="spinning" size={13} /> : <Upload size={13} />}上传
        </button>
        <button type="button" className="secondary-button ssh-files-download" data-control="ssh-download" onClick={() => void download()} disabled={busy || !selected} title={!workspace ? "下载需要一个工作区来确定落盘目录" : "下载选中文件到工作区 .pidesktop/downloads/"}>
          <Download size={13} />下载
        </button>
      </div>

      <div className="ssh-files-list" role="listbox" aria-label="远端文件">
        {loading && entries === undefined && <div className="ssh-files-empty"><LoaderCircle className="spinning" size={16} /><span>读取目录中…</span></div>}
        {entries?.length === 0 && !loading && <div className="ssh-files-empty"><FolderOpen size={20} /><span>目录为空</span></div>}
        {entries?.map((entry) => (
          <button
            type="button"
            key={entry.name}
            role="option"
            aria-selected={selected === entry.name}
            className={`ssh-files-row${selected === entry.name ? " selected" : ""}`}
            onClick={() => setSelected(entry.name)}
            onDoubleClick={() => enterDirectory(entry)}
          >
            <span className="ssh-files-icon">{entry.kind === "directory" ? <Folder size={14} /> : <FileIcon size={14} />}</span>
            <span className="ssh-files-name" title={entry.name}>{entry.name}</span>
            <span className="ssh-files-size">{entry.sizeText}</span>
            <span className="ssh-files-time">{entry.mtimeText}</span>
          </button>
        ))}
      </div>

      {(activeTransfers.length > 0 || recentTransfers.length > 0) && (
        <div className="ssh-files-transfers">
          {[...activeTransfers, ...recentTransfers].map((item) => (
            <TransferRow key={item.transferId} transfer={item} onCancel={cancel} onReveal={openInExplorer} />
          ))}
        </div>
      )}
    </div>
  );
}

function TransferRow({ transfer, onCancel, onReveal }: { transfer: TransferState; onCancel(transferId: string): void; onReveal(relativePath: string): void }): ReactNode {
  const percent = transfer.total > 0 ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100)) : 0;
  const label = transfer.direction === "upload" ? "上传" : "下载";
  return (
    <div className={`ssh-transfer ${transfer.state}`}>
      <div className="ssh-transfer-head">
        <span className="ssh-transfer-name" title={transfer.name}>{label}：{transfer.name}</span>
        {transfer.state === "running" && transfer.total > 0 && <span className="ssh-transfer-percent">{percent}%</span>}
        {transfer.state === "running" && (
          <button type="button" className="ghost-icon ssh-transfer-cancel" data-control="ssh-transfer-cancel" title="取消传输" aria-label="取消传输" onClick={() => onCancel(transfer.transferId)}><X size={12} /></button>
        )}
      </div>
      {transfer.state === "running" && (
        <>
          <div className="ssh-transfer-bar"><span style={{ width: `${transfer.total > 0 ? percent : 30}%` }} className={transfer.total > 0 ? "" : "indeterminate"} /></div>
          <span className="ssh-transfer-detail">{formatBytes(transfer.transferred)}{transfer.total > 0 ? ` / ${formatBytes(transfer.total)}` : ""}</span>
        </>
      )}
      {transfer.state === "done" && (
        <span className="ssh-transfer-detail done">
          {label}完成（{formatBytes(transfer.transferred)}）
          {transfer.relativePath && (
            <button type="button" className="ssh-transfer-reveal" onClick={() => onReveal(transfer.relativePath!)}>在文件夹中打开</button>
          )}
        </span>
      )}
      {transfer.state === "error" && <span className="ssh-transfer-detail error">{transfer.error ?? "传输失败"}</span>}
      {transfer.state === "cancelled" && <span className="ssh-transfer-detail">已取消</span>}
    </div>
  );
}

// ——— 纯助手（渲染端本地，与主进程的 remoteJoin/remoteParent 语义一致）———

/** 多文件传输时主进程用 `base#N` 子 id，事件回来要能对上占位项。 */
function matchesTransfer(placeholderId: string, eventId: string): boolean {
  return placeholderId === eventId || eventId.startsWith(`${placeholderId}#`) || placeholderId.startsWith(`${eventId}#`);
}

function joinRemote(dir: string, name: string): string {
  const base = dir.replace(/\/+$/u, "");
  return base ? `${base}/${name}` : `/${name}`;
}

function parentOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/u, "");
  if (!trimmed || trimmed === "/") return "/";
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function baseName(path: string): string {
  return path.split(/[/\\]/u).pop() || path;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

/** 面包屑：home 存在时把 home 前缀折成「~」，其余按段拆分。 */
function buildBreadcrumb(path: string, home: string | undefined): Array<{ label: string; target: string }> {
  const segments: Array<{ label: string; target: string }> = [{ label: "/", target: "/" }];
  if (!path || path === "/") return segments;
  const homePrefix = home && home !== "/" ? home.replace(/\/+$/u, "") : undefined;
  const rest = homePrefix && path.startsWith(homePrefix) ? path.slice(homePrefix.length).replace(/^\/+/u, "") : path.replace(/^\/+/u, "");
  if (homePrefix && path.startsWith(homePrefix)) segments.push({ label: "~", target: homePrefix });
  let acc = homePrefix && path.startsWith(homePrefix) ? homePrefix : "";
  for (const part of rest.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : `/${part}`;
    segments.push({ label: part, target: acc });
  }
  return segments;
}
