import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PersistedSessionEntry } from "./session-history.js";
import {
  TEAM_ENTRY_TYPE,
  appendTeamMember,
  appendTeamTask,
  emptyTeamState,
  readTeamEntryData,
  reconcileProvisioningMember,
  restoreTeamState,
  type TeamMemberRecord,
  type TeamTaskRecord
} from "./team-store.js";

function member(overrides: Partial<TeamMemberRecord> = {}): TeamMemberRecord {
  return {
    id: "child-1",
    name: "reviewer",
    description: "审查改动",
    phase: "provisioning",
    sessionFile: "/tmp/child-1.jsonl",
    createdAt: 1,
    config: {
      mode: "inherit",
      systemPrompt: "你是审查者",
      tools: ["read", "bash"],
      model: { provider: "p", id: "m" },
      thinkingLevel: "medium",
      browserTools: false
    },
    ...overrides
  };
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

function entry(data: unknown, customType = TEAM_ENTRY_TYPE): PersistedSessionEntry {
  return { id: `e-${Math.random()}`, type: "custom", customType, data };
}

describe("team entry validation", () => {
  it("accepts valid member/task payloads and rejects malformed ones", () => {
    expect(readTeamEntryData({ kind: "member", member: member() })?.kind).toBe("member");
    expect(readTeamEntryData({ kind: "task", task: task() })?.kind).toBe("task");
    expect(readTeamEntryData({ kind: "member", member: { ...member(), id: 1 } })).toBeUndefined();
    expect(readTeamEntryData({ kind: "task", task: { ...task(), revision: 0 } })).toBeUndefined();
    expect(readTeamEntryData({ kind: "task", task: { ...task(), status: "unknown" } })).toBeUndefined();
    expect(readTeamEntryData({ kind: "member", member: { ...member(), config: { mode: "inherit" } } })).toBeUndefined();
    expect(readTeamEntryData({ kind: "other" })).toBeUndefined();
    expect(readTeamEntryData(undefined)).toBeUndefined();
  });
});

describe("restoreTeamState", () => {
  it("folds last-write-wins snapshots and keeps creation order", () => {
    const state = restoreTeamState([
      entry({ kind: "member", member: member({ phase: "provisioning" }) }),
      entry({ kind: "member", member: member({ id: "child-2", name: "explorer" }) }),
      entry({ kind: "member", member: member({ phase: "active" }) }),
      entry({ kind: "task", task: task() }),
      entry({ kind: "task", task: task({ revision: 2, status: "in_progress" }) })
    ]);
    expect(state.members.map((item) => item.name)).toEqual(["reviewer", "explorer"]);
    expect(state.members[0]!.phase).toBe("active");
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]!.revision).toBe(2);
  });

  it("ignores foreign custom types, malformed payloads, and non-custom entries", () => {
    const state = restoreTeamState([
      entry({ kind: "member", member: member() }, "pidesktop-control"),
      entry({ kind: "member", member: { ...member(), name: 1 } }),
      { id: "msg", type: "message" }
    ]);
    expect(state).toEqual(emptyTeamState());
  });

  it("keeps deleted tasks as tombstones so ids are never reused", () => {
    const state = restoreTeamState([
      entry({ kind: "task", task: task({ id: "task-1", status: "deleted", revision: 2 }) }),
      entry({ kind: "task", task: task({ id: "task-2" }) })
    ]);
    expect(state.tasks.map((item) => [item.id, item.status])).toEqual([["task-1", "deleted"], ["task-2", "pending"]]);
  });
});

describe("append helpers", () => {
  it("appends full snapshots under the team customType", () => {
    const appendCustomEntry = vi.fn(() => "entry-1");
    const session = { sessionManager: { appendCustomEntry } } as unknown as AgentSession;
    appendTeamMember(session, member());
    appendTeamTask(session, task());
    expect(appendCustomEntry.mock.calls[0]).toEqual([TEAM_ENTRY_TYPE, { kind: "member", member: member() }]);
    expect(appendCustomEntry.mock.calls[1]).toEqual([TEAM_ENTRY_TYPE, { kind: "task", task: task() }]);
  });
});

describe("provisioning reconciliation", () => {
  it("promotes a provisioning member whose first prompt was accepted", () => {
    const recovered = reconcileProvisioningMember(member({ phase: "provisioning" }), true);
    expect(recovered.phase).toBe("active");
    expect(recovered.error).toBeUndefined();
  });

  it("fails a provisioning member whose child never recorded a user message", () => {
    const recovered = reconcileProvisioningMember(member({ phase: "provisioning" }), false);
    expect(recovered.phase).toBe("failed");
    expect(recovered.error).toContain("创建未完成");
  });

  it("leaves terminal members untouched", () => {
    const active = member({ phase: "active" });
    expect(reconcileProvisioningMember(active, false)).toBe(active);
    const failed = member({ phase: "failed", error: "x" });
    expect(reconcileProvisioningMember(failed, true)).toBe(failed);
  });
});
