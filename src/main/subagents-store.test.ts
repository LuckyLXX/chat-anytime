import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSubagent, readSubagents, saveSubagent, deleteSubagent, subagentPathsFor } from "./subagents-store.js";
import type { SubagentDefinition } from "../shared/protocol.js";

let agentDir: string;
let workspace: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pidesktop-subagents-agent-"));
  workspace = mkdtempSync(join(tmpdir(), "pidesktop-subagents-ws-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function readFileList(filePath: string): SubagentDefinition[] {
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  return (parsed.subagents ?? []) as SubagentDefinition[];
}

describe("normalizeSubagent", () => {
  it("normalizes a valid definition", () => {
    const result = normalizeSubagent({
      id: "code-reviewer",
      name: "Code Reviewer",
      description: "审查代码",
      systemPrompt: "你是代码审查专家",
      scope: "project",
      tools: { read: true, bash: false },
      color: "amber",
      injectAgentsMd: true
    });
    expect(result.id).toBe("code-reviewer");
    expect(result.scope).toBe("project");
    expect(result.color).toBe("amber");
    expect(result.injectAgentsMd).toBe(true);
    expect(result.tools).toEqual({ read: true, bash: false, edit: true, write: true, grep: true, find: true, ls: true, powershell: false });
  });

  it("defaults missing tools to full and scope to global", () => {
    const result = normalizeSubagent({ id: "a", name: "A", systemPrompt: "x" });
    expect(result.scope).toBe("global");
    expect(result.tools).not.toBe("inherit");
    expect((result.tools as Record<string, boolean>).read).toBe(true);
  });

  it("keeps inherit as-is", () => {
    const result = normalizeSubagent({ id: "a", name: "A", systemPrompt: "x", tools: "inherit" });
    expect(result.tools).toBe("inherit");
  });

  it("throws on missing name or systemPrompt", () => {
    expect(() => normalizeSubagent({ id: "a", name: "", systemPrompt: "x" })).toThrow();
    expect(() => normalizeSubagent({ id: "a", name: "A", systemPrompt: "" })).toThrow();
  });
});

describe("subagentPathsFor", () => {
  it("returns a global path and an optional project path", () => {
    const paths = subagentPathsFor(workspace, agentDir);
    expect(paths.global).toContain("pidesktop-subagents.json");
    expect(paths.project).toContain(".pidesktop-subagents.json");
    expect(subagentPathsFor(undefined, agentDir).project).toBeUndefined();
  });
});

describe("read/save/delete", () => {
  it("saves to the global file when scope is global", () => {
    saveSubagent(workspace, agentDir, { id: "g", name: "G", description: "", systemPrompt: "x", tools: "inherit", scope: "global" });
    const globalPath = subagentPathsFor(workspace, agentDir).global;
    const list = readFileList(globalPath);
    expect(list.some((item) => item.id === "g")).toBe(true);
  });

  it("saves to the project file when scope is project", () => {
    saveSubagent(workspace, agentDir, { id: "p", name: "P", description: "", systemPrompt: "x", tools: "inherit", scope: "project" });
    const projectPath = subagentPathsFor(workspace, agentDir).project!;
    const list = readFileList(projectPath);
    expect(list.some((item) => item.id === "p")).toBe(true);
  });

  it("merges project over global by id and stamps scope", () => {
    saveSubagent(workspace, agentDir, { id: "same", name: "Global", description: "", systemPrompt: "global prompt", tools: "inherit", scope: "global" });
    saveSubagent(workspace, agentDir, { id: "same", name: "Project", description: "", systemPrompt: "project prompt", tools: "inherit", scope: "project" });
    const merged = readSubagents(workspace, agentDir);
    const entry = merged.find((item) => item.id === "same");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("Project");
    expect(entry!.scope).toBe("project");
  });

  it("delete removes from the target scope only", () => {
    saveSubagent(workspace, agentDir, { id: "x", name: "G", description: "", systemPrompt: "x", tools: "inherit", scope: "global" });
    expect(deleteSubagent(workspace, agentDir, "x", "global")).toBe(true);
    expect(deleteSubagent(workspace, agentDir, "x", "global")).toBe(false);
    expect(readSubagents(workspace, agentDir)).toHaveLength(0);
  });
});
