// 端到端回归：真实 ssh2 Server + 真实 Client 跑 SshConnectionManager 的 resize 通路。
//
// 为什么值得留在仓库：ssh-connections.ts 里 `new Ssh2Client() as unknown as SshClientLike`
// 这层断言让 tsc **无法**校验真实 Client 的 `shell()` 与 `Channel#setWindow` 参数顺序是否
// 与我们的包装一致。2026-10-03 的 bug 正是这里：ssh2 的签名是
// `Channel.setWindow(rows, cols, height, width)`（报文里才是 cols 在前，见
// node_modules/ssh2/lib/Channel.js:221 + lib/protocol/Protocol.js:1151），我们按
// cols 在前下发 ⇒ 远端 PTY 的列数 = 本地行数，用户看到的是「拖宽 SSH 终端后输出
// 卡在旧列数、右侧留白，缩小却会换行」。
//
// 本用例把参数顺序变成**真实协议契约**：服务端记录 pty-req 与 window-change 报文里
// 解析出的 cols/rows（ssh2 服务端解析结果，见 lib/protocol/handlers.misc.js:1123），
// 断言它们等于渲染端要求的值。把调用点换回旧顺序，本用例转红（已反向验证）。
// 全程本机回环，无外部依赖。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Server, utils } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";

import { SshConnectionManager, fingerprintOfHostKey, type SshClientLike } from "./ssh-connections.js";
import { createSshHostStore, type SshHostCrypto } from "./ssh-host-store.js";
import { createSshKnownHostsStore } from "./ssh-known-hosts.js";

/** 服务端 pty-req 解析结果（term 在 ssh2 里随报文一起给出）。 */
interface ServerPtyInfo {
  term?: string;
  cols: number;
  rows: number;
}

/** 服务端 window-change 解析结果（handlers.misc.js:1130 的顺序）。 */
interface ServerWindowChangeInfo {
  cols: number;
  rows: number;
}

interface AuthContext {
  method: string;
  username: string;
  password?: string;
  accept(): void;
  reject(methods?: string[]): void;
}

const testDirs: string[] = [];
afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("real ssh2 end-to-end window-change", () => {
  it("远端 PTY 收到的 cols/rows 等于面板要求的尺寸（拖宽跟随）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-ssh-window-e2e-"));
    testDirs.push(tmp);
    const hostKey = utils.generateKeyPairSync("ed25519").private;

    const ptyRequests: ServerPtyInfo[] = [];
    const windowChanges: ServerWindowChangeInfo[] = [];

    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on("authentication", (ctx: AuthContext) => {
        if (ctx.method === "password" && ctx.username === "u" && ctx.password === "p") ctx.accept();
        else ctx.reject();
      });
      client.on("ready", () => {
        client.on("session", (accept: () => unknown) => {
          const session = accept() as {
            on(event: "pty", listener: (acceptPty: () => void, rejectPty: () => void, info: ServerPtyInfo) => void): void;
            on(event: "window-change", listener: (acceptWc: undefined, rejectWc: undefined, info: ServerWindowChangeInfo) => void): void;
            on(event: "shell", listener: (acceptShell: () => { write(data: string): void; on(event: string, listener: (...args: never[]) => void): unknown }) => void): void;
          };
          session.on("pty", (acceptPty, _rejectPty, info) => {
            ptyRequests.push({ term: info.term, cols: info.cols, rows: info.rows });
            acceptPty();
          });
          // window-change 不请求回复（客户端走的是 Channel#setWindow 的无 wantReply 分支），
          // 所以服务端回调只会拿到 info——没有 accept 可调。
          session.on("window-change", (_acceptWc, _rejectWc, info) => {
            windowChanges.push({ cols: info.cols, rows: info.rows });
          });
          session.on("shell", (acceptShell) => {
            const stream = acceptShell();
            stream.write("remote shell ready\r\n");
          });
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const crypto: SshHostCrypto = {
      encrypt: (plain) => ({ secret: `enc:${Buffer.from(plain).toString("base64")}`, insecure: false }),
      decrypt: (secret) => (secret.startsWith("enc:") ? Buffer.from(secret.slice(4), "base64").toString("utf8") : ""),
      isAvailable: () => true
    };
    const hostStore = createSshHostStore({ filePath: join(tmp, "hosts.json"), crypto });
    hostStore.save({ name: "loopback", host: "127.0.0.1", username: "u", port }, "p");

    // 预置指纹（等同于用户已在这台主机上点过「信任」）：直连成功，不走 TOFU 探测——
    // 探测连接的握手失败会在 ssh2 服务端抛未捕获的 KEY_EXCHANGE_FAILED（探测通道
    // 已由 ssh-connections.test.ts 覆盖，这里只要 resize 通路）。
    const knownHosts = createSshKnownHostsStore(join(tmp, "known.json"));
    const publicKey = (utils.parseKey(hostKey) as { getPublicSSH(): Buffer }).getPublicSSH();
    knownHosts.put("127.0.0.1", port, fingerprintOfHostKey(publicKey));

    const published: Array<{ type: string; status?: string }> = [];
    const manager = new SshConnectionManager({
      createClient: () => new Client() as unknown as SshClientLike,
      hostStore,
      knownHosts,
      publish: (_terminalId, event) => published.push(event as { type: string; status?: string }),
      reveal: () => {},
      scheduleFlush: (callback) => {
        const timer = setTimeout(callback, 0);
        return () => clearTimeout(timer);
      }
    });

    const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("e2e 等待超时");
    };

    try {
      const hosts = manager.handle({ type: "hosts" });
      const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
      expect(hostId).toBeTruthy();

      manager.handle({ type: "connect", terminalId: "e2e", hostId, cols: 100, rows: 30 });
      await waitFor(() => published.some((event) => event.type === "status" && event.status === "connected"));
      expect(ptyRequests).toEqual([{ term: "xterm-256color", cols: 100, rows: 30 }]);

      // 用户把预览面板拖宽 → 渲染端发 resize。远端必须真的收到新列数。
      manager.handle({ type: "resize", terminalId: "e2e", cols: 132, rows: 37 });
      await waitFor(() => windowChanges.length > 0);
      expect(windowChanges.at(-1)).toEqual({ cols: 132, rows: 37 });

      // 再拖窄一次，确认双向都对（顺序写反时这里同样会红）。
      manager.handle({ type: "resize", terminalId: "e2e", cols: 88, rows: 24 });
      await waitFor(() => windowChanges.length > 1);
      expect(windowChanges.at(-1)).toEqual({ cols: 88, rows: 24 });
    } finally {
      manager.handle({ type: "kill", terminalId: "e2e" });
      server.close();
    }
  }, 30_000);
});
