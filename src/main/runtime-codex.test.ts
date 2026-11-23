import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CodexProcessEvent, CodexProcessStartOptions } from "../shared/protocol.js";
import type { CodexProcessHandle } from "./codex-process-client.js";
import {
  CodexTeamBackend,
  DEFAULT_CODEX_CLI_CONFIG,
  defaultCodexSandboxCapability,
  detectCodexExecutable,
  normalizeCodexCliConfig,
  probeCodexConnection,
  resolveCodexExecutable,
  type CodexCliConfig
} from "./runtime-codex.js";
import { codexThreadBindingPath } from "./team-store.js";
import type { TeamMemberConfig } from "./team-store.js";

/**
 * 能力簇的边界：配置归一化、PATH 探测、连接测试（只握手）、可用性（fail closed）、
 * 以及成员子会话的线程绑定落盘/恢复。
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pi-desktop-runtime-codex-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

/** 造一个「存在且是 codex 入口」的文件（扩展名跟随当前平台）。 */
function fakeExecutable(directory: string): string {
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const path = join(directory, name);
  writeFileSync(path, "// fake codex\n", { mode: 0o755 });
  return path;
}

interface FakeCli {
  handles: FakeHandle[];
  start(options: CodexProcessStartOptions): Promise<CodexProcessHandle>;
  /** 最近一条 app-server 进程（`--version` 探测也算一条）。 */
  appHandles(): FakeHandle[];
}

class FakeHandle implements CodexProcessHandle {
  readonly handle: string;
  readonly pid = 1000;
  closed = false;
  stopped: string[] = [];
  written: string[] = [];
  threadId = "thread-1";
  authState: "not-required" | "signed-out" = "not-required";
  initializeError?: { code: number; message: string };
  /** Windows 沙箱就绪读数（默认 ready：隔离闸门与真实运行时同口径）。 */
  readinessStatus: "ready" | "notConfigured" | "updateRequired" | "unknown" = "ready";
  effectiveConfig: unknown = { config: { features: { hooks: false, apps: false, plugins: false }, mcp_servers: {}, notify: [] } };
  private listeners = new Set<(event: CodexProcessEvent) => void>();
  private seq = 0;

  constructor(readonly options: CodexProcessStartOptions, index: number) {
    this.handle = `h${index}`;
  }

  write(data: string): void {
    this.written.push(data);
    const frame = JSON.parse(data) as { id?: string; method?: string; params?: Record<string, unknown> };
    if (frame.method === "initialize") {
      if (this.initializeError) this.emit({ id: frame.id, error: this.initializeError });
      else this.emit({ id: frame.id, result: { userAgent: "pidesktop/1", codexHome: "/h", platformOs: "windows", platformFamily: "windows" } });
      return;
    }
    if (frame.method === "account/read") {
      this.emit({ id: frame.id, result: { account: null, requiresOpenaiAuth: this.authState === "signed-out" } });
      return;
    }
    if (frame.method === "windowsSandbox/readiness") {
      this.emit({ id: frame.id, result: { status: this.readinessStatus } });
      return;
    }
    if (frame.method === "config/read") {
      this.emit({ id: frame.id, result: this.effectiveConfig });
      return;
    }
    if (frame.method === "thread/start") {
      this.emit({ id: frame.id, result: { thread: { id: this.threadId } } });
      return;
    }
    if (frame.method === "thread/resume") {
      this.emit({ id: frame.id, result: { thread: { id: frame.params?.threadId ?? this.threadId } } });
      return;
    }
    if (frame.method === "turn/start") {
      this.seq += 1;
      const turnId = `turn-${this.seq}`;
      this.emit({ method: "turn/started", params: { threadId: this.threadId, turn: { id: turnId, status: "inProgress" } } });
      this.emit({ method: "turn/completed", params: { threadId: this.threadId, turn: { id: turnId, status: "completed" } } });
      this.emit({ id: frame.id, result: { turn: { id: turnId, status: "completed" } } });
      return;
    }
    if (frame.id !== undefined) this.emit({ id: frame.id, result: {} });
  }

  stop(reason?: string): void {
    this.stopped.push(reason ?? "stop");
    this.closed = true;
  }

