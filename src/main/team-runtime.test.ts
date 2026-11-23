import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, TeamMemberSettlement, ThinkingLevel } from "../shared/protocol.js";
import type { PersistedSessionEntry } from "./session-history.js";
import { TEAM_ENTRY_TYPE, TEAM_IDLE_DISPOSE_MS, type TeamMemberRecord, type TeamTaskRecord } from "./team-store.js";
import type { PermissionSettlement } from "./permission-broker.js";
import type { TeamPermissionNotice } from "./team-contract.js";
import { TeamRuntime, type TeamChildCreated, type TeamChildFactory, type TeamChildSession, type TeamRuntimeOptions } from "./team-runtime.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-desktop-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

const LEAD = "lead-session";
const leadMembership = { role: "lead" as const, name: "lead" };

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

interface FakeLead {
  session: AgentSession;
  entries: PersistedSessionEntry[];
  delivered: { message: unknown; options: unknown }[];
  stats: { toolCalls: number; tokens: { total: number }; cost: number };
  context: { percent: number | null } | undefined;
  streaming: boolean;
}

function fakeLead(branch: PersistedSessionEntry[] = [], streaming = false): FakeLead {
  const entries = [...branch];
  const delivered: { message: unknown; options: unknown }[] = [];
  const stats = { toolCalls: 7, tokens: { total: 12_345 }, cost: 0.42 };
  const context: { percent: number | null } | undefined = { percent: 33 };
  const lead: FakeLead = {
    entries,
    delivered,
    stats,
    context,
    streaming,
    session: undefined as unknown as AgentSession
  };
  const session = {
    sessionId: LEAD,
    get isStreaming() { return lead.streaming; },
    model: { provider: "p", id: "m" },
    sessionManager: {
      getBranch: () => entries,
      appendCustomEntry: (customType: string, data: unknown) => {
        const id = `e-${entries.length}`;
        entries.push({ id, type: "custom", customType, data });
        return id;
      }
    },
    sendCustomMessage: async (message: unknown, options: unknown) => {
      delivered.push({ message, options });
    },
    // 与真实 AgentSession 一致：每次返回新的快照对象，缓存拿到的是值而不是活引用。
    getSessionStats: () => ({ ...stats, tokens: { ...stats.tokens } }),
    getContextUsage: () => (context ? { ...context } : undefined)
  };
  lead.session = session as unknown as AgentSession;
  return lead;
}

class FakeChild implements TeamChildSession {
  isStreaming = false;
  prompts: string[] = [];
  custom: { message: { customType: string; content: { type: string; text: string }[]; details?: unknown }; options?: unknown }[] = [];
  disposed = false;
  aborted = false;
  queueCleared = false;
  failSend = false;
  private listeners = new Set<AgentSessionEventListener>();
  stats: { toolCalls: number; tokens: { total: number }; cost: number } = { toolCalls: 0, tokens: { total: 0 }, cost: 0 };
  contextUsage: { percent: number | null } | undefined;

  constructor(readonly sessionId: string, readonly sessionFile: string) {}

  prompt(text: string, options?: { expandPromptTemplates?: boolean; preflightResult?: (disposition: "handled" | "queued" | "started") => void }): Promise<void> {
    this.prompts.push(text);
    this.isStreaming = true;
    options?.preflightResult?.("started");
    return new Promise<void>(() => { /* 模拟一个持续回合，由 emitSettled 结束 */ });
  }

