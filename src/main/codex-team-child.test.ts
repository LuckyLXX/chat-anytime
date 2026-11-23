import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAppServerClient } from "./codex-app-server.js";
import {
  CodexTeamChild,
  toolStepForItem,
  type CodexConnection,
  type CodexTurnPolicyResolver
} from "./codex-team-child.js";
import type { CodexServerRequestDecision } from "./codex-app-server.js";
import type { TeamChildEvent } from "./team-runtime.js";

/**
 * 适配器的契约：线程绑定、回合路由（start/steer/interrupt）、事件投影、
 * 三种终态的结算语义、迟到帧隔离、停止超时后的进程回收、转写写入。
 *
 * 这里用假 app-server（按帧回应）而不是真进程：真进程路径由 codex-process-e2e 覆盖。
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows 上偶发占用：忽略。
    }
  }
});

interface Frame {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

class FakeServer {
  client?: CodexAppServerClient;
  frames: Frame[] = [];
  stopped: string[] = [];
  /** 每个方法的处理函数（收到请求后由用例决定怎么回应/发通知）。 */
  handlers = new Map<string, (params: Record<string, unknown>, id: string, server: FakeServer) => void>();
  /** 线程 id（thread/start 生成）。 */
  threadId = "thread-abc";
  /** 隔离闸门的默认回执（与真实运行时同口径；用例可改写制造非 ready）。 */
  readinessStatus: "ready" | "notConfigured" | "updateRequired" | "unknown" = "ready";
  effectiveConfig: unknown = { config: { features: { hooks: false, apps: false, plugins: false }, mcp_servers: {}, notify: [] } };

  attach(client: CodexAppServerClient): void {
    this.client = client;
  }

  receive(text: string): void {
    const frame = JSON.parse(text) as Frame;
    this.frames.push(frame);
    if (frame.method === "initialize") {
      this.reply(frame.id!, { userAgent: "pidesktop/1", codexHome: "/h", platformOs: "windows", platformFamily: "windows" });
      return;
    }
    if (frame.method === "account/read") {
      this.reply(frame.id!, { account: null, requiresOpenaiAuth: false });
      return;
    }
    const handler = frame.method ? this.handlers.get(frame.method) : undefined;
    if (handler && frame.id !== undefined) {
      handler(frame.params ?? {}, frame.id, this);
      return;
    }
    // 默认回执：运行时隔离闸门（每个用例不必重复桩）。
    if (frame.id !== undefined && frame.method === "windowsSandbox/readiness") {
      this.reply(frame.id, { status: this.readinessStatus });
      return;
    }
    if (frame.id !== undefined && frame.method === "config/read") {
      this.reply(frame.id, this.effectiveConfig);
    }
  }

  reply(id: string, result: unknown): void {
    this.emit({ id, result });
  }

  fail(id: string, message: string, code = -32000): void {
    this.emit({ id, error: { code, message } });
  }

  emit(payload: Record<string, unknown>): void {
    this.client!.pushStdout(`${JSON.stringify(payload)}\n`);
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.emit({ method, params });
  }

  methods(): string[] {
    return this.frames.map((frame) => frame.method ?? "").filter(Boolean);
  }

  last(method: string): Frame | undefined {
    return [...this.frames].reverse().find((frame) => frame.method === method);
  }
}

interface Harness {
  child: CodexTeamChild;
  server: FakeServer;
  events: TeamChildEvent[];
  threadIds: string[];
  workspace: string;
  sessionFile: string;
  transcript(): Array<{ type: string; message?: { role?: string; content?: unknown; errorMessage?: string } }>;
}

