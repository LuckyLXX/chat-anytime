import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { SshEventData } from "../shared/protocol.js";
import {
  SSH_TRANSFER_MAX_BYTES,
  SshSftpTransferService,
  formatRemoteSize,
  formatRemoteTime,
  nextAvailableName,
  remoteEntryKind,
  remoteJoin,
  remoteParent,
  safeRemoteName,
  sortRemoteEntries,
  toRemoteEntries,
  type SshRemoteStats,
  type SshRemoteStatsEntry,
  type SshSftpLike
} from "./ssh-sftp.js";

// —— 纯函数 ——

function fakeStats(overrides: Partial<SshRemoteStats> = {}): SshRemoteStats {
  return {
    size: 0,
    mtime: 0,
    mode: 0o644,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides
  };
}

describe("ssh-sftp pure helpers", () => {
  it("joins remote paths with POSIX separators regardless of host OS", () => {
    expect(remoteJoin("/root", "a.txt")).toBe("/root/a.txt");
    expect(remoteJoin("/root/", "a.txt")).toBe("/root/a.txt");
    expect(remoteJoin("/", "a.txt")).toBe("/a.txt");
    expect(remoteJoin("", "a.txt")).toBe("/a.txt");
  });

  it("walks up one level but stays at the root", () => {
    expect(remoteParent("/root/dir")).toBe("/root");
    expect(remoteParent("/root")).toBe("/");
    expect(remoteParent("/root/")).toBe("/");
    expect(remoteParent("/")).toBe("/");
  });

  it("classifies entries with directories taking precedence for links", () => {
    expect(remoteEntryKind(fakeStats({ isDirectory: () => true, isFile: () => false }))).toBe("directory");
    expect(remoteEntryKind(fakeStats())).toBe("file");
    expect(remoteEntryKind(fakeStats({ isFile: () => false, isSymbolicLink: () => true }))).toBe("link");
    expect(remoteEntryKind(fakeStats({ isFile: () => false }))).toBe("other");
  });

  it("sorts directories first then by name", () => {
    const entries = [
      { name: "b.txt", kind: "file" as const, size: 1, sizeText: "1 B", mtimeText: "", mtimeMs: 0 },
      { name: "zdir", kind: "directory" as const, size: 0, sizeText: "-", mtimeText: "", mtimeMs: 0 },
      { name: "adir", kind: "directory" as const, size: 0, sizeText: "-", mtimeText: "", mtimeMs: 0 },
      { name: "a.txt", kind: "file" as const, size: 1, sizeText: "1 B", mtimeText: "", mtimeMs: 0 }
    ];
    expect(sortRemoteEntries(entries).map((entry) => entry.name)).toEqual(["adir", "zdir", "a.txt", "b.txt"]);
  });

  it("formats sizes readably and hides directory sizes", () => {
    expect(formatRemoteSize(0, "file")).toBe("0 B");
    expect(formatRemoteSize(512, "file")).toBe("512 B");
    expect(formatRemoteSize(2048, "file")).toBe("2.0 KB");
    expect(formatRemoteSize(5 * 1024 * 1024, "file")).toBe("5.0 MB");
    expect(formatRemoteSize(12 * 1024 * 1024 * 1024, "file")).toBe("12 GB");
    expect(formatRemoteSize(4096, "directory")).toBe("-");
  });

  it("treats SFTP mtime as Unix seconds and blanks unknown values", () => {
    // 关键口径：SFTP 的 mtime 是**秒**（ssh2 的 readUInt32BE），不是毫秒——
    // 当成毫秒会得到 1970 年的时间，是这类实现最常见的错。
    expect(formatRemoteTime(0)).toBe("");
    expect(formatRemoteTime(Number.NaN)).toBe("");
    const text = formatRemoteTime(1_700_000_000);
    expect(text).toMatch(/^2023-1[01]-\d{2} \d{2}:\d{2}$/u);
  });

  it("increments colliding names without touching the extension", () => {
    expect(nextAvailableName("a.txt", new Set())).toBe("a.txt");
    expect(nextAvailableName("a.txt", new Set(["a.txt"]))).toBe("a-1.txt");
    expect(nextAvailableName("a.txt", new Set(["a.txt", "a-1.txt"]))).toBe("a-2.txt");
    expect(nextAvailableName("noext", new Set(["noext"]))).toBe("noext-1");
  });

  it("strips directory components from remote-supplied names", () => {
    expect(safeRemoteName("passwd")).toBe("passwd");
    expect(safeRemoteName("../../etc/passwd")).toBe("passwd");
    expect(safeRemoteName("a\\b\\c.txt")).toBe("c.txt");
    // Windows 保留名被转义，不会写成设备
    expect(safeRemoteName("CON")).not.toBe("CON");
  });

  it("maps readdir results into sorted, formatted entries", () => {
    const list: SshRemoteStatsEntry[] = [
      { filename: "b.txt", attrs: fakeStats({ size: 2048, mtime: 1_700_000_000 }) },
      { filename: "dir", attrs: fakeStats({ size: 0, isDirectory: () => true, isFile: () => false }) }
    ];
    const entries = toRemoteEntries(list);
    expect(entries.map((entry) => entry.name)).toEqual(["dir", "b.txt"]);
    expect(entries[1]!.sizeText).toBe("2.0 KB");
    expect(entries[1]!.mtimeMs).toBe(1_700_000_000_000);
  });
});

