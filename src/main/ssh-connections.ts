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
import { SshSftpTransferService, type SshSftpLike } from "./ssh-sftp.js";
import { downloadDirFor } from "./browser-downloads.js";
import { stripAnsi } from "./ansi.js";

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
  /** 打开 SFTP 通道（首次文件操作时懒开，随连接销毁）。 */
  sftp(callback: (error: Error | undefined, sftp: SshSftpLike) => void): void;
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
  /** SFTP 通道与传输服务：首次文件操作时懒建（不用文件功能的连接零开销）。 */
  sftp?: SshSftpTransferService;
  sftpChannel?: SshSftpLike;
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

/** 剥除 ANSI OSC/CSI 序列与控制字符（AI 回执与 ssh_read 给模型干净文本）。
 *  实现已抽到 `src/main/ansi.ts`（终端侧也要用同一份），此处保留再导出以免调用方散落。 */
export { stripAnsi };

// marker 回显的构成片段：与 markerPrintfCommand 共用同一组常量，保证「测试样本」
// 与「真实回显」永不漂移（此前单测手写字面样本，漏掉了远端折行形态）。
const MARKER_ECHO_HEAD = "printf '";
const MARKER_ECHO_ESC = "\\033";
const MARKER_ECHO_OSC = MARKER_PRINTF_ESCAPE;
const MARKER_ECHO_TAIL = ";%s\\007' \"$?\"";

/** marker 的远端 printf 命令（POSIX printf：bash/dash/busybox 均支持 \033 与 \007）。 */
export function markerPrintfCommand(seq: number): string {
  return `${MARKER_ECHO_HEAD}${MARKER_ECHO_ESC}${MARKER_ECHO_OSC}${seq}${MARKER_ECHO_TAIL}`;
}

/**
 * 候选回显文本的长度上限：正常回显才 50 字符左右，防的是「输出里出现回显前缀
 * 但不是回显」时无限暂扣（如 cat 一个含该前缀且后跟大量空行的文件）。
 */
const MARKER_ECHO_CANDIDATE_LIMIT = 256;

/**
 * 显示流净化器：把 marker 命令的**字面回显**从数据流中剔除。AI 的 ssh_exec
 * 在业务命令后追加一行 printf 探针，远端 shell 会把这一行原样回显（跟用户自己
 * 敲的命令一样），会在终端里显出一行奇怪的 printf（用户实测反馈）。marker 的
 * 完成检测靠的是 printf **输出的真实 ESC 字节**，与回显的字面 `\033` 文本天然
 * 可分，所以剔除字面回显对检测零影响。
 *
 * 逐字符状态机而非整行正则，原因是**远端 readline 会折行**：命令回显超过
 * 终端列宽时，readline 在换行处插入 CRLF 并**重复边界字符**（真机实测，PTY
 * 58 列、提示符 34 字符：`printf '\033]633;pi-ssh;8` + CRLF + `8;%s\007'
 * "$?"`）。整行正则跨不过那个 CRLF，此前版本因此完全失效（用户报「还是
 * 有」）；状态机把 CRLF 与重复边界字符当折行伪影吞掉，且天然跨 chunk（候选
 * 文本暂扣到匹配完成或失配为止，失配即原样吐回输出，不丢字符）。
 * 匹配不中（如 zsh 语法高亮在回显里插了转义）退化为不过滤，无害。
 */