function harness(options: {
  threadId?: string;
  sandbox?: "read-only" | "workspace-write";
  interruptConfirmMs?: number;
  turnRequestTimeoutMs?: number;
  resolveTurnPolicy?: CodexTurnPolicyResolver;
  /** 建连接前等它：用来复现「连接还没建好就 dispose」的竞态。 */
  gate?: Promise<void>;
  handleServerRequest?: (request: { id: string | number; method: string; params: unknown }) => CodexServerRequestDecision;
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-codex-child-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const teamDir = join(root, "team");
  const manager = SessionManager.create(workspace, teamDir, { id: "member-1" });
  const sessionFile = manager.getSessionFile()!;
  const server = new FakeServer();
  const events: TeamChildEvent[] = [];
  const threadIds: string[] = [];
  const child = new CodexTeamChild({
    memberId: "member-1",
    memberName: "reviewer",
    workspace: join(root, "workspace"),
    manager,
    sandbox: options.sandbox ?? "read-only",
    ...(options.threadId ? { threadId: options.threadId } : {}),
    ...(options.interruptConfirmMs ? { interruptConfirmMs: options.interruptConfirmMs } : {}),
    connect: async (onClosed): Promise<CodexConnection> => {
      if (options.gate) await options.gate;
      const client = new CodexAppServerClient({
        write: (frame) => server.receive(frame),
        onClose: (reason) => {
          server.stopped.push(reason);
          onClosed(reason);
        },
        onProtocolError: () => undefined
      }, options.handleServerRequest);
      server.attach(client);
      return { client, stop: (reason?: string) => server.stopped.push(reason ?? "stop") };
    },
    onThreadId: (threadId) => threadIds.push(threadId),
    ...(options.resolveTurnPolicy ? { resolveTurnPolicy: options.resolveTurnPolicy } : {})
  });
  child.subscribe((event) => events.push(event));
  return {
    child,
    server,
    events,
    threadIds,
    workspace,
    sessionFile,
    transcript: () => readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; message?: { role?: string; content?: unknown; errorMessage?: string } })
  };
}

function turnStartHandler(turnId = "turn-1"): (params: Record<string, unknown>, id: string, server: FakeServer) => void {
  return (_params, id, server) => {
    server.notify("turn/started", { threadId: server.threadId, turn: { id: turnId, status: "inProgress" } });
    server.reply(id, { turn: { id: turnId, status: "inProgress" } });
  };
}

/** 等某个方法真的被发出去（握手/线程绑定花了几个 await，数微任务很脆）。 */
async function waitForMethod(server: FakeServer, method: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!server.methods().includes(method)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${method}; saw ${server.methods().join(",")}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 等条件成立（审批/排队这类微任务链，数固定 tick 很脆）。 */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function completeTurn(server: FakeServer, turnId = "turn-1", status = "completed", error?: string): void {
  server.notify("turn/completed", {
    threadId: server.threadId,
    turn: { id: turnId, status, ...(error ? { error: { message: error } } : {}) }
  });
}

describe("thread binding", () => {
  it("starts a thread once and reports the id for persistence", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-new", cliVersion: "0.171.0" }, model: "gpt-test", modelProvider: "custom" }));
    h.server.handlers.set("turn/start", turnStartHandler());
    h.server.threadId = "thread-new";
    const run = h.child.prompt("审查 src/a.ts");
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server);
    await run;
    expect(h.server.last("thread/start")?.params).toMatchObject({ cwd: expect.any(String), sandbox: "read-only", approvalPolicy: "never" });
    expect(h.threadIds).toEqual(["thread-new"]);
    expect(h.child.threadId).toBe("thread-new");
    expect(h.server.methods().filter((method) => method === "thread/start")).toHaveLength(1);
  });

  it("resumes the persisted thread instead of starting a new one", async () => {
    const h = harness({ threadId: "thread-old" });
    h.server.handlers.set("thread/resume", (_params, id, server) => server.reply(id, { thread: { id: "thread-old" } }));
    h.server.handlers.set("turn/start", turnStartHandler());
    h.server.threadId = "thread-old";
    const run = h.child.prompt("继续");
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server);
    await run;
    expect(h.server.methods()).toContain("thread/resume");
    expect(h.server.methods()).not.toContain("thread/start");
    expect(h.threadIds).toEqual([]);
  });

  it("reports a concrete reason when the persisted thread is gone (transcript kept)", async () => {
    const h = harness({ threadId: "thread-gone" });
    h.server.handlers.set("thread/resume", (_params, id, server) => server.fail(id, "thread not found"));
    await expect(h.child.prompt("继续")).rejects.toThrow(/线程恢复失败.*thread-gone.*thread not found/u);
    expect(h.server.methods()).not.toContain("thread/start");
  });

  it("re-resumes the thread after the app-server process is replaced", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: server.threadId } }));
    h.server.handlers.set("thread/resume", (_params, id, server) => server.reply(id, { thread: { id: server.threadId } }));
    h.server.handlers.set("turn/start", turnStartHandler("turn-1"));
    const first = h.child.prompt("第一轮");
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server, "turn-1");
    await first;
    // 进程崩溃（不是我们主动 stop）：线程的内存态已不存在，下一次必须重新 resume。
    h.server.client!.close("模拟进程崩溃");
    h.server.handlers.set("turn/start", turnStartHandler("turn-2"));
    const second = h.child.prompt("第二轮");
    // 不能用「历史里有 turn/start」当条件：第一轮的帧还在，会提前放行。
    await waitFor(() => h.server.methods().filter((method) => method === "turn/start").length === 2);
    completeTurn(h.server, "turn-2");
    await second;
    expect(h.server.methods().filter((method) => method === "thread/start")).toHaveLength(1);
    expect(h.server.methods()).toContain("thread/resume");
  });
});

