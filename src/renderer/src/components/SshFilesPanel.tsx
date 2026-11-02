import { AlertCircle, ArrowUp, Check, Download, File as FileIcon, Folder, FolderOpen, Home, LoaderCircle, RefreshCw, Upload, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { SshEventData, SshRemoteEntry } from "../../../shared/protocol";

/**
 * SSH 远端文件抽屉（寄生在 ssh-terminal 标签内，不是独立 tab）。
 *
 * 定位：**只读浏览 + 多选上传/下载**。远端的新建/删除/重命名一概不做——
 * 需要改远端文件时用终端敲命令（AI 也能代劳）。这是有意的范围收敛，不是遗漏。
 *
 * 与 WorkspaceTree 的关系：形似而**不复用**。WorkspaceTree 焊死在
 * listWorkspaceDirectory 上、且自带全套本地文件操作，复用它要把能跑的代码
 * 抽象出数据源层；远端还需要额外展示大小/时间/权限。这里新写一个精简的只读列表
 * 更省事也更安全（见实施计划 D 项说明）。
 *
 * 传输进度走 `onSshData(terminalId, …)` 的 transfer 事件（与终端输出同一通道、
 * 不同类型），因此抽屉与 xterm 各自订阅互不干扰。
 *
 * **刷新路径的两个坑（都踩过，别再改回去）**：
 * ① `sftp.list` 的 `path` **缺省值是远端 home**（见 ssh-sftp.ts 的 `list()`），所以
 *    「刷新」绝不能裸调 `list()` —— 初版在传输完成事件里就是裸调，症状是「在指定
 *    目录上传完文件后自动跳回根目录」。当前目录一律从 `pathRef` 取，`refresh()`
 *    是唯一出口。
 * ② 传输事件订阅的依赖里不能放 `path`（每次进目录都重新订阅），所以路径走 ref
 *    而不是 state 闭包。
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
  const [selected, setSelected] = useState<string[]>([]);
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const [busy, setBusy] = useState(false);
  // 传输 id 由渲染端生成（一次操作一个 base id，多文件在主进程拆成 base#N）。
  const transferSeqRef = useRef(0);
  // 当前目录的 ref 镜像：传输事件的订阅回调里必须拿到**最新**路径（见文件头 ⓐ）。
  const pathRef = useRef("");
  const listRef = useRef<HTMLDivElement | undefined>(undefined);
  // shift 连选的锚点（列表索引）。
  const anchorRef = useRef<number | undefined>(undefined);

  const list = useCallback(async (target?: string): Promise<void> => {
    setLoading(true);
    try {
      const result = await window.piDesktop.ssh({ type: "sftp.list", terminalId, ...(target ? { path: target } : {}) });
      if (result.kind !== "sftp-listing") {
        onError("读取远端目录返回了意外结果");
        return;
      }
      pathRef.current = result.path;
      setPath(result.path);
      setHome(result.home);
      setEntries(result.entries);
      setSelected([]);
      anchorRef.current = undefined;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [terminalId, onError]);

  /** 刷新**当前**目录。裸调 `list()` 会回到 home（坑 ⓐ）。 */
  const refresh = useCallback((): void => {
    void list(pathRef.current || undefined);
  }, [list]);

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
        }].slice(-6);
      });
      // 完成/失败后刷新列表：远端可能多/少了文件。刷新的是**当前目录**，不是 home。
      if (event.state !== "running") refresh();
    });
    return unsubscribe;
  }, [terminalId, refresh]);

  const enterDirectory = useCallback((entry: SshRemoteEntry): void => {
    if (entry.kind !== "directory") return;
    void list(joinRemote(pathRef.current, entry.name));
  }, [list]);

  const goParent = useCallback((): void => {
    void list(parentOf(pathRef.current));
  }, [list]);

  const goHome = useCallback((): void => {
    if (!home) return;
    void list(home);
  }, [list, home]);

  const selectRow = useCallback((entry: SshRemoteEntry, index: number, modifiers: { shift: boolean; toggle: boolean }): void => {
    setSelected((current) => {
      const all = entries ?? [];
      if (modifiers.shift && anchorRef.current !== undefined) {
        const from = Math.min(anchorRef.current, index);
        const to = Math.max(anchorRef.current, index);
        return all.slice(from, to + 1).map((item) => item.name);
      }
      anchorRef.current = index;
      if (modifiers.toggle) {
        return current.includes(entry.name) ? current.filter((name) => name !== entry.name) : [...current, entry.name];
      }
      return [entry.name];
    });
  }, [entries]);

  const scrollRowIntoView = useCallback((name: string): void => {
    // 不走 querySelector + CSS.escape（happy-dom 没有 CSS.escape），逐行比对 dataset 名。
    const rows = listRef.current?.querySelectorAll<HTMLElement>(".ssh-files-row") ?? [];
    for (const row of Array.from(rows)) {
      if (row.dataset.name === name) {
        row.scrollIntoView?.({ block: "nearest" });
        return;
      }
    }
  }, []);

  const onListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const all = entries ?? [];
    if (all.length === 0) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(all.map((entry) => entry.name));
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      goParent();
      return;
    }
    if (event.key === "Enter") {
      const active = all.find((entry) => selected.includes(entry.name));
      if (active && active.kind === "directory") {
        event.preventDefault();
        enterDirectory(active);
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const currentIndex = all.findIndex((entry) => selected.includes(entry.name));
    const nextIndex = currentIndex < 0
      ? 0
      : Math.min(all.length - 1, Math.max(0, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
    anchorRef.current = nextIndex;
    const next = all[nextIndex];
    if (!next) return;
    setSelected([next.name]);
    scrollRowIntoView(next.name);
  }, [entries, goParent, enterDirectory, scrollRowIntoView, selected]);

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
      }))].slice(-6));
      await window.piDesktop.ssh({ type: "sftp.upload", terminalId, transferId: base, remoteDir: pathRef.current, localPaths: files });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [terminalId, workspace, onError]);

  const download = useCallback(async (): Promise<void> => {
    // 目录不能下载（远端不做递归），选中里只挑普通文件。
    const chosen = (entries ?? []).filter((entry) => selected.includes(entry.name) && entry.kind !== "directory");
    if (chosen.length === 0) return;
    if (!workspace) {
      onError("下载需要一个工作区来确定落盘目录。请先在侧边栏选择或新建一个工作区再试。");
      return;
    }
    setBusy(true);
    try {
      const base = `ui-download-${++transferSeqRef.current}`;
      setTransfers((current) => [...current, ...chosen.map((entry, index) => ({
        transferId: chosen.length > 1 ? `${base}#${index + 1}` : base,
        direction: "download" as const,
        name: entry.name,
        transferred: 0,
        total: 0,
        state: "running" as const
      }))].slice(-6));
      await window.piDesktop.ssh({
        type: "sftp.download",
        terminalId,
        transferId: base,
        remotePaths: chosen.map((entry) => joinRemote(path, entry.name)),
        // 传工作区而非目标目录：落盘位置（.pidesktop/downloads/）由主进程按
        // 统一下载策略推导（初版漏传该字段 → 下载 100% 报「请先选择工作区」）。
        workspace
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [terminalId, path, selected, entries, workspace, onError]);

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

  const crumb = useMemo(() => buildBreadcrumb(path, home), [path, home]);
  const downloadable = selected.filter((name) => (entries ?? []).some((entry) => entry.name === name && entry.kind !== "directory")).length;
  // 正在跑的排前面（用户最关心），已结束的最多留 3 条，避免把列表挤没。
  const orderedTransfers = [...transfers.filter((item) => item.state === "running"), ...transfers.filter((item) => item.state !== "running").slice(-3)];
  const atRoot = path === "/";

  return (
    <div className="ssh-files" data-pane="ssh-files">
      <div className="ssh-files-toolbar">
        <div className="ssh-files-nav">
          <button type="button" className="ssh-files-navbtn" title="上一级" aria-label="上一级" onClick={goParent} disabled={atRoot || loading}><ArrowUp size={14} /></button>
          <button type="button" className="ssh-files-navbtn" title={home ? `主目录 ${home}` : "主目录"} aria-label="主目录" onClick={goHome} disabled={!home || path === home || loading}><Home size={14} /></button>
        </div>
        <div className="ssh-files-path" title={path || "…"}>
          {crumb.map((segment, index) => (
            <Fragment key={`${segment.target}-${index}`}>
              {index > 0 && <span className="ssh-files-sep">/</span>}
              <button type="button" className="ssh-files-crumb" onClick={() => void list(segment.target)}>{segment.label}</button>
            </Fragment>
          ))}
        </div>
        <div className="ssh-files-toolbar-actions">
          <button type="button" className="ssh-files-navbtn" title="刷新当前目录" aria-label="刷新当前目录" onClick={refresh} disabled={loading}><RefreshCw className={loading ? "spinning" : undefined} size={14} /></button>
          <span className="ssh-files-toolbar-divider" aria-hidden="true" />
          <button type="button" className="ssh-files-action primary ssh-files-upload" data-control="ssh-upload" onClick={() => void upload()} disabled={busy || !path} title={path ? `上传到这个目录：${path}` : "正在读取远端目录…"}>
            {busy ? <LoaderCircle className="spinning" size={13} /> : <Upload size={13} />}上传
          </button>
          <button
            type="button"
            className="ssh-files-action ssh-files-download"
            data-control="ssh-download"
            onClick={() => void download()}
            disabled={busy || downloadable === 0}
            title={!workspace ? "下载需要一个工作区来确定落盘目录" : downloadable === 0 ? "先在列表里选中文件" : "下载选中文件到工作区 .pidesktop/downloads/"}
          >
            <Download size={13} />下载{downloadable > 1 ? ` ${downloadable}` : ""}
          </button>
        </div>
      </div>

      <div className="ssh-files-columns" aria-hidden="true">
        <span />
        <span>名称</span>
        <span className="num">大小</span>
        <span className="num">修改时间</span>
      </div>

      <div
        className="ssh-files-list"
        role="listbox"
        aria-label="远端文件"
        aria-multiselectable="true"
        aria-busy={loading}
        tabIndex={0}
        ref={(element) => { listRef.current = element ?? undefined; }}
        onKeyDown={onListKeyDown}
      >
        {loading && entries === undefined && <div className="ssh-files-empty"><LoaderCircle className="spinning" size={16} /><span>读取目录中…</span></div>}
        {entries?.length === 0 && !loading && <div className="ssh-files-empty"><FolderOpen size={20} /><span>目录为空</span><span className="ssh-files-empty-hint">可以用上方「上传」往这里放文件</span></div>}
        {entries?.map((entry, index) => {
          const isSelected = selected.includes(entry.name);
          return (
            <button
              type="button"
              key={entry.name}
              role="option"
              aria-selected={isSelected}
              data-name={entry.name}
              data-kind={entry.kind}
              className={`ssh-files-row${isSelected ? " selected" : ""}`}
              title={entry.name}
              onClick={(event) => selectRow(entry, index, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey })}
              onDoubleClick={() => enterDirectory(entry)}
            >
              <span className="ssh-files-icon">{entry.kind === "directory" ? <Folder size={14} /> : <FileIcon size={14} />}</span>
              <span className="ssh-files-name">{entry.name}</span>
              <span className="ssh-files-size">{entry.sizeText}</span>
              <span className="ssh-files-time">{entry.mtimeText}</span>
            </button>
          );
        })}
      </div>

      {orderedTransfers.length > 0 && (
        <div className="ssh-files-transfers">
          {orderedTransfers.map((item) => (
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
  const meta = transfer.state === "running"
    ? `${transfer.total > 0 ? `${percent}% · ` : ""}${formatBytes(transfer.transferred)}${transfer.total > 0 ? ` / ${formatBytes(transfer.total)}` : ""}`
    : transfer.state === "done"
      ? formatBytes(transfer.transferred)
      : transfer.state === "cancelled"
        ? "已取消"
        : "失败";
  return (
    <div className={`ssh-transfer ${transfer.state}`}>
      <span className="ssh-transfer-icon">
        {transfer.state === "running" ? <LoaderCircle className="spinning" size={12} />
          : transfer.state === "done" ? <Check size={12} />
            : transfer.state === "cancelled" ? <X size={12} />
              : <AlertCircle size={12} />}
      </span>
      <span className="ssh-transfer-name" title={transfer.name}>{label}：{transfer.name}</span>
      <span className="ssh-transfer-meta">{meta}</span>
      {transfer.state === "running" && (
        <button type="button" className="ssh-files-navbtn ssh-transfer-cancel" data-control="ssh-transfer-cancel" title="取消传输" aria-label="取消传输" onClick={() => onCancel(transfer.transferId)}><X size={12} /></button>
      )}
      {transfer.state === "done" && transfer.relativePath && (
        <button type="button" className="ssh-transfer-reveal" onClick={() => onReveal(transfer.relativePath!)}>在文件夹中打开</button>
      )}
      {transfer.state === "error" && transfer.error && <span className="ssh-transfer-error" title={transfer.error}>{transfer.error}</span>}
      {transfer.state === "running" && (
        <span className={`ssh-transfer-progress${transfer.total > 0 ? "" : " indeterminate"}`} style={transfer.total > 0 ? { width: `${percent}%` } : undefined} />
      )}
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

/** 面包屑：当前目录在 home 之内时把 home 前缀折成「~」（不再重复画根 `/`），其余按段拆分。
 * home 判定必须按**路径边界**比较：`/home/pix` 不属于 `/home/pi`（否则会渲染出
 * 「~/x」这种指错目标的路径）。 */
function buildBreadcrumb(path: string, home: string | undefined): Array<{ label: string; target: string }> {
  if (!path || path === "/") return [{ label: "/", target: "/" }];
  const homePrefix = home && home !== "/" ? home.replace(/\/+$/u, "") : undefined;
  const underHome = homePrefix !== undefined && (path === homePrefix || path.startsWith(`${homePrefix}/`));
  const segments: Array<{ label: string; target: string }> = underHome ? [] : [{ label: "/", target: "/" }];
  if (homePrefix && underHome) segments.push({ label: "~", target: homePrefix });
  const rest = (underHome && homePrefix ? path.slice(homePrefix.length) : path).replace(/^\/+/u, "");
  let acc = underHome && homePrefix ? homePrefix : "";
  for (const part of rest.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : `/${part}`;
    segments.push({ label: part, target: acc });
  }
  return segments;
}
