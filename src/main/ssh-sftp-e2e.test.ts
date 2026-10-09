// 端到端回归：真实 ssh2 Server + 真实 SFTPWrapper 跑 SshSftpTransferService.upload。
//
// 为什么值得留在仓库：ssh-connections.ts 里 `new Ssh2Client() as unknown as SshClientLike`
// 这层断言让 tsc **无法**校验真实 SFTPWrapper 是否满足 SshSftpLike。本用例用真实
// ssh2 Server + Client 在 127.0.0.1 上跑一遍上传，把那个类型假设变成可执行的契约。
// 它同时是三条硬约束的守卫（都已反向验证会转红）：
// ① 完成判据不依赖 WriteStream.finish（改回等 finish 会以「传输超时」转红）；
// ② OPEN 回调到达前不读本地流（旧实现会把块丢掉：内容 sha 不一致/文件变短）；
// ③ 卡住时先核对远端大小（最后一个 CLOSE 确认没回来时，完整文件不能被删）。
// 全程本机回环，无外部依赖。
import { mkdtempSync, openSync, writeSync, closeSync, readSync, statSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Server, Client, utils } from "ssh2";
import { describe, expect, it } from "vitest";

import { SshSftpTransferService, type SftpTransferOutcome } from "./ssh-sftp.js";

// ssh2 的 sftp 子模块在 ESM 互操作下取不到，直接写字面量（与 SFTP.js 一致）。
const OPEN_MODE = { READ: 1, WRITE: 2 } as const;
const STATUS_CODE = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, FAILURE: 4 } as const;

/**
 * @types/ssh2 只声明了客户端侧的 SFTPWrapper，服务端子模块（handle/status/data/name/
 * attrs）没有类型。这里给探针一个最小结构视图，避免整文件退化成 any。
 */
interface SftpServerSide {
  on(event: "OPEN", listener: (reqid: number, filename: string, flags: number) => void): SftpServerSide;
  on(event: "WRITE", listener: (reqid: number, handle: Buffer, offset: number, data: Buffer) => void): SftpServerSide;
  on(event: "READ", listener: (reqid: number, handle: Buffer, offset: number, length: number) => void): SftpServerSide;
  on(event: "CLOSE", listener: (reqid: number, handle: Buffer) => void): SftpServerSide;
  on(event: "REALPATH", listener: (reqid: number, p: string) => void): SftpServerSide;
  on(event: "STAT", listener: (reqid: number, p: string) => void): SftpServerSide;
  on(event: "OPENDIR", listener: (reqid: number) => void): SftpServerSide;
  handle(reqid: number, handle: Buffer): void;
  status(reqid: number, code: number): void;
  data(reqid: number, data: Buffer | string): void;
  name(reqid: number, names: Array<{ filename: string; longname: string; attrs: Record<string, unknown> }>): void;
  attrs(reqid: number, attrs: Record<string, unknown>): void;
}

interface AuthContext {
  method: string;
  username: string;
  password?: string;
  accept(): void;
  reject(methods?: string[]): void;
}

interface ServerOptions {
  /** OPEN 的 HANDLE 确认延迟：模拟真实链路的 RTT（暴露「句柄就绪前读流」的丢块）。 */
  openDelayMs?: number;
  /** 服务端做完 CLOSE（数据落盘）但不回 STATUS：模拟「最后一个确认丢失」。 */
  skipCloseStatus?: boolean;
}

