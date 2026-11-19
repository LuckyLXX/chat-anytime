import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  GALLERY_SERVICE_LOG_TAIL_CHARS,
  GALLERY_SERVICE_WAIT_MS,
  MAX_GALLERY_SERVICE_RECORDS,
  compactServiceTail,
  galleryServiceFailureMessage,
  galleryServiceLive,
  type GalleryServiceFailure,
  type GalleryServiceRecord,
  type GalleryServiceStartRequest,
  type GalleryServiceStartResult
} from "../shared/gallery.js";
import { stripAnsi } from "./ansi.js";
import { isProcessAlive } from "./background-processes.js";
import { parseServiceAddress, probeService, waitForService, type ServiceAddress } from "./gallery-service.js";
import { resolveShellCommand, shellServiceInvocation } from "./terminal-pty.js";

/**
 * 作品（Gallery）服务型作品的**后台进程宿主**（2026-11-12）。
 *
 * 为什么要有它（用户 2026-11-12 的原话：「这些服务不应该占据一个标签页，因为页面我很
 * 可能会关掉……作为后台进程的话我没地方能看到」）：
 *
 * 旧实现把启动命令交给预览面板里的一个终端标签（PTY），进程与标签同生共死——关标签
 * （或者被标签所在的界面收起来）服务就没了。而作品里的服务有两类：① 起服务的同时要
 * 开一个页面/面板去用它；② 纯服务进程（反代 / API / 给别的程序用的桥）。第二类根本
 * 不需要终端，第一类也不该因为关掉页面就断掉。
 *
 * 现在两类都走这里：命令由主进程 spawn 成**后台进程**（没有终端、不占标签），stdout /
 * stderr 收进环形缓冲，状态与日志尾部随 `onChange` 推给渲染端的「运行中的服务」看板
 * （停止 / 重启 / 看日志 / 打开页面都在那里）。生命周期服从应用：`disposeAll()` 在
 * 应用退出时把整棵进程树杀掉，不留孤儿。
 *
 * 本模块刻意保持「注入式纯逻辑」：spawn / kill / probe / 时钟都能替换，因此单测不需要
 * 真起进程（真进程的形态由真机与 dev 冒烟覆盖）。
 */

/** 一个被拉起的进程的句柄（默认实现见 createShellLauncher）。 */
export interface GalleryServiceProcessHandle {
  pid?: number;
  /** stdout 与 stderr 都从这里出来（顺序即到达顺序）。 */
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (info: { exitCode?: number | null; error?: string }) => void): void;
  /** 单进程 kill 兜底（进程树由 killTree 负责）。 */
  kill(): void;
}

export type GalleryServiceLauncher = (command: string, cwd: string) => GalleryServiceProcessHandle;

/** 起服务的入参（形状在 shared 层：渲染端与主进程用同一份）。 */
export type GalleryServiceStartInput = GalleryServiceStartRequest;

export interface GalleryServiceRunnerDeps {
  launch: GalleryServiceLauncher;
  /** 结束整棵进程树（Windows: taskkill /F /T；POSIX: kill(-pid)）。 */
  killTree(pid: number): void;
  /** 探活（缺省 TCP connect）。 */
  probe?(address: ServiceAddress): Promise<boolean>;
  now?(): number;
  /** 等就绪的睡眠（缺省真 setTimeout）；注入它在单测里把 30 秒预算瞬移。 */
  sleep?(ms: number): Promise<void>;
  /** 状态/日志变化（调用方负责节流——输出可能一秒钟来几十次）。 */
  onChange?(): void;
  /** 单次「等就绪」预算（缺省 GALLERY_SERVICE_WAIT_MS）。 */
  waitMs?: number;
  /**
   * 停止/重启时等「旧进程真的退出」的宽限（缺省 GALLERY_SERVICE_STOP_GRACE_MS = 5s）。
   *
   * 只能**缩短**（单测把 5 秒压成几十毫秒），绝不允许把它拉长成「无限期等」：
   * 等待超时之后要如实告知「旧进程可能仍在运行」，而不是把用户卡在按钮上。
   */
  stopGraceMs?: number;
  /** 内部环形缓冲上限（字符）。 */
  logBufferChars?: number;
}

/** 内部日志环形缓冲（比推给渲染端的尾部更长，启动早期输出不会一上来就被挤掉）。 */
export const GALLERY_SERVICE_LOG_BUFFER_CHARS = 64_000;
/** `stop()` 之后等退出事件的宽限：超时仍活着就如实标记「停止没生效」。 */
export const GALLERY_SERVICE_STOP_GRACE_MS = 5_000;

interface Entry {
  record: GalleryServiceRecord;
  handle?: GalleryServiceProcessHandle;
  buffer: string;
  /** 用户点了停止（退出事件到达时据此区分「被停」与「自己崩了」）。 */
  stopping: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  /** 等待「进程已经结束」的挂起者（重启要等旧进程真的走掉再起新的）。 */
  exitWaiters: (() => void)[];
  /**
   * 一次性结算守卫（2026-11-16 计划 4.4）。
   *
   * spawn 失败会同时发 `error` 与 `exit` 两个事件（Node 对 ENOENT 两个都发），`stop()`
   * 的兜底定时器与真实退出事件也会前后脚到达。没有这个守卫，后到的事件会把「已停止」
   * 改写成「启动失败」、把 exitWaiters 唤醒两次、把 endedAt 刷成后来的时刻。
   */
  settled: boolean;
  /**
   * 这个记录被「作品运行」认领的次数（新建 = 1，每次复用 +1）。
   *
   * 面板关窗回调是异步来的：它到达时用户可能已经把面板重新打开、重新运行并重新认领了
   * 服务。关窗快照（`GalleryOwnerStopTicket`）记的是**那一刻的认领序号**，只有「同一条
   * 记录、仍是同一次认领」才会被停：重开后的新记录（新 id）与新认领（序号变了）不受影响，
   * 而关窗时正在启动的服务照停（不能因为「在途」就留孤儿）。
   */
  claimSeq: number;
  /** spawn 的异步错误（ENOENT 之类）：就绪前失败时要把原始原因带给用户。 */
  launchError?: string;
}

/**
 * 关窗那一刻捕获的「这个面板拥有什么」快照（不透明：只有 `stopByOwner` 认识它）。
 *
 * 为什么需要它（2026-11-16 计划 4.4）：面板关闭回调被推迟到下一个 tick（Electron 销毁栈
 * 里不能去结束整棵进程树），而用户可能在这之前就把面板重新打开、重新运行。只按
 * `ownerPanelId` 停会在两头出错：
 * - 把重开面板刚认领的服务（同一个记录）误杀；
 * - 反过来，为了躲这个误杀而跳过「还在启动」的服务，关窗时的在途服务就永远没人收。
 * 快照把「关窗那一刻的归属 + 那次认领」钉住：只停同一条记录的同一次认领。
 */
export interface GalleryOwnerStopTicket {
  ownerPanelId: string;
  /** 记录 id → 关窗那一刻的认领序号。 */
  claims: Map<string, number>;
  /** 关窗那一刻还在途/排队的 start（尚未登记记录）的认领 id：它们也要一起取消。 */
  pending: string[];
}

