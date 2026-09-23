import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename as renameLocal, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { DOWNLOAD_DIR_SEGMENTS, sanitizeDownloadName } from "./browser-downloads.js";
import type { SshEventData, SshRemoteEntry } from "../shared/protocol.js";

/**
 * SSH SFTP 文件传输（人工 + AI 共用同一实现）。
 *
 * 设计要点（对应实施计划）：
 * - **懒开通道**：SFTP 通道在首次文件操作时打开，随连接销毁——不用文件功能的
 *   用户零额外开销。
 * - **自建并发流水线**（既不用 ssh2 的 fastPut/fastGet，也不 pipe 它的远端
 *   WriteStream）：上传走 OPEN/WRITE/CLOSE 三个原语、8 个 WRITE 同时在途，
 *   既精确按字节计进度、可中断、可清理，又能打满链路。详见 pipeUpload 的注释
 *   —— ssh2 的远端 WriteStream 从不发 finish，是旧实现「每次都超时」的根因。
 * - **半成品约定**：下载先写 `<name>.part` 再 rename，失败/取消 unlink；上传失败
 *   尽力 unlink 远端半成品（远端清理失败只并入错误文案，不掩盖原始错误）。
 * - **绝不覆盖**：本地同名递增序号（photo.png → photo-1.png），远端同名同样递增。
 *   远端返回的文件名是不可信输入，一律经 sanitizeDownloadName 清洗 + 只取 basename。
 * - **单连接同时一个传输**：避免服务器 open-handle 压力与进度互相打架。协议层
 *   本身按 reqid 多路复用（SFTP.js:2847+）是并发安全的，这是产品选择而非技术限制。
 *
 * 纯逻辑 + 注入 sftp 视图（ssh-connections.ts 的 SshClientLike 同模式），可单测。
 */

/** 单次传输大小上限。对齐 browser 自动化的 20MB 口径思路，但文件传输需要更大的
 *  余量；500MB 走流式写盘不整包进内存，是本机与常见云主机都安全的量级。 */
export const SSH_TRANSFER_MAX_BYTES = 500 * 1024 * 1024;

/** 进度推送节流（对齐终端 flush 的 10ms 量级，避免刷爆 IPC）。 */
const PROGRESS_INTERVAL_MS = 100;

/** 单块大小。ssh2 在 OpenSSH 下的单包上限约 254KB；64KB 与 fastPut 默认一致。 */
const UPLOAD_CHUNK_BYTES = 64 * 1024;

/**
 * 上传流水线的在途 WRITE 请求数。串行单包 64KB 的吞吐是 `64KB / RTT`——实测
 * 海外节点 RTT 127ms 时只有约 180–290 KB/s，而本机上行有 620–740 KB/s，瓶颈
 * 全在等往返。ssh2 的 fastPut 默认 64 并发（lib/protocol/SFTP.js:2186），这里取
 * 其八分之一：足够压到链路带宽，又不会让弱服务器在前台会话上吃紧。
 */
const UPLOAD_CONCURRENCY = 8;

/** 传输默认/最大等待（与 ssh_exec 同量级，但传输普遍更久，故单独放宽）。 */
export const SFTP_DEFAULT_TIMEOUT_MS = 300_000;
export const SFTP_MAX_TIMEOUT_MS = 1_800_000;

/** SFTP 通道的最小结构视图（index.ts 注入真实实现，测试注入 fake）。 */
export interface SshSftpLike {
  readdir(path: string, callback: (error: Error | undefined, list: SshRemoteStatsEntry[] | undefined) => void): void;
  stat(path: string, callback: (error: Error | undefined, stats: SshRemoteStats | undefined) => void): void;
  realpath(path: string, callback: (error: Error | undefined, resolved: string | undefined) => void): void;
  unlink(path: string, callback: (error: Error | undefined) => void): void;
  /** 远端读流（下载）。调用方负责 destroy。 */
  createReadStream(path: string): NodeJS.ReadableStream;
  /**
   * 打开远端文件句柄（上传流水线用）。flags 为 SFTP 标志串（`w` = 截断+创建+写）。
   * 不用 ssh2 的远端 WriteStream：它从不发 finish（见 pipeUpload）。
   */
  open(path: string, flags: string, callback: (error: Error | undefined, handle: Buffer | undefined) => void): void;
  /**
   * 在**绝对偏移** position 写入 buffer[offset, offset+length)（上传流水线用）。
   * 协议按 reqid 多路复用，同一句柄上的并发调用是安全的——流水线正是靠它提速。
   */
  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | undefined) => void): void;
  /** 关闭句柄（上传流水线：等它回调后数据才算落盘，才能报 done）。 */
  close(handle: Buffer, callback: (error: Error | undefined) => void): void;
  end(): void;
}

