import { createHash } from "node:crypto";
import type {
  SshAutomationRequest,
  SshAutomationData,
  SshAutomationResult,
  SshCommand,
  SshCommandResult,
  SshConnectionInfo,
  SshEventData,
  SshGroupSummary,
  SshRevealEvent,
  SshHostDraft,
  SshHostSummary,
  SshHostTestResult
} from "../shared/protocol.js";
import type { SshHostStore, StoredSshHost } from "./ssh-host-store.js";
import { validateHostDraft } from "./ssh-host-store.js";
import type { SshKnownHostsStore } from "./ssh-known-hosts.js";
import { knownHostKey } from "./ssh-known-hosts.js";
import { SshSftpTransferService, type SshSftpLike } from "./ssh-sftp.js";
import { downloadDirFor } from "./browser-downloads.js";
import { stripAnsi } from "./ansi.js";

/**
 * SSH 连接管理：ssh2 Client + shell channel（远端 PTY），与本地 PTY 终端
 * （terminal-pty.ts）同一套通道形状——scrollback 重放、批量 flush（交互块
 * 走低延迟通道、大流量 10ms/64KB，见 enqueue）、resize；客户端 socket 显式
 * 打开 TCP_NODELAY（见 beginConnection）。人工输入与 AI 写入共享同一条
 * shell 流：AI 的命令经远端回显实时出现在用户的 xterm 窗口里；命令完成
 * 检测用不可打印的 OSC 序列 marker（ESC ] 633;pi-ssh;<seq>;<exit> BEL），
 * 普通命令输出无法伪造——命令回显里 printf 参数是字面反斜杠文本，与
 * printf 输出的真实 ESC 字节天然可区分。
 *
 * 纯逻辑 + 注入 ssh2 工厂/推送/存储依赖（terminal-pty 同模式），可单测。
 */

/** ssh2 Client 的最小结构视图（index.ts 注入真实实现，测试注入 fake）。 */
export interface SshClientLike {
  connect(options: SshConnectOptionsLike): void;
  /**
   * 打开/关闭 TCP_NODELAY。ssh2 **不会**自动设置它（`Client#setNoDelay` 是公开
   * API，库内部从不调用），不设置就等于让 Nagle 参与交互输入：上一个按键包还没
   * 被 ACK 时，下一个小包会被攒住，跨洋链路上表现为「连续输入被整成一包一等
   * RTT、回显成串迟滞」（2026-11-02 实测，见 beginConnection 的注释）。
   */
  setNoDelay?(noDelay: boolean): unknown;
  end(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  shell(options: { term: string; cols: number; rows: number }, callback: (error: Error | undefined, stream: SshShellStreamLike) => void): void;
  /** 打开一条 exec 通道（连接测试用：不碰用户的 shell 会话）。 */
  exec?(command: string, callback: (error: Error | undefined, stream: SshExecStreamLike) => void): void;
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
  /**
   * 空闲心跳（ms）。ssh2 每周期发一次 `keepalive@openssh.com` 全局请求，
   * `keepaliveCountMax` 次无应答就判定链路已死。不设的话，NAT / 企业防火墙
   * 常把 5–10 分钟没有流量的连接直接剪掉，用户看到的是「终端突然断开」。
   */
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
}

/** exec 通道的最小结构视图（连接测试只用它的 close）。 */
export interface SshExecStreamLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  close?(): void;
}

export interface SshShellStreamLike {
  write(data: string): void;
  /**
   * **ssh2 的口径：rows 在前**（`Channel#setWindow(rows, cols, height, width)`，报文里
   * 才是 `cols, rows, width, height`）。写成 cols 在前会静默把远端 PTY 的列数设成本地
   * 行数：初始宽屏正常、面板一拖宽输出就卡在旧列数、右侧留白（2026-10-03 修复的根因）。
   */
  setWindow(rows: number, cols: number, height: number, width: number): void;
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
  /**
   * 实时读取 settings.ssh.autoTrustFingerprint（缺省 false）。
   *
   * 开启时未知指纹**不弹确认卡**，直接记录并放行——人工面板与 AI 的连接共用这一条
   * 判断（用户明确要求「连面板点连接也不再弹卡」）。指纹已记录但本次不一致的分支
   * 不受影响：那时仍然拒绝（防中间人）。注入式，故可在测试里自由开关。
   */
  autoTrustFingerprint?: () => boolean;
  /**
   * 主机/分组清单已被 AI 改动（失效信号，不带数据）：主进程转发给渲染端，
   * 已打开的 SSH 面板据此重新拉 hosts。AI 配置变更与连接成功后的密码落库均调用；
   * 面板自身的增删改已经会 refresh，无需重复通知。
   */
  notifyHostsChanged?: () => void;
  /** Test seam：异步 flush 调度（缺省 setTimeout）。 */
  scheduleFlush?(callback: () => void): () => void;
  /**
   * Test seam：**低延迟** flush 调度（缺省 setImmediate）——交互块（打字回显）走这条，
   * 不等 10ms 批量定时器。
   */
  scheduleImmediateFlush?(callback: () => void): () => void;
}

interface PendingExec {
  seq: number;
  chunks: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: { exitCode: number | null; timedOut: boolean }) => void;
}