/**
 * 一次「为某个面板起的服务」的认领凭据（runner 内部）。
 *
 * 为什么需要它（2026-11-16 计划 4.4）：`start()` 在 `entries` 里登记记录之前有一个
 * **探活 await**（外部服务可达性，最久 800ms，慢机器上更久）。这期间面板被关掉时，
 * `stopByOwner` 遍历 `entries` 什么也找不到——探活一恢复就照样 spawn 出一个没有主人的
 * 进程。所以「为这个面板起的服务」这件事要在**发起那一刻**就登记成认领凭据，关窗时
 * 连它一起取消；在途/排队下来的 start 在下一个检查点发现凭据已取消就放弃。
 */
interface OwnerStartClaim {
  ownerPanelId: string;
  cancelled: boolean;
}

function tail(text: string, limit: number): string {
  return text.length > limit ? text.slice(text.length - limit) : text;
}

/** 输出尾部：剥掉 ANSI 控制序列（ConPTY / 彩色日志的噪声没人读得懂）。 */
export function galleryServiceLogTail(buffer: string, limit = GALLERY_SERVICE_LOG_TAIL_CHARS): string {
  return tail(stripAnsi(buffer), limit);
}

/**
 * 结束整棵进程树（默认实现）。
 *
 * Windows 用 `taskkill /F /T`（npm → node 这种父子链一次带走）；POSIX 用负 pid 打整个
 * 进程组——`createShellLauncher` 在 POSIX 上以 `detached` 启动，就是为了让进程组成为
 * 一个可整体回收的单位。
 */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    } catch {
      // taskkill 不可用（极端精简的系统镜像）：交给 handle.kill() 兜底。
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 进程已经没了：无事可做。
    }
  }
}

/**
 * 子进程输出该按什么传统编码回退：按系统语言给第一候选，`windows-1252` 兜底。
 *
 * 只在 Windows 上有意义：cmd 的内建命令、Windows PowerShell / pwsh 的 cmdlet、部分
 * Python 与系统工具都按**控制台代码页**（中文机器 = 936 / GBK；日文 932 / Shift_JIS；
 * 韩文 949 / EUC-KR）写 stdout / stderr，而不是 UTF-8。POSIX 侧输出基本都是 UTF-8，
 * 不解码成传统编码（否则合法的 UTF-8 字节被瞎解读更糟）。
 *
 * 已知边界：这里按**系统语言**猜代码页，不是读真实的 OEM 代码页——系统区域设置被
 * 手工改成非常见组合（如英文系统跑 936）时仍可能解错，那时日志里的中文会退化成
 * 替换字符，但不会影响进程本身。
 */
export function defaultServiceLegacyEncodings(
  platform: NodeJS.Platform = process.platform,
  locale: string = Intl.DateTimeFormat().resolvedOptions().locale
): readonly string[] {
  if (platform !== "win32") return [];
  const language = locale.toLowerCase().split("-")[0] ?? "";
  if (language === "zh") return ["gbk", "windows-1252"];
  if (language === "ja") return ["shift_jis", "windows-1252"];
  if (language === "ko") return ["euc-kr", "windows-1252"];
  return ["windows-1252"];
}

/** 双字节（首字节 0x81–0xFE + 尾字节）的传统编码：跨 chunk 时要能认出「首字节在末尾」。 */
const LEGACY_DOUBLE_BYTE = new Set(["gbk", "gb18030", "big5", "shift_jis", "euc-kr"]);

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function decodeStrictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeLenient(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return undefined; // 该编码在精简 ICU 里不存在：换下一个候选
  }
}

/**
 * 块里「完整的 UTF-8 前缀」有多少字节；末尾被截断的多字节字符不计入（-1 = 根本不是 UTF-8）。
 *
 * 区分这两种失败很重要：`中文` 的字节被 chunk 切成 `e4 b8 | ad e6 96 87` 是**跨块**，
 * 下一块接上就对了；而 GBK 的 `d6 d0` 永远拼不成合法 UTF-8，只能换编码解。
 */
export function utf8CompletePrefixLength(bytes: Uint8Array): number {
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (byte < 0x80) {
      index += 1;
      continue;
    }
    const need = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 0;
    if (need === 0) return -1; // 0x80–0xC1、0xF5–0xFF 不可能是 UTF-8 首字节
    for (let cursor = index + 1; cursor < index + need && cursor < bytes.length; cursor += 1) {
      if ((bytes[cursor]! & 0xc0) !== 0x80) return -1; // 续字节必须是 10xxxxxx
    }
    if (index + need > bytes.length) return index; // 尾部缺字节：等下一块
    index += need;
  }
  return bytes.length;
}

/** 双字节传统编码的完整前缀长度（首字节在末尾时留给下一块）。 */
function doubleByteCompletePrefixLength(bytes: Uint8Array): number {
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    index += byte < 0x81 ? 1 : 2;
  }
  return index > bytes.length ? bytes.length - 1 : bytes.length;
}

/**
 * 子进程输出解码器（stdout / stderr 各一份，不跨流拼接）。
 *
 * 为什么需要（2026-11-19，用户报「启动命令对中文路径支持有问题」的排查结论）：
 * 以前这里是 `String(chunk)` —— 按 UTF-8 解一切字节。可 Windows 上很多输出并不是
 * UTF-8：cmd 内建命令、Windows PowerShell / pwsh 的 cmdlet、部分 Python 与系统工具
 * 按控制台代码页（中文机器 = GBK）写 stdout / stderr。于是失败信息里最常出现的中文
 * 路径变成 `����·�� D:\�ճ�������`，看板上只剩乱码——看起来就像「中文路径不支持」。
 *
 * 逐块判定（同一个流里混着两种编码也能各解各的）：
 * 1. 整块能按 UTF-8 严格解开 → 就是 UTF-8（绝大多数情况，含本平台自己的输出）；
 * 2. 只有**末尾半个多字节字符**不完整（跨 chunk）→ 解出前半段，尾巴留到下一块；
 * 3. 其余（真的不是 UTF-8）→ 按系统传统编码解（见 defaultServiceLegacyEncodings）。
 *
 * 挂起量有界：UTF-8 最多 3 字节，双字节传统编码最多 1 字节；进程退出时 `flush()` 把
 * 它吐出来（宁可一个替换字符，也不静默丢字节）。
 */
export class GalleryServiceOutputDecoder {
  private pending = new Uint8Array(0);
  /**
   * 这股流已经确认「不是 UTF-8」了吗。
   *
   * 一旦确认就**粘住**：GBK 字节偶尔会碰巧构成合法 UTF-8（如 `C2 B7`），逐块重判会把
   * 后面的行解成另一套乱码；而反过来的情况（真 UTF-8 流里夹一段非法字节）只会
   * 错一块。所以「宁可一直错，也不要一行对一行错」。
   */
  private legacy = false;

  constructor(private readonly legacyEncodings: readonly string[] = defaultServiceLegacyEncodings()) {}

