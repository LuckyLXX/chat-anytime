import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BackgroundProcess } from "../shared/protocol.js";

/**
 * Tracks background processes left behind by the agent's bash tool.
 *
 * The SDK's bash tool waits for the shell and returns, but commands like
 * `nohup dsh web &` or `( dsh web > log 2>&1 & )` leave detached descendants
 * running. The utility process detects them after each bash execution
 * (and once per session open, against the session's bash history) by
 * fingerprinting the command against the Windows process table, then keeps
 * the list fresh with a liveness poll. The task panel renders the list and
 * can kill entries via `taskkill /F /T`.
 */

const POLL_INTERVAL_MS = 4_000;
/** Only show processes that have survived at least this long (avoids flash-in/flash-out). */
const MIN_AGE_MS = 5_000;
const SHELL_PROCESS_NAMES = new Set([
  "sh.exe", "bash.exe", "cmd.exe", "conhost.exe", "powershell.exe", "pwsh.exe",
  "wsl.exe", "git.exe", "wmic.exe", "tasklist.exe"
]);

/** Commands that just forward to another launcher — never a good fingerprint. */
const fingerprintStopwords = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "deno", "bun", "sh", "bash", "cmd", "powershell",
  "pwsh", "git", "python", "python3", "py", "ruby", "java", "go", "cargo", "dotnet",
  "run", "start", "cd", "echo", "ls", "cat", "head", "tail", "grep", "sed", "awk", "sleep",
  "timeout", "wait", "nohup", "setsid", "log", "tmp", "dev", "null", "netstat", "tasklist",
  "taskkill", "ps", "kill", "stop", "rm", "del", "copy", "move", "mkdir", "touch", "which",
  "where", "exit", "export", "env", "set", "true", "false", "done", "check", "port", "pid",
  "proc", "status", "info", "list", "show", "print", "test", "try", "check", "verify",
  "confirm", "wait", "sleep", "let", "read", "exec", "eval", "source", "call", "get", "put"
]);