describe("turn routing and projection", () => {
  it("projects command/item/message notifications and settles completed once", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", (_params, id, server) => {
      server.notify("turn/started", { threadId: "thread-abc", turn: { id: "turn-1", status: "inProgress" } });
      server.notify("item/started", { threadId: "thread-abc", turnId: "turn-1", startedAtMs: 1, item: { id: "item-1", type: "commandExecution", command: "npm test", status: "inProgress" } });
      server.notify("item/completed", { threadId: "thread-abc", turnId: "turn-1", completedAtMs: 2, item: { id: "item-1", type: "commandExecution", command: "npm test", status: "completed" } });
      server.notify("item/completed", { threadId: "thread-abc", turnId: "turn-1", completedAtMs: 3, item: { id: "item-2", type: "agentMessage", text: "审查完成：src/a.ts 无问题" } });
      server.notify("turn/completed", { threadId: "thread-abc", turn: { id: "turn-1", status: "completed" } });
      server.reply(id, { turn: { id: "turn-1", status: "completed" } });
    });
    await h.child.prompt("看下改动");
    const kinds = h.events.map((event) => event.type);
    expect(kinds).toEqual(["agent_start", "tool_execution_start", "tool_execution_end", "message_end", "agent_settled"]);
    expect(h.events[1]).toMatchObject({ toolName: "commandExecution", args: { command: "npm test" } });
    expect(h.events[3]).toMatchObject({ type: "message_end" });
    expect(h.events[4]).toMatchObject({ type: "agent_settled", aborted: false });
    expect(h.child.isStreaming).toBe(false);
    // turn/start 的协议字段：sandboxPolicy 固定只读 + cwd + approvalPolicy never。
    const turnStart = h.server.last("turn/start")!;
    expect(turnStart.params).toMatchObject({
      input: [{ type: "text", text: "看下改动" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false }
    });
  });

  it("maps workspace-write to an explicit writable root without temp dirs", async () => {
    const h = harness({ sandbox: "workspace-write" });
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", turnStartHandler());
    const run = h.child.prompt("改文件");
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server);
    await run;
    const policy = h.server.last("turn/start")!.params!.sandboxPolicy as Record<string, unknown>;
    expect(policy).toMatchObject({ type: "workspaceWrite", networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    expect(policy.writableRoots).toEqual([h.workspace]);
  });

  it("settles a failed turn through the narrow failure event, never as completed", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", (_params, id, server) => {
      server.notify("turn/started", { threadId: "thread-abc", turn: { id: "turn-1", status: "inProgress" } });
      server.notify("turn/completed", { threadId: "thread-abc", turn: { id: "turn-1", status: "failed", error: { message: "model exploded" } } });
      server.reply(id, { turn: { id: "turn-1", status: "failed" } });
    });
    await h.child.prompt("跑一下");
    const failure = h.events.find((event) => event.type === "pidesktop_run_failed");
    expect(failure).toMatchObject({ type: "pidesktop_run_failed", error: "model exploded" });
    expect(h.events.some((event) => event.type === "agent_settled")).toBe(false);
  });

  it("ignores late terminal frames from a previous turn", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", turnStartHandler("turn-1"));
    const first = h.child.prompt("第一轮");
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server, "turn-1");
    await first;
    const settled = h.events.filter((event) => event.type === "agent_settled").length;
    // 迟到/重复的终态与新回合的 started 都不能改动已结算的状态。
    completeTurn(h.server, "turn-1");
    h.server.notify("turn/started", { threadId: "thread-abc", turn: { id: "turn-0", status: "inProgress" } });
    expect(h.events.filter((event) => event.type === "agent_settled")).toHaveLength(settled);
    expect(h.events.filter((event) => event.type === "agent_start")).toHaveLength(1);
  });

  it("steers a running turn instead of starting a second one", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", turnStartHandler("turn-1"));
    h.server.handlers.set("turn/steer", (params, id, server) => {
      expect(params.expectedTurnId).toBe("turn-1");
      server.reply(id, { turnId: "turn-1" });
    });
    const first = h.child.prompt("开始");
    await waitForMethod(h.server, "turn/start");
    const steer = h.child.sendCustomMessage({ customType: "pidesktop-team-message", content: [{ type: "text", text: "再补一点" }], display: true });
    await waitForMethod(h.server, "turn/steer");
    expect(h.server.methods()).not.toContain("turn/start\u0000");
    expect(h.server.methods().filter((method) => method === "turn/start")).toHaveLength(1);
    expect(h.server.last("turn/steer")?.params).toMatchObject({ input: [{ type: "text", text: "再补一点" }] });
    completeTurn(h.server, "turn-1");
    await Promise.all([first, steer]);
  });

  it("flushes a steer that arrived before the turn id was known", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    let startRequestId: string | undefined;
    // 先不回 turn/start：回合存在但 id 未知，追加消息只能先入队。
    h.server.handlers.set("turn/start", (_params, id) => { startRequestId = id; });
    h.server.handlers.set("turn/steer", (_params, id, server) => server.reply(id, { turnId: "turn-1" }));
    const run = h.child.prompt("开始");
    await waitForMethod(h.server, "turn/start");
    const steer = h.child.sendCustomMessage({ customType: "pidesktop-team-message", content: [{ type: "text", text: "排队补充" }], display: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.server.methods()).not.toContain("turn/steer");
    h.server.notify("turn/started", { threadId: "thread-abc", turn: { id: "turn-1", status: "inProgress" } });
    h.server.reply(startRequestId!, { turn: { id: "turn-1", status: "inProgress" } });
    await waitForMethod(h.server, "turn/steer");
    expect(h.server.last("turn/steer")?.params).toMatchObject({ expectedTurnId: "turn-1", input: [{ type: "text", text: "排队补充" }] });
    completeTurn(h.server, "turn-1");
    await Promise.all([run, steer]);
  });
});

