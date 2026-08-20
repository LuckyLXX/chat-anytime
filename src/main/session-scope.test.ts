import { describe, expect, it } from "vitest";
import { agentWorkspaceSessionDir, resolveNewSessionDefaults, sessionListReadyFor, workspaceHash } from "./session-scope.js";

describe("Agent workspace session scope", () => {
  it("keeps agents and workspaces in separate deterministic directories", () => {
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).toBe(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo"));
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).not.toBe(agentWorkspaceSessionDir("C:/pi", "coder", "C:/projects/demo"));
    expect(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/demo")).not.toBe(agentWorkspaceSessionDir("C:/pi", "default", "C:/projects/other"));
    expect(workspaceHash("C:/projects/demo")).toHaveLength(20);
  });

  it("uses Agent defaults for new sessions and leaves history to Pi restoration", () => {
    expect(resolveNewSessionDefaults(false, "agent-model", "global-model", "high", "low")).toEqual({ model: "agent-model", thinkingLevel: "high" });
    expect(resolveNewSessionDefaults(true, "agent-model", "global-model", "high", "low")).toEqual({ model: undefined, thinkingLevel: undefined });
  });

  it("treats a non-empty session list from another agent as stale after an agent switch", () => {
    // Same agent, populated list: the cached list stays valid.
    expect(sessionListReadyFor(3, "coder", "coder")).toBe(true);
    // The previous agent's list is non-empty but out of scope: must re-list.
    expect(sessionListReadyFor(3, "default", "coder")).toBe(false);
    // Empty lists are never ready, even for the same agent.
    expect(sessionListReadyFor(0, "coder", "coder")).toBe(false);
    expect(sessionListReadyFor(0, undefined, undefined)).toBe(false);
  });
});
