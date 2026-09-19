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
 * - **手工流式传输**（而非 ssh2 的 fastPut/fastGet）：fastXfer 内置 64 并发
 *   （lib/protocol/SFTP.js:2186），进度粒度粗、取消与半成品清理语义模糊。手工
 *   pipe 可精确按字节计进度、可中断、可清理。
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
  /** 远端写流（上传）。调用方负责 end/destroy。 */
  createWriteStream(path: string): NodeJS.WritableStream;
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
      const bytes = await this.pipeTransfer(transferId, "upload", finalName, {
        total: size,
        timeoutMs: request.timeoutMs,
        createLocalRead: () => createReadStream(request.localPath),
        createRemoteWrite: () => this.sftp.createWriteStream(remotePath),
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
    // cancel 由 pipeTransfer 覆盖为真实中断器；此处先占位，避免并发进入。
    this.active = { transferId, cancel: () => {} };
    // direction 只用于 assertUsable 之后的语义校验，当前无额外分支。
    void direction;
  }

  private finish(): void {
    this.active = undefined;
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
   * 核心 pipe：读流 → 写流，按字节计进度（节流推送），支持取消/超时。
   * 任一环节失败即销毁双向流并调用 onCleanup 清半成品，然后把**原始错误**
   * 抛给调用方（清理错误不覆盖原始错误）。
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

      // 注册真实中断器，供 cancel() 调用。
      if (this.active && this.active.transferId === transferId) {
        this.active.cancel = () => {
          if (settled) return;
          cancelled = true;
          fail(new Error("传输已取消"), "cancelled");
        };
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