// —— 传输服务（真实 fs 流 + fake SFTP 通道）——

type Listener = (...args: never[]) => void;

class FakeSftp implements SshSftpLike {
  files = new Map<string, Buffer>();
  dirs = new Set<string>(["/"]);
  home = "/root";
  readdirCalls: string[] = [];
  unlinked: string[] = [];
  /** 远端写流入参：让测试注入慢速/出错行为。 */
  writeStreamFactory: ((path: string) => NodeJS.WritableStream) | undefined;
  readStreamFactory: ((path: string) => NodeJS.ReadableStream) | undefined;
  ended = 0;
  sftpError: Error | undefined;

  readdir(path: string, callback: (error: Error | undefined, list: SshRemoteStatsEntry[] | undefined) => void): void {
    this.readdirCalls.push(path);
    const entries: SshRemoteStatsEntry[] = [];
    for (const [filePath, bytes] of this.files) {
      if (remoteParent(filePath) === path) entries.push({ filename: filePath.split("/").pop()!, attrs: fakeStats({ size: bytes.length }) });
    }
    for (const dir of this.dirs) {
      if (dir !== path && remoteParent(dir) === path) entries.push({ filename: dir.split("/").pop()!, attrs: fakeStats({ isDirectory: () => true, isFile: () => false }) });
    }
    callback(undefined, entries);
  }

  stat(path: string, callback: (error: Error | undefined, stats: SshRemoteStats | undefined) => void): void {
    const bytes = this.files.get(path);
    if (!bytes) {
      callback(Object.assign(new Error("No such file"), { code: 2 }), undefined);
      return;
    }
    callback(undefined, fakeStats({ size: bytes.length }));
  }

  realpath(_path: string, callback: (error: Error | undefined, resolved: string | undefined) => void): void {
    callback(this.sftpError, this.sftpError ? undefined : this.home);
  }

  unlink(path: string, callback: (error: Error | undefined) => void): void {
    this.unlinked.push(path);
    this.files.delete(path);
    callback(undefined);
  }

  createReadStream(path: string): NodeJS.ReadableStream {
    if (this.readStreamFactory) return this.readStreamFactory(path);
    const bytes = this.files.get(path);
    if (!bytes) throw Object.assign(new Error("No such file"), { code: 2 });
    return Readable.from([bytes]);
  }

  createWriteStream(path: string): NodeJS.WritableStream {
    if (this.writeStreamFactory) return this.writeStreamFactory(path);
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    stream.on("finish", () => this.files.set(path, Buffer.concat(chunks)));
    return stream;
  }

  end(): void {
    this.ended += 1;
  }
}

interface Harness {
  service: SshSftpTransferService;
  sftp: FakeSftp;
  published: SshEventData[];
  dir: string;
}

const testDirs: string[] = [];
afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pidesktop-sftp-"));
  testDirs.push(dir);
  const sftp = new FakeSftp();
  const published: SshEventData[] = [];
  const service = new SshSftpTransferService({
    sftp,
    terminalId: "ssh-test",
    publish: (event) => published.push(event)
  });
  return { service, sftp, published, dir };
}

function transferStates(published: SshEventData[]): string[] {
  return published.filter((event): event is Extract<SshEventData, { type: "transfer" }> => event.type === "transfer").map((event) => event.state);
}