  onEvent(listener: (event: CodexProcessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(payload: Record<string, unknown>): void {
    const text = `${JSON.stringify(payload)}\n`;
    for (const listener of [...this.listeners]) listener({ kind: "stdout", text });
  }

  exit(code = 0): void {
    for (const listener of [...this.listeners]) listener({ kind: "exit", code });
    this.closed = true;
  }
}

function fakeCli(): FakeCli {
  const handles: FakeHandle[] = [];
  return {
    handles,
    appHandles: () => handles.filter((handle) => handle.options.args[0] === "app-server"),
    start: (options) => {
      const handle = new FakeHandle(options, handles.length);
      handles.push(handle);
      if (options.args[0] === "--version") {
        // 让「版本探测」走一条真实的事件流：stdout + exit。
        setImmediate(() => {
          for (const listener of (handle as unknown as { listeners: Set<(event: CodexProcessEvent) => void> }).listeners) {
            listener({ kind: "stdout", text: "codex-cli 0.171.0\n" });
          }
          handle.exit(0);
        });
      }
      return Promise.resolve(handle);
    }
  };
}

describe("config normalization", () => {
  it("keeps only known fields and falls back to read-only", () => {
    expect(normalizeCodexCliConfig(undefined)).toBeUndefined();
    expect(normalizeCodexCliConfig("x")).toBeUndefined();
    expect(normalizeCodexCliConfig({})).toEqual({ enabled: false, access: "read-only" });
    expect(normalizeCodexCliConfig({ enabled: true, access: "workspace-write", executable: " C:\\tools\\codex.exe " }))
      .toEqual({ enabled: true, access: "workspace-write", executable: "C:\\tools\\codex.exe" });
    expect(normalizeCodexCliConfig({ enabled: "yes", access: "danger-full-access", executable: 7 }))
      .toEqual({ enabled: false, access: "read-only" });
  });

  it("ships a disabled, read-only default", () => {
    expect(DEFAULT_CODEX_CLI_CONFIG).toEqual({ enabled: false, access: "read-only" });
  });
});

describe("executable discovery", () => {
  it("scans PATH entries in order and prefers native exe on Windows", () => {
    const env = { PATH: '"/one";/two' };
    const found = detectCodexExecutable({
      platform: "win32",
      env,
      fileExists: (path) => path === join("/two", "codex.cmd") || path === join("/two", "codex.exe")
    });
    expect(found).toBe(join("/two", "codex.exe"));
    expect(detectCodexExecutable({ platform: "linux", env: { PATH: "/one:/two" }, fileExists: (path) => path === join("/two", "codex") }))
      .toBe(join("/two", "codex"));
    expect(detectCodexExecutable({ platform: "linux", env: { PATH: "" }, fileExists: () => true })).toBeUndefined();
  });

  it("rejects a user-picked path that is not a codex executable", () => {
    const directory = tempDir("bad");
    const other = join(directory, process.platform === "win32" ? "node.exe" : "node");
    writeFileSync(other, "x");
    expect(() => resolveCodexExecutable({ enabled: true, access: "read-only", executable: other })).toThrow(/文件名必须是 codex/u);
    expect(() => resolveCodexExecutable({ enabled: true, access: "read-only" }, { env: { PATH: "" } })).toThrow(/找不到 Codex CLI/u);
  });
});

describe("availability (fail closed)", () => {
  /** 注：默认平台判定在 Windows 上拒绝 workspace-write（见 CodexSandboxCapability），
   *  所以「允许写入」的用例必须显式注入沙箱能力，不能靠宿主机碰运气。 */
  function backend(
    config: CodexCliConfig | undefined,
    extra: { sandboxCapability?: { workspaceWrite: boolean; detail: string } } = {}
  ): CodexTeamBackend {
    const cli = fakeCli();
    return new CodexTeamBackend({
      readConfig: () => config,
      startProcess: cli.start,
      ...(extra.sandboxCapability ? { sandboxCapability: extra.sandboxCapability } : {})
    });
  }

  it("is unavailable when disabled", () => {
    expect(backend(undefined).availability()).toMatchObject({ available: false, access: "read-only" });
    expect(backend({ enabled: false, access: "read-only" }).availability().reason).toContain("未启用");
  });

  it("is unavailable when the executable cannot be resolved", () => {
    const missing = process.platform === "win32" ? "codex.exe" : "codex";
    const availability = backend({ enabled: true, access: "read-only", executable: join(tempDir("no"), missing) }).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("找不到 Codex 可执行文件");
  });

  it("refuses workspace-write when the sandbox cannot be verified (no fail open)", () => {
    const executable = fakeExecutable(tempDir("write"));
    const blocked = backend({ enabled: true, access: "workspace-write", executable }, {
      sandboxCapability: { workspaceWrite: false, detail: "Windows 上无法建立可验证的 Codex 沙箱" }
    }).availability();
    expect(blocked.available).toBe(false);
    expect(blocked.reason).toContain("无法建立可验证的 Codex 沙箱");
    // 证明得了沙箱生效时才放行写入（逐轮策略仍会按 Lead 模式再收一次）。
    const allowed = backend({ enabled: true, access: "workspace-write", executable }, {
      sandboxCapability: { workspaceWrite: true, detail: "可验证" }
    }).availability();
    expect(allowed).toMatchObject({ available: true, access: "workspace-write", executable });
  });

  it("reports availability for an enabled read-only install", () => {
    const executable = fakeExecutable(tempDir("read"));
    expect(backend({ enabled: true, access: "read-only", executable }).availability()).toMatchObject({ available: true, access: "read-only", executable });
  });
});

describe("connection test", () => {
  const cwd = process.cwd();

  it("only handshakes and reports the version + auth state", async () => {
    const cli = fakeCli();
    const executable = fakeExecutable(tempDir("probe"));
    const result = await probeCodexConnection({ config: { enabled: true, access: "read-only", executable }, startProcess: cli.start, cwd });
    expect(result).toMatchObject({ ok: true, state: "ok", version: "codex-cli 0.171.0", auth: { state: "not-required" } });
    expect(result.message).toContain("已连接 Codex");
    // 进程都被回收（版本探测 + app-server）。
    expect(cli.handles.every((handle) => handle.stopped.length > 0)).toBe(true);
  });

  it("maps signed-out, incompatible and spawn failures to actionable states", async () => {
    const signedOutExecutable = fakeExecutable(tempDir("signed-out"));
    const signedOutCli = fakeCli();
    const signedOut = await probeCodexConnection({ config: { enabled: true, access: "read-only", executable: signedOutExecutable }, startProcess: async (options) => {
      const handle = await signedOutCli.start(options);
      if (options.args[0] === "app-server") (handle as unknown as FakeHandle).authState = "signed-out";
      return handle;
    }, cwd });
    expect(signedOut).toMatchObject({ ok: false, state: "signed-out" });
    expect(signedOut.message).toContain("codex login");

    const incompatibleExecutable = fakeExecutable(tempDir("incompatible"));
    const incompatibleCli = fakeCli();
    const incompatible = await probeCodexConnection({ config: { enabled: true, access: "read-only", executable: incompatibleExecutable }, startProcess: async (options) => {
      const handle = await incompatibleCli.start(options);
      if (options.args[0] === "app-server") (handle as unknown as FakeHandle).initializeError = { code: -32601, message: "nope" };
      return handle;
    }, cwd });
    expect(incompatible.state).toBe("incompatible");

    const versionCli = fakeCli();
    const spawnFailed = await probeCodexConnection({
      config: { enabled: true, access: "read-only", executable: fakeExecutable(tempDir("spawn")) },
      startProcess: async (options) => {
        if (options.args[0] === "app-server") throw new Error("EACCES");
        return versionCli.start(options);
      },
      cwd
    });
    expect(spawnFailed).toMatchObject({ ok: false, state: "spawn-failed" });
    expect(spawnFailed.message).toContain("EACCES");
  });

  it("refuses to test when disabled", async () => {
    const result = await probeCodexConnection({ config: { enabled: false, access: "read-only" }, startProcess: fakeCli().start, cwd });
    expect(result.state).toBe("not-enabled");
  });
});

describe("member child creation", () => {
  function memberConfig(executable: string): TeamMemberConfig {
    return {
      mode: "codex",
      systemPrompt: "",
      tools: [],
      thinkingLevel: "medium",
      browserTools: false,
      codex: { executable, sandbox: "read-only", approvalPolicy: "never" }
    };
  }

  it("persists the thread id in the member dir and resumes it on the next cold start", async () => {
    const root = tempDir("member");
    const workspace = join(root, "workspace");
    const memberDir = join(root, "team");
    const executable = fakeExecutable(root);
    const cli = fakeCli();
    const backend = new CodexTeamBackend({ readConfig: () => ({ enabled: true, access: "read-only", executable }), startProcess: cli.start });
    const manager = SessionManager.create(workspace, memberDir, { id: "member-1" });
    const created = await backend.createChild({
      memberId: "member-1",
      memberName: "reviewer",
      workspace,
      memberDir,
      manager,
      config: memberConfig(executable)
    });
    // 首回合建线程 → 绑定文件原子落盘。
    const run = created.handle.prompt("审查");
    await waitFor(() => existsSync(codexThreadBindingPath(memberDir, "member-1")));
    await run;
    const binding = JSON.parse(readFileSync(codexThreadBindingPath(memberDir, "member-1"), "utf8")) as Record<string, unknown>;
    expect(binding).toMatchObject({ memberId: "member-1", memberName: "reviewer", workspace, threadId: "thread-1", sandbox: "read-only" });
    created.handle.dispose();

    // 冷恢复：新的子会话沿用绑定里的 thread id（thread/resume，而不是 thread/start）。
    const resumedCli = fakeCli();
    const resumedBackend = new CodexTeamBackend({ readConfig: () => ({ enabled: true, access: "read-only", executable }), startProcess: resumedCli.start });
    const resumed = await resumedBackend.createChild({
      memberId: "member-1",
      memberName: "reviewer",
      workspace,
      memberDir,
      manager: SessionManager.create(workspace, memberDir, { id: "member-1" }),
      config: memberConfig(executable)
    });
    await resumed.handle.prompt("继续");
    const methods = resumedCli.appHandles().map((handle) => handle.written.map((frame) => (JSON.parse(frame) as { method?: string }).method));
    expect(methods.flat()).toContain("thread/resume");
    expect(methods.flat()).not.toContain("thread/start");
    resumed.handle.dispose();
  });

  it("honors the current config: a disabled backend cannot create or resume a member", async () => {
    const root = tempDir("disabled-member");
    const workspace = join(root, "workspace");
    const memberDir = join(root, "team");
    const executable = fakeExecutable(root);
    let config: CodexCliConfig = { enabled: true, access: "read-only", executable };
    const cli = fakeCli();
    const backend = new CodexTeamBackend({ readConfig: () => config, startProcess: cli.start });
    const manager = SessionManager.create(workspace, memberDir, { id: "member-1" });
    const created = await backend.createChild({
      memberId: "member-1",
      memberName: "reviewer",
      workspace,
      memberDir,
      manager,
      config: memberConfig(executable)
    });
    created.handle.dispose();
    // 创建时冻结的编制不能覆盖「现在已关闭」：冷恢复/重建一律拒绝，且不拉起新进程。
    config = { enabled: false, access: "read-only", executable };
    const before = cli.handles.length;
    await expect(backend.createChild({
      memberId: "member-1",
      memberName: "reviewer",
      workspace,
      memberDir,
      manager: SessionManager.create(workspace, memberDir, { id: "member-1" }),
      config: memberConfig(executable)
    })).rejects.toThrow(/已关闭 Codex 接入/u);
    expect(cli.handles).toHaveLength(before);
  });

  it("caps every turn at the current access setting, not the frozen member cap", async () => {
    const root = tempDir("tightened-access");
    const workspace = join(root, "workspace");
    const memberDir = join(root, "team");
    const executable = fakeExecutable(root);
    let config: CodexCliConfig = { enabled: true, access: "workspace-write", executable };
    const cli = fakeCli();
    const backend = new CodexTeamBackend({
      readConfig: () => config,
      startProcess: cli.start,
      // 仅测试：证明沙箱能力；逐轮仍要按当前设置再收一次。
      sandboxCapability: { workspaceWrite: true, detail: "可验证" },
      leadAccessMode: () => "workspace"
    });
    const manager = SessionManager.create(workspace, memberDir, { id: "member-1" });
    const created = await backend.createChild({
      memberId: "member-1",
      memberName: "reviewer",
      workspace,
      memberDir,
      manager,
      config: {
        ...memberConfig(executable),
        codex: { executable, sandbox: "workspace-write", approvalPolicy: "never" }
      }
    });
    // 创建之后用户在设置里收紧到只读：下一轮必须按只读下发（编制里的 workspace-write 只是上限）。
    config = { enabled: true, access: "read-only", executable };
    await created.handle.prompt("第二轮");
    const frames = cli.appHandles().flatMap((handle) => handle.written.map((frame) => JSON.parse(frame) as { method?: string; params?: Record<string, unknown> }));
    const turnStart = frames.find((frame) => frame.method === "turn/start");
    expect(turnStart?.params?.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    created.handle.dispose();
  });
});

async function waitFor(predicate: () => boolean, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("runtime readiness gate (no hardcoded platform prohibition)", () => {
  it("no longer blocks workspace-write just because the host is Windows", () => {
    const previous = process.platform;
    const capability = defaultCodexSandboxCapability("win32");
    expect(capability.workspaceWrite).toBe(true);
    expect(capability.detail).toContain("windowsSandbox/readiness");
    // 平台参数不影响结论（真正的闸门是运行时 readiness，不是宿主机平台）。
    expect(defaultCodexSandboxCapability(previous).workspaceWrite).toBe(true);
  });

  it("reports the concrete Windows readiness reason from the connection test for both access levels", async () => {
    const cwd = process.cwd();
    for (const access of ["read-only", "workspace-write"] as const) {
      const cli = fakeCli();
      const executable = fakeExecutable(tempDir(`readiness-${access}`));
      const result = await probeCodexConnection({
        config: { enabled: true, access, executable },
        startProcess: (options) => {
          const handle = cli.start(options);
          void handle.then((started) => { (started as unknown as { readinessStatus: string }).readinessStatus = "notConfigured"; });
          return handle;
        },
        cwd
      });
      expect(result).toMatchObject({ ok: false, state: "incompatible", access });
      expect(result.message).toContain("windowsSandbox/readiness = notConfigured");
      expect(result.message).toContain("只读与工作区写入");
      // 连接测试仍然只握手：没有建线程。
      expect(cli.appHandles().flatMap((handle) => handle.written.map((frame) => (JSON.parse(frame) as { method?: string }).method)))
        .not.toContain("thread/start");
    }
  });

  it("fails the member's first turn before thread creation when readiness is not ready", async () => {
    const root = tempDir("readiness-member");
    const workspace = join(root, "workspace");
    const memberDir = join(root, "team");
    const executable = fakeExecutable(root);
    const cli = fakeCli();
    const backend = new CodexTeamBackend({
      readConfig: () => ({ enabled: true, access: "workspace-write", executable }),
      startProcess: async (options) => {
        const handle = await cli.start(options);
        (handle as unknown as { readinessStatus: string }).readinessStatus = "notConfigured";
        return handle;
      },
      // 平台禁令已移除；这里注入「可写」只是证明拦截来自运行时 readiness。
      sandboxCapability: { workspaceWrite: true, detail: "可运行时校验" },
      leadAccessMode: () => "workspace"
    });
    const created = await backend.createChild({
      memberId: "member-1",
      memberName: "reviewer",
      workspace,
      memberDir,
      manager: SessionManager.create(workspace, memberDir, { id: "member-1" }),
      config: {
        mode: "codex",
        systemPrompt: "",
        tools: [],
        thinkingLevel: "medium",
        browserTools: false,
        codex: { executable, sandbox: "workspace-write", approvalPolicy: "never" }
      }
    });
    await expect(created.handle.prompt("改文件")).rejects.toThrow(/运行时隔离校验失败.*notConfigured/u);
    const methods = cli.appHandles().flatMap((handle) => handle.written.map((frame) => (JSON.parse(frame) as { method?: string }).method));
    expect(methods).not.toContain("thread/start");
    created.dispose();
  });
});
