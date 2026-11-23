/**
 * Codex App Server 的**进程监管**（主进程侧）。
 *
 * 分层纪律（计划 A）：进程只归 main。utility 负责 JSON-RPC 语义（握手、回合、事件路由），
 * 它既不该也不能自己 spawn/kill——进程树回收、utility 崩溃与用户退出后的孤儿清理，
 * 只有在主进程这一层才做得到。
 *
 * 三条硬约束：
 * 1. **只拉起 Codex 本地可执行文件**：路径必须是绝对路径、basename 必须是 `codex`
 *    （`codex.exe` / npm 的 `codex.cmd` / POSIX 入口），参数只能是 `app-server`
 *    （可带受限的 `-c/--enable/--disable` 覆盖）或 `--version`。任务正文一律走 stdin
 *    的 JSONL 帧，绝不拼进命令行。
 * 2. **只有 stdio**：三个管道（stdin/stdout/stderr），不监听端口、不打开网络。
 * 3. **按运行句柄隔离**：每次启动一个 handle，停止/退出后迟到的事件一律丢弃；
 *    每次 utility 重启都换一个 supervisor 实例，旧实例的句柄在新实例里不可达。
 *
 * 跨平台启动：Windows 的 npm 安装是 `codex.cmd`（一层 batch shim 再去调 native exe）。
 * 直接 spawn `.cmd` 必须经过 cmd.exe，而 cmd.exe 对引号、空格与非 ASCII 路径的转义
 * 是一堆坑；这里改为**显式解析 shim**：读出 `codex.cmd` 里指向的
 * `node_modules/@openai/codex/bin/codex.js`，用 Node 直接跑那个入口（argv 原样传递，
 * 不经过任何 shell）。解析不出来就明确报错，让用户改用原生 `codex.exe`，绝不猜。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CodexProcessEvent, CodexProcessStartOptions } from "../shared/protocol.js";
import { killProcessTree } from "./gallery-service-runner.js";

/** 同时在跑的 Codex 进程上限（每个成员至多一条；留出团队上限内的余量）。 */
export const MAX_CODEX_PROCESSES = 8;
/** 单帧 stdin 上限（一次写入的 JSONL 文本）。 */
export const CODEX_MAX_STDIN_FRAME_CHARS = 8 * 1024 * 1024;
/** stderr 只留尾部（诊断用，不参与协议）。 */
export const CODEX_STDERR_TAIL_CHARS = 8_000;
/** handle 的形状：utility 生成，main 只做形状校验（不接受任意字符串）。 */
const HANDLE_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/u;
/** 单个启动参数的长度上限（防止把一个巨大的 argv 塞进进程表）。 */
const MAX_ARG_CHARS = 4_096;
const MAX_ARGS = 24;

export interface CodexExecutableDeps {
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  isFile?: (path: string) => boolean;
  readText?: (path: string) => string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** handle 必须是 utility 分配的短标识；不合规直接拒绝（不静默丢弃）。 */
export function normalizeCodexProcessHandle(value: unknown): string {
  const handle = typeof value === "string" ? value.trim() : "";
  if (!handle || !HANDLE_PATTERN.test(handle)) throw new Error("Codex 进程句柄非法");
  return handle;
}

/**
 * 参数白名单：首项只能是 `app-server` 或 `--version`。
 *
 * `-c key=value` / `--enable|--disable feature` 是 C 阶段「关掉用户钩子、插件/Apps、
 * 自定义 MCP」需要的覆盖面；这里只校验形状（key 是标识符、value 长度有界、不含 NUL），
 * 具体配哪些键由适配器/C 的策略决定——main 不做语义判断，但也不允许任意 argv。
 */
export function validateCodexArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Codex 启动参数不能为空");
  if (value.length > MAX_ARGS) throw new Error("Codex 启动参数过多");
  const args: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Codex 启动参数必须是字符串");
    if (!item || item.length > MAX_ARG_CHARS || item.includes("\u0000")) throw new Error("Codex 启动参数非法");
    args.push(item);
  }
  const [head, ...rest] = args as [string, ...string[]];
  if (head === "--version") {
    if (rest.length > 0) throw new Error("Codex 版本探测只接受 `--version`");
    return args;
  }
  if (head !== "app-server") throw new Error("只允许启动 Codex 的 app-server（或 `--version` 探测）");
  const flagPattern = /^[A-Za-z0-9_.-]+$/u;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === "-c" || flag === "--config") {
      const pair = rest[index + 1];
      if (pair === undefined) throw new Error("Codex 配置覆盖缺少 `key=value`");
      const separator = pair.indexOf("=");
      const key = separator > 0 ? pair.slice(0, separator) : "";
      if (!key || !flagPattern.test(key)) throw new Error("Codex 配置覆盖的键名非法");
      index += 1;
      continue;
    }
    if (flag === "--enable" || flag === "--disable") {
      const feature = rest[index + 1];
      if (feature === undefined) throw new Error("Codex feature 开关缺少名称");
      if (!flagPattern.test(feature)) throw new Error("Codex feature 名称非法");
      index += 1;
      continue;
    }
    throw new Error(`不支持的 Codex 启动参数：${flag}`);
  }
  return args;
}

