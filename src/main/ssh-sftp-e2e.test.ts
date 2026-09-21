// 端到端回归：真实 ssh2 Server + 真实 SFTPWrapper 跑 SshSftpTransferService.upload。
//
// 为什么值得留在仓库：ssh-connections.ts 里 `new Ssh2Client() as unknown as SshClientLike`
// 这层断言让 tsc **无法**校验真实 SFTPWrapper 是否满足 SshSftpLike。本用例用真实
// ssh2 Server + Client 在 127.0.0.1 上跑一遍上传，把那个类型假设变成可执行的契约。
// 它同时是「上传不依赖 WriteStream.finish」的守卫：把完成判据改回等 finish，本用例会
// 以「传输超时」转红（已反向验证）。全程本机回环，无外部依赖。
import { mkdtempSync, openSync, writeSync, closeSync, readSync, statSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Server, Client, utils } from "ssh2";
import { describe, expect, it } from "vitest";

import { SshSftpTransferService } from "./ssh-sftp.js";

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

describe("real ssh2 end-to-end upload", () => {
  it("uploads through a real SFTPWrapper without relying on finish", async () => {
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
              sftp.handle(reqid, handle);
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
              sftp.status(reqid, STATUS_CODE.OK);
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

    const localPath = join(tmp, "payload.bin");
    const buf = Buffer.alloc(1024 * 1024, 0x41);
    const fd = openSync(localPath, "w");
    for (let i = 0; i < 5; i++) writeSync(fd, buf);
    closeSync(fd);

    const outcome = await new Promise<{ bytes: number; path: string }>((resolve, reject) => {
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
          svc.upload("e2e", { localPath, remoteDir: remoteRoot, remoteName: "payload.bin", timeoutMs: 30_000 })
            .then((out) => { client.end(); resolve(out); })
            .catch((e) => { client.end(); reject(e); });
        });
      });
      client.on("error", reject);
      client.connect({ host: "127.0.0.1", port, username: "u", password: "p" });
    });

    const written = statSync(join(remoteRoot, "payload.bin")).size;
    expect(outcome.bytes).toBe(5 * 1024 * 1024);
    expect(written).toBe(5 * 1024 * 1024);

    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});