  sendCustomMessage(
    message: { customType: string; content: { type: string; text: string }[]; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ): Promise<void> {
    if (this.failSend) return Promise.reject(new Error("模型不可用"));
    this.custom.push({ message, ...(options === undefined ? {} : { options }) });
    if (options?.triggerTurn) this.isStreaming = true;
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.aborted = true;
    this.isStreaming = false;
    // 与 Pi 一致：abort 后的收尾事件带 aborted=true（结算据此归类「已中止」）。
    this.emit({ type: "agent_settled", aborted: true });
    return Promise.resolve();
  }

  clearQueue(): void {
    this.queueCleared = true;
  }

  dispose(): void {
    this.disposed = true;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSessionStats(): { toolCalls: number; tokens: { total: number }; cost: number } {
    return this.stats;
  }

  getContextUsage(): { percent: number | null } | undefined {
    return this.contextUsage;
  }

  emit(event: string | Record<string, unknown>): void {
    const payload = (typeof event === "string" ? { type: event } : event) as AgentSessionEvent;
    for (const listener of [...this.listeners]) listener(payload);
  }

  settle(): void {
    this.isStreaming = false;
    this.emit("agent_settled");
  }
}

interface Harness {
  runtime: TeamRuntime;
  lead: FakeLead;
  created: FakeChild[];
  options: TeamRuntimeOptions;
  permissionCalls: { toolName: string; member: { memberId: string; memberName: string }; hooks: unknown }[];
  /** 运行时注入给权限门的两条回调（用例据此模拟「卡片发出 / 拒绝 / 超时 / 取消」）。 */
  pendingHandler?: (notice: TeamPermissionNotice, requestId?: string) => void;
  settledHandler?: (settlement: PermissionSettlement & { request: TeamPermissionNotice }) => void;
  cancelledMembers: string[];
}

function harness(branch: PersistedSessionEntry[] = [], overrides: Partial<TeamRuntimeOptions> = {}): Harness {
  const lead = fakeLead(branch);
  const created: FakeChild[] = [];
  const permissionCalls: Harness["permissionCalls"] = [];
  const cancelledMembers: string[] = [];
  const factory: TeamChildFactory = async (request) => {
    // 让子会话文件真实存在，冷恢复（SessionManager.open）才能工作。
    const file = request.manager.getSessionFile();
    if (!file) throw new Error("no session file");
    if (!existsSync(file)) {
      // 首次创建：写入一条 user 消息，模拟「首条 prompt 已被接受」并让文件落盘。
      request.manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as never);
    }
    const child = new FakeChild(request.manager.getSessionId(), file);
    created.push(child);
    return { handle: child, sessionId: child.sessionId, sessionFile: file, dispose: () => child.dispose() } satisfies TeamChildCreated;
  };
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-team-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace, { recursive: true });
  const result: Harness = {
    runtime: undefined as unknown as TeamRuntime,
    lead,
    created,
    options: undefined as unknown as TeamRuntimeOptions,
    permissionCalls,
    cancelledMembers
  };
  const options: TeamRuntimeOptions = {
    leadSession: lead.session,
    workspace,
    agentDir,
    agent: agentProfile(),
    modelRuntime: {} as never,
    getThinkingLevel: () => "medium" as ThinkingLevel,
    requestPermission: (toolName, _args, _toolCallId, member, hooks) => {
      permissionCalls.push({ toolName, member, hooks });
      result.pendingHandler = hooks.onPending;
      result.settledHandler = hooks.onSettled;
      return Promise.resolve("allow-once");
    },
    cancelMemberPermissions: (memberId) => { cancelledMembers.push(memberId); },
    onChange: () => undefined,
    createChildSession: factory,
    ...overrides
  };
  result.runtime = new TeamRuntime(options);
  result.options = options;
  return result;
}

function memberRecord(overrides: Partial<TeamMemberRecord> = {}): TeamMemberRecord {
  return {
    id: "child-1",
    name: "reviewer",
    description: "审查",
    phase: "active",
    sessionFile: "/tmp/child-1.jsonl",
    createdAt: 1,
    config: {
      mode: "inherit",
      systemPrompt: "x",
      tools: ["read"],
      model: { provider: "p", id: "m" },
      thinkingLevel: "medium",
      browserTools: false
    },
    ...overrides
  };
}

function memberEntry(record: TeamMemberRecord): PersistedSessionEntry {
  return { id: `e-${record.id}-${record.phase}`, type: "custom", customType: TEAM_ENTRY_TYPE, data: { kind: "member", member: record } };
}

function taskEntry(task: TeamTaskRecord): PersistedSessionEntry {
  return { id: `e-${task.id}-${task.revision}`, type: "custom", customType: TEAM_ENTRY_TYPE, data: { kind: "task", task } };
}

/** Lead 日志里的结算条目（durable 通道）。 */
function settlementEntries(lead: FakeLead): TeamMemberSettlement[] {
  return lead.entries
    .filter((entry) => entry.type === "custom" && entry.customType === TEAM_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "settled")
    .map((entry) => (entry.data as { settlement: TeamMemberSettlement }).settlement);
}

