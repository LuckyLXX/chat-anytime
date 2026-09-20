import { mkdtempSync, readdirSync, readFileSync as readFileSyncNode, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { SshAutomationRequest, SshAutomationResult, SshCommandResult, SshEventData, SshRevealEvent } from "../shared/protocol.js";
import { createSshHostStore, type SshHostCrypto } from "./ssh-host-store.js";
import { createSshKnownHostsStore } from "./ssh-known-hosts.js";
import {
  SshConnectionManager,
  appendScrollback,
  clampDimension,
  createMarkerEchoFilter,
  fingerprintOfHostKey,
  markerPrintfCommand,
  stripAnsi,
  type SshClientLike,
  type SshConnectOptionsLike,
  type SshShellStreamLike
} from "./ssh-connections.js";
import type { SshSftpLike } from "./ssh-sftp.js";

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
  sftpError: Error | undefined;
  /** 提前建好（而非在 sftp() 里懒建）：测试需要在连接前就预置远端目录/文件。 */
  sftpChannel: FakeSftp | undefined = new FakeSftp();
  /** 握手时呈现的 hostkey（模拟服务器换 key）。 */
  hostKey: Buffer = TEST_HOST_KEY;
  private readonly listeners = new Map<string, Listener[]>();

  sftp(callback: (error: Error | undefined, sftp: never) => void): void {
    if (this.sftpError) {
      queueMicrotask(() => callback(this.sftpError, undefined as never));
      return;
    }
    this.sftpChannel ??= new FakeSftp();
    const channel = this.sftpChannel;
    queueMicrotask(() => callback(undefined, channel as never));
  }
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

class FakeSftp implements SshSftpLike {
  entries: Array<{ filename: string; attrs: { size: number; mtime: number; mode: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean } }> = [];
  /** 供下载用例预置的远端文件（路径 → 字节）。 */
  files = new Map<string, Buffer>();
  readdirError: Error | undefined;
  home = "/root";
  ended = 0;

  readdir(_path: string, callback: (error: Error | undefined, list: never) => void): void {
    if (this.readdirError) callback(this.readdirError, undefined as never);
    else callback(undefined, this.entries as never);
  }

  stat(path: string, callback: (error: Error | undefined, stats: never) => void): void {
    const bytes = this.files.get(path);
    if (!bytes) {
      callback(Object.assign(new Error("No such file"), { code: 2 }), undefined as never);
      return;
    }
    callback(undefined, { size: bytes.length, mtime: 0, mode: 0, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as never);
  }

  realpath(_path: string, callback: (error: Error | undefined, resolved: string | undefined) => void): void {
    callback(undefined, this.home);
  }

  unlink(_path: string, callback: (error: Error | undefined) => void): void {
    callback(undefined);
  }

  createReadStream(path: string): never {
    const bytes = this.files.get(path);
    if (!bytes) throw Object.assign(new Error("No such file"), { code: 2 });
    // 真实返回可读流（下载用例需要它真的跑完）。
    return Readable.from([bytes]) as never;
  }

  createWriteStream(): never {
    throw new Error("FakeSftp.createWriteStream 未实现");
  }

  end(): void {
    this.ended += 1;
  }
}

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
  const printfLiteral = markerPrintfCommand(seq);
  // 回显里 \033 是字面文本（反斜杠），marker 输出里是真实 ESC 字节。
  stream.emit(`$ ${echo}\r\n${output}$ ${printfLiteral}\r\n${output}\x1b]633;pi-ssh;${seq};${exitCode}\x07$ `);
}

describe("ssh-connections pure helpers", () => {
  it("filters the marker printf echo out of the display stream (across chunks)", () => {
    const filter = createMarkerEchoFilter();
    const echo = markerPrintfCommand(7);
    // 同一块内完整过滤
    expect(filter(`[root@host ~]# uptime\r\n 21:07 up 3 days\r\n[root@host ~]# ${echo}\r\n`)).toBe("[root@host ~]# uptime\r\n 21:07 up 3 days\r\n[root@host ~]# ");
    // 跨块分裂（前缀被截断）也要过滤干净
    const halves = [`[root@host ~]# prin`, `tf '\\033]633;p`, `i-ssh;8;%s\\007' "$?"\r\n`];
    const joined = halves.map((part) => filter(part)).join("");
    expect(joined).toBe("[root@host ~]# ");
    // 真实 ESC marker（printf 的输出）不被误伤
    const realMarker = "\x1b]633;pi-ssh;9;0\x07";
    expect(filter(`out\r\n${realMarker}$ `)).toContain(realMarker);
    // 普通文本无损耗
    expect(filter("plain output with printf inside\n")).toBe("plain output with printf inside\n");
    // 尾部暂扣的前缀会在下一块补完整后一并剔除
    const tailFilter = createMarkerEchoFilter();
    expect(tailFilter("cmd\r\nprintf '\\033]633;pi-ss")).toBe("cmd\r\n");
    expect(tailFilter("h;10;%s\\007' \"$?\"\r\nnext\n")).toBe("next\n");
  });

  it("filters the readline-wrapped echo (real-machine fixture: CRLF + repeated boundary char)", () => {
    // 真机实测（阿里云主机，PTY 58 列、提示符 34 字符）：远端 readline 在换行处
    // 插入 CRLF **并重复边界字符**，回显因此不是单行——整行正则跨不过这个 CRLF，
    // 这正是上个版本「修了但还能看到」的根因。样本由 markerPrintfCommand 构造，
    // 保证测试与真实回显永不漂移。
    const seq = 12;
    const echo = markerPrintfCommand(seq);
    const wrapped = `${echo.slice(0, 26)}\r\n${echo[25]}${echo.slice(26)}`;
    expect(wrapped).toContain("\r\n");
    const prompt = "[root@iZmj7dkkjlbospsnrovsgeZ ~]# ";
    const filter = createMarkerEchoFilter();
    // 只剩提示符，没有探针残留，也不留空行
    expect(filter(`${prompt}${wrapped}\r\n`)).toBe(prompt);
    // 折行点落在任意位置（含数字段中间）都要能过滤；真实折行只在显示宽度
    // 边界发生，这里全覆盖更严：状态机必须对任意切分鲁棒。
    for (let cut = 1; cut < echo.length; cut += 1) {
      const broken = `${echo.slice(0, cut)}\r\n${echo[cut - 1]}${echo.slice(cut)}`;
      const out = createMarkerEchoFilter()(`${prompt}${broken}\r\n`);
      expect(out).toBe(prompt);
    }
    // 跨 chunk 的折行回显同样过滤干净
    const chunked = createMarkerEchoFilter();
    const pieces = [`${prompt}pri`, `ntf '\\033]633;pi-ssh;12\r`, `\n1`, `2;%s\\007' "$?"\r\n`];
    expect(pieces.map((part) => chunked(part)).join("")).toBe(prompt);
    // 折行回显之后紧跟的正常输出不能受损
    const withOutput = createMarkerEchoFilter()(`${prompt}${wrapped}\r\nsome output\r\n`);
    expect(withOutput).toBe(`${prompt}some output\r\n`);
  });

  it("cleans the verbatim real-machine capture (folded echo + real marker output)", () => {
    // 以下字符串是从真机 ssh_exec 回执里逐字抄下来的（阿里云主机，PTY 58 列）：
    // 回显在 `pi-ssh;4` 后折行、下一行重复边界字符 `4`，探针的**输出**（真 ESC）
    // 则不折行。这条 fixture 是上个版本失效现场的重演，必须永久驻留。
    const captured =
      "[root@iZmj7dkkjlbospsnrovsgeZ ~]# echo XYZ123\r\n" +
      "XYZ123\r\n" +
      "[root@iZmj7dkkjlbospsnrovsgeZ ~]# printf '\\033]633;pi-ssh;4" +
      "\r\n" +
      "4;%s\\007' \"$?\"\r\n" +
      "$ \x1b]633;pi-ssh;4;0\x07$ ";
    const expected =
      "[root@iZmj7dkkjlbospsnrovsgeZ ~]# echo XYZ123\r\nXYZ123\r\n[root@iZmj7dkkjlbospsnrovsgeZ ~]# " +
      "$ \x1b]633;pi-ssh;4;0\x07$ ";
    expect(createMarkerEchoFilter()(captured)).toBe(expected);
    // 任意切块（含逐字符）都必须得到同一结果——跨 chunk 安全性。
    const filter = createMarkerEchoFilter();
    let charwise = "";
    for (const c of captured) charwise += filter(c);
    expect(charwise).toBe(expected);
    const random = createMarkerEchoFilter();
    let split = "";
    for (let i = 0; i < captured.length; ) {
      const take = 1 + ((i * 7) % 9);
      split += random(captured.slice(i, i + take));
      i += take;
    }
    expect(split).toBe(expected);
  });

  it("never swallows real output that only looks like a marker echo prefix", () => {
    const filter = createMarkerEchoFilter();
    // 用户自己敲 / 输出里的普通 printf 文本：失配后原样吐回，不丢字符
    const literal = "printf '%s\\n' hello";
    expect(filter(`$ ${literal}\r\nhello\n`)).toBe(`$ ${literal}\r\nhello\n`);
    // 与回显前缀同形但后续不同的文本
    const lookalike = "printf '\\033]633;pi-ssh;not-a-number;%s\\007' \"$?\"\r\n";
    expect(filter(lookalike)).toBe(lookalike);
    // 被截断的候选前缀必须原样保留（暂扣后失配吐回）
    const dangling = createMarkerEchoFilter();
    expect(dangling("tail printf '\\033]633;pi-")).toBe("tail ");
    expect(dangling("xyz\n")).toBe("printf '\\033]633;pi-xyz\n");
  });

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
    await sleep(2);    harness.clients[0]!.emitReady();
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
    expect(hosts.data.groups).toEqual([]);
    expect(hosts.data.connections).toHaveLength(1);
    expect(hosts.data.connections[0]!.hostName).toBe("prod");
  });

  it("manages groups through the renderer channel", async () => {
    const harness = createHarness();
    const saved = harness.manager.handle({ type: "group.save", group: { name: "生产环境" } });
    expect(saved.kind).toBe("group-saved");
    const groupId = saved.kind === "group-saved" ? saved.group.id : "";
    // 主机归组 + hosts 结果带分组。
    const hostsResult = harness.manager.handle({ type: "hosts" });
    const hostId = hostsResult.kind === "hosts" ? hostsResult.hosts[0]!.id : "";
    harness.manager.handle({ type: "host.save", host: { id: hostId, name: "prod", host: "10.0.0.8", username: "root", port: 2222, groupId } });
    const after = harness.manager.handle({ type: "hosts" });
    expect(after.kind === "hosts" && after.groups.map((group) => group.name)).toEqual(["生产环境"]);
    expect(after.kind === "hosts" && after.hosts[0]!.groupId).toBe(groupId);
    // 重命名 + 删除（组内主机回落未分组，不删主机）。
    harness.manager.handle({ type: "group.save", group: { id: groupId, name: "prod-env" } });
    harness.manager.handle({ type: "group.delete", groupId });
    const final = harness.manager.handle({ type: "hosts" });
    expect(final.kind === "hosts" && final.groups).toEqual([]);
    expect(final.kind === "hosts" && final.hosts).toHaveLength(1);
    expect(final.kind === "hosts" && final.hosts[0]!.groupId).toBeUndefined();
    expect(() => harness.manager.handle({ type: "group.delete", groupId })).toThrow("分组不存在");
  });
});

