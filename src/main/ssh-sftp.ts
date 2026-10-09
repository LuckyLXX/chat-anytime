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
 * - **句柄就绪前不读本地流**：FS 读流几乎立刻有数据，而 OPEN 要等一个 RTT；读了却
 *   无处可写就是静默丢块（远端文件变短却报成功，2026-10-09 修）。
 * - **超时是空闲口径**：一段时间内没有任何字节被确认才算卡住；到点先 `stat` 远端，
 *   字节数与预期一致就判成功并保留文件（最后一个确认丢失时不该删掉一份好文件）。
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

/** 传输默认/最大等待（与 ssh_exec 同量级，但传输普遍更久，故单独放宽）。
 *
 * 口径是**空闲超时**（「多久没有字节进展」），不是总时长：旧实现把它当总时长预算，导致
 * 「进度正常但链路慢」的大文件到点就被判死（连半成品一起删）。默认 60 秒——正常链路
 * 几毫秒就有一个确认，一分钟没有任何字节被确认就是真卡住了（用户 2026-10-09 报的现象：
 * 最后一个确认没回来，一直干等到 300 秒才报超时）。 */
export const SFTP_DEFAULT_TIMEOUT_MS = 60_000;
/** 空闲预算的可调区间（秒级），也是任何单次传输的**总时长上限**基准。 */
export const SFTP_MAX_TIMEOUT_MS = 1_800_000;
/** 空闲/总时长到点后核对远端文件大小的短看门狗：核对本身不能再挂住。 */
const STALL_VERIFY_TIMEOUT_MS = 15_000;

/** 空闲预算收敛：下限 1 秒（单测要能跑到），上限 SFTP_MAX_TIMEOUT_MS。 */
function resolveIdleTimeout(timeoutMs?: number): number {
  return Math.min(SFTP_MAX_TIMEOUT_MS, Math.max(1_000, Math.round(timeoutMs ?? SFTP_DEFAULT_TIMEOUT_MS)));
}

/**
 * 传输进度计时器：**空闲超时** + 总时长上限（兜底，防「一直在慢慢爬」无限期占住调用）。
 *
 * 每次有字节进展（派出 WRITE / 收到 WRITE 确认）就重置空闲计时器：只要还在动就一直放行，
 * 真正一动不动超过 idleMs 才算卡住。旧实现只有一个总时长计时器，于是两种误判同时存在：
 * 正常但慢的传输被总时长判死（并删掉半成品），而真卡死也要干等到总时长才报。
 */
