import { describe, expect, it } from "vitest";
import type { TerminalEventData } from "../shared/protocol.js";
import { TerminalManager, appendScrollback, clampDimension, resolveShellCommand, type PtyProcess, type PtySpawnOptions } from "./terminal-pty.js";

interface FakePty extends PtyProcess {
  written: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: number;
  emitData(chunk: string): void;
  emitExit(exitCode: number): void;
}

interface Harness {
  manager: TerminalManager;
  published: TerminalEventData[];
  ptys: FakePty[];
  spawns: Array<{ file: string; args: string[]; options: PtySpawnOptions }>;
  flush(): void;
  cancelFlush(): void;
  hasPendingFlush(): boolean;
}

function createHarness(options: { defaultCwd?: string } = {}): Harness {
  const published: TerminalEventData[] = [];
  const ptys: FakePty[] = [];
  const spawns: Array<{ file: string; args: string[]; options: PtySpawnOptions }> = [];
  let flushCallback: (() => void) | undefined;
  let cancelled = false;

  function makePty(): FakePty {
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
    const pty: FakePty = {
      pid: 1000 + ptys.length,
      written: [],
      resizes: [],
      killed: 0,
      write(data) { this.written.push(data); },
      resize(cols, rows) { this.resizes.push({ cols, rows }); },
      kill() { this.killed += 1; },
      onData(listener) { dataListeners.push(listener); return { dispose: () => { const index = dataListeners.indexOf(listener); if (index >= 0) dataListeners.splice(index, 1); } }; },
      onExit(listener) { exitListeners.push(listener); return { dispose: () => { const index = exitListeners.indexOf(listener); if (index >= 0) exitListeners.splice(index, 1); } }; },
      emitData(chunk) { for (const listener of [...dataListeners]) listener(chunk); },
      emitExit(exitCode) { for (const listener of [...exitListeners]) listener({ exitCode }); }
    };
    return pty;
  }

  const manager = new TerminalManager({
    spawnPty(file, args, spawnOptions) {
      spawns.push({ file, args, options: spawnOptions });
      const pty = makePty();
      ptys.push(pty);
      return pty;
    },
    publish: (terminalId, event) => published.push(event),
    scheduleFlush(callback) {
      flushCallback = callback;
      return () => { cancelled = true; };
    },
    defaultCwd: options.defaultCwd ? () => options.defaultCwd : undefined,
    resolveShell: () => ({ file: "shell.exe", args: [] })
  });

  return {
    manager,
    published,
    ptys,
    spawns,
    flush() { const callback = flushCallback; flushCallback = undefined; cancelled = false; callback?.(); },
    cancelFlush() { cancelled = true; flushCallback = undefined; },
    hasPendingFlush() { return Boolean(flushCallback) && !cancelled; }
  };
}

function createCommand(terminalId: string, extra: { cwd?: string; cols?: number; rows?: number } = {}): { type: "create"; terminalId: string; cwd?: string; cols: number; rows: number } {
  return { type: "create", terminalId, cols: 80, rows: 24, ...extra };
}