describe("ssh-connections SFTP command dispatch", () => {
  /** 连上一条连接（SFTP 通道需连接就绪后才可懒开）。 */
  async function connected(): Promise<Harness> {
    const harness = createHarness();
    const hosts = harness.manager.handle({ type: "hosts" });
    const hostId = hosts.kind === "hosts" ? hosts.hosts[0]!.id : "";
    harness.manager.handle({ type: "connect", terminalId: "t1", hostId, cols: 80, rows: 24, trustFingerprint: true });
    await sleep(2);
    harness.clients[0]!.emitReady();
    await sleep(5);
    return harness;
  }

  it("lists a remote directory through the lazy SFTP channel", async () => {
    const harness = await connected();
    harness.clients[0]!.sftpChannel!.entries = [
      { filename: "b.txt", attrs: { size: 10, mtime: 1_700_000_000, mode: 0, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } },
      { filename: "sub", attrs: { size: 0, mtime: 1_700_000_000, mode: 0, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } }
    ];

    const result = await harness.manager.handleAsync({ type: "sftp.list", terminalId: "t1" });
    expect(result?.kind).toBe("sftp-listing");
    const listing = result as Extract<SshCommandResult, { kind: "sftp-listing" }>;
    // 目录优先 + 名称排序（与远端列表展示同口径）
    expect(listing.entries.map((entry) => entry.name)).toEqual(["sub", "b.txt"]);
    expect(listing.path).toBe("/root");
  });

  it("refuses a download without a workspace instead of writing somewhere implicit", async () => {
    const harness = await connected();
    await expect(
      harness.manager.handleAsync({ type: "sftp.download", terminalId: "t1", transferId: "x", remotePaths: ["/root/a.txt"], workspace: "  " })
    ).rejects.toThrow("工作区");
  });

  it("derives the local drop directory itself and actually reaches the transfer layer", async () => {
    // 防回归：初版渲染端**根本没传** localDir → 下载 100% 报「请先选择工作区」。
    // 现在渲染端传 workspace，目录由主进程推导；这里断言请求真的走到了服务层
    // （若目录推导缺失，会在到达 createReadStream 之前就抛错）。
    const harness = await connected();
    const channel = harness.clients[0]!.sftpChannel!;
    channel.files.set("/root/a.txt", Buffer.from("payload"));
    let readStreams = 0;
    const original = channel.createReadStream.bind(channel);
    channel.createReadStream = ((path: string) => { readStreams += 1; return original(path); }) as never;

    const dir = mkdtempSync(join(tmpdir(), "pidesktop-ssh-dl-"));
    testDirs.push(dir);
    // 工作区指向临时目录，落盘应在 <ws>/.pidesktop/downloads/
    const result = await harness.manager.handleAsync({
      type: "sftp.download", terminalId: "t1", transferId: "d1", remotePaths: ["/root/a.txt"], workspace: dir
    });
    expect(result?.kind).toBe("void");
    expect(readStreams).toBe(1);

    const files = readdirSync(join(dir, ".pidesktop", "downloads"));
    expect(files).toEqual(["a.txt"]);
    expect(readFileSyncNode(join(dir, ".pidesktop", "downloads", "a.txt"), "utf8")).toBe("payload");
  });

  it("gives a clear error for SFTP commands on an unknown terminal", async () => {
    const harness = createHarness();
    await expect(harness.manager.handleAsync({ type: "sftp.list", terminalId: "nope" })).rejects.toThrow("未就绪或已断开");
  });

  it("closes the SFTP channel when the connection is killed", async () => {
    const harness = await connected();
    await harness.manager.handleAsync({ type: "sftp.list", terminalId: "t1" });
    expect(harness.clients[0]!.sftpChannel!.ended).toBe(0);
    harness.manager.handle({ type: "kill", terminalId: "t1" });
    expect(harness.clients[0]!.sftpChannel!.ended).toBe(1);
  });
});