describe("stop semantics", () => {
  it("interrupts, waits for the real terminal state and settles aborted once", async () => {
    const h = harness({ interruptConfirmMs: 200 });
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", turnStartHandler("turn-1"));
    h.server.handlers.set("turn/interrupt", (_params, id, server) => {
      server.reply(id, {});
      completeTurn(server, "turn-1", "interrupted");
    });
    const run = h.child.prompt("长任务");
    await waitForMethod(h.server, "turn/start");
    await h.child.abort();
    await run;
    expect(h.server.methods()).toContain("turn/interrupt");
    expect(h.events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
    expect(h.events.find((event) => event.type === "agent_settled")).toMatchObject({ aborted: true });
    expect(h.server.stopped).toHaveLength(0);
  });

  it("reclaims the process tree when the terminal state never arrives", async () => {
    const h = harness({ interruptConfirmMs: 30 });
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", turnStartHandler("turn-1"));
    h.server.handlers.set("turn/interrupt", (_params, id, server) => server.reply(id, {}));
    const run = h.child.prompt("不听话的回合");
    await waitForMethod(h.server, "turn/start");
    await h.child.abort();
    await run;
    expect(h.server.stopped.length).toBeGreaterThan(0);
    expect(h.events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
    expect(h.events.find((event) => event.type === "agent_settled")).toMatchObject({ aborted: true });
  });

  it("dispose kills the process and rejects later prompts", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", turnStartHandler("turn-1"));
    const run = h.child.prompt("跑");
    await waitForMethod(h.server, "turn/start");
    h.child.dispose();
    // 在途回合被主动销毁：promise 以收口（不是悬挂），且之后不再接受新任务。
    await run;
    expect(h.server.stopped.length).toBeGreaterThan(0);
    await expect(h.child.prompt("再来")).rejects.toThrow(/已释放/u);
  });

  it("does not dispatch a late turn after disposal while the process is starting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ gate });
    const run = h.child.prompt("跑");
    // 等一个宏任务窗口，确保 prompt 已停在 connect 上（还没建 client）。
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.child.dispose();
    release();
    await expect(run).rejects.toThrow(/已释放/u);
    expect(h.server.methods()).not.toContain("turn/start");
    expect(h.server.methods()).not.toContain("thread/start");
  });
});

