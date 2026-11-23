import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, TeamMemberSettlement, ThinkingLevel } from "../shared/protocol.js";
import type { PersistedSessionEntry } from "./session-history.js";
import { TEAM_ENTRY_TYPE } from "./team-store.js";
import {
  TeamRuntime,
  type TeamChildCreated,
  type TeamChildEvent,
  type TeamChildListener,
  type TeamChildSession,
  type TeamCodexBackend,
  type TeamCodexBackendAvailability,
  type TeamCodexChildRequest,
  type TeamRuntimeOptions
} from "./team-runtime.js";

/**
 * Lead → 成员的后端路由：Codex 成员走外部后端（不进 Pi 的 createChildSession），
 * 预检发生在占用成员名之前，失败结算走窄失败契约，快照/工具面能看出运行来源。
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

const leadMembership = { role: "lead" as const, name: "lead" };

class FakeCodexChild implements TeamChildSession {
  isStreaming = false;
  prompts: string[] = [];
  messages: string[] = [];
  aborts = 0;
  disposed = false;
  queueClears = 0;
  private listeners = new Set<TeamChildListener>();

  constructor(readonly sessionId: string) {}

  prompt(text: string, options?: { preflightResult?: (disposition: "handled" | "queued" | "started") => void }): Promise<void> {
    this.prompts.push(text);
    this.isStreaming = true;
    // 与真实适配器一致：回合被受理后回一次 started（spawn 只等这个信号），
    // 并立刻发 agent_start（团队运行时从这里开始为回合记账）。
    options?.preflightResult?.("started");
    this.emit({ type: "agent_start" });
    return Promise.resolve();
  }

  sendCustomMessage(message: { content: { type: "text"; text: string }[] }): Promise<void> {
    this.messages.push(message.content.map((block) => block.text).join("\n"));
    this.isStreaming = true;
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.aborts += 1;
    this.isStreaming = false;
    this.emit({ type: "agent_settled", aborted: true });
    return Promise.resolve();
  }

  clearQueue(): void {
    this.queueClears += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  subscribe(listener: TeamChildListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: TeamChildEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  startTurn(): void {
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
  }

  settle(): void {
    this.isStreaming = false;
    this.emit({ type: "agent_settled", aborted: false });
  }

  fail(error: string): void {
    this.isStreaming = false;
    this.emit({ type: "pidesktop_run_failed", error });
  }
}

interface Harness {
  runtime: TeamRuntime;
  lead: { session: AgentSession; entries: PersistedSessionEntry[] };
  codexChildren: FakeCodexChild[];
  childRequests: TeamCodexChildRequest[];
  piChildren: string[];
  availability: TeamCodexBackendAvailability;
  settlements(): TeamMemberSettlement[];
}

function harness(overrides: { availability?: Partial<TeamCodexBackendAvailability>; withCodex?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-team-codex-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace, { recursive: true });
  const entries: PersistedSessionEntry[] = [];
  const lead = {
    sessionId: "lead-session",
    isStreaming: false,
    model: { provider: "p", id: "m" },
    sessionManager: {
      getBranch: () => entries,
      appendCustomEntry: (customType: string, data: unknown) => {
        const id = `e-${entries.length}`;
        entries.push({ id, type: "custom", customType, data });
        return id;
      }
    },
    sendCustomMessage: async () => undefined,
    getSessionStats: () => ({ toolCalls: 0, tokens: { total: 0 }, cost: 0 })
  } as unknown as AgentSession;
  const codexChildren: FakeCodexChild[] = [];
  const childRequests: TeamCodexChildRequest[] = [];
  const piChildren: string[] = [];
  const availability: TeamCodexBackendAvailability = {
    available: true,
    access: "read-only",
    executable: "C:\\tools\\codex.exe",
    version: "codex-cli 0.171.0",
    ...(overrides.availability ?? {})
  };
  const backend: TeamCodexBackend = {
    availability: () => availability,
    createChild: async (request) => {
      childRequests.push(request);
      const child = new FakeCodexChild(request.manager.getSessionId());
      codexChildren.push(child);
      return {
        handle: child,
        sessionId: request.manager.getSessionId(),
        sessionFile: request.manager.getSessionFile() ?? "",
        dispose: () => child.dispose()
      } satisfies TeamChildCreated;
    }
  };
  const options: TeamRuntimeOptions = {
    leadSession: lead,
    workspace,
    agentDir,
    agent: agentProfile(),
    modelRuntime: {} as never,
    getThinkingLevel: () => "medium" as ThinkingLevel,
    getSubagentCatalog: () => [{
      id: "def-1",
      name: "reviewer",
      description: "审查者",
      scope: "project" as const,
      systemPrompt: "你是审查者",
      tools: "inherit" as const,
      color: "#fff"
    }],
    requestPermission: () => Promise.resolve("allow-once"),
    onChange: () => undefined,
    createChildSession: async (request) => {
      piChildren.push(request.name);
      throw new Error("Pi 子会话不应为 Codex 成员创建");
    },
    ...(overrides.withCodex === false ? {} : { codex: backend })
  };
  const runtime = new TeamRuntime(options);
  return {
    runtime,
    lead: { session: lead, entries },
    codexChildren,
    childRequests,
    piChildren,
    availability,
    settlements: () => entries
      .filter((entry) => entry.type === "custom" && entry.customType === TEAM_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "settled")
      .map((entry) => (entry.data as { settlement: TeamMemberSettlement }).settlement)
  };
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

describe("codex backend routing", () => {
  it("creates Codex members through the external backend and marks their source", async () => {
    const h = harness();
    const view = await h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex" });
    expect(h.piChildren).toEqual([]);
    expect(h.childRequests).toHaveLength(1);
    expect(h.childRequests[0]).toMatchObject({ memberName: "reviewer" });
    expect(h.codexChildren[0]!.prompts).toEqual(["看 diff"]);
    expect(view.backend).toBe("codex");
    expect(view.model).toBe("codex/default");
    const snapshot = h.runtime.snapshot();
    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.members[0]).toMatchObject({ name: "reviewer", backend: "codex", model: "codex/default" });
    expect(h.runtime.backends()).toEqual([{
      backend: "codex",
      available: true,
      access: "read-only",
      version: "codex-cli 0.171.0"
    }]);
  });

  it("keeps the member config free of invented Pi provider/model", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex" });
    const record = h.childRequests[0]!.config;
    expect(record.mode).toBe("codex");
    expect(record.model).toBeUndefined();
    expect(record.codex).toMatchObject({ executable: "C:\\tools\\codex.exe", sandbox: "read-only", approvalPolicy: "never" });
  });

  it("preflights the backend before occupying the member name", async () => {
    const h = harness({ availability: { available: false, reason: "Codex 接入未启用" } });
    await expect(h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex" }))
      .rejects.toThrow(/Codex 接入未启用/u);
    // 名字没有被 failed 记录占掉：同一名字仍可用于 Pi 成员（这里让 Pi 工厂报错以证明进了 Pi 分支）。
    await expect(h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff" }))
      .rejects.toThrow(/Pi 子会话不应为 Codex 成员创建|成员会话/u);
    expect(h.runtime.snapshot().members.every((member) => member.backend !== "codex")).toBe(true);
  });

  it("rejects subagent + codex before allocating the name", async () => {
    const h = harness();
    await expect(h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex", subagent: "reviewer" }))
      .rejects.toThrow(/不支持 subagent/u);
    expect(h.runtime.snapshot().members).toHaveLength(0);
  });

  it("says explicitly when the backend is not wired at all", async () => {
    const h = harness({ withCodex: false });
    await expect(h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex" }))
      .rejects.toThrow(/Codex 后端未接入/u);
    expect(h.runtime.backends()).toEqual([]);
  });
});

describe("codex member settlement", () => {
  it("settles a failed turn exactly once through the narrow failure contract", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex" });
    const child = h.codexChildren[0]!;
    child.startTurn();
    child.fail("model exploded");
    child.fail("model exploded");
    const settlements = h.settlements();
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ memberName: "reviewer", outcome: "failed", error: "model exploded" });
    const snapshot = h.runtime.snapshot();
    expect(snapshot.members[0]).toMatchObject({ name: "reviewer", status: "inactive", settlement: { outcome: "failed" } });
  });

  it("settles completed turns and keeps the last report", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex" });
    const child = h.codexChildren[0]!;
    child.startTurn();
    child.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "结论：无问题" }] } } as unknown as TeamChildEvent);
    child.settle();
    const settlements = h.settlements();
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: "completed", summary: "结论：无问题" });
  });

  it("reuses the member dir and cold-resumes through the backend after idle dispose", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex" });
    const first = h.codexChildren[0]!;
    first.settle();
    // 释放运行时里这条成员句柄（等价于空闲回收），下一次 send 必须走冷恢复。
    h.codexChildren[0]!.dispose();
    const memberDir = h.childRequests[0]!.memberDir;
    await invokePrivate(h.runtime, "detach", requestMemberId(h));
    await h.runtime.send(leadMembership, "reviewer", "继续");
    expect(h.childRequests).toHaveLength(2);
    expect(h.childRequests[1]!.memberDir).toBe(memberDir);
    expect(h.childRequests[1]!.memberId).toBe(h.childRequests[0]!.memberId);
    expect(h.codexChildren[1]!.messages.join("\n")).toContain("继续");
  });

  it("stops Codex members through the shared stop path (abort + clear queue)", async () => {
    const h = harness();
    await h.runtime.spawn(leadMembership, { name: "reviewer", description: "审查", prompt: "看 diff", backend: "codex" });
    const child = h.codexChildren[0]!;
    const result = h.runtime.interrupt(leadMembership, { name: "reviewer" });
    expect(result.status).toBe("delivered");
    expect(child.queueClears).toBe(1);
    expect(child.aborts).toBe(1);
    expect(h.settlements()[0]).toMatchObject({ outcome: "aborted" });
  });
});

/** `detach` 是私有的：测试里显式调用一次来模拟空闲回收（生产路径由定时器触发）。 */
async function invokePrivate(runtime: TeamRuntime, method: string, ...args: unknown[]): Promise<void> {
  await (runtime as unknown as Record<string, (...params: unknown[]) => unknown>)[method]!(...args);
}

function requestMemberId(h: Harness): string {
  return h.childRequests[0]!.memberId;
}
