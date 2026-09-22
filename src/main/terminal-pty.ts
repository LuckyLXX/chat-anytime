import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import type { TerminalCommand, TerminalEventData } from "../shared/protocol.js";

/**
 * User-facing terminal host for the preview panel. PTY processes live in the
 * main process (node-pty adapter injected by index.ts), xterm.js renders in
 * the sandboxed renderer; bytes cross as UTF-8 strings over per-terminal IPC.
 * This module keeps all logic pure over injected dependencies so it can be
 * unit-tested without node-pty or Electron (see terminal-pty.test.ts).
 */

/** Minimal structural view of a node-pty process (IPty). */
export interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export const TERMINAL_MAX_COUNT = 5;
const FLUSH_INTERVAL_MS = 10;
const FLUSH_MAX_CHARS = 64 * 1024;
const SCROLLBACK_LIMIT_CHARS = 200 * 1024;
const DIMENSION_MIN = 2;
const DIMENSION_MAX = 500;
/** 退出后保留的输出尾部：服务型作品的「启动失败原因」就靠它。 */
const EXIT_TAIL_CHARS = 2000;
/** 保留多少条已退出终端的尾部（同一作品的终端 id 固定，几条就够回看）。 */
const EXIT_RECORD_LIMIT = 8;

export interface TerminalManagerDeps {
  spawnPty(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
  publish(terminalId: string, event: TerminalEventData): void;
  /** Test seam: schedule an async flush, returning a cancel function. */
  scheduleFlush?(callback: () => void): () => void;
  defaultCwd?(): string | undefined;
  resolveShell?(shell: string | undefined): { file: string; args: string[] };
}

interface TerminalRecord {
  terminalId: string;
  pty: PtyProcess;
  /** Replayed on renderer reconnect so remounted xterm tabs keep their content. */
  scrollback: string;
  /** Chunks accumulated since the last flush, sent as one IPC message. */
  pending: string;
  disposeListeners(): void;
}

/** 已退出终端的残留信息：进程没了以后还得能回答「为啥没起来」。 */
interface TerminalExitRecord {
  exitCode?: number;
  tail: string;
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

/**
 * Pick the shell for a new terminal. Windows prefers PowerShell 7 over the
 * built-in Windows PowerShell; everything else falls back to cmd / $SHELL.
 * Pure over injected inputs for testability.
 */
export function resolveShellCommand(input: { shell?: string; platform?: NodeJS.Platform; env?: Record<string, string | undefined>; exists?(path: string): boolean }): { file: string; args: string[] } {
  const exists = input.exists ?? existsSync;
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const shell = input.shell?.trim();
  if (shell && exists(shell)) return { file: shell, args: [] };

  if (platform === "win32") {
    const pathValue = env.PATH ?? env.Path ?? "";
    const pathDirs = pathValue.split(delimiter).filter((dir) => dir.trim().length > 0);
    for (const candidate of ["pwsh.exe", "powershell.exe"]) {
      const absolute = pathDirs.map((dir) => join(dir, candidate)).find((dir) => exists(dir));
      if (absolute) return { file: absolute, args: [] };
    }
    if (env.ComSpec && exists(env.ComSpec)) return { file: env.ComSpec, args: [] };
    return { file: "cmd.exe", args: [] };
  }
  if (env.SHELL && exists(env.SHELL)) return { file: env.SHELL, args: [] };
  if (exists("/bin/bash")) return { file: "/bin/bash", args: [] };
  return { file: "/bin/sh", args: [] };
}

/**
 * 把一条命令交给 shell 「跑完就退出」：服务型作品「运行」用的 PTY 形态。
 *
 * 为什么不让 shell 保持交互、把命令当输入打进去：
 *  - 交互 shell 在子命令退出后**自己不会退**，「命令写错了」与「服务正在跑」对
 *    上层完全同形，等待方只能干等满超时；
 *  - 这个 PTY 就是服务的宿主：进程退出码 = 命令退出码（可直接报「已退出（代码 N）」），
 *    关掉标签 = 杀掉服务，正是用户 2026-09-23 选定的生命周期。
 *
 * 用 shell 而不是直接 spawn 命令：Windows 上 `npm`/`npx` 实际是 .cmd，不经过
 * shell 解析会直接 ENOENT；用用户自己的 shell 也与「自己在终端里跑」一致。
 *
 * **cmd.exe 必须走环境变量，不能把命令当参数传**（真机实测 2026-09-23）：
 * node-pty 在 Windows 上按 MSVCRT 规则拼命令行（用反斜杠转义引号），而 cmd 只认
 * 自己那套引号规则——`cmd /d /s /c 'node -e "console.log(1)"'` 会静默跑出一个空
 * 结果（退出码 0、零输出，最坑的一种错）；改传 `%PI_SERVICE_COMMAND%` 由 cmd 自己
 * 展开，实测引号/`&`/`%`/带空格的路径/精确退出码全对。pwsh / Windows PowerShell
 * 自己解析 -Command 的字符串，引号无此问题（两边都真机验过）。
 */
export const SERVICE_COMMAND_ENV = "PI_SERVICE_COMMAND";

export function shellServiceInvocation(shellFile: string, command: string): { args: string[]; env?: Record<string, string> } {
  const name = basename(shellFile).toLowerCase();
  if (name === "cmd" || name === "cmd.exe") return { args: ["/d", "/s", "/c", `%${SERVICE_COMMAND_ENV}%`], env: { [SERVICE_COMMAND_ENV]: command } };
  if (name === "pwsh" || name === "pwsh.exe" || name === "powershell" || name === "powershell.exe") {
    // 不传 -NoProfile：nvm-windows 等把 PATH 写在 profile 里，跳过 profile 会让
    // 明明能跑的 `node xxx` 变成找不到命令。
    return { args: ["-NoLogo", "-Command", command] };
  }
  return { args: ["-c", command] };
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly pendingFlush = new Set<TerminalRecord>();
  /** 已退出终端的尾部（有界）：进程没了也得能回答「为啥没起来」。 */
  private readonly exits = new Map<string, TerminalExitRecord>();
  private readonly schedule: (callback: () => void) => () => void;
  private cancelFlush: (() => void) | undefined;

  constructor(private readonly deps: TerminalManagerDeps) {
    this.schedule = deps.scheduleFlush ?? ((callback) => {
      const timer = setTimeout(callback, FLUSH_INTERVAL_MS);
      return () => clearTimeout(timer);
    });
  }

  handle(command: TerminalCommand): void {
    switch (command.type) {
      case "create": this.create(command); break;
      case "input": this.terminals.get(command.terminalId)?.pty.write(command.data); break;
      case "resize": {
        const record = this.terminals.get(command.terminalId);
        if (record) record.pty.resize(clampDimension(command.cols, 80), clampDimension(command.rows, 24));
        break;
      }
      case "kill": this.kill(command.terminalId); break;
    }
  }

  /** True when a `create` spawned a fresh PTY (false = reconnect/replay or rejection). */
  private create(command: Extract<TerminalCommand, { type: "create" }>): boolean {
    const existing = this.terminals.get(command.terminalId);
    if (existing) {
      // Renderer remount (tab switch, panel reopen): keep the live PTY, replay
      // scrollback and adopt the new dimensions instead of spawning a shell.
      existing.pty.resize(clampDimension(command.cols, 80), clampDimension(command.rows, 24));
      if (existing.scrollback) this.deps.publish(command.terminalId, { type: "data", terminalId: command.terminalId, data: existing.scrollback });
      return false;
    }
    if (this.terminals.size >= TERMINAL_MAX_COUNT) {
      this.deps.publish(command.terminalId, { type: "error", terminalId: command.terminalId, message: `终端数量已达上限（${TERMINAL_MAX_COUNT}），请先关闭其他终端标签。` });
      return false;
    }
    const resolve = this.deps.resolveShell ?? ((shell) => resolveShellCommand({ shell }));
    const shell = resolve(command.shell);
    const initialCommand = command.initialCommand?.trim();
    // 有 initialCommand = 这个 PTY 直接跑那条命令（跑完就退），见 shellServiceInvocation。
    const service = initialCommand ? shellServiceInvocation(shell.file, initialCommand) : undefined;
    const args = service ? service.args : shell.args;
    const cwd = command.cwd?.trim() ? command.cwd : this.deps.defaultCwd?.();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    if (service?.env) Object.assign(env, service.env);
    try {
      const pty = this.deps.spawnPty(shell.file, args, {
        name: "xterm-256color",
        cols: clampDimension(command.cols, 80),
        rows: clampDimension(command.rows, 24),
        cwd,
        env
      });
      const dataSubscription = pty.onData((chunk) => this.enqueue(command.terminalId, chunk));
      const exitSubscription = pty.onExit((event) => this.handleExit(command.terminalId, event.exitCode));
      this.terminals.set(command.terminalId, {
        terminalId: command.terminalId,
        pty,
        scrollback: "",
        pending: "",
        disposeListeners: () => {
          dataSubscription.dispose();
          exitSubscription.dispose();
        }
      });
      return true;
    } catch (error) {
      this.deps.publish(command.terminalId, { type: "error", terminalId: command.terminalId, message: `终端启动失败：${error instanceof Error ? error.message : String(error)}` });
      return false;
    }
  }

  private enqueue(terminalId: string, chunk: string): void {
    const record = this.terminals.get(terminalId);
    if (!record) return;
    record.scrollback = appendScrollback(record.scrollback, chunk);
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

  private handleExit(terminalId: string, exitCode: number): void {
    const record = this.terminals.get(terminalId);
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
    record.disposeListeners();
    this.terminals.delete(terminalId);
    // 尾部要在删记录之前抓：记录一删，输出就没了，而「启动命令为啥退出」
    // 恰好只能从输出里看出来。
    this.rememberExit(terminalId, exitCode, record.scrollback);
    this.deps.publish(terminalId, { type: "exit", terminalId, exitCode });
  }

  private rememberExit(terminalId: string, exitCode: number, scrollback: string): void {
    this.exits.delete(terminalId);
    this.exits.set(terminalId, { exitCode, tail: scrollback.length > EXIT_TAIL_CHARS ? scrollback.slice(scrollback.length - EXIT_TAIL_CHARS) : scrollback });
    while (this.exits.size > EXIT_RECORD_LIMIT) {
      const oldest = this.exits.keys().next().value;
      if (oldest === undefined) break;
      this.exits.delete(oldest);
    }
  }

  /**
   * 终端此刻的状态：服务型作品的等待方靠它决定「还值得再等吗」。
   *
   * 关键区分：`exitCode === undefined` 既包含活着、也包含**尚未创建**——等待方
   * 不能把「还没创建」当成失败（渲染端开标签与等待是两个独立 IPC，先后者到是常态）。
   *
   * 「活着的记录」优先于「退出记录」：同一 id 重新起了进程后，上一次的失败记录
   * 不得把新进程判死（重试即重启服务，见下测试）；这里不靠 create 时清记录，
   * 而是把优先序放在唯一的读路径上。
   */
  status(terminalId: string): { alive: boolean; exitCode?: number; tail?: string } {
    if (this.terminals.has(terminalId)) return { alive: true };
    const exited = this.exits.get(terminalId);
    if (!exited) return { alive: false };
    const status: { alive: boolean; exitCode?: number; tail?: string } = { alive: false };
    if (exited.exitCode !== undefined) status.exitCode = exited.exitCode;
    if (exited.tail) status.tail = exited.tail;
    return status;
  }

  /** 终端输出的尾部（活着取实时 scrollback，已退出取残留记录）。 */
  tail(terminalId: string, chars = 2000): string | undefined {
    const alive = this.terminals.get(terminalId);
    if (alive) return alive.scrollback.length > chars ? alive.scrollback.slice(alive.scrollback.length - chars) : alive.scrollback;
    const exited = this.exits.get(terminalId);
    if (!exited) return undefined;
    return exited.tail.length > chars ? exited.tail.slice(exited.tail.length - chars) : exited.tail;
  }

  private kill(terminalId: string): void {
    const record = this.terminals.get(terminalId);
    if (record) record.pty.kill();
  }

  disposeAll(): void {
    this.cancelFlush?.();
    this.cancelFlush = undefined;
    this.pendingFlush.clear();
    for (const record of this.terminals.values()) {
      record.disposeListeners();
      record.pty.kill();
    }
    this.terminals.clear();
    this.exits.clear();
  }
}