describe("approvals, transcripts and helpers", () => {
  it("denies server approval requests (no silent escalation)", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", (params, id, server) => {
      server.notify("turn/started", { threadId: "thread-abc", turn: { id: "turn-1", status: "inProgress" } });
      server.emit({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-abc", turnId: "turn-1" } });
      server.reply(id, { turn: { id: "turn-1", status: "inProgress" } });
    });
    const run = h.child.prompt("执行命令");
    await waitForMethod(h.server, "turn/start");
    const reply = h.server.frames.find((frame) => frame.id === "approval-1");
    expect(reply?.error).toBeTruthy();
    completeTurn(h.server);
    await run;
  });

  it("writes user/assistant entries compatible with the existing transcript reader", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", (params, id, server) => {
      server.notify("turn/started", { threadId: "thread-abc", turn: { id: "turn-1", status: "inProgress" } });
      server.notify("item/completed", { threadId: "thread-abc", turnId: "turn-1", item: { id: "m1", type: "agentMessage", text: "结论：可以合并" } });
      server.notify("turn/completed", { threadId: "thread-abc", turn: { id: "turn-1", status: "completed" } });
      server.reply(id, { turn: { id: "turn-1", status: "completed" } });
    });
    await h.child.prompt("请审查");
    const messages = h.transcript().filter((entry) => entry.type === "message").map((entry) => entry.message);
    expect(messages[0]).toMatchObject({ role: "user", content: "请审查" });
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(messages[1]?.content)).toContain("结论：可以合并");
    expect(messages[1]).toMatchObject({ stopReason: "stop" });
  });

  it("maps thread items to timeline steps without inventing tools", () => {
    expect(toolStepForItem({ id: "a", type: "commandExecution", command: "ls" })).toEqual({ toolName: "commandExecution", args: { command: "ls" } });
    expect(toolStepForItem({ id: "b", type: "fileChange", path: "src/a.ts" })).toEqual({ toolName: "fileChange", args: { path: "src/a.ts" } });
    expect(toolStepForItem({ id: "c", type: "agentMessage", text: "hi" })).toBeUndefined();
    expect(toolStepForItem({ id: "d", type: "reasoning" })).toBeUndefined();
  });
});

/**
 * C 阶段的权限边界（适配器侧）：下发的 sandboxPolicy 必须就是裁决出来的那一个，
 * 裁决结果不许超过成员编制冻结的上限，服务端提权请求必须被明确拒绝（不悬挂）。
 */
