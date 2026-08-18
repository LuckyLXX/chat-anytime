import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
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

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly pendingFlush = new Set<TerminalRecord>();
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
    const cwd = command.cwd?.trim() ? command.cwd : this.deps.defaultCwd?.();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    try {
      const pty = this.deps.spawnPty(shell.file, shell.args, {
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
    this.deps.publish(terminalId, { type: "exit", terminalId, exitCode });
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
  }
}
