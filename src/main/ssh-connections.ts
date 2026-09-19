import { createHash } from "node:crypto";
import type {
  SshAutomationRequest,
  SshAutomationData,
  SshAutomationResult,
  SshCommand,
  SshCommandResult,
  SshConnectionInfo,
  SshEventData,
  SshRevealEvent,
  SshHostDraft,
  SshHostSummary
} from "../shared/protocol.js";
import type { SshHostStore } from "./ssh-host-store.js";
import { validateHostDraft } from "./ssh-host-store.js";
import type { SshKnownHostsStore } from "./ssh-known-hosts.js";

/**
 * SSH 连接管理：ssh2 Client + shell channel（远端 PTY），与本地 PTY 终端
 * （terminal-pty.ts）同一套通道形状——scrollback 重放、10ms/64KB 批量
 * flush、resize。人工输入与 AI 写入共享同一条 shell 流：AI 的命令经远端
 * 回显实时出现在用户的 xterm 窗口里；命令完成检测用不可打印的 OSC 序列
 * marker（ESC ] 633;pi-ssh;<seq>;<exit> BEL），普通命令输出无法伪造——
 * 命令回显里 printf 参数是字面反斜杠文本，与 printf 输出的真实 ESC 字节
 * 天然可区分。
 *
 * 纯逻辑 + 注入 ssh2 工厂/推送/存储依赖（terminal-pty 同模式），可单测。
 */

