import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSubagent, readBundledSubagents, readSubagentModelOverrides, readSubagents, saveSubagent, saveSubagentModelOverride, subagentModelOverridesPath, deleteSubagent, subagentPathsFor } from "./subagents-store.js";
import type { SubagentDefinition } from "../shared/protocol.js";

let agentDir: string;
let workspace: string;
let bundledDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pidesktop-subagents-agent-"));
  workspace = mkdtempSync(join(tmpdir(), "pidesktop-subagents-ws-"));
  bundledDir = mkdtempSync(join(tmpdir(), "pidesktop-subagents-bundled-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(bundledDir, { recursive: true, force: true });
});

function writeBundled(id: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(bundledDir, `${id}.json`), JSON.stringify({ id, name: id, description: "内置", systemPrompt: "内置提示词", tools: { read: true, edit: false }, ...extra }), "utf8");
}

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

  it("never lets a config file claim the bundled scope", () => {
    // bundled 由 readBundledSubagents 强制标定；用户配置里写它也会被归一到 global，
    // 否则一个手改的 JSON 就能造出「只读却可删」的矛盾条目。
    expect(normalizeSubagent({ id: "a", name: "A", systemPrompt: "x", scope: "bundled" }).scope).toBe("global");
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

describe("bundled (内置) definitions", () => {
  it("reads one definition per json file and forces bundled scope + builtin flag", () => {
    writeBundled("code-reviewer");
    writeBundled("explorer", { scope: "project" });
    writeFileSync(join(bundledDir, "README.md"), "not json", "utf8");
    const list = readBundledSubagents(bundledDir);
    expect(list).toHaveLength(2);
    expect(list.every((entry) => entry.scope === "bundled" && entry.builtin === true)).toBe(true);
  });

  it("skips only the broken file instead of losing the whole built-in set", () => {
    writeBundled("good");
    writeFileSync(join(bundledDir, "bad.json"), "{ not json", "utf8");
    expect(readBundledSubagents(bundledDir).map((entry) => entry.id)).toEqual(["good"]);
  });

  it("returns nothing for a missing directory", () => {
    expect(readBundledSubagents(join(bundledDir, "nope"))).toEqual([]);
  });

  it("merges bundled < global < project by id", () => {
    writeBundled("code-reviewer");
    expect(readSubagents(workspace, agentDir, bundledDir).find((entry) => entry.id === "code-reviewer")?.scope).toBe("bundled");
    saveSubagent(workspace, agentDir, { id: "code-reviewer", name: "mine", description: "", systemPrompt: "用户版", tools: "inherit", scope: "global" });
    expect(readSubagents(workspace, agentDir, bundledDir).find((entry) => entry.id === "code-reviewer")?.scope).toBe("global");
    saveSubagent(workspace, agentDir, { id: "code-reviewer", name: "project版", description: "", systemPrompt: "项目版", tools: "inherit", scope: "project" });
    const merged = readSubagents(workspace, agentDir, bundledDir);
    expect(merged.filter((entry) => entry.id === "code-reviewer")).toHaveLength(1);
    expect(merged.find((entry) => entry.id === "code-reviewer")?.scope).toBe("project");
  });

  it("lets a user definition replace a bundled one by NAME even when the ids differ", () => {
    // 真实场景：用户的存量定义 id 是随机生成的（subagent-xxxx），名称却正好是
    // code-reviewer。若只按 id 合并，清单里会出现两个同名条目，「按名称引用」命中哪个
    // 变成不确定——按名字覆盖后用户那份直接替掉内置那份，零额外配置。
    writeBundled("code-reviewer");
    saveSubagent(workspace, agentDir, { id: "subagent-mtgnorly", name: "code-reviewer", description: "我的版本", systemPrompt: "用户提示词", tools: "inherit", scope: "global" });
    const merged = readSubagents(workspace, agentDir, bundledDir);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("subagent-mtgnorly");
    expect(merged[0]!.description).toBe("我的版本");
  });

  it("keeps definitions with different names side by side", () => {
    writeBundled("code-reviewer");
    saveSubagent(workspace, agentDir, { id: "my-own", name: "my-helper", description: "", systemPrompt: "x", tools: "inherit", scope: "global" });
    expect(readSubagents(workspace, agentDir, bundledDir).map((entry) => entry.name).sort()).toEqual(["code-reviewer", "my-helper"]);
  });

  it("applies the user model override to a bundled definition only", () => {
    writeBundled("explorer");
    expect(readSubagents(workspace, agentDir, bundledDir).find((entry) => entry.id === "explorer")?.model).toBeUndefined();
    saveSubagentModelOverride(agentDir, "explorer", { provider: "p", id: "m" });
    expect(readSubagents(workspace, agentDir, bundledDir).find((entry) => entry.id === "explorer")?.model).toEqual({ provider: "p", id: "m" });
    expect(readSubagentModelOverrides(agentDir)).toEqual({ explorer: { provider: "p", id: "m" } });
    // 清空 = 回到继承默认模型，而不是写一条空值进去。
    saveSubagentModelOverride(agentDir, "explorer", undefined);
    expect(readSubagentModelOverrides(agentDir)).toEqual({});
    expect(existsSync(subagentModelOverridesPath(agentDir))).toBe(true);
  });

  it("rejects any write that targets the bundled scope", () => {
    writeBundled("explorer");
    expect(() => saveSubagent(workspace, agentDir, { id: "explorer", name: "x", description: "", systemPrompt: "x", tools: "inherit", scope: "bundled" })).toThrow(/内置/u);
    expect(() => deleteSubagent(workspace, agentDir, "explorer", "bundled")).toThrow(/内置/u);
    // 只读保护不能误伤用户自己的两个作用域。
    expect(deleteSubagent(workspace, agentDir, "missing", "global")).toBe(false);
  });

  it("keeps a bundled definition untouched when only the model is overridden", () => {
    writeBundled("explorer", { description: "原描述" });
    saveSubagentModelOverride(agentDir, "explorer", { provider: "p", id: "m" });
    const entry = readSubagents(workspace, agentDir, bundledDir).find((item) => item.id === "explorer")!;
    expect(entry.description).toBe("原描述");
    expect(entry.systemPrompt).toBe("内置提示词");
    expect(entry.scope).toBe("bundled");
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