  push(chunk: Uint8Array | string): string {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    if (bytes.length === 0) return "";
    const joined = this.pending.length > 0 ? concatBytes(this.pending, bytes) : bytes;
    this.pending = new Uint8Array(0);
    if (!this.legacy) {
      const utf8 = decodeStrictUtf8(joined);
      if (utf8 !== undefined) return utf8;
      const complete = utf8CompletePrefixLength(joined);
      if (complete === 0) {
        // 块边界正好切在第一个字符里（整块都不完整）：留着等下一块，绝不能当传统编码解。
        this.pending = joined.slice(0);
        return "";
      }
      if (complete > 0 && complete < joined.length) {
        const head = decodeStrictUtf8(joined.subarray(0, complete));
        if (head !== undefined) {
          this.pending = joined.slice(complete);
          return head;
        }
      }
      this.legacy = true;
    }
    // 不是 UTF-8（或这股流已认定不是）：按系统传统编码解。双字节编码的末尾可能是
    // 「半个字」，留给下一块。
    const doubleByte = this.legacyEncodings.some((encoding) => LEGACY_DOUBLE_BYTE.has(encoding));
    const usable = doubleByte ? joined.subarray(0, doubleByteCompletePrefixLength(joined)) : joined;
    if (usable.length < joined.length) this.pending = joined.slice(usable.length);
    for (const encoding of this.legacyEncodings) {
      const text = decodeLenient(usable, encoding);
      if (text !== undefined) return text;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(usable);
  }

  /** 进程退出：把挂起的半截字符吐出来（不静默丢字节）。 */
  flush(): string {
    if (this.pending.length === 0) return "";
    const bytes = this.pending;
    this.pending = new Uint8Array(0);
    if (!this.legacy) {
      const utf8 = decodeStrictUtf8(bytes);
      if (utf8 !== undefined) return utf8;
    }
    for (const encoding of this.legacyEncodings) {
      const text = decodeLenient(bytes, encoding);
      if (text !== undefined) return text;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/**
 * 默认启动器：用用户自己的 shell 跑命令（与「自己在终端里跑」同一套解析）。
 *
 * 为什么经过 shell 而不是直接 spawn：Windows 上 `npm` / `npx` 实际是 `.cmd`，不经过
 * shell 解析会直接 ENOENT。命令的引号/`%`/`&` 处理沿用 `shellServiceInvocation`
 *（`cmd.exe` 必须走环境变量，见 terminal-pty.ts 的真机事故记录）。
 *
 * `stdio` 第二三项是 pipe：输出要进看板的日志。stdin 给 ignore——后台服务没有终端可
 * 交互，想让进程不阻塞就得显式关掉它（有些工具会等 stdin）。
 *
 * 输出一律过 `GalleryServiceOutputDecoder`（2026-11-19）：直接 `String(chunk)` 会把
 * GBK 的中文日志写成乱码，中文路径的报错就彻底不可读了。
 */
export function createShellLauncher(
  options: {
    shell?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    /** 输出不是 UTF-8 时按什么编码回退（缺省按系统语言推断，单测可注入）。 */
    legacyEncodings?: readonly string[];
  } = {}
): GalleryServiceLauncher {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const legacyEncodings = options.legacyEncodings ?? defaultServiceLegacyEncodings(platform);
  const shell = resolveShellCommand({ shell: options.shell, platform, env });
  return (command, cwd) => {
    const invocation = shellServiceInvocation(shell.file, command);
    const child = spawn(shell.file, invocation.args, {
      cwd,
      env: { ...env, ...(invocation.env ?? {}) },
      windowsHide: true,
      // POSIX：新进程组 ⇒ kill(-pid) 能整组回收；Windows：taskkill /T 已够，不需要 detached。
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    // stdout / stderr 各自一份解码器：两股流互不相干，拼在一起会把半个字符拼错。
    const stdoutDecoder = new GalleryServiceOutputDecoder(legacyEncodings);
    const stderrDecoder = new GalleryServiceOutputDecoder(legacyEncodings);
    let dataListener: ((chunk: string) => void) | undefined;
    const early: string[] = [];
    const emit = (text: string): void => {
      if (!text) return;
      if (dataListener) dataListener(text);
      else early.push(text); // 监听器还没挂上（极早期输出）：攒着，挂上即补发
    };
    child.stdout?.on("data", (chunk: Buffer) => emit(stdoutDecoder.push(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => emit(stderrDecoder.push(chunk)));
    return {
      get pid() {
        return child.pid;
      },
      onData(listener) {
        dataListener = listener;
        for (const text of early.splice(0)) listener(text);
      },
      onExit(listener) {
        child.once("error", (error: Error) => listener({ exitCode: null, error: error.message }));
        child.once("exit", (code) => {
          // 退出前把两个解码器里挂着的半截字符补出来：最后的报错往往就在这一口。
          emit(stdoutDecoder.flush());
          emit(stderrDecoder.flush());
          listener({ exitCode: code });
        });
      },
      kill() {
        try {
          child.kill();
        } catch {
          // 已经退出：无事可做。
        }
      }
    };
  };
}

/** 应用退出后（`disposeAll()`）所有启动入口的统一回执。 */
const GALLERY_SERVICE_DISPOSED_MESSAGE = "应用正在退出：不再启动新的后台服务";
/** 停止中的记录不许复用时的回执（计划 4.4 第 3 条）。 */
const GALLERY_SERVICE_STOPPING_MESSAGE = "正在停止，请稍后再运行";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 退出码的可读后缀（记录 note 与回执文案共用一份）。 */
function exitCodeText(exitCode: number | null | undefined): string {
  return typeof exitCode === "number" ? `（退出码 ${exitCode}）` : "";
}

export class GalleryServiceRunner {
  private readonly entries = new Map<string, Entry>();
  /**
   * 每个 appId 一条串行队列（存尾部 promise）。
   *
   * 快速双击「运行」时两次 start 都会先探活（异步），谁先探完谁先 spawn——同一端口上
   * 就叠了两个进程；restart 的「停旧 → 等真的退出 → 起新」被另一条 start 插进来时，
   * 还会出现「旧的没走、新的已起」。队列把同一作品的操作变成确定顺序。
   */
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * 同 appId + 同参数的在途 start：合流到同一个 Promise。
   *
   * 与队列的分工：队列保证**不同参数**的操作按顺序发生；合流保证**同一份请求**连点
   * 两次只 spawn 一次、两边拿到同一份回执（也不会让第二次白等满 30 秒预算）。
   */
  private readonly inflight = new Map<string, { key: string; promise: Promise<GalleryServiceStartResult> }>();
  /**
   * 在途 / 排队的 start、restart 的 owner 认领（认领 id → 凭据）。
   *
   * 与 `entries` 的分工：`entries` 里是**已经拉起了进程**的记录，而这里包含「连记录都还
   * 没登记」的那一段（探活 await、等旧进程退出）。面板关窗要两头都封：只封 `entries`
   * 会留下「关窗后凭空多出来的孤儿进程」（见 OwnerStartClaim）。
   */
  private readonly ownerStarts = new Map<string, OwnerStartClaim>();
  /** `disposeAll()` 之后不再 spawn：在途 start 在 spawn 前的检查点据此取消。 */
  private disposed = false;
  private readonly now: () => number;
  private readonly logBufferChars: number;
  private readonly waitMs: number;
  private readonly stopGraceMs: number;

  constructor(private readonly deps: GalleryServiceRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.logBufferChars = deps.logBufferChars ?? GALLERY_SERVICE_LOG_BUFFER_CHARS;
    // 就绪预算与作品「运行」的既有口径同一个常量（30 秒）；测试通过注入整段替换。
    this.waitMs = deps.waitMs ?? GALLERY_SERVICE_WAIT_MS;
    this.stopGraceMs = Math.max(1, deps.stopGraceMs ?? GALLERY_SERVICE_STOP_GRACE_MS);
  }

  /** 看板数据：活着的在前（按启动时间），已结束的在后（最近结束的在前）。 */
  list(): GalleryServiceRecord[] {
    const records = [...this.entries.values()].map((entry) => ({ ...entry.record }));
    return records.sort((left, right) => {
      const leftLive = galleryServiceLive(left);
      const rightLive = galleryServiceLive(right);
      if (leftLive !== rightLive) return leftLive ? -1 : 1;
      if (leftLive) return left.startedAt - right.startedAt;
      return (right.endedAt ?? 0) - (left.endedAt ?? 0);
    });
  }

  /** 某作品此刻活着（启动中/运行中）的服务。 */
  liveForApp(appId: string): GalleryServiceRecord | undefined {
    return this.list().find((record) => record.appId === appId && galleryServiceLive(record));
  }

  /**
   * 起一个后台服务。
   *
   * 三条刻意的顺序（与旧终端的「已可达不重启」同一取向）：
   * 1. 同作品已有**同命令同目录**的活进程 → 直接复用（重复点「运行」不叠进程）；
   * 2. 命令/目录变了 → 先停旧的、等它真的走掉再起新的（否则端口冲突，新进程起不来）；
   * 3. 登记了 url 且此刻已可达 → 不起进程（那是用户手工起的或上一次留下的，别乱杀）。
   *
   * 入口是**串行 + 合流**的（见 queues / inflight）：并发只影响排队，不会叠进程。
   */
  async start(input: GalleryServiceStartInput): Promise<GalleryServiceStartResult> {
    const title = input.title.trim() || "作品服务";
    if (!input.command.trim()) return { ok: false, message: "启动命令为空：作品没登记 command，无法在后台起服务。" };
    if (this.disposed) return { ok: false, message: `${GALLERY_SERVICE_DISPOSED_MESSAGE}（「${title}」没有启动）` };

    const signature = [input.command.trim(), input.cwd.trim(), input.url?.trim() ?? "", input.ownerPanelId?.trim() ?? ""].join("\u0000");
    const pending = this.inflight.get(input.appId);
    // 同一份请求已经在途（快速双击「运行」）：合流，绝不再 spawn 一个。合流的第二方拿到
    // 的是**同一份回执**（其中的 `reused` 反映的是那次真实启动，不是「它自己复用了」）。
    if (pending && pending.key === signature) return pending.promise;

    const claimId = this.beginOwnerClaim(input.ownerPanelId);
    const promise = this.enqueue(input.appId, async () => {
      try {
        return await this.startLocked(input, claimId);
      } catch (error) {
        // 队列里的异常绝不能变成「点了运行没有反应」：转成可读回执。
        return { ok: false as const, message: `「${title}」启动失败：${errorText(error)}` };
      }
    });
    this.trackInflight(input.appId, signature, promise);
    this.endOwnerClaimWhenSettled(claimId, promise);
    return promise;
  }

  /**
   * 停掉一个服务（结束进程树）。已结束的记录会被直接移出看板（那是用户点「清除」的语义）。
   * 返回 false = 找不到这个 id。
   *
   * 同步语义是刻意的：IPC（`gallery:service-stop`）与面板关窗回调都要求即时结果。
   * 真正确认「进程已经退出」靠退出事件（或 stopGraceMs 之后的兜底），期间记录保持
   * `stopping`：这既是看板上的「正在停止…」，也是**不许复用**的闸门。
   */
  stop(id: string): boolean {
    return this.stopEntry(id);
  }

  /** 重启：停掉旧进程、**等它真的退出**，再用同一份登记重新拉起。 */
  async restart(id: string): Promise<GalleryServiceStartResult> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, message: "这个服务已经不在看板里了" };
    if (this.disposed) return { ok: false, message: GALLERY_SERVICE_DISPOSED_MESSAGE };
    const input: GalleryServiceStartInput = {
      appId: entry.record.appId,
      title: entry.record.title,
      command: entry.record.command,
      cwd: entry.record.cwd
    };
    if (entry.record.url) input.url = entry.record.url;
    if (entry.record.ownerPanelId) input.ownerPanelId = entry.record.ownerPanelId;
    // 重启也带 owner 认领：面板在「停旧 → 等退出」这段里关掉时，也不能旧着两条腿起新进程。
    const claimId = this.beginOwnerClaim(entry.record.ownerPanelId);
    // 与 start 同一个 appId 队列：重启期间不会被另一个 start 插进来「同时起两个」。
    const promise = this.enqueue(entry.record.appId, async () => {
      try {
        return await this.restartLocked(id, input, claimId);
      } catch (error) {
        return { ok: false as const, message: `「${input.title}」重启失败：${errorText(error)}` };
      }
    });
    this.endOwnerClaimWhenSettled(claimId, promise);
    return promise;
  }

  /**
   * 面板窗口关掉时停掉「平台为它起的」本地服务（按 ownerPanelId 认领）。
   *
   * 只有平台自己 spawn 的记录带 ownerPanelId：地址已可达的外部服务压根不会建记录，
   * 因此永远进不了这条链路（计划 4.4 第 8 条）。
   *
   * 传 `ticket`（`prepareOwnerStop()` 在关窗当拍抓到的快照）时，只停「同一条记录、
   * 仍是同一次认领」的服务：关窗后重开面板产生的新记录、以及被重新认领过的老记录都不
   * 碰，而关窗时**正在启动**的服务照停（不然面板关了，那个还在探活的进程就没人收了）。
   * 不传则维持旧语义：停掉这个 owner 现在活着的全部服务。
   *
   * 不论有没有快照，**还没登记记录的在途/排队 start 一律取消**（见 OwnerStartClaim）：
   * 它们从探活里醒来后绝不能再 spawn。所以这个方法是「面板关窗」的唯一闸门——迟到的
   * 旧关窗回调必须在调用方就被挡掉（面板侧的 run 代际负责），不要拿它赌 timing。
   */
  stopByOwner(ownerPanelId: string, ticket?: GalleryOwnerStopTicket): number {
    const scoped = ticket && ticket.ownerPanelId === ownerPanelId ? ticket : undefined;
    // 1) 先封「还没登记记录」的那一段：卡在探活里的 start 一恢复就会 spawn，必须比它早。
    //    关窗当拍已经用 prepareOwnerStop 封过时，这里是幂等兜底。
    if (scoped) {
      this.cancelOwnerClaims(scoped);
    } else {
      for (const claim of this.ownerStarts.values()) {
        if (claim.ownerPanelId === ownerPanelId) claim.cancelled = true;
      }
    }
    // 2) 再停已经登记了记录的服务（有快照时只停快照里那几次认领）。
    const claims = scoped?.claims;
    const ids = [...this.entries.values()]
      .filter((entry) => entry.record.ownerPanelId === ownerPanelId && galleryServiceLive(entry.record))
      .filter((entry) => {
        if (!claims) return true;
        // 快照里没有的（关窗后新起的记录）与认领序号变过的（关窗后被重新认领的）都不碰。
        return claims.get(entry.record.id) === entry.claimSeq;
      })
      .map((entry) => entry.record.id);
    let stopped = 0;
    for (const id of ids) if (this.stopEntry(id)) stopped += 1;
    return stopped;
  }

  /**
   * 关窗事件里**同步**调用：把「这一刻这个面板拥有哪些服务、各是第几次认领、还有哪几次
   * 在途 start」钉成快照。
   *
   * 调用方（面板关窗路径）必须在**关窗当拍**抓好快照，再把 `stopByOwner(owner, ticket)`
   * 交给延时回调：晚抓一拍就可能把重开后新认领的服务写进快照，那又回到误杀。
   */
  ownerStopTicket(ownerPanelId: string): GalleryOwnerStopTicket {
    const claims = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (entry.record.ownerPanelId !== ownerPanelId) continue;
      if (!galleryServiceLive(entry.record)) continue;
      claims.set(entry.record.id, entry.claimSeq);
    }
    const pending: string[] = [];
    for (const [claimId, claim] of this.ownerStarts) {
      if (claim.ownerPanelId === ownerPanelId) pending.push(claimId);
    }
    return { ownerPanelId, claims, pending };
  }

  /**
   * 面板关窗**当拍**（同步）调用：抓快照 + 就地把「还没登记记录」的在途 start 认领取消。
   *
   * 为什么取消必须当拍，而不是留给延时里的 `stopByOwner`（2026-11-16 P2-1）：
   * 探活恢复是一个**微任务**，关窗收尾（setImmediate）是**宏任务**。只把取消留到延时
   * 回调，探活就会在中间那一拍恢复、发现认领还没被取消，照样 spawn 出一个**新记录**——
   * 它不在快照的 `claims` 里，延时回调的精确停止也打不到它，于是成了没人要的孤儿进程。
   *
   * 这里只动认领标记（纯数据：不 kill、不碰任何记录、不动看板），真正的停止仍由延时
   * 回调的 `stopByOwner(ownerPanelId, ticket)` 完成；重复调用无副作用。
   */
  prepareOwnerStop(ownerPanelId: string): GalleryOwnerStopTicket {
    const ticket = this.ownerStopTicket(ownerPanelId);
    this.cancelOwnerClaims(ticket);
    return ticket;
  }

  /** 把快照里那几次在途认领标成取消（纯数据：不 kill、不碰记录；重复调用无副作用）。 */
  private cancelOwnerClaims(ticket: GalleryOwnerStopTicket): void {
    for (const claimId of ticket.pending) {
      const claim = this.ownerStarts.get(claimId);
      if (claim && claim.ownerPanelId === ticket.ownerPanelId) claim.cancelled = true;
    }
  }

  /**
   * 应用退出：把每一棵还在跑的进程树都杀掉（用户 2026-11-12 选定：不留孤儿）。
   *
   * 顺序不能反：**先关闸门再动进程**。在途 start 可能停在探活这个 await 上，闸门开了
   * 它才会在 spawn 前的检查点取消；否则退出路径上还会凭空多出一个没人回收的进程。
   */
  disposeAll(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.stopTimer) {
        clearTimeout(entry.stopTimer);
        entry.stopTimer = undefined;
      }
      // 退出路径上不再关心后续的 error / exit 事件（也不会再有记录可结算）。
      entry.settled = true;
      const waiters = entry.exitWaiters.splice(0);
      for (const waiter of waiters) waiter();
      if (!galleryServiceLive(entry.record)) continue;
      entry.stopping = true;
      const pid = entry.record.pid;
      if (pid) {
        // 同 stop()：有 pid 就只走进程树回收（先杀 shell 会断掉树的父子关系，
        // 孙进程反倒活下来——应用退出了却留下孤儿进程，正是这一路要避免的事）。
        this.deps.killTree(pid);
        continue;
      }
      try {
        entry.handle?.kill();
      } catch {
        // 退出路径上的失败不值得阻塞应用关闭。
      }
    }
    // 记录先标死再清空：在途 start 的 watch() 读的是这条记录，若还写着「运行中」
    // 它会一直等到 30 秒预算耗尽（应用都退出了，不该还有定时器在跑）。
    for (const entry of this.entries.values()) {
      entry.record.status = "stopped";
      entry.record.ready = false;
      entry.record.endedAt = this.now();
      entry.record.note ??= "应用正在退出，已停止";
    }
    this.entries.clear();
  }

  /** 停一个记录（stop / stopByOwner / restart 共用一条闸门）。 */
  private stopEntry(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (!galleryServiceLive(entry.record)) {
      this.entries.delete(id);
      this.emit();
      return true;
    }
    // 停止已经发起过：幂等（重复点停止不再补一次 killTree）。
    if (entry.stopping) return true;
    entry.stopping = true;
    entry.record.note = "正在停止…";
    const pid = entry.record.pid;
    if (pid) {
      // 只走进程树回收，**不要**同时 handle.kill()（2026-11-12 集成测试逮到的竞态）：
      // taskkill /T 是异步 spawn，而 child.kill() 是同步 TerminateProcess(string)——
      // 先打死 shell 会让树的父子关系断掉，taskkill 随后找不到那个 pid，于是 node 孙子
      // 进程变成孤儿继续占着端口（「停了但端口还通」）。POSIX 侧同理：kill(-pid) 已经
      // 覆盖整组，单杀 shell 反而会漏掉组内成员。
      this.deps.killTree(pid);
    } else {
      try {
        entry.handle?.kill();
      } catch {
        // 已经退出的进程：交给下面的兜底定时器判断。
      }
    }
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    entry.stopTimer = setTimeout(() => {
      entry.stopTimer = undefined;
      if (!this.entries.has(id) || !galleryServiceLive(entry.record)) return;
      // 5 秒还没退出：要么 kill 没生效（进程还活着 → 如实告知），要么退出事件丢了。
      if (entry.record.pid && isProcessAlive(entry.record.pid)) {
        // 兜底再打一次单进程（树回收没生效时至少别留一个活着的 shell）：
        // 记录保持「运行中」，让用户看到「停止没生效」而不是以为已经清了。
        try {
          entry.handle?.kill();
        } catch {
          // 忽略：下面的状态才是给用户看的。
        }
        entry.stopping = false;
        entry.record.note = "停止命令没有生效，进程可能仍在运行";
        this.emit();
        return;
      }
      this.settle(entry, { exitCode: null });
    }, this.stopGraceMs);
    this.emit();
    return true;
  }

  private async restartLocked(id: string, input: GalleryServiceStartInput, claimId?: string): Promise<GalleryServiceStartResult> {
    if (this.disposed) return { ok: false, message: GALLERY_SERVICE_DISPOSED_MESSAGE };
    if (this.ownerClaimCancelled(claimId)) return this.ownerCancelledResult(input.title);
    const current = this.entries.get(id);
    if (!current) return { ok: false, message: "这个服务已经不在看板里了" };
    if (galleryServiceLive(current.record)) {
      this.stopEntry(id);
      await this.awaitExit(current, this.stopGraceMs);
      // 计划 4.4 第 5 条：旧进程没确认退出就**不**起新的（叠进程会抢端口，用户看到的是
      // 「重启了却连不上」）。超时如实告知「可能仍在运行」，并保留原记录与日志。
      if (galleryServiceLive(current.record)) {
        return {
          ok: false,
          message: `「${current.record.title}」的旧进程（pid ${current.record.pid ?? "未知"}）在 ${this.stopGraceSeconds()} 秒内没有退出，可能仍在运行：先在看板上停止它，确认端口空出来再重启。`,
          record: { ...current.record }
        };
      }
      if (this.disposed) return { ok: false, message: GALLERY_SERVICE_DISPOSED_MESSAGE };
      // 等旧进程退出的这段时间里面板被关掉了：不要再起新的（那个进程已经没主人了）。
      if (this.ownerClaimCancelled(claimId)) return this.ownerCancelledResult(input.title);
    }
    return this.startLocked(input, claimId);
  }

  /** start 的真实现（只在 appId 队列里跑，内部绝不再入队——那会自己等自己）。 */
  private async startLocked(input: GalleryServiceStartInput, claimId?: string): Promise<GalleryServiceStartResult> {
    const command = input.command.trim();
    const cwd = input.cwd.trim();
    const title = input.title.trim() || "作品服务";
    if (this.disposed) return { ok: false, message: `${GALLERY_SERVICE_DISPOSED_MESSAGE}（「${title}」没有启动）` };
    if (!command) return { ok: false, message: "启动命令为空：作品没登记 command，无法在后台起服务。" };
    // 探活地址解析不了就**在 spawn 之前** fail-closed（2026-11-16 复核）：否则进程会照常起来，
    // 而 invalid-url 要到 awaitReadiness 的探活阶段才报——看板上留下一个「运行中」却永远
    // 等不到就绪的记录，谁也不知道该不该停它（也没人接手）。校验放在任何状态变更之前，
    // 所以「换命令 + 坏地址」这种请求也不会先把旧进程停掉再失败。
    if (input.url && !parseServiceAddress(input.url)) {
      const failure: GalleryServiceFailure = { reason: "invalid-url" };
      return { ok: false, message: galleryServiceFailureMessage({ title, url: input.url }, failure), failure };
    }
    // 排队期间面板已经关了（或关窗后已经开始新一轮）：这一次认领作废。
    if (this.ownerClaimCancelled(claimId)) return this.ownerCancelledResult(title);

    const existing = this.liveEntryForApp(input.appId);
    if (existing) {
      // 停止中的记录**不许复用**（计划 4.4 第 3 条）：此刻 spawn 新进程只会和「正在退出
      // 的旧进程」抢同一个端口，用户看到的是「起了但连不上」。
      if (existing.stopping) {
        return { ok: false, message: `「${existing.record.title}」${GALLERY_SERVICE_STOPPING_MESSAGE}`, record: { ...existing.record } };
      }
      const same = existing.record.command === command && existing.record.cwd === cwd;
      if (same) {
        // 复用：命令没变，最多把后来补上的 url / 面板归属同步过去。
        const before = `${existing.record.url ?? ""}\u0000${existing.record.ownerPanelId ?? ""}`;
        if (input.url && existing.record.url !== input.url) existing.record.url = input.url;
        if (input.ownerPanelId) existing.record.ownerPanelId = input.ownerPanelId;
        // 认领序号 +1：关窗快照靠它区分「关窗前的老认领」与「关窗后被重新认领」
        // （见 GalleryOwnerStopTicket）。
        existing.claimSeq += 1;
        // 复用时地址 / 归属可能变了：必须推一帧，否则看板的「打开页面」还指着旧地址。
        if (`${existing.record.url ?? ""}\u0000${existing.record.ownerPanelId ?? ""}` !== before) this.emit();
        return this.awaitReadiness(existing, true, claimId);
      }
      this.stop(existing.record.id);
      await this.awaitExit(existing, this.stopGraceMs);
      // 旧进程没确认退出就绝不放行（换命令与 restart 同一口径）。
      if (galleryServiceLive(existing.record)) {
        return {
          ok: false,
          message: `「${existing.record.title}」的旧进程（pid ${existing.record.pid ?? "未知"}）在 ${this.stopGraceSeconds()} 秒内没有退出，可能仍在运行：先在看板上停止它，确认端口空出来再运行。`,
          record: { ...existing.record }
        };
      }
      if (this.disposed) return { ok: false, message: `${GALLERY_SERVICE_DISPOSED_MESSAGE}（「${title}」没有启动）` };
      if (this.ownerClaimCancelled(claimId)) return this.ownerCancelledResult(title);
    }

    const address = input.url ? parseServiceAddress(input.url) : undefined;
    if (address && (await this.probeAddress(address))) {
      // 探活是 await 点：应用可能已经在这期间开始退出。外部服务也不该在退出路径上被
      // 「复用成功」——那会让调用方拿着一个已经收不回来的结果去开窗/开页面。
      if (this.disposed) return { ok: false, message: `${GALLERY_SERVICE_DISPOSED_MESSAGE}（「${title}」没有启动）` };
      if (this.ownerClaimCancelled(claimId)) return this.ownerCancelledResult(title);
      // 地址已经可达且不是我们起的：不碰它，让调用方直接去用。
      this.emit();
      return { ok: true, reused: false, external: true };
    }
    // 探活是 await 点：应用可能在这期间开始退出，面板也可能已经关了。spawn 前必须再看
    // 一次——否则 disposeAll / 关窗之后还会凭空多出一个没人回收的进程（计划 4.4 第 9 条，
    // 以及「探活里卡住接着被关窗」那条路）。
    if (this.disposed) return { ok: false, message: `${GALLERY_SERVICE_DISPOSED_MESSAGE}（「${title}」没有启动）` };
    if (this.ownerClaimCancelled(claimId)) return this.ownerCancelledResult(title);

    const record: GalleryServiceRecord = {
      id: `gs-${randomUUID().slice(0, 12)}`,
      appId: input.appId,
      title,
      command,
      cwd,
      status: "starting",
      ready: false,
      startedAt: this.now()
    };
    if (input.url) record.url = input.url;
    if (input.ownerPanelId) record.ownerPanelId = input.ownerPanelId;
    const entry: Entry = { record, buffer: "", stopping: false, exitWaiters: [], settled: false, claimSeq: 1 };
    this.entries.set(record.id, entry);

    let handle: GalleryServiceProcessHandle;
    try {
      handle = this.deps.launch(command, cwd);
    } catch (error) {
      record.status = "failed";
      record.endedAt = this.now();
      record.note = `无法启动：${errorText(error)}`;
      this.emit();
      return { ok: false, message: `「${title}」的后台进程启动失败：${record.note}`, record: { ...record } };
    }
    entry.handle = handle;
    if (handle.pid) record.pid = handle.pid;
    handle.onData((chunk) => this.appendLog(entry, chunk));
    handle.onExit((info) => this.settle(entry, info));
    this.emit();
    return this.awaitReadiness(entry, false, claimId);
  }

  /** 等「这个服务就绪 / 确定失败」：复用已有进程与新建进程共用同一条尾巴。 */
  private async awaitReadiness(entry: Entry, reused: boolean, claimId?: string): Promise<GalleryServiceStartResult> {
    const record = entry.record;
    // 复用一个「已经就绪」的进程时不再重新等一轮预算：就绪是上一次判定的结果，
    // 再探一次只会让「再点一次运行」这种无害操作卡满 30 秒（登记的地址万一写错，
    // 用户看到的就是一个转半分钟然后报超时的按钮）。
    if (reused && record.status === "running" && record.ready) {
      return { ok: true, record: { ...record }, reused: true, external: false };
    }
    // 等待前先看一次取消闸门：用户点了停止就不该报「已就绪」，也不该报成启动失败。
    const cancelled = this.cancelMessageFor(entry, claimId);
    if (cancelled) return { ok: false, message: cancelled, record: { ...record } };

    // 没有探活地址：spawn 成功即就绪（服务自己会听端口，平台无从判断也不需要判断）。
    if (!record.url) {
      if (!record.pid) {
        // 句柄没给出 pid = 子进程可能根本没起来（spawn 失败是异步 'error'，此刻还没到）。
        // 给事件一个轮次再判定，绝不在 error 到达之前先回一个「已运行」——那会让调用方
        // 拿着一个不存在的服务去开窗口/开页面（计划 4.4 第 7 条的同类静默问题）。
        await this.nextTurn();
        const cancelledWhileSpawning = this.cancelMessageFor(entry, claimId);
        if (cancelledWhileSpawning) return { ok: false, message: cancelledWhileSpawning, record: { ...record } };
        if (!galleryServiceLive(record)) return this.exitedResult(entry);
        // 启动器可能在下一拍才交出进程号：再读一次句柄，仍然没有才判失败。
        if (!record.pid && entry.handle?.pid) record.pid = entry.handle.pid;
        if (!record.pid) {
          record.status = "failed";
          record.ready = false;
          record.endedAt = this.now();
          record.note ??= "无法确认进程已启动：启动器没有返回 pid";
          this.emit();
          return { ok: false, message: `「${record.title}」的后台进程没有启动起来（启动器没有返回进程号）：${record.note}`, record: { ...record } };
        }
      }
      if (record.status === "starting" && !entry.settled) {
        record.status = "running";
        record.ready = true;
      }
      this.emit();
      return galleryServiceLive(record)
        ? { ok: true, record: { ...record }, reused, external: false }
        : this.exitedResult(entry);
    }

    const result = await waitForService({
      url: record.url,
      timeoutMs: this.waitMs,
      now: this.now,
      ...(this.deps.probe ? { probe: this.deps.probe } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      watch: () => (galleryServiceLive(record) ? undefined : { exited: true, exitCode: record.exitCode, tail: record.log })
    });

    // —— 每个 await 之后都要重新判定：等待期间 stop / stopByOwner / disposeAll / 进程
    //    自己退出都可能已经发生，绝不能拿 await 之前的状态当事实。
    const cancelledAfterWait = this.cancelMessageFor(entry, claimId);
    if (cancelledAfterWait) return { ok: false, message: cancelledAfterWait, record: { ...record } };
    // 就绪确认前进程就结束了：**哪怕端口随后通了也不能标成「运行中」**——平台已经回收
    // 不了它拉起的服务（计划 4.4 第 7 条；waitForService 的「先探测后看退出」正好会在
    // 这个窗口里返回 ok，旧实现就是这么把已死进程标成 running 的）。
    if (!galleryServiceLive(record)) return this.exitedResult(entry);

    if (result.ok) {
      if (record.status === "starting") {
        record.status = "running";
        record.ready = true;
        record.note = undefined;
      }
      this.emit();
      return { ok: true, record: { ...record }, reused, external: false };
    }

    const failure: GalleryServiceFailure = { reason: result.reason };
    if (result.exitCode !== undefined) failure.exitCode = result.exitCode;
    if (result.tail) failure.tail = result.tail;
    if (result.reason === "timeout") {
      // 进程还活着，只是地址还没通：留在看板上如实标「未就绪」，别把它当失败进程隐藏掉。
      record.status = "running";
      record.ready = false;
      record.note = "等待服务就绪超时（进程仍在后台运行）";
      this.emit();
      return { ok: false, message: galleryServiceFailureMessage({ title: record.title, url: record.url }, failure, this.waitMs), failure, record: { ...record } };
    }
    if (result.reason === "ended") {
      // 命令在就绪前以 0 退出：平台托管要求前台长期运行（与 exitedResult 同一口径）。
      record.ready = false;
      this.emit();
      return { ok: false, message: this.exitedBeforeReadyMessage(record), failure, record: { ...record } };
    }
    if (result.reason === "invalid-url") {
      // 地址解析不了：进程还活着，平台永远不会判它就绪——但**不是进程失败**，不能标成
      // 「进程已结束」。新的启动已在 spawn 前被拦下，这条只服务旧记录（复用到的登记）。
      record.ready = false;
      record.note = "登记的服务地址无法解析：进程在运行，但无法探活";
      this.emit();
      return { ok: false, message: galleryServiceFailureMessage({ title: record.title, url: record.url }, failure, this.waitMs), failure, record: { ...record } };
    }
    record.ready = false;
    if (record.note === undefined) record.note = failure.reason === "exited" ? "启动命令报错退出" : "进程已结束，服务未就绪";
    this.emit();
    // 失败原因用 shared 层的唯一文案源（退出码 / 输出尾部），主进程与渲染端不许各写一套。
    return { ok: false, message: galleryServiceFailureMessage({ title: record.title, url: record.url }, failure, this.waitMs), failure, record: { ...record } };
  }

  /**
   * 「进程在服务就绪前就结束了」的统一回执（计划 4.4 第 7 条）。
   *
   * 退出码非 0 仍走 shared 层的唯一文案（带退出码与输出尾部，这是用户最需要原因的一类）；
   * spawn 本身失败（异步 'error'）要带上原始错误。
   * 退出码 0 **不再**被当成「启动器形态，稍等就好」：平台托管的命令必须前台长期运行，
   * 它提前结束就意味着平台回收不了它拉起的服务（pythonw / start / cmd /c start 这类
   * 把服务脱离进程树的启动器）——必须以失败结束并明确说清「没有服务所有权」。
   */
  private exitedResult(entry: Entry): GalleryServiceStartResult {
    const record = entry.record;
    const failed = typeof record.exitCode === "number" && record.exitCode !== 0;
    const failure: GalleryServiceFailure = { reason: failed ? "exited" : "ended" };
    if (typeof record.exitCode === "number") failure.exitCode = record.exitCode;
    if (record.log) failure.tail = record.log;
    record.ready = false;
    if (record.status === "starting") {
      // 还没被 settle 结算成终态（理论上不该发生）：就地补一个可解释的终态，
      // 绝不把已经死掉的进程留在「启动中」。
      record.status = "failed";
      record.endedAt ??= this.now();
      record.note ??= "启动命令在服务就绪前结束：不能建立可回收的服务所有权";
    }
    this.emit();
    if (entry.launchError) {
      return { ok: false, message: `「${record.title}」的后台进程启动失败：${entry.launchError}`, failure, record: { ...record } };
    }
    const message = failed
      ? galleryServiceFailureMessage({ title: record.title, url: record.url }, failure, this.waitMs)
      : this.exitedBeforeReadyMessage(record);
    return { ok: false, message, failure, record: { ...record } };
  }

  /** 就绪前以 0 / 未知码结束的文案：不再暗示「进程结束是正常的」。 */
  private exitedBeforeReadyMessage(record: GalleryServiceRecord): string {
    const tailText = compactServiceTail(record.log);
    return `「${record.title}」的启动命令在服务就绪前就结束了${exitCodeText(record.exitCode)}：平台无法回收它拉起的进程（不能建立可回收的服务所有权）。托管命令必须在前台长期运行——不要用 start / pythonw / cmd /c start 这类会立刻返回的启动器。${tailText ? `输出尾部：${tailText}` : "完整输出见作品墙「运行中的服务」里的日志。"}`;
  }

  /** 这次等待是否已被取消（stop / stopByOwner / restart / disposeAll）：给出可读原因。 */
  private cancelMessageFor(entry: Entry, claimId?: string): string | undefined {
    if (this.disposed) return `「${entry.record.title}」的启动已取消（应用正在退出）。`;
    if (this.ownerClaimCancelled(claimId)) return `「${entry.record.title}」的启动已取消（面板已关闭）。`;
    if (entry.stopping) return `「${entry.record.title}」的启动已取消（服务正在停止）。`;
    return undefined;
  }

  /** 面板关窗把这次还没成形的启动取消了（记录都还没登记的那种）。 */
  private ownerCancelledResult(title: string): GalleryServiceStartResult {
    return { ok: false, message: `「${title}」的启动已取消（面板已关闭）。` };
  }

  /** 登记一次 owner 认领：关窗（stopByOwner）据此取消还卡在探活/排队里的 start。 */
  private beginOwnerClaim(ownerPanelId: string | undefined): string | undefined {
    const owner = ownerPanelId?.trim();
    if (!owner) return undefined;
    const claimId = `oc-${randomUUID()}`;
    this.ownerStarts.set(claimId, { ownerPanelId: owner, cancelled: false });
    return claimId;
  }

  private endOwnerClaimWhenSettled(claimId: string | undefined, promise: Promise<unknown>): void {
    if (!claimId) return;
    const clear = (): void => {
      this.ownerStarts.delete(claimId);
    };
    void promise.then(clear, clear);
  }

  private ownerClaimCancelled(claimId: string | undefined): boolean {
    if (!claimId) return false;
    return this.ownerStarts.get(claimId)?.cancelled === true;
  }

  private appendLog(entry: Entry, chunk: string): void {
    if (!chunk) return;
    entry.buffer = tail(entry.buffer + chunk, this.logBufferChars);
    entry.record.log = galleryServiceLogTail(entry.buffer);
    this.emit();
  }

  private settle(entry: Entry, info: { exitCode?: number | null; error?: string }): void {
    // 一次性结算：spawn 失败会同时发 error 与 exit，stop 的兜底定时器与真实退出事件
    // 也会前后脚到达。重复结算会把「已停止」改回「启动失败」、把 exitWaiters 唤醒两次。
    if (entry.settled) return;
    entry.settled = true;
    if (entry.stopTimer) {
      clearTimeout(entry.stopTimer);
      entry.stopTimer = undefined;
    }
    const waiters = entry.exitWaiters.splice(0);
    for (const waiter of waiters) waiter();
    if (!this.entries.has(entry.record.id)) return;
    const record = entry.record;
    record.endedAt = this.now();
    if (typeof info.exitCode === "number") record.exitCode = info.exitCode;
    if (info.error) {
      entry.launchError = info.error;
      record.status = "failed";
      record.note = `无法启动：${info.error}`;
    } else if (entry.stopping) {
      record.status = "stopped";
      record.note = "已手动停止";
    } else if (!record.ready) {
      // 就绪前结束：不管退出码是几都是**启动失败**（平台回收不了它拉起的进程，
      // 见 exitedResult）。旧实现把退出码 0 记成「正常结束」，用户会以为服务是好的。
      record.status = "failed";
      record.note = `启动命令在服务就绪前结束${exitCodeText(info.exitCode)}：不能建立可回收的服务所有权`;
    } else if (info.exitCode === 0) {
      // 就绪后正常结束（daemon 化或服务自己收工）：保留退出码与日志，状态是「已停止」。
      record.status = "stopped";
      record.note = "进程已结束（退出码 0）";
    } else {
      record.status = "failed";
      record.note = typeof info.exitCode === "number" ? `进程已退出（退出码 ${info.exitCode}）` : "进程已退出";
    }
    entry.handle = undefined;
    this.trimDead();
    this.emit();
  }

  /** 已结束的记录只留最近的一批（活着的永不淘汰）。 */
  private trimDead(): void {
    const dead = [...this.entries.values()]
      .filter((entry) => !galleryServiceLive(entry.record))
      .sort((left, right) => (right.record.endedAt ?? 0) - (left.record.endedAt ?? 0));
    for (const entry of dead.slice(MAX_GALLERY_SERVICE_RECORDS)) this.entries.delete(entry.record.id);
  }

  /**
   * 等「这个进程真的走掉」。
   *
   * 预算就是调用方传的 `this.stopGraceMs`（`deps.stopGraceMs`，生产缺省等于
   * `GALLERY_SERVICE_STOP_GRACE_MS` = 5 秒）。单测注入它时**整段替换**这个预算，不是
   * 「在 5 秒里再取小」——否则注入就只是装饰，想验「等很久」的用例会真等 5 秒。超时后
   * 调用方自己去判定「旧进程还在」并如实报错——这里绝不假装已经退出。
   */
  private awaitExit(entry: Entry, budgetMs: number): Promise<void> {
    if (!this.entries.has(entry.record.id) || !galleryServiceLive(entry.record)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, budgetMs));
      entry.exitWaiters.push(done);
    });
  }

  /** 让出一个事件循环轮次（异步 spawn error / 迟到的退出事件会在这一轮里到达）。 */
  private nextTurn(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** 每个 appId 一条串行队列：前一个操作失败也要继续跑后一个（顺序，不是短路）。 */
  private enqueue(appId: string, task: () => Promise<GalleryServiceStartResult>): Promise<GalleryServiceStartResult> {
    const previous = this.queues.get(appId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    this.queues.set(appId, tail);
    void tail.then(() => {
      if (this.queues.get(appId) === tail) this.queues.delete(appId);
    });
    return run;
  }

  private trackInflight(appId: string, key: string, promise: Promise<GalleryServiceStartResult>): void {
    const tracked = { key, promise };
    this.inflight.set(appId, tracked);
    const clear = (): void => {
      if (this.inflight.get(appId) === tracked) this.inflight.delete(appId);
    };
    void promise.then(clear, clear);
  }

  private stopGraceSeconds(): number {
    return Math.max(1, Math.round(this.stopGraceMs / 1000));
  }

  private liveEntryForApp(appId: string): Entry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.record.appId === appId && galleryServiceLive(entry.record)) return entry;
    }
    return undefined;
  }

  private async probeAddress(address: ServiceAddress): Promise<boolean> {
    const probe = this.deps.probe ?? probeService;
    try {
      return await probe(address);
    } catch {
      return false;
    }
  }

  private emit(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // 推送失败不能影响进程管理本身。
    }
  }
}
