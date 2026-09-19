import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SshAutomationRequest, SshAutomationResult, SshEventData, SshRevealEvent } from "../shared/protocol.js";
import { createSshHostStore, type SshHostCrypto } from "./ssh-host-store.js";
import { createSshKnownHostsStore } from "./ssh-known-hosts.js";
import {
  SshConnectionManager,
  appendScrollback,
  clampDimension,
  fingerprintOfHostKey,
  stripAnsi,
  type SshClientLike,
  type SshConnectOptionsLike,
  type SshShellStreamLike
} from "./ssh-connections.js";

// —— fakes ——

type Listener = (...args: never[]) => void;

class FakeShellStream implements SshShellStreamLike {
  written: string[] = [];
  closed = 0;
  private readonly dataListeners: Listener[] = [];
  private readonly closeListeners: Listener[] = [];

  write(data: string): void {
    this.written.push(data);
  }

  setWindow(): void {}

  end(): void {}

  close(): void {
    this.closed += 1;
    for (const listener of [...this.closeListeners]) listener();
  }

  on(event: string, listener: Listener): this {
    if (event === "data") this.dataListeners.push(listener);
    if (event === "close") this.closeListeners.push(listener);
    return this;
  }

  /** 模拟远端输出（utf8 字符串）。 */
  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data as never);
  }
}

class FakeClient implements SshClientLike {
  connectOptions: SshConnectOptionsLike | undefined;
  ended = 0;
  shellStream: FakeShellStream | undefined;
  shellError: Error | undefined;
  /** 握手时呈现的 hostkey（模拟服务器换 key）。 */
  hostKey: Buffer = TEST_HOST_KEY;
  private readonly listeners = new Map<string, Listener[]>();

  connect(options: SshConnectOptionsLike): void {
    this.connectOptions = options;
    // 模拟真实 ssh2：connect() 只异步发起，hostVerifier 在握手阶段（下一微任务）
    // 才被调用；false → error 事件（首版 bug 正是误以为它同步执行）。
    const verifier = options.hostVerifier;
    if (verifier) {
      queueMicrotask(() => {
        if (!verifier(this.hostKey)) this.emit("error", new Error("Handshake verification failed"));
      });
    }
  }

  end(): void {
    this.ended += 1;
  }

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  shell(_options: { term: string; cols: number; rows: number }, callback: (error: Error | undefined, stream: SshShellStreamLike) => void): void {
    if (this.shellError) {
      queueMicrotask(() => callback(this.shellError, undefined as never));
      return;
    }
    this.shellStream = new FakeShellStream();
    queueMicrotask(() => callback(undefined, this.shellStream!));
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...(args as never[]));
  }

  /** 触发 ready（握手通过后）。 */
  emitReady(): void {
    this.emit("ready");
  }
}

const TEST_HOST_KEY = Buffer.from("test-host-key-bytes");