/** 起一台真实 ssh2 SFTP 服务端（回环）。 */
async function startServer(options: ServerOptions = {}): Promise<{ port: number; remoteRoot: string; stop(): void; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "pi-e2e-"));
  const remoteRoot = join(tmp, "remote");
  mkdirSync(remoteRoot, { recursive: true });
  const hostKey = utils.generateKeyPairSync("ed25519").private;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx: AuthContext) => {
      if (ctx.method === "password" && ctx.username === "u" && ctx.password === "p") ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept: () => unknown) => {
        const session = accept() as { on(event: "sftp", listener: (acceptSftp: () => SftpServerSide) => void): void };
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const openFiles = new Map<number, { fd: number; path: string }>();
          let handleCount = 0;
          sftp.on("OPEN", (reqid: number, filename: string, flags: number) => {
            const local = join(remoteRoot, basename(filename));
            const fd = openSync(local, (flags & OPEN_MODE.READ) ? "r" : "w");
            const handle = Buffer.alloc(4);
            openFiles.set(handleCount, { fd, path: local });
            handle.writeUInt32BE(handleCount, 0);
            handleCount += 1;
            if (options.openDelayMs) setTimeout(() => sftp.handle(reqid, handle), options.openDelayMs);
            else sftp.handle(reqid, handle);
          }).on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            const rec = openFiles.get(handle.readUInt32BE(0));
            if (!rec) return sftp.status(reqid, STATUS_CODE.FAILURE);
            writeSync(rec.fd, data, 0, data.length, Number(offset));
            sftp.status(reqid, STATUS_CODE.OK);
          }).on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
            const rec = openFiles.get(handle.readUInt32BE(0));
            if (!rec) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const buf = Buffer.alloc(length);
            const n = readSync(rec.fd, buf, 0, length, Number(offset));
            if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, buf.subarray(0, n));
          }).on("CLOSE", (reqid: number, handle: Buffer) => {
            const rec = openFiles.get(handle.readUInt32BE(0));
            if (rec) { closeSync(rec.fd); openFiles.delete(handle.readUInt32BE(0)); }
            // 数据已落盘；只在需要模拟「确认丢失」时不回 STATUS。
            if (!options.skipCloseStatus) sftp.status(reqid, STATUS_CODE.OK);
          }).on("REALPATH", (reqid: number, _p: string) => {
            sftp.name(reqid, [{ filename: remoteRoot, longname: remoteRoot, attrs: {} }]);
          }).on("STAT", (reqid: number, p: string) => {
            const local = join(remoteRoot, basename(p));
            if (!existsSync(local)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftp.attrs(reqid, { mode: 0o100644, uid: 0, gid: 0, size: statSync(local).size, atime: 0, mtime: 0 });
          }).on("OPENDIR", (reqid: number) => {
            sftp.status(reqid, STATUS_CODE.FAILURE);
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, remoteRoot, tmp, stop: () => { server.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

/** 写一个带花纹的本地文件（全同字节的文件无法暴露内容错位）。 */
function writeLocalFile(path: string, sizeBytes: number): void {
  const fd = openSync(path, "w");
  const block = Buffer.alloc(256 * 1024);
  for (let i = 0; i < Math.max(1, Math.ceil(sizeBytes / block.length)); i += 1) {
    for (let j = 0; j < block.length; j += 1) block[j] = (i * 31 + j * 7) % 251;
    const remaining = sizeBytes - i * block.length;
    writeSync(fd, remaining >= block.length ? block : block.subarray(0, remaining));
  }
  closeSync(fd);
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** 用真实 SFTPWrapper 跑一次上传（结构类型断言在这里被真正执行）。 */
function uploadWithRealSftp(options: {
  port: number;
  localPath: string;
  remoteDir: string;
  remoteName: string;
  timeoutMs?: number;
}): Promise<SftpTransferOutcome> {
  return new Promise<SftpTransferOutcome>((resolve, reject) => {
    const client = new Client();
    client.on("ready", () => {
      client.sftp((err, realSftp) => {
        if (err) return reject(err);
        // 关键：这里传的是**真实**的 SFTPWrapper，而不是测试假件——
        // 若结构类型假设错了（方法名/回调形状不符），这里会直接炸。
        const svc = new SshSftpTransferService({
          sftp: realSftp as never,
          terminalId: "e2e",
          publish: () => {}
        });
        svc.upload("e2e", {
          localPath: options.localPath,
          remoteDir: options.remoteDir,
          remoteName: options.remoteName,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
        })
          .then((out) => { client.end(); resolve(out); })
          .catch((e: Error) => { client.end(); reject(e); });
      });
    });
    client.on("error", reject);
    client.connect({ host: "127.0.0.1", port: options.port, username: "u", password: "p" });
  });
}

describe("real ssh2 end-to-end upload", () => {
  it("uploads through a real SFTPWrapper without relying on finish", async () => {
    const server = await startServer();
    const localPath = join(server.tmp, "payload.bin");
    writeLocalFile(localPath, 5 * 1024 * 1024);

    const outcome = await uploadWithRealSftp({
      port: server.port,
      localPath,
      remoteDir: server.remoteRoot,
      remoteName: "payload.bin",
      timeoutMs: 30_000
    });

    const remotePath = join(server.remoteRoot, "payload.bin");
    expect(outcome.bytes).toBe(5 * 1024 * 1024);
    expect(statSync(remotePath).size).toBe(5 * 1024 * 1024);
    // 内容也必须一致：只比大小会漏掉「丢了开头一块、后面顺移」这类损坏。
    expect(sha256(remotePath)).toBe(sha256(localPath));
    expect(outcome.note).toBeUndefined();

    server.stop();
  }, 60_000);

  it("loses no bytes while the remote handle is still opening", async () => {
    // OPEN 的确认故意晚 250ms：本地读流早就把数据递上来了。旧实现会在这段窗口里读流
    // 并把块丢掉（回环实测会随机丢 1–2 块、RTT 大时整文件丢光），现在一个字节都不许丢。
    const server = await startServer({ openDelayMs: 250 });
    const localPath = join(server.tmp, "rtt.bin");
    writeLocalFile(localPath, 1024 * 1024 + 4096);

    const outcome = await uploadWithRealSftp({
      port: server.port,
      localPath,
      remoteDir: server.remoteRoot,
      remoteName: "rtt.bin",
      timeoutMs: 30_000
    });

    const remotePath = join(server.remoteRoot, "rtt.bin");
    expect(outcome.bytes).toBe(1024 * 1024 + 4096);
    expect(statSync(remotePath).size).toBe(1024 * 1024 + 4096);
    expect(sha256(remotePath)).toBe(sha256(localPath));

    server.stop();
  }, 60_000);

  it("keeps a complete remote file when the CLOSE confirmation never comes", async () => {
    // 用户报的「上传完了就是不结束，像没有结束标识」：数据全落盘了，只是最后一个 STATUS
    // 没回来。旧实现在超时后 unlink——把一份好文件删掉。现在按远端大小核对为成功。
    const server = await startServer({ skipCloseStatus: true });
    const localPath = join(server.tmp, "ackless.bin");
    writeLocalFile(localPath, 64 * 1024);

    const outcome = await uploadWithRealSftp({
      port: server.port,
      localPath,
      remoteDir: server.remoteRoot,
      remoteName: "ackless.bin",
      timeoutMs: 1_000
    });

    const remotePath = join(server.remoteRoot, "ackless.bin");
    expect(existsSync(remotePath)).toBe(true);
    expect(outcome.bytes).toBe(64 * 1024);
    expect(outcome.note).toContain("已核对一致");
    expect(sha256(remotePath)).toBe(sha256(localPath));

    server.stop();
  }, 60_000);
});