function createProgressTimers(options: { idleMs: number; totalMs: number; onIdle(): void; onTotal(): void }): { touch(): void; stop(): void } {
  let idleTimer = setTimeout(options.onIdle, options.idleMs);
  const totalTimer = setTimeout(options.onTotal, options.totalMs);
  return {
    touch(): void {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(options.onIdle, options.idleMs);
    },
    stop(): void {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
    }
  };
}

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
  /** 降级完成时的说明（目前只在上传「按远端大小核对」路径出现，供回执如实交代）。 */
  note?: string;
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
      const result = await this.pipeUpload(transferId, "upload", finalName, {
        localPath: request.localPath,
        total: size,
        timeoutMs: request.timeoutMs,
        remotePath,
        onCleanup: () => this.removeRemote(remotePath)
      });
      this.publishState(transferId, "upload", finalName, result.bytes, size, "done");
      return {
        name: finalName,
        bytes: result.bytes,
        path: remotePath,
        // 降级完成（最后一个确认未回、已按远端大小核对）必须如实交代，不能当作正常路径。
        ...(result.recoveredBySizeCheck
          ? { note: "远端字节数已核对一致，但最后一个传输确认未收到（链路/服务端未回 STATUS）——按成功处理，远端文件保留。" }
          : {})
      };
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

  /**
   * 远端文件大小。timeoutMs 给定时加一层短看门狗（核对路径用）：stat 自己也可能挂住，
   * 而它跑在「已经超时」的分支上，不能再把整个调用拖住。
   */
  private remoteSize(remotePath: string, timeoutMs?: number): Promise<number | undefined> {
    return new Promise((resolveSize) => {
      let settled = false;
      const finish = (value: number | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveSize(value);
      };
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(undefined), timeoutMs);
      try {
        this.sftp.stat(remotePath, (error, stats) => {
          finish(error || !stats ? undefined : stats.size);
        });
      } catch {
        finish(undefined);
      }
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
   *
   * 另一条硬约束（2026-10-09 修）：**OPEN 回调到达之前不读本地流**。读流几乎立刻
   * 出数据，而 OPEN 要等一个 RTT；旧实现在这段窗口里照读并把块丢掉，RTT 越大丢得
   * 越多（真机实测 100ms RTT 下整文件丢光、报「上传成功 0 字节」）。
   *
   * 超时口径（2026-10-09 用户报「上传完了就是不结束，像没有结束标识」）：空闲超时 +
   * **到点先核对远端文件大小**。最后一个确认（WRITE/CLOSE 的 STATUS）没回来时，远端
   * 文件往往已经完整；旧实现到点就 unlink，把一份好文件删掉。
   */
  private pipeUpload(
    transferId: string,
    direction: "upload",
    name: string,
    options: { localPath: string; total: number; timeoutMs?: number; remotePath: string; onCleanup(): void }
  ): Promise<{ bytes: number; recoveredBySizeCheck: boolean }> {
    return new Promise<{ bytes: number; recoveredBySizeCheck: boolean }>((resolveDone, rejectDone) => {
      const total = options.total;
      const idleMs = resolveIdleTimeout(options.timeoutMs);
      const totalMs = Math.max(SFTP_MAX_TIMEOUT_MS, idleMs);

      // 本地读流按「一块」为单位产出。不用 pipe：我们要的是「在途 WRITE 达配额就停」
      // 的反压语义，交给流自己 pipe 会把数据无节制地灌进内存排队。
      const source = createReadStream(options.localPath, { highWaterMark: UPLOAD_CHUNK_BYTES });

      let handle: Buffer | undefined;
      let offset = 0;
      let inflight = 0;
      let transferred = 0;
      /** 已从本地读出的字节数。不变量：收尾时必须 === transferred（见 closeWhenDrained）。 */
      let consumed = 0;
      let settled = false;
      let cancelled = false;
      let lastPublishedAt = 0;
      let sourceEnded = false;

      const teardown = (): void => {
        timers.stop();
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

      /**
       * 空闲/总时长到点：**先核对远端文件大小再决定生死**。
       *
       * 用户 2026-10-09 报的现象（小文件，面板与 AI 均复现）：进度走完、远端文件其实完整，
       * 但「就是不结束，像没有结束标识」——最后一个确认（CLOSE 或 WRITE 的 STATUS）
       * 没回来。旧实现到点直接 unlink，把一份好文件删掉。现在：远端字节数与预期一致
       * ⇒ 判成功（保留文件，回执里如实注明降级完成）；不一致 ⇒ 才是真失败，照旧清理。
       */
      const resolveStall = (reason: "idle" | "total"): void => {
        if (settled) return;
        const label = reason === "idle"
          ? `传输超时（${Math.round(idleMs / 1000)} 秒内没有任何字节被确认）`
          : `传输超过总时长上限（${Math.round(totalMs / 1000)} 秒）`;
        void this.remoteSize(options.remotePath, STALL_VERIFY_TIMEOUT_MS).then((remoteBytes) => {
          if (settled) return;
          if (remoteBytes !== undefined && remoteBytes === total) {
            settled = true;
            teardown(); // 顺便尽力关掉远端句柄（不等它的确认）
            resolveDone({ bytes: total, recoveredBySizeCheck: true });
            return;
          }
          fail(new Error(`${label}，已中止并清理未完成的文件`), "error");
        });
      };

      const timers = createProgressTimers({
        idleMs,
        totalMs,
        onIdle: () => resolveStall("idle"),
        onTotal: () => resolveStall("total")
      });

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
        // 收尾不变量：**从本地读出的每一个字节都必须已经派给远端**。
        // 旧实现让 pump 在 OPEN 回调之前就能读流，读到的块因 handle 未就绪被
        // `dispatch` 直接 return 丢掉（既不写也不计字节，offset 不前进）——
        // 真机实测（OpenSSH + 100ms RTT）**整个文件被丢光**却报「上传成功 0 字节」，
        // 本机回环也会随机丢 1–2 块并把文件静默截短。这里把它变成一声明确的失败
        // （远端半成品照常清理），任何「读了没写」的路径都不可能再伪装成成功。
        if (consumed !== transferred) {
          fail(new Error(`上传中止：本地已读 ${consumed} 字节，只有 ${transferred} 字节写出到远端（远端文件已清理）`), "error");
          return;
        }
        const closing = handle;
        handle = undefined;
        this.sftp.close(closing, (error) => {
          if (settled) return;
          if (error) {
            fail(error, cancelled ? "cancelled" : "error");
            return;
          }
          settled = true;
          timers.stop();
          resolveDone({ bytes: transferred, recoveredBySizeCheck: false });
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
        timers.touch(); // 收到确认＝有进展
        if (sourceEnded && inflight === 0) {
          closeWhenDrained();
          return;
        }
        pump();
      };

      /**
       * 派一块：截取当前偏移处的字节，占用一个在途名额。
       * 句柄由调用方**传入**而不是就地读 `handle`——没有句柄就没有写入口，
       * 那种「读到了却写不了」的状态在 pump 里就被挡住了，这里不存在丢弃分支。
       */
      const dispatch = (chunk: Buffer, activeHandle: Buffer): void => {
        const position = offset;
        offset += chunk.length;
        inflight += 1;
        transferred += chunk.length;
        timers.touch(); // 派出字节＝有进展
        publishProgress();
        this.sftp.write(activeHandle, chunk, 0, chunk.length, position, (error) => {
          onWriteDone(error ?? undefined);
        });
      };

      /**
       * 在配额内尽量多派块。用显式 read() 而不是 data 事件：暂停/恢复的时机由我们
       * 自己掌握（在途数达配额就停手），不必和流内部缓冲抢节奏。
       *
       * **句柄未就绪时一个字节都不读**：SFTP 的 OPEN 要等一个 RTT，而本地读流
       * 几乎立刻就有数据（'readable' 先于 open 回调到达）。旧实现照样读，读到的块
       * 无处可写被丢掉——磁盘越快、RTT 越大丢得越多（实测 RTT 100ms 时整文件丢光）。
       * 停手后读流只会缓冲到 highWaterMark 就自然反压，不会把文件灌进内存。
       */
      const pump = (): void => {
        if (settled || !handle) return;
        const activeHandle = handle;
        while (!sourceEnded && inflight < UPLOAD_CONCURRENCY) {
          const chunk = source.read() as Buffer | null;
          if (chunk === null) break; // 暂无数据，等 readable 事件再试
          consumed += chunk.length;
          dispatch(chunk, activeHandle);
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
        timers.touch();
        // pump 在句柄就绪前不读流，所以 open 之前攒下的数据（以及空文件）都停在
        // 这里：显式补一轮，否则会等一个永不到来的 readable。
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
      const idleMs = resolveIdleTimeout(options.timeoutMs);
      const totalMs = Math.max(SFTP_MAX_TIMEOUT_MS, idleMs);

      let read: NodeJS.ReadableStream;
      let write: NodeJS.WritableStream;
      let transferred = 0;
      let settled = false;
      let cancelled = false;
      let lastPublishedAt = 0;

      const teardown = (): void => {
        timers.stop();
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
        timers.stop();
        resolveDone(transferred);
      };

      const timers = createProgressTimers({
        idleMs,
        totalMs,
        onIdle: () => fail(new Error(`传输超时（${Math.round(idleMs / 1000)} 秒内没有任何数据到达），已中止并清理未完成的文件`), "error"),
        onTotal: () => fail(new Error(`传输超过总时长上限（${Math.round(totalMs / 1000)} 秒），已中止并清理未完成的文件`), "error")
      });

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
        timers.touch(); // 有数据到达＝有进展
        transferred += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
        const now = Date.now();
        if (now - lastPublishedAt >= PROGRESS_INTERVAL_MS) {
          lastPublishedAt = now;
          this.publishState(transferId, direction, name, transferred, total, "running");
        }
      });
      read.on("error", (error: Error) => fail(error, cancelled ? "cancelled" : "error"));
      write.on("error", (error: Error) => fail(error, cancelled ? "cancelled" : "error"));

      // 完成信号：**下载方向**看本地 fs 写流的 finish（标准 WritableStream 语义，可靠）。
      // 上传不走这里（见 pipeUpload）：ssh2 的远端 WriteStream 永不发 finish，且它的
      // close 也不发（`emitClose = false`，lib/protocol/SFTP.js:3846）。这里的超时是
      // 空闲口径（无数据到达才计时），不再用总时长卡正常但慢的下载。
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