interface Harness {
  manager: SshConnectionManager;
  published: SshEventData[];
  reveals: SshRevealEvent[];
  clients: FakeClient[];
  knownHostsPath: string;
  /** 预置下一台 client 的握手 hostkey（模拟服务器换 key）。 */
  setNextHostKey(key: Buffer): void;
  waitFor<T>(promise: Promise<T>): Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const testDirs: string[] = [];
afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createHarness(options: { seedHost?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pidesktop-ssh-conn-"));
  testDirs.push(dir);
  const published: SshEventData[] = [];
  const reveals: SshRevealEvent[] = [];
  const clients: FakeClient[] = [];
  const crypto: SshHostCrypto = {
    encrypt: (plain) => ({ secret: `enc:${Buffer.from(plain).toString("base64")}`, insecure: false }),
    decrypt: (secret) => (secret.startsWith("enc:") ? Buffer.from(secret.slice(4), "base64").toString("utf8") : ""),
    isAvailable: () => true
  };
  const hostStore = createSshHostStore({ filePath: join(dir, "hosts.json"), crypto });
  if (options.seedHost !== false) hostStore.save({ name: "prod", host: "10.0.0.8", username: "root", port: 2222 }, "pw");
  const knownHostsPath = join(dir, "known.json");
  const knownHosts = createSshKnownHostsStore(knownHostsPath);
  const control = { nextHostKey: undefined as Buffer | undefined };
  const manager = new SshConnectionManager({
    createClient: () => {
      const client = new FakeClient();
      if (control.nextHostKey) {
        client.hostKey = control.nextHostKey;
        control.nextHostKey = undefined;
      }
      clients.push(client);
      return client;
    },
    hostStore,
    knownHosts,
    publish: (terminalId, event) => published.push(event),
    reveal: (event) => reveals.push(event),
    scheduleFlush: (callback) => {
      const timer = setTimeout(callback, 0);
      return () => clearTimeout(timer);
    }
  });
  return { manager, published, reveals, clients, knownHostsPath, setNextHostKey: (key: Buffer) => { control.nextHostKey = key; }, waitFor: async <T,>(promise: Promise<T>) => promise };
}

const FINGERPRINT = fingerprintOfHostKey(TEST_HOST_KEY);

/** 模拟远端对一条 AI 命令的完整回显（字面 printf 回显 + 输出 + 真实 marker）。 */
function emitCommandOutcome(stream: FakeShellStream, echo: string, output: string, exitCode: number, seq: number): void {
  const printfLiteral = `printf '\\033]633;pi-ssh;${seq};%s\\007' "$?"`;
  // 回显里 \033 是字面文本（反斜杠），marker 输出里是真实 ESC 字节。
  stream.emit(`$ ${echo}\r\n${output}$ ${printfLiteral}\r\n${output}\x1b]633;pi-ssh;${seq};${exitCode}\x07$ `);
}

describe("ssh-connections pure helpers", () => {
  it("clamps dimensions and trims scrollback", () => {
    expect(clampDimension(Number.NaN, 80)).toBe(80);
    expect(clampDimension(999, 24)).toBe(500);
    expect(clampDimension(0, 24)).toBe(2);
    const trimmed = appendScrollback("x".repeat(199_000), "y".repeat(5000));
    expect(trimmed.length).toBeLessThanOrEqual(200 * 1024);
    expect(trimmed.endsWith("y")).toBe(true);
  });

  it("strips ANSI but keeps literal \\033 text (marker anti-spoofing)", () => {
    const text = "\x1b[32mok\x1b[0m done printf '\\033]633;pi-ssh;1;%s\\007'";
    const stripped = stripAnsi(text);
    expect(stripped).toContain("ok");
    expect(stripped).not.toContain("\x1b");
    // 字面反斜杠形式保留：命令回显不会被误判为 marker。
    expect(stripped).toContain("\\033]633;pi-ssh;1");
  });

  it("computes OpenSSH-style fingerprints", () => {
    expect(FINGERPRINT).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(FINGERPRINT.endsWith("=")).toBe(false);
  });
});

describe("SshConnectionManager.connect (renderer channel)", () => {
  it("rejects unknown hosts and missing passwords", () => {
    const harness = createHarness();
    expect(() => harness.manager.handle({ type: "connect", terminalId: "t1", hostId: "missing", cols: 80, rows: 24 })).toThrow("主机不存在");
    const badStore = createHarness({ seedHost: false });
    expect(() => badStore.manager.handle({ type: "connect", terminalId: "t1", hostId: "whatever", cols: 80, rows: 24 })).toThrow("主机不存在");
  });

  it("pushes the fingerprint as an event for an untrusted first connection (TOFU probe)", async () => {
    const harness = createHarness();
    const hosts = harness.manager.handle({ type: "hosts" });
    const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
    // ssh2 的 hostVerifier 在异步握手中才执行：connect() 返回时指纹未知，指纹
    // 必须作为事件推送（首版 bug：随返回值带回 → 渲染端永远「正在连接」）。
    const result = harness.manager.handle({ type: "connect", terminalId: "t1", hostId, cols: 80, rows: 24 });
    expect(result).toEqual({ kind: "connect" });
    await sleep(5);
    const fingerprints = harness.published.filter((event) => event.type === "fingerprint");
    expect(fingerprints).toHaveLength(1);
    expect((fingerprints[0] as { fingerprint: string }).fingerprint).toBe(FINGERPRINT);
    // 探测连接的握手失败是预期路径：不 publish error。
    expect(harness.published.filter((event) => event.type === "error")).toHaveLength(0);
  });

  it("completes the connection after trustFingerprint and persists the fingerprint", async () => {
    const harness = createHarness();
    const hosts = harness.manager.handle({ type: "hosts" });
    const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
    harness.manager.handle({ type: "connect", terminalId: "t1", hostId, cols: 100, rows: 30, trustFingerprint: true });
    await sleep(2);
    harness.clients[0]!.emitReady();
    await sleep(5);
    expect(harness.published).toContainEqual({ type: "status", terminalId: "t1", status: "connected" });
    // 指纹已记录：第二次连接（新 terminalId）不再探测。
    const second = harness.manager.handle({ type: "connect", terminalId: "t2", hostId, cols: 80, rows: 24 });
    expect(second).toEqual({ kind: "connect" });
    await sleep(2);
    expect(harness.clients[1]!.connectOptions?.hostVerifier?.(TEST_HOST_KEY)).toBe(true);
    expect(harness.clients[1]!.connectOptions?.hostVerifier?.(Buffer.from("other"))).toBe(false);
  });

  it("rejects a changed fingerprint with an explicit error", async () => {
    const harness = createHarness();
    const hosts = harness.manager.handle({ type: "hosts" });
    const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
    harness.manager.handle({ type: "connect", terminalId: "t1", hostId, cols: 80, rows: 24, trustFingerprint: true });
    await sleep(2);
    harness.clients[0]!.emitReady();
    await sleep(5);
    // 服务器换了 hostkey：第二台 client 呈现不同指纹，握手被拒。
    harness.setNextHostKey(Buffer.from("attacker-key"));
    harness.manager.handle({ type: "connect", terminalId: "t2", hostId, cols: 80, rows: 24 });
    await sleep(5);
    const errors = harness.published.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain("指纹");
  });

  it("replays scrollback on reconnect with the same terminalId and forwards input/resize", async () => {
    const harness = createHarness();
    const hosts = harness.manager.handle({ type: "hosts" });
    const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
    harness.manager.handle({ type: "connect", terminalId: "t1", hostId, cols: 80, rows: 24, trustFingerprint: true });
    await sleep(2);
    harness.clients[0]!.emitReady();
    await sleep(5);
    harness.clients[0]!.shellStream!.emit("welcome banner\r\n");
    await sleep(10);
    harness.published.length = 0;
    // 同 id 重连：重放 scrollback + status。
    harness.manager.handle({ type: "connect", terminalId: "t1", hostId, cols: 80, rows: 24 });
    await sleep(5);
    expect(harness.published.some((event) => event.type === "data" && event.data.includes("welcome banner"))).toBe(true);
    harness.manager.handle({ type: "input", terminalId: "t1", data: "ls\r" });
    expect(harness.clients[0]!.shellStream!.written.at(-1)).toBe("ls\r");
    harness.manager.handle({ type: "resize", terminalId: "t1", cols: 120, rows: 40 });
    harness.manager.handle({ type: "kill", terminalId: "t1" });
    expect(harness.clients[0]!.ended).toBeGreaterThan(0);
  });
});

describe("SshConnectionManager.handleAutomation (AI channel)", () => {
  async function connectHarness(): Promise<{ harness: Harness; hostId: string; ai: (request: SshAutomationRequest) => Promise<SshAutomationResult> }> {
    const harness = createHarness();
    const hosts = harness.manager.handle({ type: "hosts" });
    const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
    // 人工先信任指纹（TOFU）。
    harness.manager.handle({ type: "connect", terminalId: "human", hostId, cols: 80, rows: 24, trustFingerprint: true });
    await sleep(2);
    harness.clients[0]!.emitReady();
    await sleep(5);
    const ai = (request: SshAutomationRequest) => harness.manager.handleAutomation("session-1", request);
    return { harness, hostId, ai };
  }

  it("connects, binds the session, and reveals the terminal", async () => {
    const { harness, ai } = await connectHarness();
    const result = await ai({ op: "connect", host: "prod" });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.kind !== "connect") throw new Error("unexpected");
    expect(result.data.connection.hostName).toBe("prod");
    expect(harness.reveals).toHaveLength(1);
    expect(harness.reveals[0]!.hostName).toBe("prod");
  });

  it("refuses first-ever connections that need fingerprint confirmation", async () => {
    const harness = createHarness();
    const hosts = harness.manager.handle({ type: "hosts" });
    const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
    const result = await harness.manager.handleAutomation("session-x", { op: "connect", host: "prod" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error).toContain("人工确认服务器指纹");
    expect(harness.reveals).toHaveLength(0);
  });

  it("executes a command through the shell stream and parses the exit code", async () => {
    const { harness, ai } = await connectHarness();
    await ai({ op: "connect", host: "prod" });
    const stream = harness.clients[0]!.shellStream!;
    const execPromise = ai({ op: "exec", command: "uptime", timeoutMs: 5000 });
    // 命令写入 shell 流（回显前提——用户窗口能看到）。
    const written = stream.written.at(-1)!;
    expect(written.startsWith("uptime\n")).toBe(true);
    expect(written).toContain("printf '\\033]633;pi-ssh;");
    // 远端回显：命令行 + 输出 + marker（seq=1）。
    emitCommandOutcome(stream, "uptime", " 21:07  load average: 0.1\n", 0, 1);
    const result = await execPromise;
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.kind !== "exec") throw new Error("unexpected");
    expect(result.data.exitCode).toBe(0);
    expect(result.data.timedOut).toBeUndefined();
    expect(result.data.output).toContain("load average");
    // 字面 printf 回显保留（无 ANSI），真实 marker 被剥掉。
    expect(result.data.output).not.toContain("\x1b");
  });

  it("times out without killing the connection and reports partial output", async () => {
    const { harness, ai } = await connectHarness();
    await ai({ op: "connect", host: "prod" });
    const stream = harness.clients[0]!.shellStream!;
    const execPromise = ai({ op: "exec", command: "sleep 30", timeoutMs: 1000 });
    stream.emit("$ sleep 30\r\nstill running...\r\n");
    const result = await execPromise;
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.kind !== "exec") throw new Error("unexpected");
    expect(result.data.timedOut).toBe(true);
    expect(result.data.exitCode).toBeNull();
    expect(result.data.output).toContain("still running");
    // 连接仍在：write 可用。
    const writeResult = await ai({ op: "write", data: "\x03" });
    expect(writeResult.ok).toBe(true);
    expect(stream.written.at(-1)).toBe("\x03");
  });

  it("reads scrollback tails and closes connections", async () => {
    const { harness, ai } = await connectHarness();
    await ai({ op: "connect", host: "prod" });
    const stream = harness.clients[0]!.shellStream!;
    stream.emit("\x1b[31mERROR\x1b[0m disk full\r\n");
    const read = await ai({ op: "read", tailChars: 1000 });
    expect(read.ok).toBe(true);
    if (!read.ok || read.data.kind !== "read") throw new Error("unexpected");
    expect(read.data.text).toContain("disk full");
    expect(read.data.text).not.toContain("\x1b");
    const closed = await ai({ op: "close" });
    expect(closed.ok).toBe(true);
    if (!closed.ok || closed.data.kind !== "close") throw new Error("unexpected");
    expect(closed.data.closed).toBe(true);
    const afterClose = await ai({ op: "read" });
    expect(afterClose.ok).toBe(false);
  });

  it("lists hosts and matching connections", async () => {
    const { ai } = await connectHarness();
    await ai({ op: "connect", host: "prod" });
    const hosts = await ai({ op: "hosts" });
    expect(hosts.ok).toBe(true);
    if (!hosts.ok || hosts.data.kind !== "hosts") throw new Error("unexpected");
    expect(hosts.data.hosts).toHaveLength(1);
    expect(hosts.data.connections).toHaveLength(1);
    expect(hosts.data.connections[0]!.hostName).toBe("prod");
  });
});
