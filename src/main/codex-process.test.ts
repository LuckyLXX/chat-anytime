import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexProcessEvent } from "../shared/protocol.js";
import {
  CodexProcessSupervisor,
  normalizeCodexProcessHandle,
  resolveCodexLaunch,
  validateCodexArgs,
  validateCodexExecutable,
  type CodexChildProcess,
  type CodexLaunchResolution
} from "./codex-process.js";

/**
 * 进程监管的边界：只拉起 Codex、参数受限、npm shim 显式解析、事件一次性、
 * 进程树回收、按句柄隔离。全部用注入的 fake 子进程，不需要真进程。
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      // Windows 上可能有短暂占用：失败不影响断言。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pi-desktop-codex-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

class FakeChild {
  pid: number | undefined;
  written: string[] = [];
  stdin = { write: (data: string) => { this.written.push(data); return true; } };
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  stdout = { on: (event: string, listener: (...args: unknown[]) => void) => this.add(event, listener) };
  stderr = { on: (event: string, listener: (...args: unknown[]) => void) => this.add(event, listener) };

  constructor(pid: number | undefined = 4242) {
    this.pid = pid;
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    return this.add(event, listener);
  }

  private add(event: string, listener: (...args: unknown[]) => void): unknown {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  data(chunk: string | Buffer): void {
    this.fire("data", typeof chunk === "string" ? chunk : chunk);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.fire("exit", code, signal);
  }
}

interface Supervised {
  supervisor: CodexProcessSupervisor;
  events: Array<{ handle: string; event: CodexProcessEvent }>;
  children: FakeChild[];
  killed: number[];
}

function supervised(overrides: { maxProcesses?: number; executable?: string; args?: string[] } = {}): Supervised {
  const events: Supervised["events"] = [];
  const children: FakeChild[] = [];
  const killed: number[] = [];
  const supervisor = new CodexProcessSupervisor({
    onEvent: (handle, event) => events.push({ handle, event }),
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as CodexChildProcess;
    },
    killTree: (pid) => killed.push(pid),
    validateExecutable: (value) => String(value),
    resolveLaunch: (executable, args): CodexLaunchResolution => ({ file: executable, args, env: {}, shim: "exe" }),
    ...(overrides.maxProcesses ? { maxProcesses: overrides.maxProcesses } : {})
  });
  return { supervisor, events, children, killed };
}

const START = { executable: "C:\\tools\\codex.exe", args: ["app-server"], cwd: "C:\\work" };

describe("handle and argument validation", () => {
  it("accepts only short opaque handles", () => {
    expect(normalizeCodexProcessHandle("codex-abc_1:2")).toBe("codex-abc_1:2");
    expect(() => normalizeCodexProcessHandle("")).toThrow();
    expect(() => normalizeCodexProcessHandle("bad handle")).toThrow();
    expect(() => normalizeCodexProcessHandle("x".repeat(200))).toThrow();
  });

  it("allows app-server with bounded config overrides and a bare --version probe", () => {
    expect(validateCodexArgs(["app-server"])).toEqual(["app-server"]);
    expect(validateCodexArgs(["app-server", "-c", "features.hooks=false"])).toEqual(["app-server", "-c", "features.hooks=false"]);
    expect(validateCodexArgs(["app-server", "--disable", "plugins"])).toEqual(["app-server", "--disable", "plugins"]);
    expect(validateCodexArgs(["--version"])).toEqual(["--version"]);
    expect(() => validateCodexArgs([])).toThrow();
    expect(() => validateCodexArgs(["exec"])).toThrow(/app-server/u);
    expect(() => validateCodexArgs(["app-server", "--dangerously-bypass"])).toThrow(/不支持的 Codex 启动参数/u);
    expect(() => validateCodexArgs(["app-server", "-c"])).toThrow(/key=value/u);
    expect(() => validateCodexArgs(["app-server", "-c", "=oops"])).toThrow(/键名非法/u);
    expect(() => validateCodexArgs(["--version", "extra"])).toThrow();
  });

  it("only accepts absolute paths to a codex executable", () => {
    const deps = { fileExists: () => true, isFile: () => true };
    expect(validateCodexExecutable("C:\\Program Files\\codex\\codex.exe", { ...deps, platform: "win32" })).toContain("codex.exe");
    expect(validateCodexExecutable("/usr/local/bin/codex", { ...deps, platform: "linux" })).toBe("/usr/local/bin/codex");
    expect(() => validateCodexExecutable("codex.exe", { ...deps, platform: "win32" })).toThrow(/绝对路径/u);
    expect(() => validateCodexExecutable("C:\\tools\\node.exe", { ...deps, platform: "win32" })).toThrow(/文件名必须是 codex/u);
    expect(() => validateCodexExecutable("C:\\tools\\codex.ps1", { ...deps, platform: "win32" })).toThrow(/PowerShell shim/u);
    expect(() => validateCodexExecutable("C:\\tools\\codex.exe", { ...deps, platform: "win32", fileExists: () => false })).toThrow(/找不到/u);
    expect(() => validateCodexExecutable("/opt/node", { ...deps, platform: "linux" })).toThrow(/文件名必须是 codex/u);
  });
});

describe("npm shim resolution", () => {
  it("parses codex.cmd into the official JS entry (paths with spaces and non-ASCII)", () => {
    const root = join(tempDir("shim"), "有 空格");
    const bin = join(root, "node_modules", "@openai", "codex", "bin");
    mkdirSync(bin, { recursive: true });
    const entry = join(bin, "codex.js");
    writeFileSync(entry, "// fake\n", "utf8");
    const shim = join(root, "codex.cmd");
    writeFileSync(shim, "@ECHO off\r\n\"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n", "utf8");
    const resolved = resolveCodexLaunch(shim, ["app-server"], { platform: "win32", nodeExecutable: "C:\\node\\node.exe" });
    expect(resolved.shim).toBe("node-entry");
    expect(resolved.file).toBe("C:\\node\\node.exe");
    expect(resolved.args).toEqual([entry, "app-server"]);
    expect(resolved.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("rejects an unparseable shim instead of guessing through cmd.exe", () => {
    const root = tempDir("shim2");
    const shim = join(root, "codex.cmd");
    writeFileSync(shim, "@ECHO off\r\nsomething-else %*\r\n", "utf8");
    expect(() => resolveCodexLaunch(shim, ["app-server"], { platform: "win32" })).toThrow(/无法解析 Codex npm shim/u);
  });

  it("spawns native exe and POSIX entries directly", () => {
    expect(resolveCodexLaunch("C:\\tools\\codex.exe", ["app-server"], { platform: "win32" })).toMatchObject({ shim: "exe", env: {} });
    expect(resolveCodexLaunch("/usr/bin/codex", ["app-server"], { platform: "linux" })).toMatchObject({ shim: "posix", env: {} });
  });
});

describe("supervisor lifecycle", () => {
  it("spawns, forwards writes and decodes UTF-8 split across chunks", async () => {
    const s = supervised();
    const { pid } = await s.supervisor.start("codex-1", START);
    expect(pid).toBe(4242);
    s.supervisor.write("codex-1", "{\"method\":\"initialized\"}\n");
    expect(s.children[0]!.written).toEqual(["{\"method\":\"initialized\"}\n"]);
    const bytes = Buffer.from("中文\n", "utf8");
    s.children[0]!.data(bytes.subarray(0, 2));
    s.children[0]!.data(bytes.subarray(2));
    const stdout = s.events.filter((entry) => entry.event.kind === "stdout").map((entry) => (entry.event as { text: string }).text).join("");
    expect(stdout).toBe("中文\n");
  });

  it("emits exit exactly once even when error and exit both fire", async () => {
    const s = supervised();
    await s.supervisor.start("codex-1", START);
    s.children[0]!.fire("error", new Error("ENOENT"));
    s.children[0]!.exit(null);
    const exits = s.events.filter((entry) => entry.event.kind === "exit");
    expect(exits).toHaveLength(1);
    expect(s.supervisor.size()).toBe(0);
  });

  it("stops the whole tree and ignores writes after stop", async () => {
    const s = supervised();
    await s.supervisor.start("codex-1", START);
    s.supervisor.stop("codex-1");
    expect(s.killed).toEqual([4242]);
    s.supervisor.write("codex-1", "late\n");
    expect(s.children[0]!.written).toEqual([]);
    s.children[0]!.exit(0);
    expect(s.events.filter((entry) => entry.event.kind === "exit")).toHaveLength(1);
  });

  it("rejects duplicate handles, unknown writes and the process cap", async () => {
    const s = supervised({ maxProcesses: 1 });
    await s.supervisor.start("codex-1", START);
    await expect(s.supervisor.start("codex-1", START)).rejects.toThrow(/句柄重复/u);
    await expect(s.supervisor.start("codex-2", START)).rejects.toThrow(/上限/u);
    s.supervisor.write("codex-unknown", "x");
    expect(s.children).toHaveLength(1);
  });

  it("turns an EPIPE on stdin into a diagnostic instead of crashing the main process", async () => {
    const s = supervised();
    await s.supervisor.start("codex-1", START);
    const stdin = s.children[0]!.stdin;
    // 异步 EPIPE（进程已退出但事件还没到）：写回调带错误，不冒泡成未处理的 'error'。
    stdin.write = (_data: string, callback?: (error?: Error | null) => void) => {
      callback?.(new Error("EPIPE"));
      return false;
    };
    s.supervisor.write("codex-1", "{\"method\":\"initialized\"}\n");
    const stderr = s.events.filter((entry) => entry.event.kind === "stderr").map((entry) => (entry.event as { text: string }).text).join("\n");
    expect(stderr).toContain("EPIPE");
    // 同步抛错也不能从 supervisor 里逃出去。
    stdin.write = () => { throw new Error("EPIPE sync"); };
    expect(() => s.supervisor.write("codex-1", "x\n")).not.toThrow();
    expect(s.events.some((entry) => entry.event.kind === "stderr" && (entry.event as { text: string }).text.includes("EPIPE sync"))).toBe(true);
  });

  it("kills every live process on shutdown and sends no further events", async () => {
    const s = supervised();
    await s.supervisor.start("codex-1", START);
    await s.supervisor.start("codex-2", START);
    s.supervisor.shutdown();
    expect(s.killed.sort()).toEqual([4242, 4242]);
    const before = s.events.length;
    s.children[0]!.exit(0);
    expect(s.events.length).toBe(before);
    await expect(s.supervisor.start("codex-3", START)).rejects.toThrow(/已关闭/u);
  });

  it("rejects invalid start requests before spawning", async () => {
    const s = supervised();
    // 参数与 cwd 的校验不依赖可执行文件是否真实存在（这里注入了放行的 validator）。
    await expect(s.supervisor.start("codex-1", { executable: "C:\\tools\\codex.exe", args: ["exec"], cwd: "C:\\w" })).rejects.toThrow(/app-server/u);
    await expect(s.supervisor.start("codex-1", { executable: "C:\\tools\\codex.exe", args: ["app-server"], cwd: "work" })).rejects.toThrow(/绝对路径/u);
    expect(s.children).toHaveLength(0);
    // 真校验器：相对路径在任何 spawn 之前就被拒。
    const strict = new CodexProcessSupervisor({
      onEvent: () => undefined,
      spawnProcess: () => { throw new Error("should not spawn"); }
    });
    await expect(strict.start("codex-1", { executable: "codex.exe", args: ["app-server"], cwd: process.cwd() })).rejects.toThrow(/绝对路径|只支持/u);
  });

  it("reports spawn failures with an actionable message", async () => {
    const events: Array<{ handle: string; event: CodexProcessEvent }> = [];
    const supervisor = new CodexProcessSupervisor({
      onEvent: (handle, event) => events.push({ handle, event }),
      spawnProcess: () => { throw new Error("EACCES"); },
      validateExecutable: (value) => String(value),
      resolveLaunch: (executable, args) => ({ file: executable, args, env: {}, shim: "exe" })
    });
    await expect(supervisor.start("codex-1", START)).rejects.toThrow(/EACCES/u);
  });
});
