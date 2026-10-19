import { describe, expect, it } from "vitest";
import type { TeamMemberRecord, TeamState, TeamTaskRecord } from "./team-store.js";
import { MAX_TEAM_TASKS } from "./team-store.js";
import {
  assertTaskGraph,
  createTask,
  nextTaskId,
  normalizeWriteScope,
  normalizeWriteScopes,
  projectTaskView,
  resolveOwnerId,
  updateTask,
  withTask,
  type TeamTaskCaller
} from "./team-tasks.js";

const LEAD = "lead-session";

function member(overrides: Partial<TeamMemberRecord> = {}): TeamMemberRecord {
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
      tools: [],
      model: { provider: "p", id: "m" },
      thinkingLevel: "medium",
      browserTools: false
    },
    ...overrides
  };
}

function state(tasks: TeamTaskRecord[] = [], members: TeamMemberRecord[] = [member()]): TeamState {
  return { members, tasks };
}

function task(overrides: Partial<TeamTaskRecord> = {}): TeamTaskRecord {
  return {
    id: "task-1",
    revision: 1,
    subject: "改 A",
    description: "把 A 改掉",
    status: "pending",
    blockedBy: [],
    writeScopes: ["src/a.ts"],
    ...overrides
  };
}

const lead: TeamTaskCaller = { id: LEAD, role: "lead", name: "lead" };
const reviewer: TeamTaskCaller = { id: "child-1", role: "teammate", name: "reviewer" };

describe("write scopes", () => {
  it("normalizes separators and rejects escapes/absolute paths", () => {
    expect(normalizeWriteScope(" src\\a.ts/ ")).toBe("src/a.ts");
    expect(normalizeWriteScope("./src//a.ts")).toBe("src/a.ts");
    expect(() => normalizeWriteScope("/etc/passwd")).toThrow(/相对路径/u);
    expect(() => normalizeWriteScope("C:/temp")).toThrow(/相对路径/u);
    expect(() => normalizeWriteScope("src/../secret")).toThrow(/\.\./u);
    expect(normalizeWriteScopes(["src/a.ts", "src\\a.ts", "docs/"])).toEqual(["src/a.ts", "docs"]);
  });
});

describe("createTask", () => {
  it("allocates monotonic ids and never reuses a deleted one", () => {
    const current = state([task({ id: "task-3", status: "deleted" }), task({ id: "task-7" })]);
    expect(nextTaskId(current)).toBe("task-8");
    expect(createTask(current, { subject: " s ", description: " d " })).toMatchObject({
      id: "task-8",
      revision: 1,
      status: "pending",
      subject: "s",
      description: "d"
    });
  });

  it("validates text, dependencies, and the active-task limit", () => {
    expect(() => createTask(state(), { subject: " ", description: "d" })).toThrow(/subject/u);
    expect(() => createTask(state(), { subject: "s", description: "" })).toThrow(/description/u);
    expect(() => createTask(state(), { subject: "s", description: "d", blockedBy: ["task-9"] })).toThrow(/不存在/u);
    expect(() => createTask(state([task({ id: "task-1" })]), { subject: "s", description: "d", blockedBy: ["task-1", "task-1"] })).toThrow(/重复/u);
    const full = state(Array.from({ length: MAX_TEAM_TASKS }, (_, index) => task({ id: `task-${index + 1}` })));
    expect(() => createTask(full, { subject: "s", description: "d" })).toThrow(/上限/u);
    // 已删除任务不占上限。
    const withDeleted = state([...full.tasks.slice(1), task({ id: "task-1", status: "deleted" })]);
    expect(() => createTask(withDeleted, { subject: "s", description: "d" })).not.toThrow();
  });
});