describe("SshSftpTransferService", () => {
  it("lists a directory with home resolution", async () => {
    const { service, sftp } = createHarness();
    sftp.files.set("/root/a.txt", Buffer.from("hello"));
    const listing = await service.list();
    expect(listing.path).toBe("/root");
    expect(listing.home).toBe("/root");
    expect(listing.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  it("uploads a local file and reports progress then done", async () => {
    const { service, sftp, published, dir } = createHarness();
    const localPath = join(dir, "payload.txt");
    writeFileSync(localPath, "upload-me");
    sftp.dirs.add("/root");

    const outcome = await service.upload("t1", { localPath, remoteDir: "/root" });
    expect(outcome.name).toBe("payload.txt");
    expect(outcome.path).toBe("/root/payload.txt");
    expect(outcome.bytes).toBe(9);
    expect(sftp.files.get("/root/payload.txt")!.toString()).toBe("upload-me");
    expect(transferStates(published).at(-1)).toBe("done");
    expect(published.at(-1)).toMatchObject({ direction: "upload", state: "done", transferred: 9 } as never);
  });

  it("increments the remote name instead of overwriting an existing file", async () => {
    const { service, sftp, dir } = createHarness();
    const localPath = join(dir, "a.txt");
    writeFileSync(localPath, "new");
    sftp.dirs.add("/root");
    sftp.files.set("/root/a.txt", Buffer.from("original"));

    const outcome = await service.upload("t1", { localPath, remoteDir: "/root" });
    expect(outcome.name).toBe("a-1.txt");
    expect(sftp.files.get("/root/a.txt")!.toString()).toBe("original");
    expect(sftp.files.get("/root/a-1.txt")!.toString()).toBe("new");
  });

  it("downloads into a .part then renames, leaving no partial file", async () => {
    const { service, sftp, dir } = createHarness();
    sftp.files.set("/root/data.bin", Buffer.from("remote-bytes"));

    const outcome = await service.download("t1", { remotePath: "/root/data.bin", localDir: dir });
    expect(outcome.name).toBe("data.bin");
    expect(readFileSync(outcome.path, "utf8")).toBe("remote-bytes");
    // 半成品必须已被改名，目录里只剩最终文件
    const names = await readdir(dir);
    expect(names).toEqual(["data.bin"]);
  });

  it("never overwrites an existing local file when downloading", async () => {
    const { service, sftp, dir } = createHarness();
    sftp.files.set("/root/data.bin", Buffer.from("fresh"));
    writeFileSync(join(dir, "data.bin"), "existing");

    const outcome = await service.download("t1", { remotePath: "/root/data.bin", localDir: dir });
    expect(outcome.name).toBe("data-1.bin");
    expect(readFileSync(join(dir, "data.bin"), "utf8")).toBe("existing");
    expect(readFileSync(outcome.path, "utf8")).toBe("fresh");
  });

  it("rejects files above the transfer cap before touching the network", async () => {
    const { service, sftp, dir } = createHarness();
    const localPath = join(dir, "huge.bin");
    // 稀疏文件：只改逻辑大小，不真的写入 500MB。
    const handle = await open(localPath, "w");
    await handle.truncate(SSH_TRANSFER_MAX_BYTES + 1);
    await handle.close();
    expect((await stat(localPath)).size).toBeGreaterThan(SSH_TRANSFER_MAX_BYTES);

    await expect(service.upload("t1", { localPath, remoteDir: "/root" })).rejects.toThrow("超过单次传输上限");
    // 超限在 stat 阶段就拒绝，不应发出任何目录查询
    expect(sftp.readdirCalls).toHaveLength(0);
  });

  it("cleans up the remote half-file when an upload errors", async () => {
    const { service, sftp, dir, published } = createHarness();
    const localPath = join(dir, "x.txt");
    writeFileSync(localPath, "data");
    sftp.dirs.add("/root");
    sftp.writeStreamFactory = () => {
      const stream = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("远端写入失败")); } });
      return stream;
    };

    await expect(service.upload("t1", { localPath, remoteDir: "/root" })).rejects.toThrow("远端写入失败");
    expect(sftp.unlinked).toContain("/root/x.txt");
    expect(transferStates(published).at(-1)).toBe("error");
  });

  it("cleans up the local .part and reports cancelled on cancel", async () => {
    const { service, sftp, dir, published } = createHarness();
    sftp.files.set("/root/big.bin", Buffer.from("x".repeat(4096)));

    // 一个只抽不吐的远端读流：让传输停在半路以便取消
    let readStream: PassThrough | undefined;
    sftp.readStreamFactory = () => {
      readStream = new PassThrough();
      return readStream;
    };
    const pending = service.download("t1", { remotePath: "/root/big.bin", localDir: dir });
    await new Promise((resolve) => setTimeout(resolve, 10));
    readStream?.write(Buffer.from("partial"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.cancel("t1")).toBe(true);
    await expect(pending).rejects.toThrow("已取消");

    expect(transferStates(published).at(-1)).toBe("cancelled");
    // .part 与最终文件都不该存在
    const names = await readdir(dir);
    expect(names).toEqual([]);
  });

  it("cleans up the local .part on timeout", async () => {
    const { service, sftp, dir, published } = createHarness();
    sftp.files.set("/root/slow.bin", Buffer.from("x".repeat(4096)));
    sftp.readStreamFactory = () => new PassThrough();

    await expect(service.download("t1", { remotePath: "/root/slow.bin", localDir: dir, timeoutMs: 30 })).rejects.toThrow("传输超时");
    expect(transferStates(published).at(-1)).toBe("error");
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a second concurrent transfer on the same connection", async () => {
    const { service, sftp, dir } = createHarness();
    sftp.files.set("/root/a.bin", Buffer.from("x"));
    sftp.readStreamFactory = () => new PassThrough();
    const first = service.download("t1", { remotePath: "/root/a.bin", localDir: dir });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(service.download("t2", { remotePath: "/root/a.bin", localDir: dir })).rejects.toThrow("已有文件传输在进行中");
    service.cancel("t1");
    await expect(first).rejects.toThrow("已取消");
  });

  it("splits multi-file transfers into per-file sub ids", async () => {
    const { service, sftp, dir, published } = createHarness();
    sftp.files.set("/root/one.txt", Buffer.from("1"));
    sftp.files.set("/root/two.txt", Buffer.from("2"));

    // 直接驱动服务层多文件语义：两次独立下载（渲染端/管理器负责编号）
    await service.download("base", { remotePath: "/root/one.txt", localDir: dir });
    await service.download("base", { remotePath: "/root/two.txt", localDir: dir });
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(["one.txt", "two.txt"]);
    expect(transferStates(published).filter((state) => state === "done")).toHaveLength(2);
  });

  it("stops accepting transfers after dispose and closes the channel", async () => {
    const { service, sftp, dir } = createHarness();
    sftp.files.set("/root/a.txt", Buffer.from("x"));
    service.dispose();
    await expect(service.list()).rejects.toThrow("连接已关闭");
    await expect(service.download("t1", { remotePath: "/root/a.txt", localDir: dir })).rejects.toThrow("连接已关闭");
    expect(sftp.ended).toBe(1);
  });

  it("surfaces a clear error when the local source is missing", async () => {
    const { service, dir } = createHarness();
    await expect(service.upload("t1", { localPath: join(dir, "nope.txt"), remoteDir: "/root" })).rejects.toThrow("无法读取本地文件");
  });

  it("keeps the original error out of the cleanup path", async () => {
    const { service, sftp, dir } = createHarness();
    const localPath = join(dir, "x.txt");
    writeFileSync(localPath, "data");
    sftp.dirs.add("/root");
    sftp.writeStreamFactory = () => new Writable({ write(_c, _e, callback) { callback(new Error("原始错误")); } });
    // 远端 unlink 也失败：不得让清理错误掩盖原始错误
    sftp.unlink = (_path: string, callback: (error: Error | undefined) => void) => callback(new Error("清理也失败了"));

    await expect(service.upload("t1", { localPath, remoteDir: "/root" })).rejects.toThrow("原始错误");
  });
});

describe("SshSftpTransferService file access sanity", () => {
  it("writes the downloaded file to a readable path", async () => {
    const { service, sftp, dir } = createHarness();
    sftp.files.set("/root/ok.txt", Buffer.from("fine"));
    const outcome = await service.download("t1", { remotePath: "/root/ok.txt", localDir: join(dir, "nested") });
    await expect(access(outcome.path)).resolves.toBeUndefined();
  });
});
