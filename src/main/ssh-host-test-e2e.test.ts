// 端到端回归：真实 ssh2 Server + 真实 Client 跑面板「测试」的通路（`testHost`）。
//
// 为什么值得留在仓库：这条通路原来只在 ssh-connections.test.ts 里对着 fake 跑，而 fake
// 的 exec 通道是「下一微任务直接 emit('close', 0)」的理想化形状。真实 ssh2 的 exec 通道
// 是 Node 的 Readable（`Channel`），它的 close 不是在协议层 CLOSE 报文到达时立刻发出的：
// node_modules/ssh2/lib/utils.js 的 _shutdownChannel 里是
// `channel.once('end', doClose)` —— **可读端必须被消费过，'end' 才会触发**。所以不去读
// stream，就永远等不到 close：只挂 close 监听、不排水（不消费）的实现会在 20s 后报
// 「测试命令超时（远端没有应答）」。2026-11-02 用户反馈「测速基本都超时，但主机明明连得上」
// 就是这个根因——单测里的 fake 太理想，恰好绕过了它。本用例让真实 Client 对着真实
// ssh2 Server 跑完「建连 → exec → 通道关闭」，把 execRoundTrip 里的排水处理
// （`stream.on('data', …)`）删掉即转红（已反向验证）。全程本机回环，无外部依赖。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Server, utils } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";

import { SshConnectionManager, fingerprintOfHostKey, type SshClientLike } from "./ssh-connections.js";
import { createSshHostStore, type SshHostCrypto } from "./ssh-host-store.js";
import { createSshKnownHostsStore } from "./ssh-known-hosts.js";

interface AuthContext {
  method: string;
  username: string;
  password?: string;
  accept(): void;
  reject(methods?: string[]): void;
}

/** 服务端 exec 通道（ssh2 服务端的 Session 给出的 stream 子集）。 */
interface ServerExecStream {
  write(data: string): void;
  exit(code: number): void;
  end(): void;
}

const testDirs: string[] = [];
afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hostCrypto: SshHostCrypto = {
  encrypt: (plain) => ({ secret: `enc:${Buffer.from(plain).toString("base64")}`, insecure: false }),
  decrypt: (secret) => (secret.startsWith("enc:") ? Buffer.from(secret.slice(4), "base64").toString("utf8") : ""),
  isAvailable: () => true
};

interface EchoServer {
  server: Server;
  port: number;
  /** 服务端真实收到的 exec 命令。 */
  execs: string[];
  /** 服务端 host key 的公钥（用于预置指纹）。 */
  publicKey: Buffer;
}

async function startEchoServer(): Promise<EchoServer> {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const publicKey = (utils.parseKey(hostKey) as { getPublicSSH(): Buffer }).getPublicSSH();
  const execs: string[] = [];
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx: AuthContext) => {
      if (ctx.method === "password" && ctx.username === "u" && ctx.password === "p") ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept: () => unknown) => {
        const session = accept() as {
          on(event: "pty", listener: (acceptPty: () => void) => void): void;
          on(event: "shell", listener: (acceptShell: () => { write(data: string): void }) => void): void;
          on(event: "exec", listener: (acceptExec: () => ServerExecStream, rejectExec: () => void, info: { command: string }) => void): void;
        };
        session.on("pty", (acceptPty) => acceptPty());
        session.on("shell", (acceptShell) => {
          acceptShell().write("remote shell ready\r\n");
        });
        // 真机 OpenSSH 上 `echo ok` 的行为：写一行输出 → 退出码 0 → 关闭通道。
        session.on("exec", (acceptExec, _rejectExec, info) => {
          execs.push(info.command);
          const stream = acceptExec();
          stream.write("ok\n");
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port, execs, publicKey };
}

interface TestHostHarness {
  manager: SshConnectionManager;
  published: Array<{ type: string; status?: string }>;
  hostId: string;
}

/** 建一份主机已「信任过指纹」的管理器（TOFU 探测不是本用例的主题）。 */
function buildManager(tmp: string, server: EchoServer): TestHostHarness {
  const hostStore = createSshHostStore({ filePath: join(tmp, "hosts.json"), crypto: hostCrypto });
  hostStore.save({ name: "loopback", host: "127.0.0.1", username: "u", port: server.port }, "p");
  const knownHosts = createSshKnownHostsStore(join(tmp, "known.json"));
  knownHosts.put("127.0.0.1", server.port, fingerprintOfHostKey(server.publicKey));
  const published: Array<{ type: string; status?: string }> = [];
  const manager = new SshConnectionManager({
    createClient: () => new Client() as unknown as SshClientLike,
    hostStore,
    knownHosts,
    publish: (_terminalId, event) => published.push(event as { type: string; status?: string }),
    reveal: () => {}
  });
  const hosts = manager.handle({ type: "hosts" });
  const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
  return { manager, published, hostId };
}

describe("real ssh2 end-to-end host test (面板「测试」)", () => {
  it("临时建连：exec 'echo ok' 能真的走完通道关闭，返回往返毫秒数", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-ssh-host-test-e2e-"));
    testDirs.push(tmp);
    const echo = await startEchoServer();
    try {
      const { manager, hostId } = buildManager(tmp, echo);
      const started = Date.now();
      const result = await manager.testHost(hostId);
      const elapsed = Date.now() - started;

      // 关键：不能靠 20s 超时兜底——本机回环的一次 echo 往返必须远小于它。
      expect(result).toMatchObject({ ok: true });
      expect(result.error).toBeUndefined();
      expect(result.connectMs).toBeGreaterThanOrEqual(0);
      expect(result.roundTripMs).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(10_000);
      expect(echo.execs).toEqual(["echo ok"]);
    } finally {
      echo.server.close();
    }
  }, 40_000);

  it("已有连接：在同一个 client 上开 exec 通道，不重连", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-ssh-host-test-live-e2e-"));
    testDirs.push(tmp);
    const echo = await startEchoServer();
    try {
      const { manager, published, hostId } = buildManager(tmp, echo);
      manager.handle({ type: "connect", terminalId: "live", hostId, cols: 80, rows: 24 });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !published.some((event) => event.type === "status" && event.status === "connected")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(published.some((event) => event.type === "status" && event.status === "connected")).toBe(true);

      const result = await manager.testHost(hostId);
      expect(result).toMatchObject({ ok: true });
      // 已有连接时 connectMs 不该出现：没有重新握手。
      expect(result.connectMs).toBeUndefined();
      expect(result.roundTripMs).toBeGreaterThanOrEqual(0);
      expect(echo.execs).toEqual(["echo ok"]);
      manager.handle({ type: "kill", terminalId: "live" });
    } finally {
      echo.server.close();
    }
  }, 40_000);
});