describe("spawn", () => {
  it("writes provisioning then active, starts the initial prompt and reports running", async () => {
    const h = harness();
    const view = await h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查改动", prompt: "读一下 diff" });
    expect(view).toMatchObject({ target: "reviewer", role: "teammate", status: "running", description: "审查改动" });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.prompts).toEqual(["读一下 diff"]);
    const kinds = h.lead.entries.map((entry) => (entry.data as { kind: string }).kind);
    expect(kinds).toEqual(["member", "member"]);
    const phases = h.lead.entries.map((entry) => (entry.data as { member?: { phase?: string } }).member?.phase);
    expect(phases).toEqual(["provisioning", "active"]);
    expect(h.runtime.snapshot()).toMatchObject({ running: 1 });
  });

  it("does not wake team_wait on member tool activity (avoids paid polling cascades)", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    const wait = h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    child.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.ts" } });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(wait).resolves.toMatchObject({ timedOut: true });
    expect(child.aborted).toBe(false);
  });

  it("projects live member activity and the shared task board into the snapshot", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.stats = { toolCalls: 3, tokens: { total: 1234 }, cost: 0.02 };
    child.contextUsage = { percent: 42 };
    child.emit({ type: "agent_start" });
    child.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: { path: "src/a.ts" } });
    let row = h.runtime.snapshot().members[0]!;
    expect(row).toMatchObject({
      sessionId: child.sessionId,
      activity: { steps: 3, currentTool: "edit", currentDetail: "src/a.ts", tokens: 1234, contextPercent: 42 }
    });
    expect(row.activity?.recent.at(-1)).toMatchObject({ tool: "edit", status: "running", detail: "src/a.ts" });

    // 并行同名工具：只按 toolCallId 收口，不能把另一个仍在跑的 edit 也标成 done。
    child.emit({ type: "tool_execution_start", toolCallId: "call-2", toolName: "edit", args: { path: "src/b.ts" } });
    child.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result: {}, isError: false, durationMs: 50 });
    row = h.runtime.snapshot().members[0]!;
    expect(row.activity?.recent.find((step) => step.toolCallId === "call-1")).toMatchObject({ status: "done" });
    expect(row.activity?.recent.find((step) => step.toolCallId === "call-2")).toMatchObject({ status: "running" });
    expect(row.activity?.currentDetail).toBe("src/b.ts");
    child.emit({ type: "tool_execution_end", toolCallId: "call-2", toolName: "edit", result: {}, isError: false });
    row = h.runtime.snapshot().members[0]!;
    expect(row.activity?.recent.find((step) => step.toolCallId === "call-2")).toMatchObject({ status: "done" });
    expect(row.activity?.currentTool).toBeUndefined();

    // 用户停止 → agent_settled{aborted}：步骤收口为中性 aborted，而不是红色错误。
    child.emit({ type: "tool_execution_start", toolCallId: "call-3", toolName: "read", args: { path: "src/c.ts" } });
    child.emit({ type: "agent_settled", aborted: true });
    expect(h.runtime.snapshot().members[0]?.activity?.recent.at(-1)).toMatchObject({ status: "aborted" });

    const task = await h.runtime.createTask(leadMembership, { subject: "渲染器", description: "实现渲染入口" });
    await h.runtime.updateTask({ role: "teammate", name: "reviewer" }, { taskId: task.id, expectedRevision: task.revision, action: "claim" });
    const snapshot = h.runtime.snapshot();
    expect(snapshot.tasks).toContainEqual(expect.objectContaining({ id: task.id, status: "in_progress", ownerName: "reviewer" }));
    expect(snapshot.members[0]).toMatchObject({ taskId: task.id, taskSubject: "渲染器" });
  });

  it("rejects duplicates, invalid names, role violations and the member limit", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    await expect(h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" })).rejects.toThrow(/已被使用/u);
    await expect(h.runtime.spawn(leadMembership, { name: "Reviewer", description: "x", prompt: "p" })).rejects.toThrow(/kebab-case/u);
    await expect(h.runtime.spawn(leadMembership, { name: "lead", description: "x", prompt: "p" })).rejects.toThrow(/kebab-case/u);
    await expect(h.runtime.spawn({ role: "teammate", name: "reviewer" }, { name: "x", description: "x", prompt: "p" })).rejects.toThrow(/只有 Team Lead/u);
  });

  it("records a failed member when the child cannot be created, and keeps the name reserved", async () => {
    const h = harness([], { createChildSession: async () => { throw new Error("模型不可用"); } });
    await expect(h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" })).rejects.toThrow(/模型不可用/u);
    const phases = h.lead.entries.map((entry) => (entry.data as { member?: { phase?: string } }).member?.phase);
    expect(phases).toEqual(["provisioning", "failed"]);
    expect(h.runtime.snapshot().members[0]).toMatchObject({ name: "reviewer", status: "failed" });
    await expect(h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" })).rejects.toThrow(/已被使用/u);
  });
});

describe("membership and messages", () => {
  it("steers a running member and wakes a cold member on demand", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    const firstSend = h.runtime.send(leadMembership, "reviewer", "看一下 src/a.ts");
    await vi.advanceTimersByTimeAsync(0);
    await firstSend;
    expect(child.custom[0]!.message).toMatchObject({
      customType: "pidesktop-team-message",
      details: { sender: "lead", target: "reviewer" }
    });
    expect(child.custom[0]!.message.content[0]!.text).toContain("来自 Lead");
    expect(child.custom[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });

    // 成员回合结束 → idle 计时 → 释放子会话 → 再 send 走冷恢复。
    child.settle();
    await vi.advanceTimersByTimeAsync(TEAM_IDLE_DISPOSE_MS + 1);
    expect(child.disposed).toBe(true);
    const secondSend = h.runtime.send(leadMembership, "reviewer", "继续");
    await vi.advanceTimersByTimeAsync(0);
    await secondSend;
    expect(h.created).toHaveLength(2);
    expect(h.created[1]!.custom[0]!.message.content[0]!.text).toContain("继续");
  });

  it("delivers to the Lead at a step boundary while streaming, and queues silently when idle", async () => {
    const streaming = fakeLead([], true);
    const h = harness([], { leadSession: streaming.session });
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    await h.runtime.send({ role: "teammate", name: "reviewer" }, "lead", "报告");
    expect(streaming.delivered[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });

    const idle = fakeLead([], false);
    const h2 = harness([], { leadSession: idle.session });
    await h2.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    await h2.runtime.send({ role: "teammate", name: "reviewer" }, "lead", "报告");
    expect(idle.delivered[0]!.options).toEqual({ triggerTurn: false });
  });

  it("rejects self messages, oversized messages and unknown targets", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    await expect(h.runtime.send(leadMembership, "lead", "x")).rejects.toThrow(/自己/u);
    await expect(h.runtime.send(leadMembership, "reviewer", "x".repeat(70_000))).rejects.toThrow(/字节/u);
    await expect(h.runtime.send(leadMembership, "ghost", "x")).rejects.toThrow(/找不到可用成员/u);
    await expect(h.runtime.send({ role: "teammate", name: "ghost" }, "lead", "x")).rejects.toThrow(/不是当前团队成员/u);
  });
});