describe("turn permission boundary", () => {
  it("reports a queued preflight while the first-round approval is pending", async () => {
    let release!: () => void;
    let workspace = "";
    const h = harness({
      resolveTurnPolicy: async (input) => {
        input.onAwaitingApproval?.();
        await new Promise<void>((resolve) => { release = resolve; });
        return { cwd: workspace, sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalPolicy: "never" };
      }
    });
    workspace = h.workspace;
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", turnStartHandler());
    const dispositions: string[] = [];
    const run = h.child.prompt("写文件", { preflightResult: (disposition) => dispositions.push(disposition) });
    await waitFor(() => dispositions.length === 1);
    // 确认还没点，但预检已经放行：spawn 不会在用户点卡之前超时、把成员记成 failed。
    expect(dispositions).toEqual(["queued"]);
    expect(h.server.methods()).not.toContain("turn/start");
    release();
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server);
    await run;
    expect(dispositions).toEqual(["queued", "started"]);
  });

  it("sends the resolved read-only sandbox with approvalPolicy never", async () => {
    const h = harness();
    // 通知里的 threadId 必须与绑定到的线程一致，否则会被迟到帧过滤器挡掉（现象是回合永不收口）。
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: server.threadId } }));
    h.server.handlers.set("turn/start", turnStartHandler());
    const done = h.child.prompt("看看仓库");
    await waitForMethod(h.server, "turn/start");
    const params = h.server.last("turn/start")!.params!;
    expect(params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(params.approvalPolicy).toBe("never");
    expect(params.cwd).toBe(h.workspace);
    completeTurn(h.server);
    await done;
  });

  it("refuses a resolved policy that exceeds the frozen access cap", async () => {
    const h = harness({
      sandbox: "read-only",
      resolveTurnPolicy: () => ({
        cwd: process.cwd(),
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        approvalPolicy: "never"
      })
    });
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-1" } }));
    await expect(h.child.prompt("写文件")).rejects.toThrow(/不能以工作区写入执行/u);
    expect(h.server.methods()).not.toContain("turn/start");
  });

  it("refuses a policy that lets Codex ask for approval (sandbox escalation)", async () => {
    const h = harness({
      sandbox: "workspace-write",
      resolveTurnPolicy: () => ({
        cwd: process.cwd(),
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        approvalPolicy: "on-request"
      })
    });
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-1" } }));
    await expect(h.child.prompt("写文件")).rejects.toThrow(/审批策略必须是 never/u);
    expect(h.server.methods()).not.toContain("turn/start");
  });

  it("answers a permission-escalation request instead of hanging", async () => {
    const requests: string[] = [];
    const h = harness({
      handleServerRequest: (request) => {
        requests.push(request.method);
        return { kind: "error", code: -32001, message: "拒绝扩大权限" };
      }
    });
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: server.threadId } }));
    h.server.handlers.set("turn/start", turnStartHandler());
    const done = h.child.prompt("跑一下");
    await waitForMethod(h.server, "turn/start");
    // 服务端主动要提权：客户端必须立刻回一帧错误（不回 = Codex 回合永久悬挂）。
    h.server.emit({ id: "srv-1", method: "item/permissions/requestApproval", params: { itemId: "i1" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toEqual(["item/permissions/requestApproval"]);
    completeTurn(h.server);
    await done;
  });
});