/** 密码卡需要展示的主机身份（事件载荷，不含密码）。 */
interface SshHostIdentity {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
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
  /** 用户（或 AI）已信任的指纹（连接 ready 后写入指纹库）。 */
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
/** 待确认指纹表的条数上限（超出淘汰最旧的；见 pendingTrust 注释）。 */
export const PENDING_TRUST_LIMIT = 20;
/**
 * 单次批量导入的主机条数上限。hostStore 每条都会原子写盘一次，不设上限等于让
 * 一次工具调用做无界 IO；超限直接拒绝整批（不部分写入，免得用户以为导完了）。
 */
export const HOST_IMPORT_LIMIT = 200;
const FLUSH_INTERVAL_MS = 10;
const FLUSH_MAX_CHARS = 64 * 1024;
/**
 * 交互块上限：累计输出不超过它就走「下一轮事件循环立刻发」，不等 10ms 批量。
 *
 * 为什么（2026-11-02 实测）：`setTimeout(10)` 在 Windows 上的实际触发间隔是
 * 定时器粒度 **15.6ms**，而它固定挂在每次按键回显的前面——真实主机（RTT 124ms）
 * 端到端回显 p50 142ms，其中 15.8ms 是这口批量；换成 setImmediate 后同一探针
 * 降到 0.6ms。打字回显本来就是 1–3 字节的小块，批量合并对它零收益。
 * 阈值取 2KB：覆盖普通命令输出（`ls`/`cd`/提示符），又不会把 `cat` 这种
 * 大流量放进低延迟通道。
 */
export const INTERACTIVE_FLUSH_MAX_CHARS = 2 * 1024;
/**
 * 低延迟 flush 的最小间隔（节流）：逐行打印的小块输出（构建日志、进度条）不能把
 * IPC 打成风暴——8ms 内只允许一次立即 flush，其余回落 10ms 批量。
 * 人打字最快约 10 键/秒（100ms 间隔），永远在闸门之外，不受影响。
 */
export const INTERACTIVE_FLUSH_MIN_GAP_MS = 8;
const SCROLLBACK_LIMIT_CHARS = 200 * 1024;
const DIMENSION_MIN = 2;
const DIMENSION_MAX = 500;
const CONNECT_TIMEOUT_MS = 20_000;
/**
 * 空闲心跳：15 秒一次、3 次无应答判死（ssh2 的 keepalive 只在该周期内没有其它
 * 报文时才发，交互输入期间不会额外产生流量）。依据见 SshConnectOptionsLike。
 */
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;
/** 连接测试的硬上限（建连 + 一条 echo 往返）：超过就按失败返回。 */
export const SSH_TEST_TIMEOUT_MS = 20_000;
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

/**
 * 名称归一键（分组名与主机名共用）：trim + 小写。
 *
 * 用户粘进对话里的清单大小写常不统一（`Prod` vs `prod`），精确匹配会在库里
 * 长出两个近似分组/两台近似主机；导入路径一律用这个键比较。面板的人工操作不受
 * 影响（仍按输入的原文保存）。
 */
export function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export class SshConnectionManager {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly pendingFlush = new Set<ConnectionRecord>();
  /** AI 会话 → 连接绑定（连接归 tab 所有，会话 dispose 不解绑不关连接）。 */
  private readonly sessionBindings = new Map<string, string>();
  /** 探测记录：terminalId → 指纹（TOFU 拒绝后 record 即被清理，AI 的轮询只能从这里看到探测结果）。 */
  private readonly probedFingerprints = new Map<string, string>();
  /**
   * 待确认指纹：hostKey → 本次握手探测到的指纹。
   *
   * 与 probedFingerprints 的区别是键与寿命：后者按 terminalId（探测连接被 kill 后就
   * 没用了），本表按主机留存，供随后的 `trust-host`（AI 的 ssh_trust_fingerprint）消费
   * ——AI 不需要手抄指纹，也不可能凭空写库：只有真实握手过的指纹才会进这里。
   * 无定时器，按条数上限淘汰（超限删最旧）。
   */
  private readonly pendingTrust = new Map<string, { fingerprint: string; at: number }>();
  /**
   * 本次运行有效的临时密码（hostId → 凭据）：密码卡用户不勾「记住密码」时也不落库，
   * 但留在内存里，重连与开关标签都不再追问。重启即忘（进程内存，不写盘）。
   * `secret` 是写入时主机凭据的指纹：主机被编辑（换地址/账号/密码）后这条缓存立即失效。
   */
  private readonly sessionPasswords = new Map<string, {
    password: string;
    /** 用户勾了「记住密码」：先记下，等握手成功再落库。 */
    remember: boolean;
    host: string;
    port: number;
    username: string;
    secret: string;
  }>();
  /** 等待用户输入的请求（terminalId → 事件）：重挂载/重发 connect 时重放，kill 时清理。 */
  private readonly pendingPasswords = new Map<string, Extract<SshEventData, { type: "password-required" }>>();
  private execSequence = 0;
  private readonly schedule: (callback: () => void) => () => void;
  private readonly scheduleImmediate: (callback: () => void) => () => void;
  private cancelFlush: (() => void) | undefined;
  private cancelImmediate: (() => void) | undefined;
  /** 上一次 publish 数据的时间（单调时钟）：低延迟 flush 的节流闸门。 */
  private lastPublishAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: SshConnectionsDeps) {
    this.schedule = deps.scheduleFlush ?? ((callback) => {
      const timer = setTimeout(callback, FLUSH_INTERVAL_MS);
      return () => clearTimeout(timer);
    });
    this.scheduleImmediate = deps.scheduleImmediateFlush ?? ((callback) => {
      const handle = setImmediate(callback);
      return () => clearImmediate(handle);
    });
  }

  // ——— 渲染端命令通道（与 TerminalManager.handle 同构） ———