export function createMarkerEchoFilter(): (chunk: string) => string {
  // 目标序列被拆成固定文本段：前 3 段是字面量（与 markerPrintfCommand 共用，
  // 测试样本因此不会与真实回显漂移），第 4 段是序号（至少一位数字），第 5 段是尾。
  const literals = [MARKER_ECHO_HEAD, MARKER_ECHO_ESC, MARKER_ECHO_OSC] as const;
  const DIGITS = literals.length;
  const TAIL = DIGITS + 1;
  const END = TAIL + 1;
  let out = "";
  /** 0..DIGITS-1 = 正在匹配 literals[stage]；DIGITS = 序号数字；TAIL = 尾段；END = 回显已丢弃。 */
  let stage = 0;
  /** 当前段内已匹配到的字符数。 */
  let pos = 0;
  /** 序号段已收到的数字（至少一位才算合法）。 */
  let digits = "";
  /** 候选回显文本（尚未确认）。空串 = 不在候选态，普通字符直接出输出。 */
  let matched = "";
  /** 已匹配的最后一个字符：折行伪影重复的就是它。 */
  let lastChar = "";
  /** 刚吞掉一个换行（折行伪影），下一个字符若是边界字符的重复则也吞掉。 */
  let dupPending = false;

  /** 失配：候选文本不是回显（或只是回显前缀），原样吐回输出并复位。 */
  const flush = (): void => {
    out += matched;
    matched = "";
    stage = 0;
    pos = 0;
    digits = "";
    lastChar = "";
    dupPending = false;
  };

  /** 回显完整匹配：丢弃候选文本并复位（行尾伪影由 END 阶段处理）。 */
  const drop = (): void => {
    matched = "";
    stage = 0;
    pos = 0;
    digits = "";
    lastChar = "";
    dupPending = false;
  };

  /** 当前段还需要等的字符（序号段接受任意数字，返回 undefined 表示「是数字即可」）。 */
  const expected = (): string | undefined => {
    if (stage === DIGITS) return undefined;
    const text = stage === TAIL ? MARKER_ECHO_TAIL : literals[stage]!;
    return text[pos];
  };

  /** 当前段的完整长度（序号段视作一位，见 feed 里的特判）。 */
  const lengthOf = (at: number): number => (at === DIGITS ? 1 : at === TAIL ? MARKER_ECHO_TAIL.length : literals[at]!.length);

  const feed = (c: string): void => {
    // 候选过长 = 必然不是回显：原样吐出，避免无限暂扣。
    if (matched.length > MARKER_ECHO_CANDIDATE_LIMIT) flush();
    for (;;) {
      if (stage === END) {
        // 回显已丢弃；把行尾换行与紧随的重复边界字符一并吞掉，不留空提示符行。
        if (c === "\r" || c === "\n") {
          dupPending = true;
          return;
        }
        if (dupPending && c === lastChar) {
          dupPending = false;
          return;
        }
        drop();
        continue; // 该字符按普通输出重新处理
      }
      const inMatch = stage > 0 || matched.length > 0 || dupPending;
      if (c === "\r" || c === "\n") {
        // 候选态里的换行只能是远端折行伪影（真实回显是单行命令）。
        if (inMatch) {
          matched += c;
          dupPending = true;
          return;
        }
        out += c;
        return;
      }
      // 折行伪影重复的边界字符：先当伪影吞掉，但仍记进候选——若后续失配，
      // 候选原样吐回输出，绝不丢字符（不变量：删掉 CR/LF 后候选 === 迄今收到的字符）。
      if (dupPending && c === lastChar) {
        dupPending = false;
        matched += c;
        return;
      }
      const want = expected();
      const hit = stage === DIGITS ? c >= "0" && c <= "9" : c === want;
      if (hit) {
        matched += c;
        lastChar = c;
        dupPending = false;
        pos += 1;
        if (stage === DIGITS) {
          // 序号至少一位；遇到非数字才切到尾段（同一个字符重新匹配）。
          digits += c;
          return;
        }
        if (pos === lengthOf(stage)) {
          if (stage === TAIL) {
            // 回显完整确认：立刻丢弃，只留 lastChar 供行尾伪影判定。
            drop();
            stage = END;
            lastChar = c;
            return;
          }
          stage += 1;
          pos = 0;
        }
        return;
      }
      if (stage === DIGITS && digits.length > 0) {
        // 序号已结束：切到尾段并用当前字符继续匹配。
        stage = TAIL;
        pos = 0;
        continue;
      }
      if (inMatch) {
        flush();
        continue;
      }
      out += c;
      return;
    }
  };

  return (chunk: string): string => {
    out = "";
    for (const c of chunk) feed(c);
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
      default:
        // 所有 sftp.* 都是异步入队（流式传输），统一走 handleSftp；由 index.ts
        // 按性质选同步/异步入口（这里只能报错，不能返回 Promise）。
        throw new Error(`不支持同步执行的 SSH 命令：${command.type}`);
    }
  }

  /** SFTP 命令（异步入口）。`handleSftp()` 负责整个 sftp.* 命名空间。 */
  handleAsync(command: SshCommand): Promise<SshCommandResult> | undefined {
    if (command.type.startsWith("sftp.")) {
      return this.handleSftp(command as Extract<SshCommand, { type: `sftp.${string}` }>);
    }
    return undefined;
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

  // ——— SFTP 文件传输（人工渲染端命令） ———

  /**
   * 懒开 SFTP 通道：首次文件操作时 `client.sftp()`，随后缓存到连接记录，
   * 连接销毁时一并 end。不用文件功能的用户不会多开任何通道。
   */
  private ensureSftp(record: ConnectionRecord): Promise<SshSftpTransferService> {
    if (record.sftp) return Promise.resolve(record.sftp);
    if (record.status !== "connected") return Promise.reject(new Error("SSH 连接尚未就绪，请等待终端连上后再传输文件"));
    return new Promise((resolveService, rejectService) => {
      record.client.sftp((error, sftp) => {
        if (error || !sftp) {
          rejectService(new Error(`无法打开 SFTP 通道（服务器可能未启用 SFTP 子系统）：${error?.message ?? "未知错误"}`));
          return;
        }
        record.sftpChannel = sftp;
        const service = new SshSftpTransferService({
          sftp,
          terminalId: record.terminalId,
          publish: (event) => this.deps.publish(record.terminalId, event)
        });
        record.sftp = service;
        resolveService(service);
      });
    });
  }

  /** 多文件时给子传输编号（`base#1`），单文件用原名（取消可按前缀匹配）。 */
  private subTransferId(base: string, index: number, count: number): string {
    return count > 1 ? `${base}#${index + 1}` : base;
  }

  /**
   * 人工 SFTP 命令分派。单个文件失败**不中断**整批（失败已经通过 transfer 事件
   * 告知用户），但全批失败时把错误抛回渲染端（否则用户看到一堆失败却没有理由）。
   */
  async handleSftp(command: Extract<SshCommand, { type: `sftp.${string}` }>): Promise<SshCommandResult> {
    const record = this.connections.get(command.terminalId);
    if (!record || record.status === "closed") throw new Error("SSH 连接未就绪或已断开，请先连接终端");

    if (command.type === "sftp.cancel") {
      const service = record.sftp;
      if (!service) return { kind: "void" };
      const active = service.activeTransferId();
      // 取消按基 id 前缀匹配：多文件传输时活动 id 是 `base#N`。
      if (active && (active === command.transferId || active.startsWith(`${command.transferId}#`))) {
        service.cancel(active);
      }
      return { kind: "void" };
    }

    const service = await this.ensureSftp(record);

    if (command.type === "sftp.list") {
      const listing = await service.list(command.path);
      return { kind: "sftp-listing", path: listing.path, ...(listing.home ? { home: listing.home } : {}), entries: listing.entries };
    }

    if (command.type === "sftp.upload") {
      const failures: string[] = [];
      for (const [index, localPath] of command.localPaths.entries()) {
        const id = this.subTransferId(command.transferId, index, command.localPaths.length);
        try {
          await service.upload(id, { localPath, remoteDir: command.remoteDir });
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (failures.length === command.localPaths.length && failures.length > 0) throw new Error(failures[0]!);
      return { kind: "void" };
    }

    // sftp.download
    // 渲染端传工作区，落盘目录在主进程按统一下载策略推导（渲染端不得自行指定
    // 磁盘路径；与浏览器下载同一落点，也便于 AI 统一用 ls .pidesktop/downloads/ 找产物）。
    const workspace = command.workspace.trim();
    if (!workspace) throw new Error("下载需要先确定工作区，当前会话没有可用工作区");
    const localDir = downloadDirFor(workspace);
    const downloadFailures: string[] = [];
    for (const [index, remotePath] of command.remotePaths.entries()) {
      const id = this.subTransferId(command.transferId, index, command.remotePaths.length);
      try {
        await service.download(id, { remotePath, localDir });
      } catch (error) {
        downloadFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (downloadFailures.length === command.remotePaths.length && downloadFailures.length > 0) throw new Error(downloadFailures[0]!);
    return { kind: "void" };
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
        case "upload": {
          const record = this.boundRecord(sessionKey);
          const service = await this.ensureSftp(record);
          const result = await service.upload(`ai-upload-${Date.now().toString(36)}`, {
            localPath: request.localPath,
            remoteDir: request.remoteDir,
            ...(request.remoteName ? { remoteName: request.remoteName } : {}),
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
          });
          return { ok: true, data: { kind: "upload", remotePath: result.path, name: result.name, bytes: result.bytes } };
        }
        case "download": {
          const record = this.boundRecord(sessionKey);
          const service = await this.ensureSftp(record);
          const result = await service.download(`ai-download-${Date.now().toString(36)}`, {
            remotePath: request.remotePath,
            localDir: request.localDir,
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
          });
          // 只回绝对路径：相对路径由 utility（知道工作区）算，主进程不猜。
          return { ok: true, data: { kind: "download", localPath: result.path, name: result.name, bytes: result.bytes } };
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
    // SFTP 先于 client.end()：取消在途传输（流已被销毁）+ 关 SFTP 通道，
    // 否则客户端断开时在途传输会以晦涩的通道错误收场。
    record.sftp?.dispose();
    record.sftp = undefined;
    record.sftpChannel = undefined;
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