/** ssh2 Client 的最小结构视图（index.ts 注入真实实现，测试注入 fake）。 */
export interface SshClientLike {
  connect(options: SshConnectOptionsLike): void;
  end(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  shell(options: { term: string; cols: number; rows: number }, callback: (error: Error | undefined, stream: SshShellStreamLike) => void): void;
}

export interface SshConnectOptionsLike {
  host: string;
  port: number;
  username: string;
  password?: string;
  tryKeyboard?: boolean;
  readyTimeout?: number;
  /** 返回 true 放行握手；返回 false 拒绝（TOFU 待确认/指纹不匹配）。 */
  hostVerifier?: (key: Buffer) => boolean;
}

export interface SshShellStreamLike {
  write(data: string): void;
  setWindow(cols: number, rows: number, height: number, width: number): void;
  end(): void;
  close(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface SshConnectionsDeps {
  createClient(): SshClientLike;
  hostStore: SshHostStore;
  knownHosts: SshKnownHostsStore;
  publish(terminalId: string, event: SshEventData): void;
  reveal(event: SshRevealEvent): void;
  /** Test seam：异步 flush 调度（缺省 setTimeout）。 */
  scheduleFlush?(callback: () => void): () => void;
}

interface PendingExec {
  seq: number;
  chunks: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: { exitCode: number | null; timedOut: boolean }) => void;
}

interface ConnectionRecord {
  terminalId: string;
  hostId: string;
  hostName: string;
  host: string;
  port: number;
  username: string;
  client: SshClientLike;
  stream?: SshShellStreamLike;
  status: "connecting" | "connected" | "closed";
  scrollback: string;
  pending: string;
  /** 探测连接（TOFU 待确认）拿到的指纹；非空时 error/close 事件静默。 */
  probeFingerprint?: string;
  /** 用户已在确认卡上信任的指纹（连接 ready 后写入指纹库）。 */
  trustedFingerprint?: string;
  /** 指纹与已记录不一致（hostVerifier 已拒绝）：error 事件用明确文案。 */
  fingerprintMismatch?: string;
  pendingExec?: PendingExec;
  /** 显示流净化器：剔除 marker 命令的字面回显（跨 chunk 安全）。 */
  echoFilter: (chunk: string) => string;
  disposeListeners(): void;
}

export const SSH_MAX_CONNECTIONS = 5;
const FLUSH_INTERVAL_MS = 10;
const FLUSH_MAX_CHARS = 64 * 1024;
const SCROLLBACK_LIMIT_CHARS = 200 * 1024;
const DIMENSION_MIN = 2;
const DIMENSION_MAX = 500;
const CONNECT_TIMEOUT_MS = 20_000;
const EXEC_DEFAULT_TIMEOUT_MS = 60_000;
const EXEC_MIN_TIMEOUT_MS = 1_000;
const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_OUTPUT_LIMIT_CHARS = 8 * 1024;
export const READ_DEFAULT_CHARS = 4 * 1024;
export const READ_MAX_CHARS = 16 * 1024;

// marker 序列：ESC ] 633;pi-ssh;<seq>; <exit> BEL（OSC 633 与 VSCode shell
// integration 同段位，不与常见终端应用冲突）。源码内一律用显式转义，禁止
// 控制字符字面量（此前 write 双转义事故的教训）。
const MARKER_OSC_PREFIX = "\u001b]633;pi-ssh;";
const MARKER_BEL = "\u0007";
const MARKER_PRINTF_ESCAPE = "]633;pi-ssh;";

function markerSequence(seq: number): string {
  return MARKER_OSC_PREFIX + `${seq};`;
}

export function clampDimension(value: number, fallback: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return fallback;
  return Math.min(DIMENSION_MAX, Math.max(DIMENSION_MIN, rounded));
}

export function appendScrollback(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > SCROLLBACK_LIMIT_CHARS ? next.slice(next.length - SCROLLBACK_LIMIT_CHARS) : next;
}

/** OpenSSH 风格指纹（SHA256 base64 去 padding）。 */
export function fingerprintOfHostKey(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** 剥除 ANSI OSC/CSI 序列与控制字符（AI 回执与 ssh_read 给模型干净文本）。 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** marker 的远端 printf 命令（POSIX printf：bash/dash/busybox 均支持 \033 与 \007）。 */
function markerPrintfCommand(seq: number): string {
  return `printf '\\033${MARKER_PRINTF_ESCAPE}${seq};%s\\007' "$?"`;
}

/** 远端 shell 对 marker 命令的字面回显（连同行尾换行一并剔除，避免留下空提示符行）。 */
const MARKER_ECHO_RE = /printf '\\033\]633;pi-ssh;\d+;%s\\007' "\$\?"\r?\n?/g;
/** 跨 chunk 匹配用的固定前缀（尾部暂扣上限 = 本串长度 - 1）。 */
const MARKER_ECHO_PREFIX = "printf '\\033]633;pi-ssh;";

/**
 * 显示流净化器：把 marker 命令的**字面回显**从数据流中剔除。AI 的 ssh_exec
 * 在业务命令后追加一行 printf 探针，远端 shell 会把这一行原样回显（跟用户自己
 * 敲的命令一样），会在终端里显出一行奇怪的 printf（用户实测反馈）。marker 的
 * 完成检测靠的是 printf **输出的真实 ESC 字节**，与回显的字面 `\033` 文本天然
 * 可分，所以剔除字面回显对检测零影响；跨 chunk 的半个前缀会被暂扣至下一块。
 * 匹配不中（如 zsh 语法高亮在回显中插了转义）则自然退化为不过滤，无害。
 */
export function createMarkerEchoFilter(): (chunk: string) => string {
  let tail = "";
  return (chunk: string): string => {
    let out = (tail + chunk).replace(MARKER_ECHO_RE, "");
    tail = "";
    // 尾部若是模式前缀的一部分（下个 chunk 可能补全），先暂扣不发出。
    for (let keep = Math.min(MARKER_ECHO_PREFIX.length - 1, out.length); keep > 0; keep -= 1) {
      if (MARKER_ECHO_PREFIX.startsWith(out.slice(-keep))) {
        tail = out.slice(-keep);
        out = out.slice(0, -keep);
        break;
      }
    }
    return out;
  };
}

export function hostMatches(summary: SshHostSummary, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  return summary.id.toLowerCase() === trimmed || summary.name.toLowerCase() === trimmed;
}

export class SshConnectionManager {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly pendingFlush = new Set<ConnectionRecord>();
  /** AI 会话 → 连接绑定（连接归 tab 所有，会话 dispose 不解绑不关连接）。 */
  private readonly sessionBindings = new Map<string, string>();
  /** 探测记录：terminalId → 指纹（TOFU 拒绝后 record 即被清理，AI 的轮询只能从这里看到探测结果）。 */
  private readonly probedFingerprints = new Map<string, string>();
  private execSequence = 0;
  private readonly schedule: (callback: () => void) => () => void;
  private cancelFlush: (() => void) | undefined;

  constructor(private readonly deps: SshConnectionsDeps) {
    this.schedule = deps.scheduleFlush ?? ((callback) => {
      const timer = setTimeout(callback, FLUSH_INTERVAL_MS);
      return () => clearTimeout(timer);
    });
  }

  // ——— 渲染端命令通道（与 TerminalManager.handle 同构） ———

  handle(command: SshCommand): SshCommandResult {
    switch (command.type) {
      case "connect": return this.connect(command.terminalId, command.hostId, command.cols, command.rows, command.trustFingerprint === true);
      case "input": this.connections.get(command.terminalId)?.stream?.write(command.data); return { kind: "void" };
      case "resize": {
        const record = this.connections.get(command.terminalId);
        if (record?.stream) record.stream.setWindow(clampDimension(command.cols, 80), clampDimension(command.rows, 24), 480, 640);
        return { kind: "void" };
      }
      case "kill": this.kill(command.terminalId); return { kind: "void" };
      case "hosts": {
        const hosts = this.deps.hostStore.list();
        const groups = this.deps.hostStore.listGroups();
        const connectedHostIds = [...this.connections.values()].filter((record) => record.status !== "closed").map((record) => record.hostId);
        return { kind: "hosts", hosts, groups, connectedHostIds };
      }
      case "host.save": {
        const error = validateHostDraft(command.host);
        if (error) throw new Error(error);
        return { kind: "host-saved", host: this.deps.hostStore.save(command.host, command.password) };
      }
      case "host.delete": {
        if (!this.deps.hostStore.remove(command.hostId)) throw new Error("主机不存在或已删除");
        return { kind: "host-deleted" };
      }
      case "group.save": {
        return { kind: "group-saved", group: this.deps.hostStore.saveGroup(command.group) };
      }
      case "group.delete": {
        if (this.deps.hostStore.removeGroup(command.groupId) < 0) throw new Error("分组不存在或已删除");
        return { kind: "group-deleted" };
      }
    }
  }

  /** 发起连接。返回带 fingerprint = TOFU 待确认（渲染端显示确认卡后带 trustFingerprint 重发）。 */
  private connect(terminalId: string, hostId: string, cols: number, rows: number, trustFingerprint: boolean): SshCommandResult {
    const existing = this.connections.get(terminalId);
    if (existing && existing.status !== "closed") {
      if (existing.scrollback) this.deps.publish(terminalId, { type: "data", terminalId, data: existing.scrollback });
      this.deps.publish(terminalId, { type: "status", terminalId, status: existing.status });
      return { kind: "connect" };
    }
    const stored = this.deps.hostStore.get(hostId);
    if (!stored) throw new Error("主机不存在，请先在 SSH 面板保存配置");
    if (this.connections.size >= SSH_MAX_CONNECTIONS) throw new Error(`SSH 连接数量已达上限（${SSH_MAX_CONNECTIONS}），请先关闭其他连接标签`);
    const password = this.deps.hostStore.passwordOf(hostId);
    if (password === undefined) throw new Error("该主机未保存密码，请先在 SSH 面板补录密码");

    const known = this.deps.knownHosts.get(stored.host, stored.port);
    // 重连同 id（信任后重发 / 重新连接）：清掉旧探测记录，避免陈旧指纹误判。
    this.probedFingerprints.delete(terminalId);
    const record: ConnectionRecord = {
      terminalId,
      hostId,
      hostName: stored.name,
      host: stored.host,
      port: stored.port,
      username: stored.username,
      client: this.deps.createClient(),
      status: "connecting",
      scrollback: "",
      pending: "",
      echoFilter: createMarkerEchoFilter(),
      disposeListeners: () => {}
    };
    this.connections.set(terminalId, record);
    this.deps.publish(terminalId, { type: "status", terminalId, status: "connecting", detail: `${stored.username}@${stored.host}:${stored.port}` });

    const listeners: Array<() => void> = [];
    const on = (event: string, listener: (...args: never[]) => void): void => {
      record.client.on(event, listener);
      listeners.push(() => record.client.on(event, () => {}));
    };
    record.disposeListeners = () => {
      for (const dispose of listeners) dispose();
    };

    on("error", ((error: Error) => {
      if (record.status === "closed") return; // kill 之后的 socket 错误静默
      if (record.probeFingerprint) {
        // 探测连接（TOFU 待确认）被拒绝是预期路径：fingerprint 已随 connect 返回。
        this.disposeRecord(terminalId);
        return;
      }
      const detail = record.fingerprintMismatch
        ? `主机指纹与已记录的不一致（可能是中间人攻击，或服务器重装/换 IP）。记录指纹校验失败：${record.fingerprintMismatch}。若确认服务器已更换，请删除 userData/pidesktop-ssh-known-hosts.json 中 ${stored.host}:${stored.port} 条目后重连。`
        : error.message || "SSH 连接失败";
      this.failRecord(terminalId, detail);
    }) as unknown as (...args: never[]) => void);

    on("close", (() => {
      if (record.status !== "closed") this.closeRecord(terminalId, "连接已断开");
    }) as unknown as (...args: never[]) => void);

    on("keyboard-interactive", ((_name: string, _instructions: string, _lang: string, prompts: Array<{ echo: boolean }>, finish: (answers: string[]) => void) => {
      // 密码认证被服务器要求走 keyboard-interactive 时用同一密码应答。
      finish(prompts.map(() => password));
    }) as unknown as (...args: never[]) => void);

    on("ready", (() => {
      record.client.shell({ term: "xterm-256color", cols: clampDimension(cols, 80), rows: clampDimension(rows, 24) }, (error, stream) => {
        if (error || !stream) {
          this.failRecord(terminalId, error?.message || "无法打开远程 shell（服务器可能禁用了 PTY 分配）");
          return;
        }
        record.stream = stream;
        record.status = "connected";
        if (record.trustedFingerprint) {
          this.deps.knownHosts.put(record.host, record.port, record.trustedFingerprint);
          record.trustedFingerprint = undefined;
        }
        stream.on("data", ((chunk: Buffer) => {
          this.enqueue(terminalId, chunk.toString("utf8"));
        }) as unknown as (...args: never[]) => void);
        stream.on("close", (() => {
          if (record.status !== "closed") {
            record.status = "closed";
            record.client.end();
            this.closeRecord(terminalId, "远程 shell 已关闭");
          }
        }) as unknown as (...args: never[]) => void);
        this.deps.publish(terminalId, { type: "status", terminalId, status: "connected" });
      });
    }) as unknown as (...args: never[]) => void);

    record.client.connect({
      host: stored.host,
      port: stored.port,
      username: stored.username,
      password,
      tryKeyboard: true,
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        const fingerprint = fingerprintOfHostKey(key);
        if (known === fingerprint) return true;
        if (known === undefined) {
          if (trustFingerprint) {
            record.trustedFingerprint = fingerprint;
            return true;
          }
          // 探测：拒绝握手并**推事件**告知指纹——ssh2 的 hostVerifier 在异步握手中
          // 才被调用，connect() 早已返回，指纹不可能随命令返回值带回（首版 bug：
          // 渲染端永远停在「正在连接」）。渲染端收事件后显示确认卡，用户信任后
          // 带 trustFingerprint 重发；AI 的轮询从 probedFingerprints 看到。
          record.probeFingerprint = fingerprint;
          this.probedFingerprints.set(terminalId, fingerprint);
          this.deps.publish(terminalId, { type: "fingerprint", terminalId, fingerprint });
          return false;
        }
        record.fingerprintMismatch = fingerprint; // 拒绝 + error 事件给明确文案
        return false;
      }
    });
    return { kind: "connect" };
  }

  // ——— AI 操作通道（utility → main RPC） ———

  async handleAutomation(sessionKey: string, request: SshAutomationRequest): Promise<SshAutomationResult> {
    try {
      switch (request.op) {
        case "hosts": {
          const hosts = this.deps.hostStore.list();
          const groups = this.deps.hostStore.listGroups();
          const connections = [...this.connections.values()]
            .filter((record) => record.status === "connected")
            .map((record) => connectionInfoOf(record));
          return { ok: true, data: { kind: "hosts", hosts, groups, connections } };
        }
        case "connect": {
          const stored = this.findHost(request.host);
          const existing = [...this.connections.values()].find((record) => record.hostId === stored.id && record.status !== "closed");
          let terminalId: string;
          if (existing) {
            terminalId = existing.terminalId;
          } else {
            terminalId = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            this.connect(terminalId, stored.id, 80, 24, false);
            // 连接是异步的：等就绪 / 失败 / 探测出指纹（TOFU 需人工确认，AI 拒绝）。
            await this.waitForConnected(terminalId);
          }
          this.sessionBindings.set(sessionKey, terminalId);
          const record = this.connections.get(terminalId);
          if (!record) throw new Error("连接已失效，请重试 ssh_connect");
          // AI 绑定的连接对用户可见（tab 激活）：命令回显是需求核心。
          this.deps.reveal({ terminalId, hostId: record.hostId, hostName: record.hostName });
          return { ok: true, data: { kind: "connect", connection: connectionInfoOf(record) } };
        }
        case "exec": {
          const record = this.boundRecord(sessionKey);
          if (record.pendingExec) throw new Error("已有命令正在执行，请等待完成（可 ssh_read 查看进度）或先 ssh_write 发送 Ctrl-C 中断");
          const timeoutMs = Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(EXEC_MIN_TIMEOUT_MS, Math.round(request.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS)));
          const data = await this.aiExec(record, request.command, timeoutMs);
          return { ok: true, data };
        }
        case "write": {
          const record = this.boundRecord(sessionKey);
          if (!record.stream) throw new Error("连接尚未就绪或已断开");
          record.stream.write(request.data);
          return { ok: true, data: { kind: "write", written: request.data.length } };
        }
        case "read": {
          const record = this.boundRecord(sessionKey);
          const tailChars = Math.min(READ_MAX_CHARS, Math.max(200, Math.round(request.tailChars ?? READ_DEFAULT_CHARS)));
          const text = stripAnsi(record.scrollback).slice(-tailChars);
          return { ok: true, data: { kind: "read", text, totalChars: record.scrollback.length } };
        }
        case "close": {
          const terminalId = this.sessionBindings.get(sessionKey);
          this.sessionBindings.delete(sessionKey);
          if (!terminalId) return { ok: true, data: { kind: "close", closed: false } };
          const had = this.connections.has(terminalId);
          this.kill(terminalId);
          return { ok: true, data: { kind: "close", closed: had } };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private findHost(query: string): SshHostSummary {
    const hosts = this.deps.hostStore.list();
    if (hosts.length === 0) throw new Error("尚未配置任何 SSH 主机。请先在侧边栏 SSH 面板保存主机（地址/端口/用户名/密码）。");
    const trimmed = query.trim().toLowerCase();
    const exact = hosts.find((host) => hostMatches(host, query));
    if (exact) return exact;
    const partial = hosts.filter((host) => host.name.toLowerCase().includes(trimmed));
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) throw new Error(`主机名称「${query}」匹配到多条配置（${partial.map((host) => host.name).join("、")}），请使用完整名称。`);
    throw new Error(`未找到主机「${query}」。可用主机：${hosts.map((host) => host.name).join("、")}`);
  }

  private boundRecord(sessionKey: string): ConnectionRecord {
    const terminalId = this.sessionBindings.get(sessionKey);
    if (!terminalId) throw new Error("当前会话尚未建立 SSH 连接，请先调用 ssh_connect。");
    const record = this.connections.get(terminalId);
    if (!record || record.status === "closed") throw new Error("SSH 连接已断开，请重新 ssh_connect。");
    return record;
  }

  /** 等待连接就绪/失败/指纹探测（AI 新建连接用；复用已有连接时不会走到这里）。 */
  private waitForConnected(terminalId: string, timeoutMs = CONNECT_TIMEOUT_MS + 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const record = this.connections.get(terminalId);
      if (!record) return reject(new Error("连接已失效"));
      if (record.status === "connected") return resolve();
      const cleanup = (): void => {
        clearTimeout(timer);
        clearInterval(poll);
      };
      const timer = setTimeout(() => {
        cleanup();
        this.kill(terminalId);
        reject(new Error(`SSH 连接超时（${Math.round(timeoutMs / 1000)} 秒），请检查主机地址、端口与防火墙`));
      }, timeoutMs);
      const poll = setInterval(() => {
        // TOFU 探测优先于「记录消失」判定：探测被拒后 record 已被静默清理。
        const probed = this.probedFingerprints.get(terminalId);
        if (probed) {
          cleanup();
          this.probedFingerprints.delete(terminalId);
          this.kill(terminalId);
          reject(new Error(`首次连接该主机需要人工确认服务器指纹。请先在侧边栏 SSH 面板连接一次并信任指纹（指纹 ${probed}），之后 AI 即可复用该连接。`));
          return;
        }
        const current = this.connections.get(terminalId);
        if (!current || current.status === "closed") {
          cleanup();
          reject(new Error("SSH 连接失败或已断开（认证被拒绝或网络不可达）"));
          return;
        }
        if (current.status === "connected") {
          cleanup();
          resolve();
        }
      }, 100);
    });
  }

  /**
   * 向 shell 流写入命令 + marker printf，等待远端输出 marker（含退出码）。
   * 输出含命令回显（模型看到提示符与目录上下文）；超时不杀连接（命令可能
   * 仍在远端执行），返回已收到的部分输出并标记 timedOut。
   */
  private aiExec(record: ConnectionRecord, command: string, timeoutMs: number): Promise<SshAutomationData> {
    return new Promise((resolve) => {
      if (!record.stream) {
        resolve({ kind: "exec", output: "", exitCode: null, timedOut: true });
        return;
      }
      const seq = ++this.execSequence;
      const chunks: string[] = [];
      const finish = (result: { exitCode: number | null; timedOut: boolean }): void => {
        record.pendingExec = undefined;
        resolve({
          kind: "exec",
          output: stripAnsi(chunks.join("")).slice(-EXEC_OUTPUT_LIMIT_CHARS),
          exitCode: result.exitCode,
          timedOut: result.timedOut || undefined
        });
      };
      const timer = setTimeout(() => finish({ exitCode: null, timedOut: true }), timeoutMs);
      record.pendingExec = {
        seq,
        chunks,
        timer,
        resolve: (result) => {
          clearTimeout(timer);
          finish(result);
        }
      };
      // 一次写入整段（换行触发执行）；回显自然出现在用户窗口——需求核心。
      record.stream.write(`${command}\n${markerPrintfCommand(seq)}\n`);
    });
  }

  // ——— 数据流（terminal-pty 同款批量 flush） ———

  private enqueue(terminalId: string, chunk: string): void {
    const record = this.connections.get(terminalId);
    if (!record) return;
    // 剔除 marker 命令的终端回显（用户不该看到探针行）；净化后的流同时进
    // scrollback、AI 输出收集与 publish，三处口径一致。
    chunk = record.echoFilter(chunk);
    if (!chunk) return;
    record.scrollback = appendScrollback(record.scrollback, chunk);
    if (record.pendingExec) {
      record.pendingExec.chunks.push(chunk);
      const combined = record.pendingExec.chunks.join("");
      const prefix = markerSequence(record.pendingExec.seq);
      const markerStart = combined.indexOf(prefix);
      if (markerStart >= 0) {
        const afterMarker = combined.slice(markerStart + prefix.length);
        const belIndex = afterMarker.indexOf(MARKER_BEL);
        if (belIndex >= 0) {
          const codeText = afterMarker.slice(0, belIndex).trim();
          const exitCode = /^\d+$/.test(codeText) ? Number.parseInt(codeText, 10) : null;
          const pending = record.pendingExec;
          record.pendingExec = undefined;
          pending.resolve({ exitCode, timedOut: false });
        }
      }
    }
    if (record.pending.length + chunk.length >= FLUSH_MAX_CHARS) {
      this.pendingFlush.delete(record);
      const data = record.pending + chunk;
      record.pending = "";
      this.deps.publish(terminalId, { type: "data", terminalId, data });
      return;
    }
    record.pending += chunk;
    this.pendingFlush.add(record);
    if (!this.cancelFlush) this.cancelFlush = this.schedule(() => {
      this.cancelFlush = undefined;
      this.flush();
    });
  }

  private flush(): void {
    const records = [...this.pendingFlush];
    this.pendingFlush.clear();
    for (const record of records) {
      if (!record.pending) continue;
      const data = record.pending;
      record.pending = "";
      this.deps.publish(record.terminalId, { type: "data", terminalId: record.terminalId, data });
    }
    if (this.pendingFlush.size > 0 && !this.cancelFlush) {
      this.cancelFlush = this.schedule(() => {
        this.cancelFlush = undefined;
        this.flush();
      });
    }
  }

  // ——— 生命周期 ———

  private failRecord(terminalId: string, message: string): void {
    const record = this.connections.get(terminalId);
    if (!record) return;
    this.abortPendingExec(record);
    this.deps.publish(terminalId, { type: "error", terminalId, message });
    this.disposeRecord(terminalId);
    this.deps.publish(terminalId, { type: "status", terminalId, status: "closed", detail: message });
  }

  private closeRecord(terminalId: string, detail: string): void {
    const record = this.connections.get(terminalId);
    if (!record) return;
    this.abortPendingExec(record);
    this.disposeRecord(terminalId);
    this.deps.publish(terminalId, { type: "status", terminalId, status: "closed", detail });
  }

  private abortPendingExec(record: ConnectionRecord): void {
    if (!record.pendingExec) return;
    const pending = record.pendingExec;
    record.pendingExec = undefined;
    clearTimeout(pending.timer);
    pending.resolve({ exitCode: null, timedOut: true });
  }

  /** 纯清理：flush 残留、解绑监听、end client、移出 map。不 publish（调用方负责事件语义）。 */
  private disposeRecord(terminalId: string): void {
    const record = this.connections.get(terminalId);
    if (!record) return;
    if (record.pending) {
      const data = record.pending;
      record.pending = "";
      this.deps.publish(terminalId, { type: "data", terminalId, data });
    }
    this.pendingFlush.delete(record);
    if (this.pendingFlush.size === 0) {
      this.cancelFlush?.();
      this.cancelFlush = undefined;
    }
    record.status = "closed";
    record.disposeListeners();
    try {
      record.stream?.end();
      record.client.end();
    } catch {
      // 已销毁的 client 再 end 属幂等路径
    }
    this.connections.delete(terminalId);
  }

  kill(terminalId: string): void {
    const record = this.connections.get(terminalId);
    if (!record) return;
    record.status = "closed"; // 先置态：后续 error/close 事件据此静默
    try {
      record.stream?.close();
      record.client.end();
    } catch {
      // 幂等
    }
    this.closeRecord(terminalId, "连接已关闭");
  }

  disposeAll(): void {
    for (const terminalId of [...this.connections.keys()]) this.kill(terminalId);
  }
}

function connectionInfoOf(record: ConnectionRecord): SshConnectionInfo {
  return { terminalId: record.terminalId, hostId: record.hostId, hostName: record.hostName, host: record.host, username: record.username };
}