describe("TerminalManager", () => {
  it("spawns a shell with clamped dimensions and forwards input", () => {
    const harness = createHarness();
    harness.manager.handle({ ...createCommand("t1"), cols: 9999, rows: 0.4 });
    harness.manager.handle({ type: "input", terminalId: "t1", data: "echo hi\r" });

    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.options.cols).toBe(500);
    expect(harness.spawns[0]!.options.rows).toBe(2);
    expect(harness.ptys[0]!.written).toEqual(["echo hi\r"]);
  });

  it("batches pty output into one publish per flush", () => {
    const harness = createHarness();
    harness.manager.handle(createCommand("t1"));
    harness.ptys[0]!.emitData("a");
    harness.ptys[0]!.emitData("b");
    harness.ptys[0]!.emitData("c");
    expect(harness.published).toEqual([]);
    expect(harness.hasPendingFlush()).toBe(true);

    harness.flush();
    expect(harness.published).toEqual([{ type: "data", terminalId: "t1", data: "abc" }]);
    expect(harness.hasPendingFlush()).toBe(false);
  });

  it("flushes oversized chunks immediately instead of waiting for the timer", () => {
    const harness = createHarness();
    harness.manager.handle(createCommand("t1"));
    const chunk = "x".repeat(70 * 1024);
    harness.ptys[0]!.emitData(chunk);
    expect(harness.published).toEqual([{ type: "data", terminalId: "t1", data: chunk }]);
    expect(harness.hasPendingFlush()).toBe(false);
  });

  it("replays scrollback and resizes on reconnect instead of respawning", () => {
    const harness = createHarness();
    harness.manager.handle(createCommand("t1"));
    harness.ptys[0]!.emitData("hello ");
    harness.flush();
    harness.ptys[0]!.emitData("world");
    harness.flush();

    harness.manager.handle({ ...createCommand("t1"), cols: 120, rows: 40 });
    expect(harness.spawns).toHaveLength(1);
    expect(harness.ptys[0]!.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(harness.published.at(-1)).toEqual({ type: "data", terminalId: "t1", data: "hello world" });
  });

  it("publishes pending output then exit, and forgets the terminal", () => {
    const harness = createHarness();
    harness.manager.handle(createCommand("t1"));
    harness.ptys[0]!.emitData("bye");
    harness.ptys[0]!.emitExit(3);

    expect(harness.published).toEqual([
      { type: "data", terminalId: "t1", data: "bye" },
      { type: "exit", terminalId: "t1", exitCode: 3 }
    ]);
    expect(harness.hasPendingFlush()).toBe(false);

    // A later create for the same id spawns a fresh shell.
    harness.manager.handle(createCommand("t1"));
    expect(harness.spawns).toHaveLength(2);
  });

  it("caps live terminals and reports an error event", () => {
    const harness = createHarness();
    for (let index = 0; index < 5; index += 1) harness.manager.handle(createCommand(`t${index}`));
    harness.manager.handle(createCommand("t5"));

    expect(harness.spawns).toHaveLength(5);
    expect(harness.published).toEqual([{ type: "error", terminalId: "t5", message: expect.stringContaining("上限") }]);
  });

  it("kills the pty on kill and via disposeAll without publishing exit", () => {
    const harness = createHarness();
    harness.manager.handle(createCommand("t1"));
    harness.manager.handle(createCommand("t2"));
    harness.manager.handle({ type: "kill", terminalId: "t1" });

    expect(harness.ptys[0]!.killed).toBe(1);
    // kill relies on the pty's own onExit to clean up; the record stays until then.
    harness.ptys[0]!.emitExit(0);
    expect(harness.published.some((event) => event.type === "exit" && event.terminalId === "t1")).toBe(true);

    harness.manager.handle({ type: "kill", terminalId: "missing" });
    harness.manager.disposeAll();
    expect(harness.ptys[1]!.killed).toBe(1);
    expect(harness.published.some((event) => event.type === "exit" && event.terminalId === "t2")).toBe(false);
  });

  it("reports spawn failures as error events", () => {
    const published: TerminalEventData[] = [];
    const manager = new TerminalManager({
      spawnPty() { throw new Error("conpty 不可用"); },
      publish: (terminalId, event) => published.push(event),
      resolveShell: () => ({ file: "shell.exe", args: [] })
    });
    manager.handle(createCommand("t1"));
    expect(published).toEqual([{ type: "error", terminalId: "t1", message: expect.stringContaining("conpty 不可用") }]);
  });

  it("falls back to the workspace default cwd when create omits it", () => {
    const harness = createHarness({ defaultCwd: "D:\\work\\demo" });
    harness.manager.handle({ type: "create", terminalId: "t1", cols: 80, rows: 24 });
    expect(harness.spawns[0]!.options.cwd).toBe("D:\\work\\demo");
  });
});

describe("resolveShellCommand", () => {
  it("prefers pwsh over powershell along PATH on Windows", () => {
    const exists = (path: string) => path.endsWith("pwsh.exe") || path.endsWith("powershell.exe");
    const shell = resolveShellCommand({ platform: "win32", env: { PATH: "C:\\bin;C:\\Windows\\System32\\WindowsPowerShell\\v1.0" }, exists });
    expect(shell.file.endsWith("pwsh.exe")).toBe(true);
  });

  it("falls back to ComSpec when no PowerShell is on PATH", () => {
    const comSpec = "C:\\Windows\\system32\\cmd.exe";
    const shell = resolveShellCommand({ platform: "win32", env: { PATH: "C:\\bin", ComSpec: comSpec }, exists: (path) => path === comSpec });
    expect(shell.file).toBe(comSpec);
  });

  it("honors an explicit shell that exists", () => {
    const shell = resolveShellCommand({ platform: "win32", shell: "C:\\Program Files\\Git\\bin\\bash.exe", env: { PATH: "" }, exists: (path) => path.startsWith("C:\\Program Files\\Git") });
    expect(shell.file).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("uses SHELL on posix platforms", () => {
    const shell = resolveShellCommand({ platform: "linux", env: { SHELL: "/usr/bin/zsh" }, exists: () => true });
    expect(shell.file).toBe("/usr/bin/zsh");
  });
});

describe("helpers", () => {
  it("clamps dimensions into the supported range", () => {
    expect(clampDimension(1, 80)).toBe(2);
    expect(clampDimension(80.6, 80)).toBe(81);
    expect(clampDimension(100000, 80)).toBe(500);
    expect(clampDimension(Number.NaN, 80)).toBe(80);
  });

  it("drops the oldest scrollback beyond the cap", () => {
    const limit = 200 * 1024;
    let buffer = "a".repeat(limit - 10);
    buffer = appendScrollback(buffer, "0123456789abcdefghij");
    expect(buffer).toHaveLength(limit);
    expect(buffer.startsWith("abcdefghij")).toBe(false);
    expect(buffer.endsWith("0123456789abcdefghij")).toBe(true);
  });
});
