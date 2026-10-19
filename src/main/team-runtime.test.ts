import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, ThinkingLevel } from "../shared/protocol.js";
import type { PersistedSessionEntry } from "./session-history.js";
import { TEAM_ENTRY_TYPE, TEAM_IDLE_DISPOSE_MS, type TeamMemberRecord, type TeamTaskRecord } from "./team-store.js";
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
}

function fakeLead(branch: PersistedSessionEntry[] = [], streaming = false): FakeLead {
  const entries = [...branch];
  const delivered: { message: unknown; options: unknown }[] = [];
  const session = {
    sessionId: LEAD,
    isStreaming: streaming,
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
    }
  };
  return { session: session as unknown as AgentSession, entries, delivered };
}

class FakeChild implements TeamChildSession {
  isStreaming = false;
  prompts: string[] = [];
  custom: { message: { customType: string; content: { type: string; text: string }[]; details?: unknown }; options?: unknown }[] = [];
  disposed = false;
  aborted = false;
  failSend = false;
  private listeners = new Set<(event: { type: string }) => void>();

  constructor(readonly sessionId: string, readonly sessionFile: string) {}

  prompt(text: string, options?: { expandPromptTemplates?: boolean; preflightResult?: (disposition: "handled" | "queued" | "started") => void }): Promise<void> {
    this.prompts.push(text);
    this.isStreaming = true;
    options?.preflightResult?.("started");
    return new Promise<void>(() => { /* 模拟一个持续回合，由 emitSettled 结束 */ });
  }

  sendCustomMessage(
    message: { customType: string; content: { type: "text"; text: string }[]; display: boolean; details?: unknown },
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
    this.emit("agent_settled");
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
  }

  subscribe(listener: (event: { type: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...this.listeners]) listener({ type });
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
}

function harness(branch: PersistedSessionEntry[] = [], overrides: Partial<TeamRuntimeOptions> = {}): Harness {
  const lead = fakeLead(branch);
  const created: FakeChild[] = [];
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
  const options: TeamRuntimeOptions = {
    leadSession: lead.session,
    workspace,
    agentDir,
    agent: agentProfile(),
    modelRuntime: {} as never,
    getThinkingLevel: () => "medium" as ThinkingLevel,
    requestPermission: () => Promise.resolve("allow-once"),
    onChange: () => undefined,
    createChildSession: factory,
    ...overrides
  };
  return { runtime: new TeamRuntime(options), lead, created, options };
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
    await expect(waiting).resolves.toEqual({ timedOut: false });
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

  it("interrupts a teammate without clearing queued messages, and stopAll aborts every running member", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "x", prompt: "p" });
    const child = h.created[0]!;
    expect(h.runtime.interrupt(leadMembership, "reviewer")).toEqual({ previousStatus: "running" });
    expect(child.aborted).toBe(true);
    expect(() => h.runtime.interrupt({ role: "teammate", name: "reviewer" }, "reviewer")).toThrow(/只有 Team Lead/u);
    expect(() => h.runtime.interrupt(leadMembership, "lead")).toThrow(/不能中断 Team Lead/u);

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