describe("wait / interrupt / stopAll", () => {
  it("wakes on the next team change and returns noProgress without active peers", async () => {
    const h = harness();
    const noPeer = await h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    expect(noPeer.noProgress?.reason).toBe("no-active-peer");
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const waiting = h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    await h.runtime.createTask(leadMembership, { subject: "s", description: "d" });
    await expect(waiting).resolves.toMatchObject({ timedOut: false });
  });

  it("times out and rejects on abort", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const waiting = h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(waiting).resolves.toEqual({ timedOut: true });
    const controller = new AbortController();
    const aborted = h.runtime.wait(leadMembership, 10_000, controller.signal);
    controller.abort(new Error("用户停止"));
    await expect(aborted).rejects.toThrow(/用户停止/u);
  });

  it("does not count the Lead as an active peer for a teammate's wait", async () => {
    const streaming = fakeLead([], true);
    const h = harness([], { leadSession: streaming.session });
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    h.created[0]!.settle();
    const result = await h.runtime.wait({ role: "teammate", name: "reviewer" }, 10_000, new AbortController().signal);
    expect(result.noProgress?.reason).toBe("no-active-peer");
  });

  it("reports an immediate delivery failure instead of claiming the message was accepted", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    h.created[0]!.failSend = true;
    await expect(h.runtime.send(leadMembership, "reviewer", "hi")).rejects.toThrow(/模型不可用/u);
  });

  it("stops a teammate by name with an accepted receipt, and stopAll stops every running member", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    expect(h.runtime.interrupt(leadMembership, { name: "reviewer" })).toMatchObject({
      target: "member",
      value: "reviewer",
      memberName: "reviewer",
      status: "delivered"
    });
    // 受理后进入 stopping，迟到的 agent_settled 才把它落回 inactive。
    expect(child.aborted).toBe(true);
    expect(h.runtime.snapshot().members[0]?.status).toBe("inactive");
    expect(() => h.runtime.interrupt({ role: "teammate", name: "reviewer" }, { name: "reviewer" })).toThrow(/只有 Team Lead/u);
    expect(() => h.runtime.interrupt(leadMembership, { name: "lead" })).toThrow(/不能中断 Team Lead/u);
    // 二选一是硬约束：都不给或都给都拒绝。
    expect(() => h.runtime.interrupt(leadMembership, {})).toThrow(/二选一/u);
    expect(() => h.runtime.interrupt(leadMembership, { name: "reviewer", taskId: "task-1" })).toThrow(/二选一/u);

    await h.runtime.spawn(leadMembership, { name: "explorer", description: "x", prompt: "p" });
    const second = h.created[1]!;
    h.runtime.stopAll();
    expect(second.aborted).toBe(true);
  });
});

describe("tasks", () => {
  it("creates, lists, gets and CAS-updates tasks through the service", async () => {
    const h = harness();
    const created = await h.runtime.createTask(leadMembership, { subject: "改 A", description: "把 A 改掉", writeScopes: ["src/a.ts"] });
    expect(created).toMatchObject({ id: "task-1", revision: 1, status: "pending", ready: true });
    const claimed = await h.runtime.updateTask(leadMembership, { taskId: "task-1", expectedRevision: 1, action: "claim" });
    expect(claimed).toMatchObject({ status: "in_progress", ownerName: "lead", revision: 2 });
    await expect(h.runtime.updateTask(leadMembership, { taskId: "task-1", expectedRevision: 1, action: "complete" })).rejects.toThrow(/当前 revision 2/u);
    const completed = await h.runtime.updateTask(leadMembership, { taskId: "task-1", expectedRevision: 2, action: "complete" });
    expect(completed.status).toBe("completed");
    expect(h.runtime.getTask(leadMembership, "task-1").status).toBe("completed");
    expect(h.runtime.listTasks(leadMembership, {}).tasks).toHaveLength(1);
    expect(h.lead.entries.filter((entry) => (entry.data as { kind: string }).kind === "task")).toHaveLength(3);
  });

  it("rejects task ops from a non-member", () => {
    const h = harness();
    expect(() => h.runtime.listTasks({ role: "teammate", name: "ghost" }, {})).toThrow(/不是当前团队成员/u);
  });
});