/** Detect commands that plausibly leave a background process behind. */
export function isBackgroundCommand(command: string): boolean {
  return /(^|[\s;(|&])(nohup|setsid)\s+/u.test(command)
    || /\b(start|cmd)\s+\/b\b/u.test(command)          // Windows: start /b
    || /&\s*\)/u.test(command)                          // ( cmd & )
    || /&\s*(#|;|$)/u.test(command)                     // cmd & / cmd & # note
    || />\s*\/dev\/null\s*2?&?1?\s*&/u.test(command);   // > /dev/null 2>&1 &
}

/** Distinctive tokens (program name etc.) of a command, used to match processes. */
export function commandFingerprints(command: string): string[] {
  const tokens = command.split(/[^\p{L}\p{N}@._/-]+/u).filter((token) => token.length >= 3);
  const seen = new Set<string>();
  const fingerprints: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (fingerprintStopwords.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    fingerprints.push(lower);
    if (fingerprints.length >= 2) break;
  }
  return fingerprints;
}

function commandLineMatches(commandLine: string, fingerprints: string[]): boolean {
  if (!commandLine || fingerprints.length === 0) return false;
  const lower = commandLine.toLowerCase();
  return fingerprints.every((fingerprint) => lower.includes(fingerprint));
}

/** WMI datetime "20260814065519.123456+480" or JSON "/Date(1786696390416)/" → epoch ms. */
export function wmiDateToMs(value: string | null | undefined): number {
  if (!value) return 0;
  const jsonDate = /^\/Date\((\d+)\)\//u.exec(value);
  if (jsonDate) return Number(jsonDate[1]);
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/u.exec(value);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

export interface ProcessSnapshotEntry {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  Name?: unknown;
  CommandLine?: unknown;
  CreationDate?: unknown;
}

/** Full Windows process table via CIM. ~0.5–2s; callers must throttle. */
export async function snapshotProcesses(): Promise<ProcessSnapshotEntry[]> {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress";
  const output = await new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  const parsed = JSON.parse(output.trim() || "[]") as ProcessSnapshotEntry | ProcessSnapshotEntry[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Desktop shells that indicate a process was launched by the user, not by the plugin. */
const userDesktopProcessNames = new Set(["explorer.exe", "windowsterminal.exe", "wt.exe"]);

/** Build pid → snapshot entry lookup (live processes only). */
export function snapshotIndex(entries: ProcessSnapshotEntry[]): Map<number, ProcessSnapshotEntry> {
  const index = new Map<number, ProcessSnapshotEntry>();
  for (const entry of entries) {
    const pid = Number(entry.ProcessId);
    if (Number.isInteger(pid) && pid > 0) index.set(pid, entry);
  }
  return index;
}

/**
 * Post-execution guard: a process is only treated as launched by this bash
 * execution if its direct parent was created inside the execution window.
 * Manually started processes have long-lived parents (terminal/explorer) and
 * are excluded. Orphaned processes (parent exited, e.g. nohup) cannot be
 * verified and are kept.
 */
export function parentCreatedInWindow(entry: ProcessSnapshotEntry, index: Map<number, ProcessSnapshotEntry>, sinceMs: number): boolean {
  const parentPid = Number(entry.ParentProcessId);
  const parent = Number.isInteger(parentPid) && parentPid > 0 ? index.get(parentPid) : undefined;
  if (!parent) return true; // orphan / parent exited — unverifiable, keep
  const parentCreated = wmiDateToMs(typeof parent.CreationDate === "string" ? parent.CreationDate : null);
  return parentCreated <= 0 || parentCreated >= sinceMs - 5_000;
}

/**
 * Discovery guard: walk the ancestor chain; if it reaches a desktop shell
 * (explorer / Windows Terminal) the process was started by the user manually,
 * not by the plugin. A broken chain (plugin-spawned orphans) is kept.
 */
export function hasUserDesktopAncestor(entry: ProcessSnapshotEntry, index: Map<number, ProcessSnapshotEntry>): boolean {
  let current: ProcessSnapshotEntry | undefined = entry;
  const seen = new Set<number>();
  for (let depth = 0; depth < 32; depth++) {
    if (!current) return false;
    const pid = Number(current.ProcessId);
    if (!Number.isInteger(pid) || seen.has(pid)) return false; // cycle — unverifiable
    seen.add(pid);
    const name = typeof current.Name === "string" ? current.Name.toLowerCase() : "";
    if (userDesktopProcessNames.has(name)) return true;
    const rawParentPid = current.ParentProcessId;
    const parentPid: number = Number(rawParentPid);
    current = Number.isInteger(parentPid) && parentPid > 0 ? index.get(parentPid) : undefined;
  }
  return false;
}

/** Extract shell commands (bash/powershell tool calls) from persisted session messages (assistant tool-call blocks). */
export function bashCommandsFromMessages(messages: readonly unknown[]): string[] {
  const commands: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    for (const block of record.content) {
      if (!block || typeof block !== "object") continue;
      const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== "toolCall" || (call.name !== "bash" && call.name !== "powershell")) continue;
      const command = (call.arguments as { command?: unknown } | undefined)?.command;
      if (typeof command === "string" && command.trim()) commands.push(command);
    }
  }
  return commands;
}

export class BackgroundProcessRegistry {
  private readonly processes = new Map<number, BackgroundProcess>();
  private readonly pendingChecks = new Map<number, { command: string; fingerprints: string[]; timer: ReturnType<typeof setTimeout> }>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastScanAt = 0;

  constructor(private readonly onChanged: () => void) {}

  list(): BackgroundProcess[] {
    return [...this.processes.values()];
  }

  /** Kill a tracked process tree (taskkill /F /T) and remove the card immediately. */
  kill(id: string): boolean {
    const entry = this.list().find((item) => item.id === id);
    if (!entry) return false;
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(entry.pid)], { stdio: "ignore", windowsHide: true, detached: true });
    } catch { /* taskkill may be unavailable */ }
    // Optimistic removal: the panel card must disappear the moment the user
    // clicks stop, without waiting for the liveness poll. If taskkill failed
    // the process survives untracked; a later scan re-registers it.
    this.processes.delete(entry.pid);
    this.onChanged();
    return true;
  }

  /**
   * Scan the process table for survivors of a bash command. `sinceMs` bounds
   * matches to processes created around the execution and requires the direct
   * parent to have been created in that window (post-execution scans).
   * Discovery scans (no `sinceMs`) match against historical commands and
   * exclude processes whose ancestor chain reaches a desktop shell (i.e.
   * started manually by the user, not by the plugin).
   */
  async scanForCommand(command: string, sinceMs?: number): Promise<BackgroundProcess[]> {
    const fingerprints = commandFingerprints(command);
    if (fingerprints.length === 0) return [];
    // Throttle: a full CIM table scan is expensive and consecutive bash
    // executions are common; 3s between scans is plenty for survivor detection.
    const now = Date.now();
    if (now - this.lastScanAt < 3_000) return [];
    this.lastScanAt = now;
    try {
      const entries = await snapshotProcesses();
      const index = snapshotIndex(entries);
      const found: BackgroundProcess[] = [];
      for (const entry of entries) {
        const name = typeof entry.Name === "string" ? entry.Name.toLowerCase() : "";
        if (SHELL_PROCESS_NAMES.has(name)) continue;
        if (!commandLineMatches(typeof entry.CommandLine === "string" ? entry.CommandLine : "", fingerprints)) continue;
        const created = wmiDateToMs(typeof entry.CreationDate === "string" ? entry.CreationDate : null);
        if (sinceMs !== undefined) {
          if (created > 0 && created < sinceMs - 5_000) continue;
          if (!parentCreatedInWindow(entry, index, sinceMs)) continue;
        } else if (hasUserDesktopAncestor(entry, index)) {
          continue;
        }
        const pid = Number(entry.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0 || this.processes.has(pid)) continue;
        // Defer short-lived processes: a process that has not survived MIN_AGE
        // yet would flash in and out of the panel (registered now, removed by
        // the liveness poll moments later). Re-check it once it reaches the
        // age threshold and only then register it.
        if (created > 0 && now - created < MIN_AGE_MS) {
          this.scheduleRecheck(pid, command, fingerprints, created);
          continue;
        }
        const process: BackgroundProcess = {
          id: randomUUID(),
          command,
          pid,
          startedAt: created > 0 ? created : (sinceMs ?? now)
        };
        this.processes.set(pid, process);
        found.push(process);
      }
      if (found.length > 0) {
        this.ensurePolling();
        this.onChanged();
      }
      return found;
    } catch (error) {
      // Process snapshot unavailable (no PowerShell, policy) — stay quiet.
      return [];
    }
  }

  /** Discover processes left by background commands from session history. */
  async discoverFromHistory(commands: readonly string[]): Promise<void> {
    for (const command of commands) {
      if (!isBackgroundCommand(command)) continue;
      await this.scanForCommand(command);
    }
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const pending of this.pendingChecks.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingChecks.clear();
    this.processes.clear();
  }

  /** Defer registration until the process has survived MIN_AGE_MS, then re-check. */
  private scheduleRecheck(pid: number, command: string, fingerprints: string[], created: number): void {
    if (this.pendingChecks.has(pid)) return;
    const delay = Math.max(0, created + MIN_AGE_MS - Date.now() + 250);
    const timer = setTimeout(() => { void this.recheckPending(pid); }, delay);
    this.pendingChecks.set(pid, { command, fingerprints, timer });
  }

  /** Re-check a deferred process: register it only if it is still alive and still matches. */
  private async recheckPending(pid: number): Promise<void> {
    const pending = this.pendingChecks.get(pid);
    this.pendingChecks.delete(pid);
    if (!pending || this.processes.has(pid)) return;
    try {
      const entries = await snapshotProcesses();
      const entry = entries.find((item) => Number(item.ProcessId) === pid);
      if (!entry) return; // process already exited — nothing to show
      const name = typeof entry.Name === "string" ? entry.Name.toLowerCase() : "";
      if (SHELL_PROCESS_NAMES.has(name)) return;
      if (!commandLineMatches(typeof entry.CommandLine === "string" ? entry.CommandLine : "", pending.fingerprints)) return;
      const created = wmiDateToMs(typeof entry.CreationDate === "string" ? entry.CreationDate : null);
      const process: BackgroundProcess = {
        id: randomUUID(),
        command: pending.command,
        pid,
        startedAt: created > 0 ? created : Date.now()
      };
      this.processes.set(pid, process);
      this.ensurePolling();
      this.onChanged();
    } catch {
      // Snapshot unavailable — skip; the next scan may pick the process up.
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
  }

  /** Remove tracked processes that are no longer alive. */
  private async poll(): Promise<void> {
    if (this.processes.size === 0) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      return;
    }
    const ids = [...this.processes.keys()];
    const script = `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`;
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      const alive = new Set(output.split(/\s+/u).map((line) => line.trim()).filter(Boolean).map(Number));
      let changed = false;
      for (const pid of ids) {
        if (!alive.has(pid)) {
          this.processes.delete(pid);
          changed = true;
        }
      }
      if (changed) this.onChanged();
    } catch {
      // Poll failure is transient — keep entries until a later poll succeeds.
    }
  }
}
