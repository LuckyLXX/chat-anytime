import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  GALLERY_SERVICE_LOG_TAIL_CHARS,
  GALLERY_SERVICE_WAIT_MS,
  MAX_GALLERY_SERVICE_RECORDS,
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
 * 默认启动器：用用户自己的 shell 跑命令（与「自己在终端里跑」同一套解析）。
 *
 * 为什么经过 shell 而不是直接 spawn：Windows 上 `npm` / `npx` 实际是 `.cmd`，不经过
 * shell 解析会直接 ENOENT。命令的引号/`%`/`&` 处理沿用 `shellServiceInvocation`
 *（`cmd.exe` 必须走环境变量，见 terminal-pty.ts 的真机事故记录）。
 *
 * `stdio` 第二三项是 pipe：输出要进看板的日志。stdin 给 ignore——后台服务没有终端可
 * 交互，想让进程不阻塞就得显式关掉它（有些工具会等 stdin）。
 */
export function createShellLauncher(
  options: { shell?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): GalleryServiceLauncher {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
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
    return {
      get pid() {
        return child.pid;
      },
      onData(listener) {
        child.stdout?.on("data", (chunk: Buffer) => listener(String(chunk)));
        child.stderr?.on("data", (chunk: Buffer) => listener(String(chunk)));
      },
      onExit(listener) {
        child.once("error", (error: Error) => listener({ exitCode: null, error: error.message }));
        child.once("exit", (code) => listener({ exitCode: code }));
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

export class GalleryServiceRunner {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly logBufferChars: number;
  private readonly waitMs: number;

  constructor(private readonly deps: GalleryServiceRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.logBufferChars = deps.logBufferChars ?? GALLERY_SERVICE_LOG_BUFFER_CHARS;
    // 就绪预算与作品「运行」的既有口径同一个常量（30 秒）；测试通过注入整段替换。
    this.waitMs = deps.waitMs ?? GALLERY_SERVICE_WAIT_MS;
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
   */
  async start(input: GalleryServiceStartInput): Promise<GalleryServiceStartResult> {
    const command = input.command.trim();
    const cwd = input.cwd.trim();
    const title = input.title.trim() || "作品服务";
    if (!command) return { ok: false, message: "启动命令为空：作品没登记 command，无法在后台起服务。" };

    const existing = this.liveEntryForApp(input.appId);
    if (existing) {
      const same = existing.record.command === command && existing.record.cwd === cwd;
      if (same) {
        // 复用：命令没变，最多把后来补上的 url / 面板归属同步过去。
        if (input.url && existing.record.url !== input.url) existing.record.url = input.url;
        if (input.ownerPanelId) existing.record.ownerPanelId = input.ownerPanelId;
        return this.awaitReadiness(existing, true);
      }
      this.stop(existing.record.id);
      await this.awaitExit(existing, GALLERY_SERVICE_STOP_GRACE_MS);
    }

    if (input.url) {
      const address = parseServiceAddress(input.url);
      if (address && (await this.probeAddress(address))) {
        // 地址已经可达且不是我们起的：不碰它，让调用方直接去用。
        this.emit();
        return { ok: true, reused: false, external: true };
      }
    }

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
    const entry: Entry = { record, buffer: "", stopping: false, exitWaiters: [] };
    this.entries.set(record.id, entry);

    let handle: GalleryServiceProcessHandle;
    try {
      handle = this.deps.launch(command, cwd);
    } catch (error) {
      record.status = "failed";
      record.endedAt = this.now();
      record.note = `无法启动：${error instanceof Error ? error.message : String(error)}`;
      this.emit();
      return { ok: false, message: `「${title}」的后台进程启动失败：${record.note}`, record: { ...record } };
    }
    entry.handle = handle;
    if (handle.pid) record.pid = handle.pid;
    handle.onData((chunk) => this.appendLog(entry, chunk));
    handle.onExit((info) => this.settle(entry, info));
    this.emit();
    return this.awaitReadiness(entry, false);
  }

  /**
   * 停掉一个服务（结束进程树）。已结束的记录会被直接移出看板（那是用户点「清除」的语义）。
   * 返回 false = 找不到这个 id。
   */
  stop(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (!galleryServiceLive(entry.record)) {
      this.entries.delete(id);
      this.emit();
      return true;
    }
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
    }, GALLERY_SERVICE_STOP_GRACE_MS);
    this.emit();
    return true;
  }

  /** 重启：停掉旧进程、等它真的退出，再用同一份登记重新拉起。 */
  async restart(id: string): Promise<GalleryServiceStartResult> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, message: "这个服务已经不在看板里了" };
    const input: GalleryServiceStartInput = {
      appId: entry.record.appId,
      title: entry.record.title,
      command: entry.record.command,
      cwd: entry.record.cwd
    };
    if (entry.record.url) input.url = entry.record.url;
    if (entry.record.ownerPanelId) input.ownerPanelId = entry.record.ownerPanelId;
    if (galleryServiceLive(entry.record)) {
      this.stop(id);
      await this.awaitExit(entry, GALLERY_SERVICE_STOP_GRACE_MS);
    }
    return this.start(input);
  }

  /** 面板窗口关掉时停掉「平台为它起的」本地服务（按 ownerPanelId 认领）。 */
  stopByOwner(ownerPanelId: string): number {
    const ids = [...this.entries.values()]
      .filter((entry) => entry.record.ownerPanelId === ownerPanelId && galleryServiceLive(entry.record))
      .map((entry) => entry.record.id);
    let stopped = 0;
    for (const id of ids) if (this.stop(id)) stopped += 1;
    return stopped;
  }

  /** 应用退出：把每一棵还在跑的进程树都杀掉（用户 2026-11-12 选定：不留孤儿）。 */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.stopTimer) {
        clearTimeout(entry.stopTimer);
        entry.stopTimer = undefined;
      }
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
    this.entries.clear();
  }

  /** 等「这个服务就绪 / 确定失败」：复用已有进程与新建进程共用同一条尾巴。 */
  private async awaitReadiness(entry: Entry, reused: boolean): Promise<GalleryServiceStartResult> {
    const record = entry.record;
    // 复用一个「已经就绪」的进程时不再重新等一轮预算：就绪是上一次判定的结果，
    // 再探一次只会让「再点一次运行」这种无害操作卡满 30 秒（登记的地址万一写错，
    // 用户看到的就是一个转半分钟然后报超时的按钮）。
    if (reused && record.status === "running" && record.ready) {
      return { ok: true, record: { ...record }, reused: true, external: false };
    }
    // 没有探活地址：spawn 成功即就绪（服务自己会听端口，平台无从判断也不需要判断）。
    if (!record.url) {
      if (record.status === "starting") {
        record.status = "running";
        record.ready = true;
      }
      const live = galleryServiceLive(record);
      this.emit();
      return live
        ? { ok: true, record: { ...record }, reused, external: false }
        : { ok: false, message: `「${record.title}」的进程已经退出了。${record.note ?? ""}`.trim(), record: { ...record } };
    }
    const result = await waitForService({
      url: record.url,
      timeoutMs: this.waitMs,
      now: this.now,
      ...(this.deps.probe ? { probe: this.deps.probe } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      watch: () => (galleryServiceLive(record) ? undefined : { exited: true, exitCode: record.exitCode, tail: record.log })
    });
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
    // 失败原因用 shared 层的唯一文案源（退出码 / 输出尾部 / 「命令只是启动器」三种
    // 情形都在那里分开写），主进程与渲染端不许各写一套。
    const message = galleryServiceFailureMessage({ title: record.title, url: record.url }, failure, this.waitMs);
    if (result.reason === "timeout" && galleryServiceLive(record)) {
      // 进程还活着，只是地址还没通：留在看板上如实标「未就绪」，别把它当失败进程隐藏掉。
      record.status = "running";
      record.ready = false;
      record.note = "等待服务就绪超时（进程仍在后台运行）";
      this.emit();
      return { ok: false, message, failure, record: { ...record } };
    }
    record.ready = false;
    if (record.note === undefined) record.note = failure.reason === "exited" ? "启动命令报错退出" : "进程已结束，服务未就绪";
    this.emit();
    return { ok: false, message, failure, record: { ...record } };
  }

  private appendLog(entry: Entry, chunk: string): void {
    if (!chunk) return;
    entry.buffer = tail(entry.buffer + chunk, this.logBufferChars);
    entry.record.log = galleryServiceLogTail(entry.buffer);
    this.emit();
  }

  private settle(entry: Entry, info: { exitCode?: number | null; error?: string }): void {
    if (entry.stopTimer) {
      clearTimeout(entry.stopTimer);
      entry.stopTimer = undefined;
    }
    if (!this.entries.has(entry.record.id)) return;
    const record = entry.record;
    record.endedAt = this.now();
    if (typeof info.exitCode === "number") record.exitCode = info.exitCode;
    if (info.error) {
      record.status = "failed";
      record.note = `无法启动：${info.error}`;
    } else if (entry.stopping) {
      record.status = "stopped";
      record.note = "已手动停止";
    } else if (info.exitCode === 0) {
      record.status = "stopped";
      record.note = "进程已结束（退出码 0）";
    } else {
      record.status = "failed";
      record.note = typeof info.exitCode === "number" ? `进程已退出（退出码 ${info.exitCode}）` : "进程已退出";
    }
    entry.handle = undefined;
    const waiters = entry.exitWaiters.splice(0);
    for (const waiter of waiters) waiter();
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

  private awaitExit(entry: Entry, timeoutMs: number): Promise<void> {
    if (!this.entries.has(entry.record.id) || !galleryServiceLive(entry.record)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      entry.exitWaiters.push(done);
    });
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