export interface SshRemoteStats {
  size: number;
  mtime: number;
  mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** readdir 返回的条目（ssh2 的 FileEntryWithStats 形状）。 */
export interface SshRemoteStatsEntry {
  filename: string;
  attrs: SshRemoteStats;
}

export interface SshSftpDeps {
  sftp: SshSftpLike;
  terminalId: string;
  publish(event: SshEventData): void;
  /** Test seam：节流调度（缺省 setTimeout）。 */
  schedule?(callback: () => void): () => void;
}

// ——— 纯函数（无 IO，测试主战场） ———

/** POSIX 风格拼接：远端路径分隔符恒为 `/`，绝不引入 node:path 的 Windows 语义。 */
export function remoteJoin(dir: string, name: string): string {
  const base = dir.replace(/\/+$/u, "");
  if (!base) return `/${name}`;
  return `${base}/${name}`;
}

/** 上一级目录；根目录返回自身（面包屑「上一级」在根处禁用）。 */
export function remoteParent(dir: string): string {
  const trimmed = dir.replace(/\/+$/u, "");
  if (!trimmed || trimmed === "/") return "/";
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return "/";
  return index === 0 ? "/" : trimmed.slice(0, index);
}

/** 远端条目类型判定：目录优先（符号链接若指向目录仍按目录展示，便于进入）。 */
export function remoteEntryKind(stats: SshRemoteStats): SshRemoteEntry["kind"] {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "link";
  return "other";
}

/** 目录优先、同类按名排序（对齐工作区文件树既有口径，localeCompare 稳定可预测）。 */
export function sortRemoteEntries(entries: SshRemoteEntry[]): SshRemoteEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === "directory";
    const bDir = b.kind === "directory";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 人类可读大小；目录显示 `-`（目录的 size 在 SFTP 里无意义）。 */
export function formatRemoteSize(size: number, kind: SshRemoteEntry["kind"]): string {
  if (kind === "directory") return "-";
  if (!Number.isFinite(size) || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

/** 人类可读修改时间（本地时区 `YYYY-MM-DD HH:mm`）；未知返回空串。 */
export function formatRemoteTime(mtimeSeconds: number): string {
  // SFTP 的 mtime 是 Unix 秒（SFTP.js:2615 readUInt32BE），不是毫秒。
  if (!Number.isFinite(mtimeSeconds) || mtimeSeconds <= 0) return "";
  const date = new Date(mtimeSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把远端 readdir 结果映射为可渲染条目（排序 + 格式化一次完成）。 */
export function toRemoteEntries(list: SshRemoteStatsEntry[]): SshRemoteEntry[] {
  return sortRemoteEntries(
    list.map((item) => {
      const kind = remoteEntryKind(item.attrs);
      const size = kind === "directory" ? 0 : item.attrs.size;
      return {
        name: item.filename,
        kind,
        size,
        sizeText: formatRemoteSize(item.attrs.size, kind),
        mtimeText: formatRemoteTime(item.attrs.mtime),
        mtimeMs: Number.isFinite(item.attrs.mtime) && item.attrs.mtime > 0 ? item.attrs.mtime * 1000 : 0
      };
    })
  );
}

/**
 * 同名递增：`photo.png` → `photo-1.png` → `photo-2.png`…。`taken` 为已占用的名字
 * 集合（调用方逐次累积）。与 browser-save-image.ts 的落盘冲突策略同口径。
 */
export function nextAvailableName(filename: string, taken: Set<string>): string {
  if (!taken.has(filename)) return filename;
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${base}-${attempt}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 远端文件名只取 basename 并清洗（防 `../../x` 逃出目标目录）。 */
export function safeRemoteName(raw: string): string {
  return sanitizeDownloadName(basename(raw.replace(/\\/gu, "/")));
}

// ——— 传输服务 ———

export interface SftpUploadRequest {
  localPath: string;
  remoteDir: string;
  remoteName?: string;
  timeoutMs?: number;
}

export interface SftpDownloadRequest {
  remotePath: string;
  /** 本地目录（绝对路径）。缺省=调用方按工作区解析，服务层不猜。 */
  localDir: string;
  timeoutMs?: number;
}

export interface SftpTransferOutcome {
  name: string;
  bytes: number;
  /** 上传=远端最终路径；下载=本地绝对路径。 */
  path: string;
}

interface ActiveTransfer {
  transferId: string;
  cancel(): void;
}

export class SshSftpTransferService {
  private sftp: SshSftpLike;
  private active: ActiveTransfer | undefined;
  /** beginTransfer 之后、真实中断器注册之前收到的取消请求（注册时兑现，见 beginTransfer）。 */
  private pendingCancelId: string | undefined;
  private disposed = false;

  constructor(private readonly deps: SshSftpDeps) {
    this.sftp = deps.sftp;
  }

  /** 远端 home（面包屑「主目录」）。失败返回 undefined，由调用方退化到 `/`。 */
  home(): Promise<string | undefined> {
    return new Promise((resolveHome) => {
      this.sftp.realpath(".", (error, resolved) => {
        resolveHome(error || !resolved ? undefined : resolved);
      });
    });
  }

  /** 列目录。path 缺省=远端 home（解析不出时退回 `/`）。 */
  async list(path?: string): Promise<{ path: string; home?: string; entries: SshRemoteEntry[] }> {
    this.assertUsable();
    const home = await this.home();
    const target = path?.trim() ? path.trim() : (home ?? "/");
    const list = await new Promise<SshRemoteStatsEntry[]>((resolveList, rejectList) => {
      this.sftp.readdir(target, (error, entries) => {
        if (error) rejectList(new Error(describeSftpError(error, `读取目录失败：${target}`)));
        else resolveList(entries ?? []);
      });
    });
    return { path: target, ...(home ? { home } : {}), entries: toRemoteEntries(list) };
  }

  /**
   * 上传单个本地文件到远端目录。返回远端最终路径（同名冲突时为递增后的名字）。
   */
  async upload(transferId: string, request: SftpUploadRequest): Promise<SftpTransferOutcome> {
    this.assertUsable();
    this.beginTransfer(transferId, "upload");

    let size: number;
    try {
      const info = await stat(request.localPath);
      if (!info.isFile()) throw new Error(`只能上传普通文件：${request.localPath}`);
      size = info.size;
    } catch (error) {
      this.finish();
      throw error instanceof Error && error.message.startsWith("只能上传") ? error : new Error(`无法读取本地文件：${request.localPath}`);
    }
    if (size > SSH_TRANSFER_MAX_BYTES) {
      this.finish();
      throw new Error(`文件超过单次传输上限 ${formatRemoteSize(SSH_TRANSFER_MAX_BYTES, "file")}：${basename(request.localPath)}（${formatRemoteSize(size, "file")}）`);
    }

    const name = request.remoteName?.trim() ? safeRemoteName(request.remoteName) : safeRemoteName(basename(request.localPath));
    const dir = request.remoteDir.replace(/\/+$/u, "") || "/";
    const taken = await this.remoteNames(dir);
    const finalName = nextAvailableName(name, taken);
    const remotePath = remoteJoin(dir, finalName);

    try {
      const bytes = await this.pipeUpload(transferId, "upload", finalName, {
        localPath: request.localPath,
        total: size,
        timeoutMs: request.timeoutMs,
        remotePath,
        onCleanup: () => this.removeRemote(remotePath)
      });
      this.publishState(transferId, "upload", finalName, bytes, size, "done");
      return { name: finalName, bytes, path: remotePath };
    } finally {
      this.finish();
    }
  }

  /**
   * 下载远端文件到本地目录。先写 `<name>.part` 再 rename；失败/取消清理半成品，
   * 绝不留下看着像完整文件的残片。
   */
  async download(transferId: string, request: SftpDownloadRequest): Promise<SftpTransferOutcome> {
    this.assertUsable();
    this.beginTransfer(transferId, "download");

    const dir = resolve(request.localDir);
    const rawName = request.remotePath.split("/").pop() ?? "";
    const name = safeRemoteName(rawName) || "download";
    const total = await this.remoteSize(request.remotePath);
    if (total !== undefined && total > SSH_TRANSFER_MAX_BYTES) {
      this.finish();
      throw new Error(`远端文件超过单次传输上限 ${formatRemoteSize(SSH_TRANSFER_MAX_BYTES, "file")}：${name}（${formatRemoteSize(total, "file")}）`);
    }

    try {
      await mkdir(dir, { recursive: true });
      // 用 `wx` 独占创建 `.part` 占位：同名冲突时递增，避免覆盖也避免竞态。
      const { finalName, partPath } = await reserveLocalPart(dir, name);
      const finalPath = join(dir, finalName);
      try {
        const bytes = await this.pipeTransfer(transferId, "download", finalName, {
          total,
          timeoutMs: request.timeoutMs,
          createRemoteRead: () => this.sftp.createReadStream(request.remotePath),
          createLocalWrite: () => createWriteStream(partPath),
          onCleanup: () => this.removeLocal(partPath)
        });
        // 先确保最终名仍未被占用（保留期间可能被外部创建），再改名——绝不覆盖。
        if (await pathExists(finalPath)) {
          throw new Error(`本地文件已存在：${finalName}（不会覆盖已有文件）`);
        }
        await renameLocal(partPath, finalPath);
        this.publishState(transferId, "download", finalName, bytes, total ?? bytes, "done", {
          relativePath: [...DOWNLOAD_DIR_SEGMENTS, finalName].join("/")
        });
        return { name: finalName, bytes, path: finalPath };
      } catch (error) {
        await this.removeLocal(partPath);
        throw error;
      }
    } finally {
      this.finish();
    }
  }

  /** 当前在途传输的 id（无则 undefined）。多文件传输时是子 id（`base#index`）。 */
  activeTransferId(): string | undefined {
    return this.active?.transferId;
  }

  /** 取消在途传输（幂等）。半成品清理由 pipeTransfer 的失败路径负责。 */
  cancel(transferId: string): boolean {
    if (!this.active || this.active.transferId !== transferId) return false;
    this.active.cancel();
    return true;
  }

  /** 连接销毁：取消在途传输并关掉 SFTP 通道。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.cancel();
    try {
      this.sftp.end();
    } catch {
      // 已销毁的通道再 end 属幂等路径
    }
  }

  // ——— 内部 ———

  private assertUsable(): void {
    if (this.disposed) throw new Error("SSH 连接已关闭，无法传输文件");
  }

  private beginTransfer(transferId: string, direction: "upload" | "download"): void {
    if (this.active) {
      throw new Error("该连接已有文件传输在进行中，请等待完成或先取消（同一连接同时只允许一个传输）");
    }
    // 真实中断器由 pipeUpload / pipeTransfer 在初始化完成后才注册；在那之前先记下取消请求，
    // 注册时立即兑现——否则「刚发起就点取消」会拿到 true 却什么都没发生（传输照跑）。
    this.active = {
      transferId,
      cancel: () => {
        this.pendingCancelId = transferId;
      }
    };
    // direction 只用于 assertUsable 之后的语义校验，当前无额外分支。
    void direction;
  }

  private finish(): void {
    this.active = undefined;
    this.pendingCancelId = undefined;
  }

  private async remoteNames(dir: string): Promise<Set<string>> {
    return new Promise((resolveNames) => {
      this.sftp.readdir(dir, (error, entries) => {
        // 目录不可读（新建目录/无权限）不该阻断上传：空集合 → 直接用原名。
        resolveNames(new Set(error ? [] : (entries ?? []).map((entry) => entry.filename)));
      });
    });
  }

  private remoteSize(remotePath: string): Promise<number | undefined> {
    return new Promise((resolveSize) => {
      this.sftp.stat(remotePath, (error, stats) => {
        resolveSize(error || !stats ? undefined : stats.size);
      });
    });
  }

  private removeRemote(remotePath: string): void {
    this.sftp.unlink(remotePath, () => {
      // 远端清理失败不改变原始失败原因：只做尽力而为。
    });
  }

  private async removeLocal(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // 半成品不存在/已被清理：幂等
    }
  }

  private publishState(
    transferId: string,
    direction: "upload" | "download",
    name: string,
    transferred: number,
    total: number,
    state: "running" | "done" | "error" | "cancelled",
    extra: { error?: string; relativePath?: string } = {}
  ): void {
    this.deps.publish({
      type: "transfer",
      terminalId: this.deps.terminalId,
      transferId,
      direction,
      name,
      state,
      transferred,
      total,
      ...extra
    });
  }

  /**
   * 上传：自建并发流水线（OPEN → 并发 WRITE → CLOSE）。
   *
   * **为什么不用 `sftp.createWriteStream(remotePath)` + `read.pipe(write)`**（旧实现）：
   * `pipeTransfer` 只在 `write.on("finish")` 里 resolve，而 ssh2 的远端 WriteStream
   * **永远不会发 finish**——它的 `_final()` 先 `destroy()` 再回调 cb，于是 finish 永不
   * 触发；真正发出来的是 close（`closeStream()` 在无错时 `stream.emit('close')`，
   * 见 SFTP.js:3833–3860 一带）。旧注释正好判断反了（写的是「emitClose=false 所以不发
   * close」——不发的是 finish）。后果是**每次上传都只能等超时**，然后走清理把**其实
   * 已经传完**的远端文件 unlink 掉：用户看到的就是「卡很久，最后报超时，远端什么都没有」。
   *
   * 同时把串行改流水线：旧实现一包一等，吞吐 ≈ `64KB / RTT`（实测海外 RTT 127ms 时约
   * 180–290 KB/s，而本机上行有 620–740 KB/s，时间都花在等往返上）。这里维持
   * `UPLOAD_CONCURRENCY` 个 WRITE 同时在途。SFTP 按 reqid 多路复用，同一句柄并发写是
   * 协议允许的——ssh2 自己的 fastXfer（fastPut）就是这么干的。
   *
   * 完成判据用 **CLOSE 的回调**：服务端确认句柄关闭后数据才算落盘，此时报 done 才不会说谎。
   */
  private pipeUpload(
    transferId: string,
    direction: "upload",
    name: string,
    options: { localPath: string; total: number; timeoutMs?: number; remotePath: string; onCleanup(): void }
  ): Promise<number> {
    return new Promise<number>((resolveDone, rejectDone) => {
      const total = options.total;
      const timeoutMs = Math.min(SFTP_MAX_TIMEOUT_MS, Math.max(1_000, Math.round(options.timeoutMs ?? SFTP_DEFAULT_TIMEOUT_MS)));

      // 本地读流按「一块」为单位产出。不用 pipe：我们要的是「在途 WRITE 达配额就停」
      // 的反压语义，交给流自己 pipe 会把数据无节制地灌进内存排队。
      const source = createReadStream(options.localPath, { highWaterMark: UPLOAD_CHUNK_BYTES });

      let handle: Buffer | undefined;
      let offset = 0;
      let inflight = 0;
      let transferred = 0;
      let settled = false;
      let cancelled = false;
      let lastPublishedAt = 0;
      let sourceEnded = false;

      const teardown = (): void => {
        clearTimeout(timer);
        source.destroy();
        // 成功路径由 closeWhenDrained 关句柄；失败/取消路径在这里补一刀，避免句柄泄漏。
        if (handle) {
          const closing = handle;
          handle = undefined;
          try { this.sftp.close(closing, () => { /* 失败路径的关闭结果无关紧要 */ }); } catch { /* 幂等 */ }
        }
      };

      const fail = (error: Error, state: "error" | "cancelled"): void => {
        if (settled) return;
        settled = true;
        teardown();
        options.onCleanup();
        this.publishState(transferId, direction, name, transferred, total, state, { error: error.message });
        rejectDone(error);
      };

      const timer = setTimeout(() => {
        cancelled = true;
        fail(new Error(`传输超时（${Math.round(timeoutMs / 1000)} 秒），已中止并清理未完成的文件`), "error");
      }, timeoutMs);

      // 注册真实中断器，供 cancel() 调用；并兑现注册之前收到的取消请求。
      if (this.active && this.active.transferId === transferId) {
        this.active.cancel = () => {
          if (settled) return;
          cancelled = true;
          fail(new Error("传输已取消"), "cancelled");
        };
        if (this.pendingCancelId === transferId) this.active.cancel();
      }

      source.on("error", (error: Error) => fail(error, cancelled ? "cancelled" : "error"));

      const publishProgress = (): void => {
        const now = Date.now();
        if (now - lastPublishedAt >= PROGRESS_INTERVAL_MS) {
          lastPublishedAt = now;
          this.publishState(transferId, direction, name, transferred, total, "running");
        }
      };

      /** 所有块写清、本地也读完 → CLOSE，等它的回调才算成功。 */
      const closeWhenDrained = (): void => {
        if (settled || !handle) return;
        const closing = handle;
        handle = undefined;
        this.sftp.close(closing, (error) => {
          if (settled) return;
          if (error) {
            fail(error, cancelled ? "cancelled" : "error");
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolveDone(transferred);
        });
      };

      /** 一块写完后：补派下一块（维持配额），或收尾。 */
      const onWriteDone = (error: Error | undefined): void => {
        inflight -= 1;
        if (error) {
          fail(error, cancelled ? "cancelled" : "error");
          return;
        }
        if (settled) return;
        if (sourceEnded && inflight === 0) {
          closeWhenDrained();
          return;
        }
        pump();
      };

      /** 派一块：截取当前偏移处的字节，占用一个在途名额。 */
      const dispatch = (chunk: Buffer): void => {
        const activeHandle = handle;
        if (!activeHandle) return;
        const position = offset;
        offset += chunk.length;
        inflight += 1;
        transferred += chunk.length;
        publishProgress();
        this.sftp.write(activeHandle, chunk, 0, chunk.length, position, (error) => {
          onWriteDone(error ?? undefined);
        });
      };

      /**
       * 在配额内尽量多派块。用显式 read() 而不是 data 事件：暂停/恢复的时机由我们
       * 自己掌握（在途数达配额就停手），不必和流内部缓冲抢节奏。
       */
      const pump = (): void => {
        if (settled) return;
        while (!sourceEnded && inflight < UPLOAD_CONCURRENCY) {
          const chunk = source.read() as Buffer | null;
          if (chunk === null) break; // 暂无数据，等 readable 事件再试
          dispatch(chunk);
        }
        // 本地读完 + 在途清空：可能是空文件，也可能是最后一块刚好写完。
        if (!settled && sourceEnded && inflight === 0) closeWhenDrained();
      };

      source.on("readable", () => pump());
      source.on("end", () => {
        sourceEnded = true;
        pump();
      });

      this.sftp.open(options.remotePath, "w", (error, openedHandle) => {
        if (settled) return;
        if (error || !openedHandle) {
          fail(error ?? new Error(`无法在远端创建文件：${options.remotePath}`), cancelled ? "cancelled" : "error");
          return;
        }
        handle = openedHandle;
        // open 之前可读流可能已经攒好数据甚至读完（事件早于回调到达）：显式补一轮，
        // 否则空文件与小文件会停在这里等一个永不到来的 readable。
        pump();
      });
    });
  }

  /**
   * 核心 pipe：读流 → 写流，按字节计进度（节流推送），支持取消/超时。
   * **仅用于下载**（远端读 → 本地 fs 写）：下载方向的写流是 Node 的 fs.WriteStream，
   * 它会正常发 finish，因此这里的完成判据成立。上传方向见 pipeUpload。
   */
  private pipeTransfer(
    transferId: string,
    direction: "upload" | "download",
    name: string,
    options: {
      total?: number;
      timeoutMs?: number;
      createLocalRead?: () => NodeJS.ReadableStream;
      createRemoteRead?: () => NodeJS.ReadableStream;
      createLocalWrite?: () => NodeJS.WritableStream;
      createRemoteWrite?: () => NodeJS.WritableStream;
      onCleanup(): void;
    }
  ): Promise<number> {
    return new Promise<number>((resolveDone, rejectDone) => {
      const total = options.total ?? 0;
      const timeoutMs = Math.min(SFTP_MAX_TIMEOUT_MS, Math.max(1_000, Math.round(options.timeoutMs ?? SFTP_DEFAULT_TIMEOUT_MS)));

      let read: NodeJS.ReadableStream;
      let write: NodeJS.WritableStream;
      let transferred = 0;
      let settled = false;
      let cancelled = false;
      let lastPublishedAt = 0;

      const teardown = (): void => {
        clearTimeout(timer);
        read?.unpipe?.(write);
        // NodeJS 的流类型声明未暴露 destroy（它在实现上存在：fs 流与 ssh2 流都有）。
        const destroy = (stream: unknown): void => {
          const candidate = stream as { destroy?: () => void };
          try { candidate.destroy?.(); } catch { /* 已销毁属幂等路径 */ }
        };
        destroy(read);
        destroy(write);
      };

      const fail = (error: Error, state: "error" | "cancelled"): void => {
        if (settled) return;
        settled = true;
        teardown();
        options.onCleanup();
        this.publishState(transferId, direction, name, transferred, total, state, { error: error.message });
        rejectDone(error);
      };

      // 不在这里 publish done：终态由调用方在**半成品改名成功后**发布
      //（下载要带 relativePath，且改名失败时不能误报 done）。
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveDone(transferred);
      };

      const timer = setTimeout(() => {
        cancelled = true;
        fail(new Error(`传输超时（${Math.round(timeoutMs / 1000)} 秒），已中止并清理未完成的文件`), "error");
      }, timeoutMs);

      try {
        read = (options.createLocalRead ?? options.createRemoteRead)!();
        write = (options.createLocalWrite ?? options.createRemoteWrite)!();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)), "error");
        return;
      }

      // 注册真实中断器，供 cancel() 调用；并兑现注册之前收到的取消请求。
      if (this.active && this.active.transferId === transferId) {
        this.active.cancel = () => {
          if (settled) return;
          cancelled = true;
          fail(new Error("传输已取消"), "cancelled");
        };
        if (this.pendingCancelId === transferId) this.active.cancel();
      }

      read.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        transferred += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
        const now = Date.now();
        if (now - lastPublishedAt >= PROGRESS_INTERVAL_MS) {
          lastPublishedAt = now;
          this.publishState(transferId, direction, name, transferred, total, "running");
        }
      });
      read.on("error", (error: Error) => fail(error, cancelled ? "cancelled" : "error"));
      write.on("error", (error: Error) => fail(error, cancelled ? "cancelled" : "error"));

      // 本地读 → 远端写（上传）：写流 finish 表示远端收完；远端写流 close 亦兜底。
      // 远端读 → 本地写（下载）：写流 finish 表示本地落盘完成。
      // 完成信号只看写流 finish：这是标准 WritableStream 语义（本地上传读流读完后
      // pipe 会自动 end 远端写流，远端收完发 finish）。**不监听 close 兜底**——ssh2 的
      //远端 WriteStream 显式设了 `emitClose = false`（lib/protocol/SFTP.js:3846，
      //注释 "For backwards compat do not emit close on destroy"），根本不会发 close；
      //为此写一个永不触发的兜底只会误导后人（且若它真的在静默中止时发 close，
      //兜底就会把失败误报成成功）。写流始终不发 finish 时由超时兜底。
      write.on("finish", () => succeed());

      read.pipe(write);
    });
  }
}

/**
 * 在本地目录里为 `<name>` 争取一个不冲突的 `.part` 占位名。
 * 用 `wx` 独占创建，冲突（或并发竞态）则递增序号重试。
 */
async function reserveLocalPart(dir: string, name: string): Promise<{ finalName: string; partPath: string }> {
  const taken = new Set<string>();
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = nextAvailableName(name, taken);
    // 最终名已被占用 ⇒ 换下一个序号（否则后面的 rename 会覆盖它）。
    if (await pathExists(join(dir, candidate))) {
      taken.add(candidate);
      continue;
    }
    const partPath = join(dir, `.${candidate}.part`);
    try {
      const handle = await open(partPath, "wx");
      await handle.close();
      return { finalName: candidate, partPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      taken.add(candidate);
    }
  }
  throw new Error(`无法为 ${name} 找到可用的本地文件名（同名文件过多）`);
}

/** 存在性判据（fs.stat，出错一律当不存在）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 把 ssh2 的 SFTP 错误转成可行动文案（原始 message 保留在末尾便于排查）。 */
export function describeSftpError(error: Error, prefix: string): string {
  // ssh2 把 SFTP 状态码作为 error.code 抛出（数字），Node 的 fs 错误则是字符串码
  //（ENOENT 等）——两者都要容纳，故按 unknown 取值后再收敛。
  const raw = (error as { code?: unknown }).code;
  const hint =
    raw === 2 ? "（路径不存在）"
    : raw === 3 ? "（权限不足）"
    : raw === 4 ? "（服务器拒绝该操作）"
    : raw === 8 ? "（服务器不支持该操作——可能未启用 SFTP）"
    : "";
  return `${prefix}${hint}：${error.message}`;
}