/**
 * 可执行文件校验：绝对路径 + basename 是 `codex` + 真实存在。
 *
 * 这一层是「只支持 Codex 本地可执行文件」的硬闸门：用户选错文件（或渲染端/IPC 被
 * 构造出任意路径）时在 spawn 之前就失败，而不是先拉起一个随便什么程序。
 */
export function validateCodexExecutable(value: unknown, deps: CodexExecutableDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const isFile = deps.isFile ?? defaultIsFile;
  const exists = deps.fileExists ?? existsSync;
  const executable = typeof value === "string" ? value.trim() : "";
  if (!executable) throw new Error("Codex 可执行文件路径为空");
  if (executable.length > 4_096 || executable.includes("\u0000")) throw new Error("Codex 可执行文件路径非法");
  if (!isAbsolute(executable)) throw new Error(`Codex 可执行文件必须是绝对路径：${executable}`);
  const extension = extname(executable).toLowerCase();
  const stem = extension ? executable.slice(0, -extension.length) : executable;
  const base = stem.replace(/^.*[\\/]/u, "").toLowerCase();
  if (extension === ".ps1") {
    throw new Error("不支持 PowerShell shim（codex.ps1）：请选择同一安装目录下的 codex.cmd 或 codex.exe");
  }
  const allowedExtension = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  if (!allowedExtension.includes(extension)) {
    throw new Error(
      platform === "win32"
        ? `只支持 Codex 本地可执行文件（codex.exe / codex.cmd）：${executable}`
        : `只支持 Codex 本地可执行文件（无扩展名的 codex 入口）：${executable}`
    );
  }
  if (base !== "codex") throw new Error(`只支持 Codex 本地可执行文件（文件名必须是 codex）：${executable}`);
  if (!exists(executable) || !isFile(executable)) throw new Error(`找不到 Codex 可执行文件（或它不是普通文件）：${executable}`);
  if (platform !== "win32") {
    try {
      if ((statSync(executable).mode & 0o111) === 0) throw new Error(`Codex 入口没有执行权限（chmod +x）：${executable}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Codex 入口没有执行权限")) throw error;
      // stat 失败：上面的 exists/isFile 已经放行过，这里不再重复报错。
    }
  }
  return executable;
}

/** 启动解析结果：真正要被 spawn 的文件、argv 与额外环境变量。 */
export interface CodexLaunchResolution {
  file: string;
  args: string[];
  env: Record<string, string>;
  /** `exe` = 原生可执行文件；`posix` = POSIX 入口；`node-entry` = npm shim 解析出的 JS 入口。 */
  shim: "exe" | "posix" | "node-entry";
}

export interface CodexLaunchDeps extends CodexExecutableDeps {
  /** Node 可执行文件（缺省 process.execPath；主进程里是 Electron，需要 ELECTRON_RUN_AS_NODE）。 */
  nodeExecutable?: string;
}

/** 从 npm 的 `.cmd` shim 里认出它要执行的 codex.js（只认官方包路径）。 */
const NPM_SHIM_ENTRY = /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/iu;

/**
 * 把「用户选的 Codex 入口 + 受限参数」解析成可 spawn 的 argv。
 *
 * Windows 的 `.cmd` 不直接 spawn：先读 shim 正文找官方包入口，找到就用 Node 跑它
 * （`ELECTRON_RUN_AS_NODE=1` 让 Electron 以纯 Node 身份运行，dev 与安装版都能用）；
 * 找不到就报可行动的错，不做「先试试 cmd.exe」这种会把空格/非 ASCII 路径弄坏的回退。
 */
export function resolveCodexLaunch(
  executable: string,
  args: string[],
  deps: CodexLaunchDeps = {}
): CodexLaunchResolution {
  const platform = deps.platform ?? process.platform;
  const exists = deps.fileExists ?? existsSync;
  const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  if (platform !== "win32") return { file: executable, args, env: {}, shim: "posix" };
  const extension = extname(executable).toLowerCase();
  if (extension === ".exe") return { file: executable, args, env: {}, shim: "exe" };
  const text = (() => {
    try {
      return readText(executable);
    } catch (error) {
      throw new Error(`无法读取 Codex npm shim：${errorText(error)}`);
    }
  })();
  const match = NPM_SHIM_ENTRY.exec(text);
  if (!match) {
    throw new Error(
      `无法解析 Codex npm shim（${executable}）：没有找到 @openai/codex 的 bin/codex.js。` +
      "请改选同一安装目录下的原生 codex.exe，或重新安装 Codex CLI。"
    );
  }
  // `%dp0%` = shim 所在目录（不是去掉扩展名的前缀）。
  const root = dirname(executable);
  const relative = match[0].replaceAll("\\", "/");
  const entry = normalize(join(root, ...relative.split("/")));
  if (!exists(entry)) {
    throw new Error(`Codex npm shim 指向的入口不存在：${entry}（请重新安装 Codex CLI，或改选 codex.exe）`);
  }
  const nodeExecutable = deps.nodeExecutable ?? process.execPath;
  return {
    file: nodeExecutable,
    args: [entry, ...args],
    // Electron 主进程的 execPath 是 electron 本身；没有这个变量它会去开一个窗口。
    env: { ELECTRON_RUN_AS_NODE: "1" },
    shim: "node-entry"
  };
}

/** 校验并归一化一条启动请求（main 收到 utility 的请求后先过这一层）。 */
export function validateCodexStartOptions(value: unknown): { executable: string; args: string[]; cwd: string } {
  if (!value || typeof value !== "object") throw new Error("Codex 启动请求非法");
  const record = value as Partial<CodexProcessStartOptions>;
  const executable = validateCodexExecutable(record.executable);
  const args = validateCodexArgs(record.args);
  const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
  if (!cwd || !isAbsolute(cwd) || cwd.includes("\u0000")) throw new Error(`Codex 工作目录必须是绝对路径：${cwd || "（空）"}`);
  return { executable, args, cwd };
}

/** 子进程的最小形状（单测可注入 fake，不必真起进程）。 */
export interface CodexChildProcess {
  pid?: number;
  stdin: {
    write(data: string, callback?: (error?: Error | null) => void): boolean;
    on?(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface CodexProcessSupervisorOptions {
  /** 进程事件出口（main 把它原样转发给当前这条 utility）。 */
  onEvent(handle: string, event: CodexProcessEvent): void;
  platform?: NodeJS.Platform;
  maxProcesses?: number;
  stderrTailChars?: number;
  /** 测试注入：把解析结果变成子进程。 */
  spawnProcess?: (launch: CodexLaunchResolution, cwd: string) => CodexChildProcess;
  /** 测试注入：结束进程树。 */
  killTree?: (pid: number) => void;
  /** 协议层做可执行文件校验的注入点（单测不必真造 .exe）。 */
  validateExecutable?: (executable: unknown) => string;
  /** 协议层做启动分辨率注入点。 */
  resolveLaunch?: (executable: string, args: string[]) => CodexLaunchResolution;
}

interface ProcessEntry {
  handle: string;
  child: CodexChildProcess;
  pid?: number;
  /** 收到 stop 后不再接受 write；退出事件仍要走完（一次性结算）。 */
  stopping: boolean;
  /** exit 事件只发一次（spawn 失败会同时给 error 与 exit）。 */
  settled: boolean;
  /** 已请求过 kill 但还没有 pid：拿到 pid 时立即回收。 */
  killOnSpawn: boolean;
}

/**
 * 一个 utility 实例的 Codex 进程表。
 *
 * 实例与 utility 同生命周期：`startRuntime()` 建新实例、旧实例 `shutdown()`；
 * utility 退出时 main 调 `shutdown()`，应用退出时 `before-quit` 再兜一次。
 */
export class CodexProcessSupervisor {
  private readonly processes = new Map<string, ProcessEntry>();
  private readonly onEvent: (handle: string, event: CodexProcessEvent) => void;
  private readonly platform: NodeJS.Platform;
  private readonly maxProcesses: number;
  private readonly stderrTailChars: number;
  private readonly spawnProcess: (launch: CodexLaunchResolution, cwd: string) => CodexChildProcess;
  private readonly killTree: (pid: number) => void;
  private readonly validateExecutable: (executable: unknown) => string;
  private readonly resolveLaunch: (executable: string, args: string[]) => CodexLaunchResolution;
  private disposed = false;

  constructor(options: CodexProcessSupervisorOptions) {
    this.onEvent = options.onEvent;
    this.platform = options.platform ?? process.platform;
    this.maxProcesses = options.maxProcesses ?? MAX_CODEX_PROCESSES;
    this.stderrTailChars = options.stderrTailChars ?? CODEX_STDERR_TAIL_CHARS;
    this.spawnProcess = options.spawnProcess ?? ((launch, cwd) => spawn(launch.file, launch.args, {
      cwd,
      env: { ...process.env, ...launch.env },
      // 只有 stdio：不监听端口、不打开网络。
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // POSIX：新进程组 ⇒ kill(-pid) 覆盖 npm shim 拉起的整棵树。
      detached: this.platform !== "win32"
    }) as unknown as CodexChildProcess);
    this.killTree = options.killTree ?? ((pid) => killProcessTree(pid, this.platform));
    this.validateExecutable = options.validateExecutable ?? ((executable) => validateCodexExecutable(executable, { platform: this.platform }));
    this.resolveLaunch = options.resolveLaunch ?? ((executable, args) => resolveCodexLaunch(executable, args, { platform: this.platform }));
  }

  /** 当前活着的进程数（诊断/测试）。 */
  size(): number {
    return this.processes.size;
  }

  /**
   * 启动一条 Codex 进程。失败（校验不通过、spawn error、超时）一律抛出可读错误；
   * 成功返回 pid（可能 undefined——POSIX 上极少数平台不立即给 pid）。
   */
  async start(handle: string, options: unknown): Promise<{ pid?: number }> {
    if (this.disposed) throw new Error("Codex 进程监管已关闭（运行时正在退出）");
    const key = normalizeCodexProcessHandle(handle);
    if (this.processes.has(key)) throw new Error(`Codex 进程句柄重复：${key}`);
    if (this.processes.size >= this.maxProcesses) throw new Error(`同时运行的 Codex 进程已达上限 ${this.maxProcesses}`);
    const request = options as Partial<CodexProcessStartOptions> | undefined;
    const executable = this.validateExecutable(request?.executable);
    const args = validateCodexArgs(request?.args);
    const cwd = typeof request?.cwd === "string" ? request.cwd.trim() : "";
    if (!cwd || !isAbsolute(cwd) || cwd.includes("\u0000")) throw new Error(`Codex 工作目录必须是绝对路径：${cwd || "（空）"}`);
    const launch = this.resolveLaunch(executable, args);
    let child: CodexChildProcess;
    try {
      child = this.spawnProcess(launch, cwd);
    } catch (error) {
      throw new Error(`Codex 进程启动失败：${errorText(error)}`);
    }
    const entry: ProcessEntry = { handle: key, child, pid: child.pid, stopping: false, settled: false, killOnSpawn: false };
    if (entry.pid !== undefined) entry.pid = child.pid;
    this.processes.set(key, entry);
    this.attach(entry);
    // spawn 是异步的：等一个 'spawn' / 'error'（最多 5s），把 ENOENT 这类立刻失败如实报出来，
    // 不让调用方拿着「已启动」去等一个永远不来的握手。
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(undefined), 5_000);
      timer.unref?.();
      const finish = (error: Error | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      (child as unknown as { on(event: string, listener: (...args: unknown[]) => void): void }).on("spawn", () => finish(undefined));
      (child as unknown as { on(event: string, listener: (...args: unknown[]) => void): void }).on("error", (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      // 已经拿到 pid 的实现（测试 fake）不会再发 spawn：下一拍直接放行。
      setImmediate(() => { if (entry.pid !== undefined) finish(undefined); });
    }).catch((error: unknown) => {
      this.settle(entry, { code: null, error: errorText(error) });
      throw new Error(`Codex 进程启动失败：${errorText(error)}`);
    });
    if (this.disposed) {
      // 启动过程中应用开始退出：立刻回收，别留下没人管的进程。
      this.terminate(entry);
      throw new Error("Codex 进程监管已关闭（运行时正在退出）");
    }
    return entry.pid === undefined ? {} : { pid: entry.pid };
  }

  /** 写一帧到 stdin。停止/退出后的写入被丢弃（迟到帧按句柄隔离）。 */
  write(handle: string, data: unknown): void {
    const entry = this.processes.get(normalizeCodexProcessHandle(handle));
    if (!entry || entry.stopping || entry.settled) return;
    const text = typeof data === "string" ? data : "";
    if (!text) return;
    if (text.length > CODEX_MAX_STDIN_FRAME_CHARS) {
      this.emit(entry, { kind: "stderr", text: `写入被拒绝：单帧超过 ${CODEX_MAX_STDIN_FRAME_CHARS} 字符` });
      return;
    }
    const stdin = entry.child.stdin;
    if (!stdin) return;
    try {
      // 带回调写入：EPIPE / 已关闭的 stdin 会走回调，不冒泡成未处理的 'error' 事件
      // （那会直接把主进程带崩）；caller 只关心「这一帧没写进去」，按 stderr 诊断报出。
      stdin.write(text, (error?: Error | null) => {
        if (error) this.emit(entry, { kind: "stderr", text: `写入 Codex stdin 失败：${errorText(error)}` });
      });
    } catch (error) {
      this.emit(entry, { kind: "stderr", text: `写入 Codex stdin 失败：${errorText(error)}` });
    }
  }

  /** 停止一条进程（结束整棵进程树；幂等）。 */
  stop(handle: string, _reason?: string): void {
    const entry = this.processes.get(normalizeCodexProcessHandle(handle));
    if (!entry) return;
    entry.stopping = true;
    this.terminate(entry);
  }

  /** utility 退出 / 运行时重建：回收全部进程，不再发事件。 */
  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.processes.values()]) {
      entry.stopping = true;
      this.terminate(entry);
      entry.settled = true;
      this.processes.delete(entry.handle);
    }
  }

  private attach(entry: ProcessEntry): void {
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stderrTail = "";
    try {
      // stdin 在进程退出后仍可能抛 EPIPE：挂一个监听器吞掉，别让主进程崩在一条迟到的帧上。
      entry.child.stdin?.on?.("error", (error) => {
        this.emit(entry, { kind: "stderr", text: `Codex stdin 出错：${errorText(error)}` });
      });
    } catch {
      // 测试替身可能没有 on：忽略。
    }
    entry.child.stdout?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
      if (text) this.emit(entry, { kind: "stdout", text });
    });
    entry.child.stderr?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
      if (!text) return;
      stderrTail = (stderrTail + text).slice(-this.stderrTailChars);
      this.emit(entry, { kind: "stderr", text });
    });
    entry.child.on("exit", (code, signal) => {
      // 退出前把两个解码器里挂着的半截多字节字符补出来（最后一行往往就是报错）。
      const restOut = stdoutDecoder.end();
      if (restOut) this.emit(entry, { kind: "stdout", text: restOut });
      const restErr = stderrDecoder.end();
      if (restErr) {
        stderrTail = (stderrTail + restErr).slice(-this.stderrTailChars);
      }
      this.settle(entry, {
        code: typeof code === "number" ? code : null,
        ...(signal ? { signal } : {}),
        ...(entry.stopping ? {} : stderrTail ? { error: stderrTail.trim().slice(-600) } : {})
      });
    });
    entry.child.on("error", (error) => {
      this.settle(entry, { code: null, error: errorText(error) });
    });
    (entry.child as unknown as { on(event: string, listener: (...args: unknown[]) => void): void }).on("spawn", () => {
      if (entry.pid === undefined) entry.pid = entry.child.pid;
      if (entry.killOnSpawn) this.terminate(entry);
    });
  }

  private terminate(entry: ProcessEntry): void {
    const pid = entry.pid;
    if (pid === undefined) {
      entry.killOnSpawn = true;
      return;
    }
    try {
      this.killTree(pid);
    } catch {
      // 进程已经没了：退出事件会把它收口。
    }
  }

  /** 一次性结算：exit/error 都走这里，重复调用不重复发事件。 */
  private settle(entry: ProcessEntry, info: { code: number | null; signal?: string; error?: string }): void {
    if (entry.settled) return;
    entry.settled = true;
    if (this.processes.get(entry.handle) === entry) this.processes.delete(entry.handle);
    if (this.disposed) return;
    this.emit(entry, {
      kind: "exit",
      code: info.code,
      ...(info.signal ? { signal: info.signal } : {}),
      ...(info.error ? { error: info.error } : {})
    });
  }

  private emit(entry: ProcessEntry, event: CodexProcessEvent): void {
    if (this.disposed) return;
    try {
      this.onEvent(entry.handle, event);
    } catch {
      // 转发失败（窗口/utility 已不在）不能影响进程监管本身。
    }
  }
}