describe("updateTask CAS", () => {
  it("rejects a stale revision instead of overwriting", () => {
    const current = state([task({ revision: 3 })]);
    expect(() => updateTask(current, LEAD, lead, { taskId: "task-1", expectedRevision: 2, action: "claim" })).toThrow(/当前 revision 3/u);
  });

  it("claims only ready pending tasks and increments the revision", () => {
    const blocked = state([task({ id: "task-1" }), task({ id: "task-2", blockedBy: ["task-1"] })]);
    expect(() => updateTask(blocked, LEAD, reviewer, { taskId: "task-2", expectedRevision: 1, action: "claim" })).toThrow(/依赖/u);
    const claimed = updateTask(blocked, LEAD, reviewer, { taskId: "task-1", expectedRevision: 1, action: "claim" });
    expect(claimed).toMatchObject({ status: "in_progress", ownerId: "child-1", revision: 2 });
    // 第二个成员不能抢已认领的任务。
    const owned = state([task({ id: "task-1", status: "in_progress", ownerId: "child-1", revision: 2 })]);
    expect(() => updateTask(owned, LEAD, { id: "child-2", role: "teammate", name: "other" }, {
      taskId: "task-1", expectedRevision: 2, action: "claim"
    })).toThrow(/已被其他成员认领/u);
  });

  it("enforces owner/lead authorization and legal transitions", () => {
    const inProgress = state([task({ status: "in_progress", ownerId: "child-1", revision: 2 })]);
    expect(() => updateTask(inProgress, LEAD, { id: "stranger", role: "teammate", name: "stranger" }, {
      taskId: "task-1", expectedRevision: 2, action: "complete"
    })).toThrow(/owner 或 Team Lead/u);
    expect(() => updateTask(inProgress, LEAD, reviewer, { taskId: "task-1", expectedRevision: 2, action: "reopen" }))
      .toThrow(/只有 completed/u);
    expect(updateTask(inProgress, LEAD, reviewer, { taskId: "task-1", expectedRevision: 2, action: "complete" }))
      .toMatchObject({ status: "completed", ownerId: "child-1", revision: 3 });
    const completed = state([task({ status: "completed", ownerId: "child-1", revision: 2 })]);
    expect(updateTask(completed, LEAD, reviewer, { taskId: "task-1", expectedRevision: 2, action: "reopen" }))
      .toMatchObject({ status: "pending", revision: 3 });
  });

  it("reassigns only via the Lead and releases on an empty owner", () => {
    const current = state([task({ status: "in_progress", ownerId: "child-1", revision: 2 })]);
    expect(() => updateTask(current, LEAD, reviewer, { taskId: "task-1", expectedRevision: 2, action: "reassign", owner: "reviewer" }))
      .toThrow(/只有 Team Lead/u);
    expect(updateTask(current, LEAD, lead, { taskId: "task-1", expectedRevision: 2, action: "reassign", owner: "reviewer" }))
      .toMatchObject({ status: "in_progress", ownerId: "child-1", revision: 3 });
    expect(updateTask(current, LEAD, lead, { taskId: "task-1", expectedRevision: 2, action: "reassign", owner: "" }))
      .toMatchObject({ status: "pending", revision: 3 });
  });

  it("rejects deleting a task that still blocks another", () => {
    const current = state([task({ id: "task-1" }), task({ id: "task-2", blockedBy: ["task-1"] })]);
    expect(() => updateTask(current, LEAD, lead, { taskId: "task-1", expectedRevision: 1, action: "delete" }))
      .toThrow(/仍被 task-2 依赖/u);
    const deleted = updateTask(current, LEAD, lead, { taskId: "task-2", expectedRevision: 1, action: "delete" });
    expect(deleted.status).toBe("deleted");
  });

  it("rejects dependency cycles on set_dependencies", () => {
    const current = state([task({ id: "task-1" }), task({ id: "task-2", blockedBy: ["task-1"] })]);
    expect(() => updateTask(current, LEAD, lead, {
      taskId: "task-1", expectedRevision: 1, action: "set_dependencies", blockedBy: ["task-2"]
    })).toThrow(/形成环/u);
  });

  it("refuses edits on a deleted tombstone", () => {
    const current = state([task({ status: "deleted" })]);
    expect(() => updateTask(current, LEAD, lead, { taskId: "task-1", expectedRevision: 1, action: "edit", subject: "x" }))
      .toThrow(/已删除/u);
  });
});

describe("views", () => {
  it("derives owner names, readiness and advisory scope warnings", () => {
    const current = state([
      task({ id: "task-1", status: "in_progress", ownerId: "child-1", writeScopes: ["src"] }),
      task({ id: "task-2", status: "pending", writeScopes: ["src/a.ts"], blockedBy: ["task-1"] }),
      task({ id: "task-3", status: "completed" })
    ]);
    const view = projectTaskView(current, current.tasks[1]!, LEAD);
    expect(view.ownerName).toBeUndefined();
    expect(view.ready).toBe(false);
    expect(view.writeScopeWarnings[0]).toContain("task-1");
    expect(projectTaskView(current, current.tasks[0]!, LEAD).ownerName).toBe("reviewer");
    expect(projectTaskView(current, { ...current.tasks[2]!, status: "pending" }, LEAD).ready).toBe(true);
  });

  it("resolves owner names to active member ids and rejects unknown names", () => {
    expect(resolveOwnerId(state(), LEAD, "lead")).toBe(LEAD);
    expect(resolveOwnerId(state(), LEAD, "reviewer")).toBe("child-1");
    expect(resolveOwnerId(state(), LEAD, "unowned")).toBeUndefined();
    expect(() => resolveOwnerId(state(), LEAD, "ghost")).toThrow(/找不到/u);
  });

  it("detects a graph cycle directly", () => {
    const cyclic = [task({ id: "task-1", blockedBy: ["task-2"] }), task({ id: "task-2", blockedBy: ["task-1"] })];
    expect(() => assertTaskGraph(cyclic, { ...cyclic[0]!, status: "pending" })).toThrow(/形成环/u);
  });

  it("replaces or appends tasks without mutating the input array", () => {
    const current = state([task({ id: "task-1" })]);
    const updated = withTask(current, task({ id: "task-1", revision: 2 }));
    const added = withTask(current, task({ id: "task-2" }));
    expect(updated.map((item) => item.revision)).toEqual([2]);
    expect(added).toHaveLength(2);
    expect(current.tasks).toHaveLength(1);
  });
});
