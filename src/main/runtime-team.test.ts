import { describe, expect, it, vi } from "vitest";
import { estimateToolTokens } from "./context-breakdown.js";
import { createTeamTools } from "./runtime-team.js";
import type { TeamService } from "./team-contract.js";
import type { TeamTaskView } from "./team-tasks.js";

const memberView = {
  target: "reviewer",
  role: "teammate" as const,
  status: "running" as const,
  description: "审查",
  model: "p/m",
  diagnostics: []
};

const taskView: TeamTaskView = {
  id: "task-1",
  revision: 1,
  subject: "改 A",
  description: "把 A 改掉",
  status: "pending",
  blockedBy: [],
  writeScopes: ["src/a.ts"],
  ready: true,
  writeScopeWarnings: []
};

function fakeService(): TeamService {
  return {
    spawn: vi.fn(async () => memberView),
    send: vi.fn(async () => ({ sent: true as const })),
    list: vi.fn(() => [memberView]),
    wait: vi.fn(async () => ({ timedOut: false })),
    interrupt: vi.fn(() => ({ previousStatus: "running" as const })),
    createTask: vi.fn(async () => taskView),
    listTasks: vi.fn(() => ({ tasks: [taskView] })),
    getTask: vi.fn(() => taskView),
    updateTask: vi.fn(async () => taskView),
    snapshot: vi.fn(() => ({ members: [], running: 0 })),
    hasRunningMembers: vi.fn(() => false),
    stopAll: vi.fn(),
    dispose: vi.fn()
  };
}

function execute(tools: ReturnType<typeof createTeamTools>, name: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return (tool.execute as unknown as (id: string, args: unknown, sig?: AbortSignal) => Promise<unknown>)("call-1", params, signal);
}

function parsed(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text);
}

describe("team tool surface", () => {
  it("gives the Lead all nine tools and teammates only the collaboration seven", () => {
    const service = fakeService();
    const lead = createTeamTools(service, { role: "lead", name: "lead" }).map((tool) => tool.name);
    const teammate = createTeamTools(service, { role: "teammate", name: "reviewer" }).map((tool) => tool.name);
    expect(lead).toEqual([
      "team_spawn",
      "team_interrupt",
      "team_send",
      "team_list",
      "team_wait",
      "team_task_create",
      "team_task_list",
      "team_task_get",
      "team_task_update"
    ]);
    expect(teammate).toEqual([
      "team_send",
      "team_list",
      "team_wait",
      "team_task_create",
      "team_task_list",
      "team_task_get",
      "team_task_update"
    ]);
  });

  it("keeps the shared policy guidelines on exactly one tool", () => {
    const tools = createTeamTools(fakeService(), { role: "lead", name: "lead" });
    const carriers = tools.filter((tool) => (tool.promptGuidelines?.length ?? 0) > 0);
    expect(carriers.map((tool) => tool.name)).toEqual(["team_list"]);
    expect(carriers[0]!.promptGuidelines!.join("\n")).toContain("write_scopes 只做重叠告警");
  });

  it("routes spawn/send/wait/interrupt through the service with the caller identity", async () => {
    const service = fakeService();
    const tools = createTeamTools(service, { role: "lead", name: "lead" });
    expect(parsed(await execute(tools, "team_spawn", { name: "reviewer", description: "审查", prompt: "看 diff" }))).toMatchObject({ target: "reviewer" });
    expect(service.spawn).toHaveBeenCalledWith({ role: "lead", name: "lead" }, { name: "reviewer", description: "审查", prompt: "看 diff" }, undefined);

    expect(parsed(await execute(tools, "team_send", { target: "reviewer", message: "hi" }))).toEqual({ sent: true });
    expect(service.send).toHaveBeenCalledWith({ role: "lead", name: "lead" }, "reviewer", "hi", undefined);

    expect(parsed(await execute(tools, "team_wait", {}))).toEqual({ timedOut: false });
    expect(service.wait).toHaveBeenCalledWith({ role: "lead", name: "lead" }, 30_000, expect.anything());

    expect(parsed(await execute(tools, "team_interrupt", { target: "reviewer" }))).toEqual({ previousStatus: "running" });
    expect(service.interrupt).toHaveBeenCalledWith({ role: "lead", name: "lead" }, "reviewer");
  });

  it("maps task tool arguments onto the service mutation shape", async () => {
    const service = fakeService();
    const tools = createTeamTools(service, { role: "lead", name: "lead" });
    await execute(tools, "team_task_create", { subject: "s", description: "d", blocked_by: ["task-0"], write_scopes: ["src"] });
    expect(service.createTask).toHaveBeenCalledWith({ role: "lead", name: "lead" }, {
      subject: "s",
      description: "d",
      blockedBy: ["task-0"],
      writeScopes: ["src"]
    });
    await execute(tools, "team_task_list", { status: "pending", owner: "reviewer", limit: 10 });
    expect(service.listTasks).toHaveBeenCalledWith({ role: "lead", name: "lead" }, {
      status: "pending",
      owner: "reviewer",
      limit: 10
    });
    await execute(tools, "team_task_get", { task_id: "task-1" });
    expect(service.getTask).toHaveBeenCalledWith({ role: "lead", name: "lead" }, "task-1");
    await execute(tools, "team_task_update", {
      task_id: "task-1",
      expected_revision: 2,
      action: "claim"
    });
    expect(service.updateTask).toHaveBeenCalledWith({ role: "lead", name: "lead" }, {
      taskId: "task-1",
      expectedRevision: 2,
      action: "claim"
    });
  });

  it("keeps the active tool schema under the measured token budget", () => {
    const tools = createTeamTools(fakeService(), { role: "lead", name: "lead" });
    const tokens = estimateToolTokens(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    })));
    // 实测 1112 tokens（9 个工具 schema，含 name/description/parameters）；预算放到 1400
    // 留出正常文案调整空间。只在开启团队模式的会话里付；超过说明描述膨胀了，先精简再放宽。
    expect(tokens).toBeLessThan(1400);
  });
});
