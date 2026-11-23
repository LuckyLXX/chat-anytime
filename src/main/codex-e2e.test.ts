import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, TeamMemberSettlement, ThinkingLevel } from "../shared/protocol.js";
import type { PersistedSessionEntry } from "./session-history.js";
import type { RuntimeCommand } from "../shared/protocol.js";
import { CodexProcessSupervisor } from "./codex-process.js";
import { CodexProcessBridge } from "./codex-process-client.js";
import { CodexTeamBackend, probeCodexConnection } from "./runtime-codex.js";
import { TeamRuntime, type TeamRuntimeOptions } from "./team-runtime.js";
import { TEAM_ENTRY_TYPE, codexThreadBindingPath } from "./team-store.js";

/**
 * 端到端：真进程 + 真监管 + 真 JSONL 协议 + 真团队编排（零网络、零真实账号）。
 *
 * 假 Codex 进程（一个 Node 脚本）按 0.146.0/0.171.0 schema 的字段回帧；它验证的是
 * 「真机才会露出来的东西」：npm shim 解析、stdio 分帧、通知/响应乱序、回合终止、
 * 停止后的进程回收、线程绑定的落盘与冷恢复。
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows 上子进程可能还有短暂占用：忽略。
    }
  }
});

const FAKE_SERVER = `
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.171.0\\n");
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let turnSeq = 0;
let activeTurn = null;
let threadId = "thread-e2e";
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") { send({ id: msg.id, result: { userAgent: "pidesktop-fake/0.171.0", codexHome: "/codex-home", platformFamily: "unix", platformOs: process.platform } }); return; }
  if (msg.method === "account/read") { send({ id: msg.id, result: { account: null, requiresOpenaiAuth: false } }); return; }
  if (msg.method === "windowsSandbox/readiness") { send({ id: msg.id, result: { status: "ready" } }); return; }
  if (msg.method === "config/read") { send({ id: msg.id, result: { config: { features: { hooks: false, apps: false, plugins: false }, mcp_servers: {}, notify: [] } } }); return; }
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: threadId, cliVersion: "0.171.0" }, model: "fake-model", modelProvider: "custom" } }); return; }
  if (msg.method === "thread/resume") { threadId = msg.params.threadId; send({ id: msg.id, result: { thread: { id: threadId } } }); return; }
  if (msg.method === "turn/start") {
    const text = (msg.params.input || []).map((i) => i.text || "").join("\\n");
    turnSeq += 1;
    const turn = "turn-" + turnSeq;
    activeTurn = turn;
    send({ id: msg.id, result: { turn: { id: turn, status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turn, status: "inProgress" } } });
    if (text.includes("[slow]")) return;
    send({ method: "item/started", params: { threadId, turnId: turn, startedAtMs: Date.now(), item: { id: "cmd-" + turn, type: "commandExecution", command: "echo " + text.slice(0, 40), status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId, turnId: turn, completedAtMs: Date.now(), item: { id: "cmd-" + turn, type: "commandExecution", command: "echo " + text.slice(0, 40), status: "completed" } } });
    if (text.includes("[ok]")) {
      send({ method: "item/completed", params: { threadId, turnId: turn, item: { id: "change-" + turn, type: "fileChange", status: "completed", changes: [{ path: require("node:path").join(msg.params.cwd, "src", "result.ts") }, { path: "notes.md" }, { path: "../outside.txt" }] } } });
    }
    send({ method: "item/completed", params: { threadId, turnId: turn, completedAtMs: Date.now(), item: { id: "msg-" + turn, type: "agentMessage", text: "完成：" + text.slice(0, 60) } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turn, status: "completed" } } });
    activeTurn = null;
    return;
  }
  if (msg.method === "turn/steer") {
    send({ id: msg.id, result: { turnId: msg.params.expectedTurnId } });
    send({ method: "item/completed", params: { threadId, turnId: msg.params.expectedTurnId, completedAtMs: Date.now(), item: { id: "msg-steer", type: "agentMessage", text: "已追加：" + (msg.params.input || []).map((i) => i.text || "").join(" ").slice(0, 40) } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: msg.params.expectedTurnId, status: "completed" } } });
    activeTurn = null;
    return;
  }
  if (msg.method === "turn/interrupt") {
    send({ id: msg.id, result: {} });
    if (activeTurn) send({ method: "turn/completed", params: { threadId, turn: { id: activeTurn, status: "interrupted" } } });
    activeTurn = null;
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`;

/** 造一条真能被 spawn 的「codex」入口：Windows 走 npm shim，POSIX 走 shebang 脚本。 */
function installFakeCodex(root: string): string {
  if (process.platform === "win32") {
    const bin = join(root, "node_modules", "@openai", "codex", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex.js"), `${FAKE_SERVER}\n`, "utf8");
    const shim = join(root, "codex.cmd");
    writeFileSync(shim, "@ECHO off\r\n\"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n", "utf8");
    return shim;
  }
  const entry = join(root, "codex");
  writeFileSync(entry, `#!/usr/bin/env node\n${FAKE_SERVER}\n`, "utf8");
  chmodSync(entry, 0o755);
  return entry;
}

interface Env {
  root: string;
  workspace: string;
  agentDir: string;
  executable: string;
  supervisor: CodexProcessSupervisor;
  bridge: CodexProcessBridge;
  backend: CodexTeamBackend;
  createRuntime(entries: PersistedSessionEntry[]): { runtime: TeamRuntime; entries: PersistedSessionEntry[]; lead: AgentSession };
  settlements(entries: PersistedSessionEntry[]): TeamMemberSettlement[];
}

function environment(): Env {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-codex-e2e-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace, { recursive: true });
  const executable = installFakeCodex(join(root, "cli"));
  let bridge!: CodexProcessBridge;
  const supervisor = new CodexProcessSupervisor({
    onEvent: (handle, event) => {
      void bridge.handleMessage({ type: "codex.process.event", handle, event });
    }
  });
  bridge = new CodexProcessBridge({
    post: (message) => {
      if (message.type === "codex.process.start") {
        void supervisor.start(message.handle, message.options).then(
          (result) => {
            void bridge.handleMessage({
              type: "codex.process.start-result",
              requestId: message.requestId,
              ok: true,
              ...(result.pid === undefined ? {} : { pid: result.pid })
            });
          },
          (error: unknown) => {
            void bridge.handleMessage({
              type: "codex.process.start-result",
              requestId: message.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        );
        return;
      }
      if (message.type === "codex.process.write") {
        supervisor.write(message.handle, message.data);
        return;
      }
      if (message.type === "codex.process.stop") supervisor.stop(message.handle, message.reason);
    }
  });
  const backend = new CodexTeamBackend({
    readConfig: () => ({ enabled: true, access: "read-only", executable }),
    startProcess: (options) => bridge.start(options)
  });
  const settlements = (entries: PersistedSessionEntry[]): TeamMemberSettlement[] => entries
    .filter((entry) => entry.type === "custom" && entry.customType === TEAM_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "settled")
    .map((entry) => (entry.data as { settlement: TeamMemberSettlement }).settlement);
  const createRuntime = (initial: PersistedSessionEntry[]): { runtime: TeamRuntime; entries: PersistedSessionEntry[]; lead: AgentSession } => {
    const entries = [...initial];
    const lead = {
      sessionId: "lead-e2e",
      isStreaming: false,
      model: { provider: "p", id: "m" },
      sessionManager: {
        getBranch: () => entries,
        appendCustomEntry: (customType: string, data: unknown) => {
          entries.push({ id: `e-${entries.length}`, type: "custom", customType, data });
          return `e-${entries.length}`;
        }
      },
      sendCustomMessage: async () => undefined,
      getSessionStats: () => ({ toolCalls: 0, tokens: { total: 0 }, cost: 0 })
    } as unknown as AgentSession;
    const options: TeamRuntimeOptions = {
      leadSession: lead,
      workspace,
      agentDir,
      agent: agentProfile(),
      modelRuntime: {} as never,
      getThinkingLevel: () => "medium" as ThinkingLevel,
      requestPermission: () => Promise.resolve("allow-once"),
      onChange: () => undefined,
      codex: backend
    };
    return { runtime: new TeamRuntime(options), entries, lead };
  };
  return { root, workspace, agentDir, executable, supervisor, bridge, backend, createRuntime, settlements };
}

function agentProfile(): AgentProfile {
  return {
    id: "agent-1",
    name: "测试助手",
    description: "",
    systemPrompt: "你是测试助手",
    divMode: "auto",
    defaultThinkingLevel: "medium",
    tools: { read: true, bash: true, edit: true, write: true, powershell: false } as AgentProfile["tools"]
  };
}

async function waitFor(predicate: () => boolean, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const leadMembership = { role: "lead" as const, name: "lead" };

describe("codex e2e (real fake process)", () => {
  it("spawns a Codex member, settles its turn and persists the thread binding", async () => {
    const env = environment();
    const { runtime, entries } = env.createRuntime([]);
    const view = await runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看下改动 [ok]", backend: "codex" });
    expect(view).toMatchObject({ target: "reviewer", role: "teammate", backend: "codex" });
    // 不对瞬时 status 做断言：假进程可能已经把这一轮跑完（running → inactive 的先后
    // 取决于 stdout 分块），断言它只会让 e2e 变成随机失败。用结算钉「这一轮真的跑过」。
    await waitFor(() => env.settlements(entries).length === 1);
    const settlement = env.settlements(entries)[0]!;
    expect(settlement).toMatchObject({ memberName: "reviewer", outcome: "completed" });
    expect(settlement.summary).toContain("完成：");
    expect(settlement.artifacts).toEqual(["src/result.ts", "notes.md"]);
    const teamDir = join(env.agentDir, "chatanytime-sessions", "agent-1", "delegations", "teams", "lead-e2e");
    const bindingFile = codexThreadBindingPath(teamDir, memberIdOf(entries));
    expect(existsSync(bindingFile)).toBe(true);
    const binding = JSON.parse(readFileSync(bindingFile, "utf8")) as Record<string, unknown>;
    expect(binding).toMatchObject({ threadId: "thread-e2e", workspace: env.workspace, sandbox: "read-only" });
    const snapshot = runtime.snapshot();
    expect(snapshot.members[0]).toMatchObject({ name: "reviewer", backend: "codex", status: "inactive" });
    expect(snapshot.members[0]!.activity?.steps ?? 0).toBeGreaterThan(0);
    runtime.dispose();
    await waitFor(() => env.supervisor.size() === 0);
  });

  it("stops a running member via turn/interrupt and reclaims the process", async () => {
    const env = environment();
    const { runtime, entries } = env.createRuntime([]);
    await runtime.spawn(leadMembership, { name: "slow", description: "长任务", prompt: "[slow] 长任务", backend: "codex" });
    await waitFor(() => runtime.snapshot().members[0]?.status === "running");
    const result = runtime.interrupt(leadMembership, { name: "slow" });
    expect(result.status).toBe("delivered");
    await waitFor(() => env.settlements(entries).length === 1);
    expect(env.settlements(entries)[0]).toMatchObject({ outcome: "aborted" });
    runtime.dispose();
    await waitFor(() => env.supervisor.size() === 0);
  });

  it("cold-resumes the same Codex thread after the runtime is rebuilt", async () => {
    const env = environment();
    const first = env.createRuntime([]);
    await first.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "第一轮", backend: "codex" });
    await waitFor(() => env.settlements(first.entries).length === 1);
    first.runtime.dispose();
    await waitFor(() => env.supervisor.size() === 0);

    // 用同一份 Lead 日志重建运行时（成员记录与 thread 绑定都还在）。
    const second = env.createRuntime(first.entries);
    await second.runtime.send(leadMembership, "reviewer", "第二轮");
    await waitFor(() => env.settlements(second.entries).length === 2);
    expect(env.settlements(second.entries)[1]).toMatchObject({ outcome: "completed" });
    expect(env.settlements(second.entries)[1]!.summary).toContain("完成：");
    second.runtime.dispose();
    await waitFor(() => env.supervisor.size() === 0);
  });

  it("handshakes the real process for the connection test (version + auth, no model call)", async () => {
    const env = environment();
    const result = await probeCodexConnection({
      config: { enabled: true, access: "read-only", executable: env.executable },
      startProcess: (options) => env.bridge.start(options),
      cwd: env.workspace
    });
    expect(result).toMatchObject({ ok: true, state: "ok", version: "codex-cli 0.171.0", auth: { state: "not-required" } });
    await waitFor(() => env.supervisor.size() === 0);
    env.supervisor.shutdown();
  });
});

function memberIdOf(entries: PersistedSessionEntry[]): string {
  const member = entries
    .filter((entry) => entry.type === "custom" && entry.customType === TEAM_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "member")
    .map((entry) => (entry.data as { member: { id: string } }).member)
    .pop();
  if (!member) throw new Error("member not recorded");
  return member.id;
}

/** 类型占位：确保 RuntimeCommand 里的 codex 分支与 main/utility 的用法一致。 */
export type CodexBridgeCommand = Extract<RuntimeCommand, { type: "codex.process.event" | "codex.process.start-result" }>;