describe("runtime isolation gate (before any thread)", () => {
  for (const sandbox of ["read-only", "workspace-write"] as const) {
    it(`fails ${sandbox} before thread creation when Windows readiness is not ready`, async () => {
      const h = harness({ sandbox });
      h.server.readinessStatus = "notConfigured";
      await expect(h.child.prompt("干活")).rejects.toThrow(/运行时隔离校验失败.*notConfigured.*只读与工作区写入/u);
      // 关键：连线程都没有建（只有握手 + readiness 两帧）。
      expect(h.server.methods()).not.toContain("thread/start");
      expect(h.server.methods()).not.toContain("thread/resume");
      expect(h.server.methods()).not.toContain("turn/start");
    });
  }

  it("fails closed when the CLI does not support windowsSandbox/readiness", async () => {
    const h = harness();
    h.server.handlers.set("windowsSandbox/readiness", (_params, id, server) => server.fail(id, "method not found", -32601));
    await expect(h.child.prompt("干活")).rejects.toThrow(/windowsSandbox\/readiness 调用失败.*两种访问级别都被拦下/u);
    expect(h.server.methods()).not.toContain("thread/start");
  });

  it("fails before the thread when the effective config still enables an MCP server", async () => {
    const h = harness();
    h.server.effectiveConfig = {
      config: {
        features: { hooks: false, apps: false, plugins: false },
        mcp_servers: { leaked: { command: "node", enabled: true } },
        notify: []
      }
    };
    await expect(h.child.prompt("干活")).rejects.toThrow(/仍有启用中的 MCP 服务器（leaked）/u);
    expect(h.server.methods()).not.toContain("thread/start");
  });

  it("fails before the thread when the effective config cannot be read", async () => {
    const h = harness();
    h.server.handlers.set("config/read", (_params, id, server) => server.fail(id, "method not found", -32601));
    await expect(h.child.prompt("干活")).rejects.toThrow(/无法读取生效配置（config\/read/u);
    expect(h.server.methods()).not.toContain("thread/start");
  });

  it("requires config/read with the member's cwd", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, { thread: { id: "thread-abc" } }));
    h.server.handlers.set("turn/start", turnStartHandler());
    const run = h.child.prompt("干活");
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server);
    await run;
    expect(h.server.last("config/read")?.params).toMatchObject({ cwd: h.workspace, includeLayers: false });
    // readiness 是真实握手调用（无参数），且在建线程之前。
    const indexOf = (method: string) => h.server.methods().indexOf(method);
    expect(indexOf("windowsSandbox/readiness")).toBeGreaterThan(-1);
    expect(indexOf("windowsSandbox/readiness")).toBeLessThan(indexOf("thread/start"));
  });
});

describe("thread attestation and explicit turn policy", () => {
  it("accepts a thread whose returned cwd/approvalPolicy/sandbox match", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, {
      thread: { id: "thread-abc" },
      cwd: h.workspace,
      approvalPolicy: "never",
      sandbox: { type: "readOnly", networkAccess: false }
    }));
    h.server.handlers.set("turn/start", turnStartHandler());
    const run = h.child.prompt("干活");
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server);
    await run;
    expect(h.child.threadId).toBe("thread-abc");
  });

  it("rejects a thread whose returned cwd is not the workspace", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, {
      thread: { id: "thread-abc" },
      cwd: join(h.workspace, "elsewhere"),
      approvalPolicy: "never",
      sandbox: { type: "readOnly" }
    }));
    await expect(h.child.prompt("干活")).rejects.toThrow(/thread\/start 返回的 cwd 不是当前工作区/u);
  });

  it("rejects a thread whose returned approvalPolicy is not never", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, {
      thread: { id: "thread-abc" },
      cwd: h.workspace,
      approvalPolicy: "on-request",
      sandbox: { type: "readOnly" }
    }));
    await expect(h.child.prompt("干活")).rejects.toThrow(/approvalPolicy 不是 never/u);
  });

  it("rejects a thread whose returned sandbox is not read-only", async () => {
    const h = harness();
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, {
      thread: { id: "thread-abc" },
      cwd: h.workspace,
      approvalPolicy: "never",
      sandbox: { type: "workspaceWrite", writableRoots: [h.workspace] }
    }));
    await expect(h.child.prompt("干活")).rejects.toThrow(/sandbox 不是 readOnly/u);
  });

  it("starts workspace-write members as read-only threads and authorizes only the turn", async () => {
    const h = harness({ sandbox: "workspace-write" });
    h.server.handlers.set("thread/start", (_params, id, server) => server.reply(id, {
      thread: { id: "thread-abc" },
      cwd: h.workspace,
      approvalPolicy: "never",
      sandbox: { type: "readOnly" }
    }));
    h.server.handlers.set("turn/start", turnStartHandler());
    const run = h.child.prompt("改文件");
    await waitForMethod(h.server, "turn/start");
    completeTurn(h.server);
    await run;
    // 线程姿态：只读 + never（成员上限不是线程权限）。
    expect(h.server.last("thread/start")?.params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never", cwd: h.workspace });
    // 本轮授权：显式的 workspace 沙箱策略（唯一放开写入的地方）。
    expect(h.server.last("turn/start")?.params).toMatchObject({
      cwd: h.workspace,
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [h.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
    });
  });
});