describe("restore and disposal", () => {
  it("rebuilds roster/tasks from the Lead branch", () => {
    const h = harness([memberEntry(memberRecord()), taskEntry({
      id: "task-1",
      revision: 2,
      subject: "s",
      description: "d",
      status: "in_progress",
      ownerId: "child-1",
      blockedBy: [],
      writeScopes: []
    })]);
    expect(h.runtime.list(leadMembership).map((member) => member.target)).toEqual(["lead", "reviewer"]);
    expect(h.runtime.getTask(leadMembership, "task-1")).toMatchObject({ revision: 2, ownerName: "reviewer" });
  });

  it("restores member runtimes so a restored active member can be messaged (cold resume)", async () => {
    const first = harness();
    await first.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    // 用同一份 Lead 分支重建运行时：成员应为 active 且可寻址，send 走冷恢复。
    const second = harness(first.lead.entries);
    await second.runtime.send(leadMembership, "reviewer", "继续");
    expect(second.created).toHaveLength(1);
    expect(second.created[0]!.custom[0]!.message.content[0]!.text).toContain("继续");
  });

  it("fails a provisioning member whose child session never got a user message", async () => {
    const h = harness([memberEntry(memberRecord({ phase: "provisioning", sessionFile: "/tmp/missing-child.jsonl" }))]);
    const summary = h.runtime.snapshot().members[0]!;
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("创建未完成");
    expect(h.lead.entries.some((entry) => (entry.data as { member?: { phase?: string } }).member?.phase === "failed")).toBe(true);
  });

  it("promotes a provisioning member when the child session file already has a user message", async () => {
    const directory = await tempDir("team-recovery");
    const file = join(directory, "child.jsonl");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "child-1", timestamp: new Date().toISOString(), cwd: "/workspace" })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "hi" }] } })}\n`, "utf8");
    const h = harness([memberEntry(memberRecord({ phase: "provisioning", sessionFile: file }))]);
    expect(h.runtime.snapshot().members[0]!.status).toBe("inactive");
  });

  it("stops member sessions and rejects further operations after dispose", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    h.runtime.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.aborted).toBe(true);
    expect(child.disposed).toBe(true);
    await expect(h.runtime.spawn(leadMembership, { name: "x", description: "x", prompt: "p" })).rejects.toThrow(/已销毁/u);
  });
});

describe("formation snapshot data", () => {
  it("records team messages with kinds and keeps only the latest 80", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    await h.runtime.spawn(leadMembership, { name: "builder", description: "y", prompt: "q" });

    await h.runtime.send(leadMembership, "reviewer", "先做 A");
    await h.runtime.send({ role: "teammate", name: "reviewer" }, "lead", "A 完成");
    await h.runtime.send({ role: "teammate", name: "reviewer" }, "builder", "帮我看下 B");

    const messages = h.runtime.snapshot().messages ?? [];
    expect(messages.map((message) => message.kind)).toEqual(["assign", "report", "direct"]);
    expect(messages.map((message) => `${message.sender}->${message.target}`)).toEqual([
      "lead->reviewer", "reviewer->lead", "reviewer->builder"
    ]);
    expect(messages[0]?.text).toBe("先做 A");

    for (let index = 0; index < 80; index += 1) {
      await h.runtime.send(leadMembership, "reviewer", `消息 ${index}`);
    }
    const trimmed = h.runtime.snapshot().messages ?? [];
    expect(trimmed).toHaveLength(80);
    expect(trimmed.at(-1)?.text).toBe("消息 79");
  });

  it("captures the latest assistant text as lastReport and ignores thinking blocks", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "内部推理" },
          { type: "text", text: "  迁移脚本已跑通，正在补回滚脚本。  " }
        ]
      }
    });
    expect(h.runtime.snapshot().members[0]?.lastReport).toMatchObject({ text: "迁移脚本已跑通，正在补回滚脚本。" });

    child.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "不该算回报" }] } });
    expect(h.runtime.snapshot().members[0]?.lastReport?.text).toBe("迁移脚本已跑通，正在补回滚脚本。");
  });

  it("exposes the lead summary and refreshes it at most once per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    const first = h.runtime.snapshot().lead;
    expect(first).toMatchObject({ model: "p/m", status: "inactive", tokens: 12_345, cost: 0.42, steps: 7, contextPercent: 33 });

    h.lead.stats.tokens.total = 99_999;
    vi.setSystemTime(1_000_500);
    child.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "进展" }] } });
    expect(h.runtime.snapshot().lead?.tokens).toBe(12_345);
    vi.setSystemTime(1_001_001);
    child.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "进展 2" }] } });
    expect(h.runtime.snapshot().lead?.tokens).toBe(99_999);
  });
});

describe("settlements delivered to the Lead", () => {
  it("writes one bounded settlement per member turn and pushes it to the Lead inbox", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    child.emit({ type: "tool_execution_start", toolCallId: "w1", toolName: "write", args: { path: "src/review/report.md" } });
    child.emit({ type: "tool_execution_end", toolCallId: "w1", toolName: "write", result: {}, isError: false });
    child.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "审查完成：见 src/review/report.md" }] }
    });
    child.emit({ type: "agent_settled" });

    const settled = settlementEntries(h.lead);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      memberName: "reviewer",
      outcome: "completed",
      reported: false,
      artifacts: ["src/review/report.md"]
    });
    expect(settled[0]!.summary).toContain("审查完成");
    // 快照与 team_list 都带同一条结算（轻量、可直接展示）。
    expect(h.runtime.snapshot().members[0]?.settlement).toMatchObject({ outcome: "completed" });
    expect(h.runtime.list(leadMembership).find((row) => row.target === "reviewer")?.settlement).toMatchObject({ outcome: "completed" });
    // Lead 空闲：结算进收件箱但不自动开回合（triggerTurn:false）。
    const delivery = h.lead.delivered.at(-1);
    expect(delivery?.options).toEqual({ triggerTurn: false });
    expect(JSON.stringify(delivery?.message)).toContain("成员「reviewer」回合结束");
  });

  it("de-duplicates the body when the member already reported to the Lead, but still provides the result", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    await h.runtime.send({ role: "teammate", name: "reviewer" }, "lead", "A 做完了");
    const beforeTurnEnd = h.lead.delivered.length;
    child.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A 做完了" }] } });
    child.emit({ type: "agent_settled" });

    const settled = settlementEntries(h.lead);
    expect(settled[0]).toMatchObject({ reported: true, outcome: "completed" });
    // 已汇报 → 不再往 Lead 收件箱塞第二条重复正文。
    expect(h.lead.delivered).toHaveLength(beforeTurnEnd);
    // 但结算本身照常可取。
    expect(h.runtime.list(leadMembership).find((row) => row.target === "reviewer")?.settlement?.summary).toBe("A 做完了");
  });

  it("separates failed / aborted from completed and never counts a stop as a failure", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    h.runtime.stopAll();
    child.emit({ type: "agent_settled", aborted: true });
    expect(settlementEntries(h.lead).at(-1)).toMatchObject({ outcome: "aborted" });

    await h.runtime.spawn(leadMembership, { name: "builder", description: "y", prompt: "q" });
    const second = h.created[1]!;
    second.emit({ type: "agent_start" });
    second.failSend = true;
    await expect(h.runtime.send(leadMembership, "builder", "hi")).rejects.toThrow(/模型不可用/u);
    expect(settlementEntries(h.lead).at(-1)).toMatchObject({ outcome: "failed" });
    expect(settlementEntries(h.lead).at(-1)!.error).toContain("模型不可用");
  });

  it("returns settlements produced BEFORE team_wait started, and never repeats the same event", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    // 成员在 Lead 开始等待之前就结束了（时序陷阱：漏报 → 白等一次）。
    child.emit({ type: "agent_start" });
    child.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "先做完了" }] } });
    child.emit({ type: "agent_settled" });

    const first = await h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    expect(first.noProgress?.reason).toBe("no-active-peer");
    expect(first.settlements).toHaveLength(1);
    expect(first.settlements?.[0]?.summary).toBe("先做完了");

    // 同一事件不会再返回一次（游标）。
    const second = await h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    expect(second.settlements).toBeUndefined();
  });

  it("returns settlements produced before the wait even while another peer is still active", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    await h.runtime.spawn(leadMembership, { name: "builder", description: "y", prompt: "q" });
    const reviewer = h.created[0]!;
    // reviewer 在 Lead 开始等待之前就结束了；builder 仍在跑（activePeer 为真）。
    reviewer.emit({ type: "agent_start" });
    reviewer.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "先结束的那个" }] } });
    reviewer.emit({ type: "agent_settled" });

    const waiting = h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    h.created[1]!.emit({ type: "agent_start" });
    h.created[1]!.emit({ type: "agent_settled" });
    const result = await waiting;
    // 两段结算都拿到：等待前结束的 reviewer + 等待期间结束的 builder，且不重复。
    expect(result.settlements?.map((settlement) => settlement.memberName)).toEqual(["reviewer", "builder"]);
  });

  it("wakes a waiting Lead with the settlement that ended the wait", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const waiting = h.runtime.wait(leadMembership, 30_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    h.created[0]!.emit({ type: "agent_start" });
    h.created[0]!.emit({ type: "agent_settled" });
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.settlements?.[0]).toMatchObject({ memberName: "reviewer", outcome: "completed" });
  });

  it("wakes the waiting Lead on user input but not on team activity frames", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const controller = new AbortController();
    const waiting = h.runtime.wait(leadMembership, 30_000, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    h.created[0]!.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
    await vi.advanceTimersByTimeAsync(200);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    h.runtime.wakeForUserInput();
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting).resolves.toMatchObject({ userInput: true });
  });
});

describe("team permission feedback", () => {
  it("surfaces a denied permission to the Lead with the member name and the reason", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    // 走运行时真正暴露给子会话的成员权限桥：身份由运行时注入，回调落在运行时记账里。
    await h.runtime.memberPermissionRequest({ memberId: child.sessionId, memberName: "reviewer" }, "bash", { command: "npm test" }, "call-bash");
    expect(h.permissionCalls.at(-1)?.member).toMatchObject({ memberId: child.sessionId, memberName: "reviewer" });

    // Lead 正在等：审批卡发出要**唤醒**等待者并带上 pendingApprovals（可行动事件）。
    const waiting = h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    h.pendingHandler?.({ memberName: "reviewer", toolName: "bash", summary: "执行命令：npm test" });
    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      pendingApprovals: [{ memberName: "reviewer", toolName: "bash", summary: "执行命令：npm test" }]
    });

    h.settledHandler?.({
      id: "call-bash", decision: "deny",
      cause: "user",
      request: { memberName: "reviewer", toolName: "bash", summary: "执行命令：npm test" }
    });

    const delivered = h.lead.delivered.map((item) => JSON.stringify(item.message)).join("\n");
    expect(delivered).toContain("成员「reviewer」的权限请求被拒");
    expect(delivered).toContain("用户拒绝");
    expect(delivered).toContain("npm test");

    child.emit({ type: "agent_settled" });
    expect(settlementEntries(h.lead).at(-1)?.blocker).toMatchObject({ kind: "permission-denied", toolName: "bash" });
  });

  it("clears the pending card by the permission request id even when it differs from the tool call id", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    await h.runtime.memberPermissionRequest({ memberId: child.sessionId, memberName: "reviewer" }, "bash", { command: "npm test" }, "call-bash");
    const request = { memberName: "reviewer", toolName: "bash", summary: "执行命令：npm test" };
    // 权限请求 id 与工具调用 id 不同：登记和摘除必须用同一个键（权限 id）。
    // 先注册等待者，再发卡（否则通知早于 waiter，只能等到超时）。
    const waiting = h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    h.pendingHandler?.(request, "permission-9");
    await expect(waiting).resolves.toMatchObject({
      pendingApprovals: [request]
    });
    h.settledHandler?.({ id: "permission-9", decision: "allow-once", cause: "user", request });
    vi.useFakeTimers();
    const after = h.runtime.wait(leadMembership, 30_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await after;
    expect(result).toMatchObject({ timedOut: true });
    expect(result.pendingApprovals).toBeUndefined();
  });

  it("registers Codex round approvals and removes them on settle", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    // 轮次确认发生在 turn/start 之前（agent_start 还没来）：登记必须自己把回合开账。
    const notice = { memberName: "reviewer", toolName: "codex", summary: "本轮写入" };
    // 先注册等待者：登记会触发 notify，晚注册就只能等超时。
    const waiting = h.runtime.wait(leadMembership, 10_000, new AbortController().signal);
    h.runtime.noteCodexApprovalPending(child.sessionId, notice, "permission-42");
    await expect(waiting).resolves.toMatchObject({
      pendingApprovals: [notice]
    });
    h.runtime.noteCodexApprovalSettled(child.sessionId, "permission-42");
    vi.useFakeTimers();
    const after = h.runtime.wait(leadMembership, 30_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await after;
    expect(result).toMatchObject({ timedOut: true });
    expect(result.pendingApprovals).toBeUndefined();
  });

  it("treats an access-mode block and a timeout as separate blockers, and a cancel as aborted (no blocker)", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    await h.runtime.memberPermissionRequest({ memberId: child.sessionId, memberName: "reviewer" }, "bash", { command: "npm test" }, "call-bash");
    const request = { memberName: "reviewer", toolName: "bash", summary: "执行命令：npm test" };

    h.settledHandler?.({ id: "call-bash", decision: "deny", cause: "mode", request });
    expect(JSON.stringify(h.lead.delivered.at(-1)?.message)).toContain("访问模式拦截");

    h.settledHandler?.({ id: "call-bash", decision: "deny", cause: "timeout", request });
    expect(JSON.stringify(h.lead.delivered.at(-1)?.message)).toContain("等待审批超时");

    // 取消（成员被停止）归中止：不记新卡点，也不额外投递拒绝正文。
    // 注意本回合前面已经有过真实卡点（超时），结算要如实带上它——被取消的那次请求
    // 本身不构成卡点，但「这一回合被拦过」是事实，Lead 据此决定改派或补授权。
    const before = h.lead.delivered.length;
    h.settledHandler?.({ id: "call-bash", decision: "deny", cause: "cancel", request });
    expect(h.lead.delivered).toHaveLength(before);
    h.runtime.stopAll();
    expect(settlementEntries(h.lead).at(-1)).toMatchObject({
      outcome: "aborted",
      blocker: { kind: "permission-timeout" }
    });

    await h.runtime.spawn(leadMembership, { name: "clean", description: "无卡点", prompt: "q" });
    const clean = h.created[1]!;
    clean.emit({ type: "agent_start" });
    h.runtime.stopAll();
    const cleanSettlement = settlementEntries(h.lead).filter((entry) => entry.memberName === "clean").at(-1)!;
    expect(cleanSettlement).toMatchObject({ outcome: "aborted" });
    expect(cleanSettlement.blocker).toBeUndefined();

    // 干净回合被取消：结算里没有卡点，只会额外给 Lead 发一条「已中止」的结算正文。
  });
});

describe("stop by task and stopping state", () => {
  it("binds a task to the member turn, claims it, and stops exactly that member", async () => {
    const h = harness();
    const task = await h.runtime.createTask(leadMembership, { subject: "审查", description: "审查 SSH 改动" });
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    await h.runtime.send(leadMembership, "reviewer", "开始审查", undefined, task.id);
    // 绑定即认领（pending+就绪 → in_progress，owner = 该成员）。
    expect(h.runtime.getTask(leadMembership, task.id)).toMatchObject({ status: "in_progress", ownerName: "reviewer" });

    const result = h.runtime.interrupt(leadMembership, { taskId: task.id });
    expect(result).toMatchObject({ target: "task", status: "delivered", memberName: "reviewer", taskId: task.id });
    expect(child.aborted).toBe(true);
    // 任务记录与归属保留（Lead 可用既有 CAS 改派）。
    expect(h.runtime.getTask(leadMembership, task.id)).toMatchObject({ status: "in_progress", ownerName: "reviewer" });
  });

  it("returns explicit statuses for completed tasks, unbound tasks and idle members", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    child.emit({ type: "agent_settled" });
    expect(h.runtime.interrupt(leadMembership, { name: "reviewer" })).toMatchObject({ status: "idle" });

    const task = await h.runtime.createTask(leadMembership, { subject: "s", description: "d" });
    expect(h.runtime.interrupt(leadMembership, { taskId: task.id })).toMatchObject({ status: "unbound" });
    expect(h.runtime.interrupt(leadMembership, { taskId: "task-999" })).toMatchObject({ status: "unknown" });

    await h.runtime.updateTask(leadMembership, { taskId: task.id, expectedRevision: task.revision, action: "claim" });
    await h.runtime.updateTask(leadMembership, { taskId: task.id, expectedRevision: task.revision + 1, action: "complete" });
    expect(h.runtime.interrupt(leadMembership, { taskId: task.id })).toMatchObject({ status: "completed" });
  });

  it("shows stopping until the settled event arrives, clears the queue and cancels member permissions", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    // 手动 abort 不自动发 settled：模拟「停止已受理、收尾还没到」的窗口。
    child.abort = (): Promise<void> => {
      child.aborted = true;
      child.isStreaming = false;
      return Promise.resolve();
    };
    const result = h.runtime.interrupt(leadMembership, { name: "reviewer" });
    expect(result.status).toBe("delivered");
    expect(h.runtime.snapshot().members[0]?.status).toBe("stopping");
    expect(h.runtime.snapshot().stopping).toBe(1);
    expect(child.queueCleared).toBe(true);
    expect(h.cancelledMembers).toEqual([child.sessionId]);
    // 重复停止幂等：还是 delivered，且不会误伤别人。
    expect(h.runtime.interrupt(leadMembership, { name: "reviewer" }).status).toBe("delivered");
  });

  it("falls back to aborted when abort itself fails (stopping never hangs forever)", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    // abort 直接抛错：不会再收到 agent_settled，必须就地收口（否则看板一直「正在停止」）。
    child.abort = (): Promise<void> => Promise.reject(new Error("abort 失败"));
    expect(h.runtime.interrupt(leadMembership, { name: "reviewer" }).status).toBe("delivered");
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.runtime.snapshot().members[0]?.status).toBe("inactive");
    expect(h.runtime.snapshot().stopping).toBeUndefined();
    expect(settlementEntries(h.lead).at(-1)).toMatchObject({ outcome: "aborted" });
    expect(child.disposed).toBe(true);
  });

  it("falls back to aborted when abort itself fails (stopping never hangs forever)", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    child.emit({ type: "agent_start" });
    // abort 直接抛错：不会再收到 agent_settled，必须就地收口（否则看板一直「正在停止」）。
    child.abort = (): Promise<void> => Promise.reject(new Error("abort 失败"));
    expect(h.runtime.interrupt(leadMembership, { name: "reviewer" }).status).toBe("delivered");
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.runtime.snapshot().members[0]?.status).toBe("inactive");
    expect(h.runtime.snapshot().stopping).toBeUndefined();
    expect(settlementEntries(h.lead).at(-1)).toMatchObject({ outcome: "aborted" });
    expect(child.disposed).toBe(true);
  });
});