  handle(command: SshCommand): SshCommandResult {
    switch (command.type) {
      case "connect": return this.connect(command.terminalId, command.hostId, command.cols, command.rows, command.trustFingerprint === true, {
        ...(command.password !== undefined ? { password: command.password } : {}),
        ...(command.rememberPassword === true ? { rememberPassword: true } : {})
      });
      case "input": this.connections.get(command.terminalId)?.stream?.write(command.data); return { kind: "void" };
      case "resize": {
        const record = this.connections.get(command.terminalId);
        // 参数顺序必须是 (rows, cols, height, width)——ssh2 的签名如此，见 SshShellStreamLike 注释。
        // 像素两项沿用 ssh2 reqPty 的默认值（640×480），只是装饰性信息。
        if (record?.stream) record.stream.setWindow(clampDimension(command.rows, 24), clampDimension(command.cols, 80), 480, 640);
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
        // 主机没了，内存里的临时密码与待输入询问也一并作废（凭据不留在进程里等下次误用）。
        this.forgetHost(command.hostId);
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
    // 连接测试要等握手/往返，必须异步（同步入口会被 IPC 调用方当成卡死）。
    if (command.type === "host.test") {
      return this.testHost(command.hostId).then((result) => ({ kind: "host-tested" as const, result }));
    }
    return undefined;
  }

  /**
   * 发起连接。返回带 fingerprint = TOFU 待确认（渲染端显示确认卡后带 trustFingerprint 重发）。
   *
   * 密码三条来源（优先级从高到低）：本次连接补传的 `password`（密码卡）→ 本次运行
   * 的临时密码（不勾「记住密码」时也留在内存里，重连不再追问）→ 落库密码。三条都
   * 没有时**不报错**，而是推 `password-required` 让渲染端弹密码卡：用户输入后拿同一
   * terminalId 重发带 password 的 connect，连接从这一步继续。
   */
  private connect(
    terminalId: string,
    hostId: string,
    cols: number,
    rows: number,
    trustFingerprint: boolean,
    supplied: { password?: string; rememberPassword?: boolean } = {}
  ): SshCommandResult {
    const existing = this.connections.get(terminalId);
    if (existing && existing.status !== "closed") {
      if (existing.scrollback) this.deps.publish(terminalId, { type: "data", terminalId, data: existing.scrollback });
      this.deps.publish(terminalId, { type: "status", terminalId, status: existing.status });
      return { kind: "connect" };
    }
    const stored = this.deps.hostStore.get(hostId);
    if (!stored) throw new Error("主机不存在，请先在 SSH 面板保存配置");
    const pending = this.pendingPasswords.get(terminalId);
    if (!pending && this.connections.size + this.pendingPasswords.size >= SSH_MAX_CONNECTIONS) throw new Error(`SSH 连接数量已达上限（${SSH_MAX_CONNECTIONS}），请先关闭其他连接标签`);
    if (pending && supplied.password === undefined && pending.hostId === hostId && pending.host === stored.host && pending.port === stored.port && pending.username === stored.username) {
      // 包括认证被拒的询问：重挂载不能再次拿旧的落库密码发起认证。
      this.deps.publish(terminalId, pending);
      return { kind: "connect" };
    }
    const password = this.resolvePassword(stored, supplied);
    if (password === undefined) {
      this.publishPasswordRequired(terminalId, identityOf(stored), "missing");
      return { kind: "connect" };
    }

    this.pendingPasswords.delete(terminalId);
    this.beginConnection(terminalId, stored, cols, rows, trustFingerprint, password);
    return { kind: "connect" };
  }

  /** 该主机当前是否有可用密码（落库的或本次运行的临时密码）。 */
  private availablePassword(hostId: string): string | undefined {
    const stored = this.deps.hostStore.get(hostId);
    if (!stored) return undefined;
    const cached = this.sessionPasswords.get(hostId);
    if (cached) {
      // 主机配置只要动过（地址/端口/用户名/已存密码），旧密码就作废：拿旧凭据去撞认证
      // 的结果是「报错→要密码→再进密码卡」，用户会以为程序在循环要密码。
      if (cached.host === stored.host && cached.port === stored.port && cached.username === stored.username && cached.secret === stored.secret) return cached.password;
      this.sessionPasswords.delete(hostId);
    }
    return this.deps.hostStore.passwordOf(hostId);
  }

  /**
   * 解析本次连接的密码，并登记临时密码 / 「记住密码」的待落库标记。
   *
   * 不勾「记住密码」也把密码留在 `sessionPasswords`：那是**本次运行**的缓存，重连、
   * 开关标签都不再追问，重启即忘。勾了记住也只**先记标记**，由握手成功后的 ready
   * 处理器落库——密码写错就落库会把错密码存进用户配置，比不保存更厌。
   */
  private resolvePassword(stored: StoredSshHost, supplied: { password?: string; rememberPassword?: boolean }): string | undefined {
    const given = supplied.password;
    if (given !== undefined) {
      if (given.length === 0) return undefined; // 空密码当作「没给」（卡片已禁止提交，兼防手写命令）
      this.sessionPasswords.set(stored.id, {
        password: given,
        remember: supplied.rememberPassword === true,
        host: stored.host,
        port: stored.port,
        username: stored.username,
        secret: stored.secret
      });
      return given;
    }
    return this.availablePassword(stored.id);
  }

  /** 向渲染端要一次密码（界面弹卡片），顺带把状态文案说清——这里不发 error/closed。 */
  private publishPasswordRequired(terminalId: string, identity: SshHostIdentity, reason: "missing" | "auth-failed", detail?: string): void {
    const event: Extract<SshEventData, { type: "password-required" }> = {
      type: "password-required",
      terminalId,
      hostId: identity.id,
      hostName: identity.name,
      host: identity.host,
      port: identity.port,
      username: identity.username,
      reason,
      // safeStorage 不可用时密码是明文降级落盘（与面板顶部的 credentialInsecure 警告同源），
      // 卡片据此把「加密保存」改成实话。
      credentialInsecure: !this.deps.hostStore.credentialsSecure(),
      ...(detail ? { detail } : {})
    };
    this.pendingPasswords.set(terminalId, event);
    this.deps.publish(terminalId, event);
  }

  /** 真正的握手与 shell 开启（密码已定；不含「要密码」那条分支）。 */
  private beginConnection(terminalId: string, stored: StoredSshHost, cols: number, rows: number, trustFingerprint: boolean, password: string): void {
    const hostId = stored.id;
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
      const message = error.message || "SSH 连接失败";
      if (!record.fingerprintMismatch && isAuthFailure(message)) {
        // 密码认证被拒：丢掉本次运行的临时密码（写错了或已过期），回到「向用户要密码」
        // 这一步。刻意**不**发 error/status closed——那会把界面钉在失败页，而此刻
        // 用户该看到的是密码卡（卡上自带失败原因）；记录静默销毁。
        this.sessionPasswords.delete(record.hostId);
        this.abortPendingExec(record);
        const identity = { id: record.hostId, name: record.hostName, host: record.host, port: record.port, username: record.username };
        this.disposeRecord(terminalId);
        this.publishPasswordRequired(terminalId, identity, "auth-failed", message);
        return;
      }
      const detail = record.fingerprintMismatch
        ? `主机指纹与已记录的不一致（可能是中间人攻击，或服务器重装/换 IP）。记录指纹校验失败：${record.fingerprintMismatch}。若确认服务器已更换，请删除 userData/pidesktop-ssh-known-hosts.json 中 ${stored.host}:${stored.port} 条目后重连。`
        : message;
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
      if (record.status === "closed") return; // 握手期间已被 kill（用户关标签/取消）
      record.client.shell({ term: "xterm-256color", cols: clampDimension(cols, 80), rows: clampDimension(rows, 24) }, (error, stream) => {
        if (record.status === "closed") {
          stream?.close();
          return;
        }
        if (error || !stream) {
          this.failRecord(terminalId, error?.message || "无法打开远程 shell（服务器可能禁用了 PTY 分配）");
          return;
        }
        // 「记住密码」到这一刻才落库：密码正确性已被服务器验证。落库对象是**当前**
        // 主机配置（用户在连接期间可能刚改过地址/账号），缓存里的 secret 同步刷新，
        // 否则刚存的凭据会被自己的指纹校验判为陈旧。写盘失败不让用户误以为已保存。
        const cached = this.sessionPasswords.get(hostId);
        const current = this.deps.hostStore.get(hostId);
        if (cached?.remember && cached.password === password && current && cached.host === current.host && cached.port === current.port && cached.username === current.username && cached.secret === current.secret) {
          try {
            this.deps.hostStore.setPassword(hostId, password);
            cached.secret = current.secret;
            cached.remember = false;
            this.deps.notifyHostsChanged?.();
          } catch {
            cached.remember = false;
            stream.close();
            this.failRecord(terminalId, "保存 SSH 密码失败，请重新连接；下次将仅在本次运行内使用密码");
            return;
          }
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

    record.client.connect(this.connectOptions(stored, password, (key: Buffer) => {
      const fingerprint = fingerprintOfHostKey(key);
      if (known === fingerprint) return true;
      if (known === undefined) {
        // 信任来源二选一：本次连接显式带 trustFingerprint（确认卡「信任并连接」），
        // 或设置里开了首连自动信任（人工与 AI 一视同仁）。两条都走 trustedFingerprint，
        // 由 ready 处理器统一写库。
        if (trustFingerprint || this.deps.autoTrustFingerprint?.() === true) {
          record.trustedFingerprint = fingerprint;
          return true;
        }
        // 探测：拒绝握手并**推事件**告知指纹——ssh2 的 hostVerifier 在异步握手中
        // 才被调用，connect() 早已返回，指纹不可能随命令返回值带回（首版 bug：
        // 渲染端永远停在「正在连接」）。渲染端收事件后显示确认卡，用户信任后
        // 带 trustFingerprint 重发；AI 的轮询从 probedFingerprints 看到，随后可调
        // ssh_trust_fingerprint 信任（对应 pendingTrust 记录）。
        record.probeFingerprint = fingerprint;
        this.probedFingerprints.set(terminalId, fingerprint);
        this.rememberPendingTrust(knownHostKey(stored.host, stored.port), fingerprint);
        this.deps.publish(terminalId, { type: "fingerprint", terminalId, fingerprint });
        return false;
      }
      record.fingerprintMismatch = fingerprint; // 拒绝 + error 事件给明确文案
      return false;
    }));
    // TCP_NODELAY：ssh2 从不自己设置（库内没有一处调用它，`Client#setNoDelay`
    // 是留给调用方的公开 API），而不设置时 Nagle 会在「上一个小包还没被 ACK」
    // 期间攒住后续小包 —— 交互输入正是「一次按键一个几字节小包」的形态，在
    // 100ms 级 RTT 的链路上会被整成「一包一等 RTT」：连续打字时回显成串迟滞、
    // 停手后还要再等一两秒才收干。所有正经 SSH 客户端都开这一项。
    // socket 在 connect() 内同步创建，所以这一行必须放在 connect() 之后。
    record.client.setNoDelay?.(true);
  }

  /**
   * 统一的 ssh2 连接参数（真实连接与连接测试共用）：readyTimeout、keepalive、
   * 认证方式、指纹校验。密码与指纹判断由调用方给，这里只负责把**通道层面的
   * 默认值收在一处**——两个入口各写一份就会漂移（keepalive 只在其中一处生效，
   * 正是那种「看着有、实际没有」的典型）。
   */
  private connectOptions(stored: StoredSshHost, password: string, hostVerifier: (key: Buffer) => boolean): SshConnectOptionsLike {
    return {
      host: stored.host,
      port: stored.port,
      username: stored.username,
      password,
      tryKeyboard: true,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      hostVerifier
    };
  }

  // ——— 连接测试（面板「测试」按钮） ———

  /**
   * 测试一台主机并给出一到两个延迟数字。
   *
   * 已有连接时**不重连**：直接在现有 client 上开一条 exec 通道跑 `echo ok`，
   * 得到的往返最接近用户打字回显的体感（不打扰正在用的 shell，也不消耗一次
   * 完整握手）。没有连接时新建一条临时连接：先量建连（TCP + 密钥交换 + 认证），
   * 再量同一连接上的一次往返，测完立刻断开。
   *
   * 失败一律返回结构化结果（不抛）：面板要显示「为什么连不上」，而不是一个
   * 只存在于控制台的异常。
   */
  async testHost(hostId: string): Promise<SshHostTestResult> {
    const stored = this.deps.hostStore.get(hostId);
    if (!stored) return { hostId, ok: false, error: "主机不存在或已删除" };
    const live = [...this.connections.values()].find((record) => record.hostId === hostId && record.status === "connected");
    if (live) {
      try {
        return { hostId, ok: true, roundTripMs: Math.round(await this.execRoundTrip(live.client)) };
      } catch (error) {
        return { hostId, ok: false, error: errorMessageOf(error) };
      }
    }
    const password = this.availablePassword(hostId);
    if (password === undefined) {
      return { hostId, ok: false, needsPassword: true, error: "该主机还没有可用密码：先在终端连接一次并输入密码，再回来测试" };
    }
    const known = this.deps.knownHosts.get(stored.host, stored.port);
    const client = this.deps.createClient();
    let unknownFingerprint = false;
    let fingerprintMismatch = false;
    return await new Promise<SshHostTestResult>((resolve) => {
      let settled = false;
      let connectMs: number | undefined;
      const started = performance.now();
      const finish = (result: SshHostTestResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { client.end(); } catch { /* 已断开 */ }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ hostId, ok: false, connectMs: connectMs === undefined ? undefined : Math.round(connectMs), error: `连接测试超时（${Math.round(SSH_TEST_TIMEOUT_MS / 1000)} 秒）` }), SSH_TEST_TIMEOUT_MS);
      client.on("error", ((error: Error) => {
        if (settled) return;
        const message = error.message || "连接失败";
        const hint = unknownFingerprint
          ? "首次连接需要确认服务器指纹：先在终端连接一次并信任，或在设置里打开「首次连接自动信任指纹」"
          : fingerprintMismatch
            ? "主机指纹与已记录的不一致（可能是中间人攻击，或服务器重装/换 IP），已拒绝测试"
            : isAuthFailure(message)
              ? `密码认证被拒绝：${message}`
              : message;
        finish({ hostId, ok: false, ...(connectMs === undefined ? {} : { connectMs: Math.round(connectMs) }), error: hint });
      }) as unknown as (...args: never[]) => void);
      client.on("keyboard-interactive", ((_name: string, _instructions: string, _lang: string, prompts: Array<{ echo: boolean }>, done: (answers: string[]) => void) => {
        done(prompts.map(() => password));
      }) as unknown as (...args: never[]) => void);
      client.on("ready", (() => {
        connectMs = performance.now() - started;
        void this.execRoundTrip(client).then((roundTripMs) => {
          finish({ hostId, ok: true, connectMs: Math.round(connectMs ?? 0), roundTripMs: Math.round(roundTripMs) });
        }, (error: unknown) => {
          finish({ hostId, ok: false, connectMs: Math.round(connectMs ?? 0), error: errorMessageOf(error) });
        });
      }) as unknown as (...args: never[]) => void);
      client.connect(this.connectOptions(stored, password, (key: Buffer) => {
        const fingerprint = fingerprintOfHostKey(key);
        if (known === fingerprint) return true;
        if (known === undefined) {
          if (this.deps.autoTrustFingerprint?.() === true) {
            this.deps.knownHosts.put(stored.host, stored.port, fingerprint);
            return true;
          }
          unknownFingerprint = true;
          return false;
        }
        fingerprintMismatch = true;
        return false;
      }));
      client.setNoDelay?.(true);
    });
  }

  /** 在一条连接上开 exec 通道跑 `echo ok`，返回从发出到通道关闭的毫秒数。 */
  private execRoundTrip(client: SshClientLike): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!client.exec) {
        reject(new Error("当前 SSH 客户端不支持 exec 通道，无法测速"));
        return;
      }
      const started = performance.now();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("测试命令超时（远端没有应答）"));
      }, SSH_TEST_TIMEOUT_MS);
      client.exec("echo ok", (error, stream) => {
        if (error) {
          settled = true;
          clearTimeout(timer);
          reject(error);
          return;
        }
        stream.on("close", ((code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (typeof code !== "number") {
            reject(new Error("测试过程中连接断开了"));
            return;
          }
          if (code !== 0) {
            reject(new Error(`远端返回退出码 ${code}`));
            return;
          }
          resolve(performance.now() - started);
        }) as unknown as (...args: never[]) => void);
      });
    });
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
          // 同一主机已经有一张「等用户输密码」的卡（可能是用户刚刚点开的，也可能是上一次
          // ssh_connect 留下的）：复用它，不再开第二张卡、不堆 tab。
          const pending = [...this.pendingPasswords.values()].find((event) => event.hostId === stored.id);
          let terminalId: string;
          if (existing || pending) {
            terminalId = (existing ?? pending!).terminalId;
          } else {
            terminalId = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            this.connect(terminalId, stored.id, 80, 24, false);
          }
          // reveal 必须在等待**之前**：没有密码时密码卡就是正事（用户不看到它，这个请求
          // 只能超时）；认证被拒时 record 已被销毁，密码卡也得有活着的标签在听。
          this.deps.reveal({ terminalId, hostId: stored.id, hostName: stored.name });
          // 同一个请求等下去：用户输入密码（或取消 / 关标签 / 超时）后这里才返回。
          await this.waitForConnected(terminalId);
          this.sessionBindings.set(sessionKey, terminalId);
          const record = this.connections.get(terminalId);
          if (!record) throw new Error("连接已失效，请重试 ssh_connect");
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
          return { ok: true, data: { kind: "upload", remotePath: result.path, name: result.name, bytes: result.bytes, ...(result.note ? { note: result.note } : {}) } };
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
        case "trust-host": {
          const stored = this.findHost(request.host);
          const key = knownHostKey(stored.host, stored.port);
          const pending = this.pendingTrust.get(key);
          if (!pending) {
            const recorded = this.deps.knownHosts.get(stored.host, stored.port);
            if (recorded) {
              return { ok: true, data: { kind: "trust-host", hostName: stored.name, host: stored.host, fingerprint: recorded, alreadyTrusted: true } };
            }
            throw new Error(`没有待确认的指纹记录。请先 ssh_connect 主机「${stored.name}」（首次连接会失败并给出指纹），再用 ssh_trust_fingerprint 信任它。`);
          }
          // 传了指纹就是「核对」语义：不一致坚决不写库（防手抄出错写错指纹）。
          const claimed = request.fingerprint?.trim();
          if (claimed && claimed !== pending.fingerprint) {
            throw new Error(`传入的指纹与本次握手的指纹不一致（实际为 ${pending.fingerprint}）。请改用实际指纹，或省略该参数由服务端记录。`);
          }
          this.deps.knownHosts.put(stored.host, stored.port, pending.fingerprint);
          this.pendingTrust.delete(key);
          return { ok: true, data: { kind: "trust-host", hostName: stored.name, host: stored.host, fingerprint: pending.fingerprint, alreadyTrusted: false } };
        }
        case "host-save": {
          const draft = request.draft;
          const error = validateHostDraft({ name: draft.name, host: draft.host, username: draft.username, ...(draft.port !== undefined ? { port: draft.port } : {}) });
          if (error) throw new Error(error);
          // 分组按名称解析（工具层不暴露内部 id）：命中复用，未命中创建。
          const groupName = draft.groupName?.trim();
          const groupId = groupName ? this.resolveGroupId(groupName) : undefined;
          // 永远不传密码：新建=无密码（连接时由用户在密码卡输入），编辑=保留原密码。
          const existing = request.target?.trim() ? this.findHost(request.target) : undefined;
          const saved = this.deps.hostStore.save({ ...(existing ? { id: existing.id } : {}), name: draft.name, host: draft.host, username: draft.username, ...(draft.port !== undefined ? { port: draft.port } : {}), ...(groupId !== undefined ? { groupId } : {}) }, undefined);
          this.deps.notifyHostsChanged?.();
          return { ok: true, data: { kind: "host-saved", host: saved } };
        }
        case "host-delete": {
          const stored = this.findHost(request.host);
          if (!this.deps.hostStore.remove(stored.id)) throw new Error(`主机「${stored.name}」不存在或已删除`);
          this.forgetHost(stored.id);
          this.deps.notifyHostsChanged?.();
          return { ok: true, data: { kind: "host-deleted", hostName: stored.name } };
        }
        case "host-import": {
          const entries = request.hosts;
          if (!Array.isArray(entries) || entries.length === 0) throw new Error("请提供要导入的主机列表（至少一条）");
          if (entries.length > HOST_IMPORT_LIMIT) {
            throw new Error(`一次最多导入 ${HOST_IMPORT_LIMIT} 台主机，本次 ${entries.length} 台，请分批导入。`);
          }
          let created = 0;
          let updated = 0;
          const groupsCreated: string[] = [];
          const failed: Array<{ index: number; name: string; error: string }> = [];
          for (const [index, entry] of entries.entries()) {
            const name = typeof entry?.name === "string" ? entry.name.trim() : "";
            try {
              const error = validateHostDraft({ name: entry?.name ?? "", host: entry?.host ?? "", username: entry?.username ?? "", ...(entry?.port !== undefined ? { port: entry.port } : {}) });
              if (error) throw new Error(error);
              const groupName = typeof entry?.groupName === "string" ? entry.groupName.trim() : "";
              // 不带 groupName = 不动分组（新建则为未分组，编辑则保留原分组）——
              // 避免一次导入把用户手动归过组的主机全部赶出来。
              const groupId = groupName ? this.resolveGroupId(groupName, groupsCreated) : undefined;
              // 按名称 upsert（大小写不敏感）：重复导入幂等，编辑路径不传密码 = 保留原密码。
              // 库里有多个同名主机时取第一个（导入是批量写入，报错会让整批其余条目白做）。
              const existing = this.deps.hostStore.list().find((host) => nameKey(host.name) === nameKey(name));
              this.deps.hostStore.save({ ...(existing ? { id: existing.id } : {}), name, host: entry.host, username: entry.username, ...(entry.port !== undefined ? { port: entry.port } : {}), ...(groupId !== undefined ? { groupId } : {}) }, undefined);
              if (existing) updated += 1;
              else created += 1;
            } catch (error) {
              // 单条失败不中断整批：一条地址写错不应该让另外 19 条白导。
              failed.push({ index, name: name || `#${index + 1}`, error: error instanceof Error ? error.message : String(error) });
            }
          }
          this.deps.notifyHostsChanged?.();
          return { ok: true, data: { kind: "host-imported", total: entries.length, created, updated, groupsCreated, failed } };
        }
        case "group-save": {
          const name = request.group?.name?.trim() ?? "";
          if (!name) throw new Error("分组名称不能为空");
          const existing = request.target?.trim() ? this.findGroup(request.target) : undefined;
          if (!existing) {
            // store.saveGroup 只做精确重名校验，这里再按归一键拦一道：否则 `Prod` 与
            // 既有的 `prod` 会同时存在（AI 复制粘贴清单时大小写不一致很常见）。
            const collision = this.deps.hostStore.listGroups().find((group) => nameKey(group.name) === nameKey(name));
            if (collision) throw new Error(`已存在同名分组「${collision.name}」（分组名不区分大小写）。`);
          }
          const saved = this.deps.hostStore.saveGroup({ ...(existing ? { id: existing.id } : {}), name });
          this.deps.notifyHostsChanged?.();
          return { ok: true, data: { kind: "group-saved", group: saved, created: !existing } };
        }
        case "group-delete": {
          const group = this.findGroup(request.group);
          const movedHosts = this.deps.hostStore.removeGroup(group.id);
          if (movedHosts < 0) throw new Error(`分组「${group.name}」不存在或已删除`);
          // 只改配置不动连接：组内主机已建立的 SSH 会话仍然活着（与面板删除同口径）。
          this.deps.notifyHostsChanged?.();
          return { ok: true, data: { kind: "group-deleted", groupName: group.name, movedHosts } };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 把分组名解析成 id：命中（大小写不敏感）复用，未命中创建。
   * `created` 收集本次新建的名字（批量导入去重用：同名多台主机只建一次）。
   */
  private resolveGroupId(groupName: string, created?: string[]): string {
    const key = nameKey(groupName);
    const existing = this.deps.hostStore.listGroups().find((group) => nameKey(group.name) === key);
    if (existing) return existing.id;
    const saved = this.deps.hostStore.saveGroup({ name: groupName.trim() });
    created?.push(saved.name);
    return saved.id;
  }

  /** 按名称（大小写不敏感）或 id 找分组；未命中报错并列出可用分组。 */
  private findGroup(query: string): SshGroupSummary {
    const groups = this.deps.hostStore.listGroups();
    const trimmed = query.trim().toLowerCase();
    const found = groups.find((group) => group.id.toLowerCase() === trimmed || nameKey(group.name) === nameKey(query));
    if (found) return found;
    throw new Error(`未找到分组「${query}」。${groups.length > 0 ? `可用分组：${groups.map((group) => group.name).join("、")}` : "当前没有任何分组。"}`);
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

  /** 删除主机时清掉内存凭据 + 结束还在等输入的询问（内存卫生，不是权限边界）。 */
  private forgetHost(hostId: string): void {
    this.sessionPasswords.delete(hostId);
    for (const event of [...this.pendingPasswords.values()]) {
      if (event.hostId === hostId) this.kill(event.terminalId);
    }
  }

  private boundRecord(sessionKey: string): ConnectionRecord {
    const terminalId = this.sessionBindings.get(sessionKey);
    if (!terminalId) throw new Error("当前会话尚未建立 SSH 连接，请先调用 ssh_connect。");
    const record = this.connections.get(terminalId);
    if (!record || record.status === "closed") throw new Error("SSH 连接已断开，请重新 ssh_connect。");
    return record;
  }

  /**
   * 记下本次握手的指纹（供 ssh_trust_fingerprint 消费）。
   *
   * 按条数上限淘汰最旧的一批：这是「最近探测过的主机」的短期备忘，不是历史记录，
   * 没有定时器也没有写盘；同一主机重连直接覆盖（只留最新一次握手的指纹）。
   */
  private rememberPendingTrust(key: string, fingerprint: string): void {
    this.pendingTrust.delete(key);
    this.pendingTrust.set(key, { fingerprint, at: Date.now() });
    while (this.pendingTrust.size > PENDING_TRUST_LIMIT) {
      const oldest = this.pendingTrust.keys().next();
      if (oldest.done) break;
      this.pendingTrust.delete(oldest.value);
    }
  }

  /**
   * 等待连接就绪 / 失败 / 指纹探测（AI 新建连接用；复用已有连接时不会走到这里）。
   *
   * 密码卡也是「等待」的一种：用户还在输入时不看作超时，只是把整体预算放长
   *（输入 90s、整个调用 110s，都小于 utility 侧的 120s watchdog）。用户取消、关闭
   * 标签（kill 清掉 pendingPasswords）或超时都会让这次 ssh_connect 如实报错，而不是
   * 让模型的回合无限挂起。
   */
  private waitForConnected(terminalId: string, timeoutMs = CONNECT_TIMEOUT_MS + 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const record = this.connections.get(terminalId);
      if (!record && !this.pendingPasswords.has(terminalId)) return reject(new Error("连接已取消或失效"));
      if (record && record.status === "connected") return resolve();
      const cleanup = (): void => {
        clearTimeout(timer);
        clearInterval(poll);
      };
      const started = Date.now();
      let passwordSeen = this.pendingPasswords.has(terminalId);
      const timer = setTimeout(() => {
        cleanup();
        this.kill(terminalId);
        reject(new Error("SSH 连接等待超时（含等待用户输入密码），请重新连接"));
      }, 110_000);
      const poll = setInterval(() => {
        // TOFU 探测优先于「记录消失」判定：探测被拒后 record 已被静默清理。
        const probed = this.probedFingerprints.get(terminalId);
        if (probed) {
          cleanup();
          this.probedFingerprints.delete(terminalId);
          this.kill(terminalId);
          reject(new Error(`首次连接该主机需要确认服务器指纹（指纹 ${probed}）。可调用 ssh_trust_fingerprint（host: 主机名）信任它，然后重新 ssh_connect；也可以让用户在 SSH 面板连接并确认。`));
          return;
        }
        if (this.pendingPasswords.has(terminalId)) {
          // 还停在密码卡上：不提「记录不存在」的报错，只在超过输入预算时收摊。
          passwordSeen = true;
          if (Date.now() - started > 90_000) {
            cleanup();
            this.kill(terminalId);
            reject(new Error("等待输入 SSH 密码超时，请重新连接或让用户先在面板保存密码"));
          }
          return;
        }
        // 提交密码前的常规超时仍然生效（没人在输密码时不该干等 110s）。
        if (!passwordSeen && Date.now() - started > timeoutMs) {
          cleanup();
          this.kill(terminalId);
          reject(new Error(`SSH 连接超时（${Math.round(timeoutMs / 1000)} 秒），请检查主机地址、端口与防火墙`));
          return;
        }
        const current = this.connections.get(terminalId);
        if (!current || current.status === "closed") {
          cleanup();
          reject(new Error("SSH 连接已取消、失败或断开"));
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
      this.lastPublishAt = performance.now();
      this.deps.publish(terminalId, { type: "data", terminalId, data });
      return;
    }
    record.pending += chunk;
    this.pendingFlush.add(record);
    // 交互块（打字回显）走低延迟通道：见 INTERACTIVE_FLUSH_MAX_CHARS 的注释。
    if (record.pending.length <= INTERACTIVE_FLUSH_MAX_CHARS && performance.now() - this.lastPublishAt >= INTERACTIVE_FLUSH_MIN_GAP_MS) {
      this.scheduleImmediateFlush();
    } else {
      this.scheduleTimerFlush();
    }
  }

  /** 10ms 批量 flush（大流量走这条）。 */
  private scheduleTimerFlush(): void {
    if (this.cancelFlush) return;
    this.cancelFlush = this.schedule(() => {
      this.cancelFlush = undefined;
      this.flush();
    });
  }

  /** 下一轮事件循环立刻 flush（交互块走这条）；定时器让位，同一批数据不等两次。 */
  private scheduleImmediateFlush(): void {
    if (this.cancelImmediate) return;
    this.cancelFlush?.();
    this.cancelFlush = undefined;
    this.cancelImmediate = this.scheduleImmediate(() => {
      this.cancelImmediate = undefined;
      this.flush();
    });
  }

  private flush(): void {
    this.cancelFlush?.();
    this.cancelFlush = undefined;
    this.cancelImmediate?.();
    this.cancelImmediate = undefined;
    this.lastPublishAt = performance.now();
    const records = [...this.pendingFlush];
    this.pendingFlush.clear();
    for (const record of records) {
      if (!record.pending) continue;
      const data = record.pending;
      record.pending = "";
      this.deps.publish(record.terminalId, { type: "data", terminalId: record.terminalId, data });
    }
    if (this.pendingFlush.size > 0) this.scheduleTimerFlush();
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
    // 还在等用户输密码：清掉询问请求（它同时是「等待中」的标记），并告知界面已取消。
    if (this.pendingPasswords.delete(terminalId)) {
      this.deps.publish(terminalId, { type: "status", terminalId, status: "closed", detail: "已取消输入密码" });
    }
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
    for (const terminalId of [...this.pendingPasswords.keys()]) this.kill(terminalId);
    this.sessionPasswords.clear();
  }
}

/** 主机身份（事件载荷用）。 */
function identityOf(stored: StoredSshHost): SshHostIdentity {
  return { id: stored.id, name: stored.name, host: stored.host, port: stored.port, username: stored.username };
}

/**
 * 密码认证失败的识别（ssh2 在「所有认证方式都试过且失败」时给这条固定文案）。
 * 刻意只认这些模式：把任意 error 都当认证失败会让「网络不通」也弹出密码框，
 * 反复让用户白输密码。
 */
/** 把任意抛错整理成面板可显示的一行文字。 */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAuthFailure(message: string): boolean {
  return /all configured authentication methods failed|no supported authentication methods|authentication failed/i.test(message);
}

function connectionInfoOf(record: ConnectionRecord): SshConnectionInfo {
  return { terminalId: record.terminalId, hostId: record.hostId, hostName: record.hostName, host: record.host, username: record.username };
}
