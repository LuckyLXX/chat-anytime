import { describe, expect, it } from "vitest";
import { agentWorkspaceSessionDir, resolveNewSessionDefaults, workspaceHash } from "./session-scope.js";

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
});
