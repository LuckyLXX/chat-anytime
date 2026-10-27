import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceResources } from "./workspace-resources.js";

const tempRoots: string[] = [];
/** 固定前缀 + 随机后缀：避免与用户真实的 ~/.agents/skills 条目同名。 */
const RUN_ID = `wsres-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function makeTempDir(prefix = "workspace-resources-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeSkill(rootDir: string, slug: string, name = slug): void {
  const skillDir = join(rootDir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# ${name}\n`, "utf8");
}

function writeCommand(rootDir: string, name: string, description = ""): void {
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, `${name}.md`), `---\ndescription: ${description}\n---\n\n模板 ${name}`, "utf8");
}

interface SubagentSeed {
  id: string;
  name?: string;
  systemPrompt?: string;
}

function writeSubagentConfig(filePath: string, entries: SubagentSeed[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const subagents = entries.map((entry) => ({
    id: entry.id,
    name: entry.name ?? entry.id,
    description: "",
    systemPrompt: entry.systemPrompt ?? `提示 ${entry.id}`
  }));
  writeFileSync(filePath, JSON.stringify({ subagents }, null, 2), "utf8");
}

function writeBundledSubagent(dir: string, entry: SubagentSeed): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${entry.id}.json`),
    JSON.stringify({ id: entry.id, name: entry.name ?? entry.id, description: "", systemPrompt: entry.systemPrompt ?? `提示 ${entry.id}` }),
    "utf8"
  );
}

interface HookSeed {
  name: string;
  body?: string;
}

function writeHookConfig(filePath: string, hooks: Array<string | HookSeed>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const rules = hooks.map((hook) => {
    const seed = typeof hook === "string" ? { name: hook, body: hook } : hook;
    return { name: seed.name, event: "turn_end", action: { kind: "notify", body: seed.body ?? seed.name } };
  });
  writeFileSync(filePath, JSON.stringify({ hooks: rules }, null, 2), "utf8");
}

function names(items: readonly { name: string }[]): string[] {
  return items.map((item) => item.name).sort();
}

describe("工作区资源隔离", () => {
  it("两个 workspace 只看到各自的项目 skills/commands/subagents/hooks，并叠加全局来源", () => {
    const agentDir = makeTempDir();
    const workspaceA = makeTempDir("workspace-resources-a-");
    const workspaceB = makeTempDir("workspace-resources-b-");

    const globalSkill = `${RUN_ID}-global-skill`;
    const globalCommand = `${RUN_ID}-global-command`;
    const globalSubagent = `${RUN_ID}-global-subagent`;
    const globalHook = `${RUN_ID}-global-hook`;
    const skillA = `${RUN_ID}-skill-a`;
    const commandA = `${RUN_ID}-command-a`;
    const subagentA = `${RUN_ID}-subagent-a`;
    const hookA = `${RUN_ID}-hook-a`;
    const skillB = `${RUN_ID}-skill-b`;
    const commandB = `${RUN_ID}-command-b`;
    const subagentB = `${RUN_ID}-subagent-b`;
    const hookB = `${RUN_ID}-hook-b`;

    writeSkill(join(agentDir, "pidesktop-skills"), globalSkill);
    writeCommand(join(agentDir, "pidesktop-commands"), globalCommand, "全局命令");
    writeSubagentConfig(join(agentDir, "pidesktop-subagents.json"), [{ id: globalSubagent }]);
    writeHookConfig(join(agentDir, "pidesktop-hooks.json"), [globalHook]);

    writeSkill(join(workspaceA, ".pidesktop-skills"), skillA);
    writeCommand(join(workspaceA, ".pidesktop-commands"), commandA, "A 项目命令");
    writeSubagentConfig(join(workspaceA, ".pidesktop-subagents.json"), [{ id: subagentA }]);
    writeHookConfig(join(workspaceA, ".pidesktop-hooks.json"), [hookA]);

    writeSkill(join(workspaceB, ".pidesktop-skills"), skillB);
    writeCommand(join(workspaceB, ".pidesktop-commands"), commandB, "B 项目命令");
    writeSubagentConfig(join(workspaceB, ".pidesktop-subagents.json"), [{ id: subagentB }]);
    writeHookConfig(join(workspaceB, ".pidesktop-hooks.json"), [hookB]);

    const cache = createWorkspaceResources({ agentDir });
    const resourcesA = cache.load(workspaceA);
    const resourcesB = cache.load(workspaceB);

    expect(resourcesA).not.toBe(resourcesB);
    expect(resourcesA.skillSummaries).toBe(resourcesA.skills);

    // A：全局 + A 项目，绝不出现 B 项目资源。
    expect(names(resourcesA.skills)).toEqual(expect.arrayContaining([globalSkill, skillA]));
    expect(names(resourcesA.skills)).not.toContain(skillB);
    expect(resourcesA.discoveredSkills.find((skill) => skill.slug === skillA)?.scope).toBe("project");
    expect(names(resourcesA.commands)).toEqual(expect.arrayContaining([globalCommand, commandA]));
    expect(names(resourcesA.commands)).not.toContain(commandB);
    expect(resourcesA.discoveredCommands.find((command) => command.name === commandA)?.scope).toBe("project");
    expect(resourcesA.subagents.map((entry) => entry.id)).toEqual(expect.arrayContaining([globalSubagent, subagentA]));
    expect(resourcesA.subagents.map((entry) => entry.id)).not.toContain(subagentB);
    expect(resourcesA.subagents.find((entry) => entry.id === subagentA)?.scope).toBe("project");
    expect(names(resourcesA.hooks)).toEqual(expect.arrayContaining([globalHook, hookA]));
    expect(names(resourcesA.hooks)).not.toContain(hookB);
    expect(resourcesA.hooks.find((hook) => hook.name === hookA)?.scope).toBe("project");

    // B：同样的全局来源 + B 项目，不串入 A。
    expect(names(resourcesB.skills)).toEqual(expect.arrayContaining([globalSkill, skillB]));
    expect(names(resourcesB.skills)).not.toContain(skillA);
    expect(names(resourcesB.commands)).toEqual(expect.arrayContaining([globalCommand, commandB]));
    expect(names(resourcesB.commands)).not.toContain(commandA);
    expect(resourcesB.subagents.map((entry) => entry.id)).toEqual(expect.arrayContaining([globalSubagent, subagentB]));
    expect(resourcesB.subagents.map((entry) => entry.id)).not.toContain(subagentA);
    expect(names(resourcesB.hooks)).toEqual(expect.arrayContaining([globalHook, hookB]));
    expect(names(resourcesB.hooks)).not.toContain(hookA);
  });

  it("项目覆盖全局、全局覆盖内置；不同名条目全部保留", () => {
    const agentDir = makeTempDir();
    const workspace = makeTempDir("workspace-resources-precedence-");
    const bundledSkillsDir = makeTempDir("workspace-resources-bundled-skills-");
    const bundledSubagentsDir = makeTempDir("workspace-resources-bundled-subagents-");

    const skillSlug = `${RUN_ID}-precedence-skill`;
    const bundledOnlySkill = `${RUN_ID}-bundled-only-skill`;
    const bundledOnlyName = `${RUN_ID}-仅内置`;
    const globalOverBundledSlug = `${RUN_ID}-global-over-bundled-skill`;
    const globalOverBundledName = `${RUN_ID}-全局覆盖内置`;
    writeSkill(bundledSkillsDir, skillSlug, "内置版");
    writeSkill(join(agentDir, "pidesktop-skills"), skillSlug, "全局版");
    writeSkill(join(workspace, ".pidesktop-skills"), skillSlug, "项目版");
    writeSkill(bundledSkillsDir, bundledOnlySkill, bundledOnlyName);
    writeSkill(bundledSkillsDir, globalOverBundledSlug, "被覆盖的内置版");
    writeSkill(join(agentDir, "pidesktop-skills"), globalOverBundledSlug, globalOverBundledName);

    const commandName = `${RUN_ID}-precedence-command`;
    writeCommand(join(agentDir, "pidesktop-commands"), commandName, "全局版");
    writeCommand(join(workspace, ".pidesktop-commands"), commandName, "项目版");

    const subagentId = `${RUN_ID}-precedence-subagent`;
    const globalOverBundledSubagentId = `${RUN_ID}-global-over-bundled-subagent`;
    writeBundledSubagent(bundledSubagentsDir, { id: subagentId, name: subagentId, systemPrompt: "内置版" });
    writeBundledSubagent(bundledSubagentsDir, { id: globalOverBundledSubagentId, systemPrompt: "内置版" });
    writeSubagentConfig(join(agentDir, "pidesktop-subagents.json"), [
      { id: subagentId, systemPrompt: "全局版" },
      { id: globalOverBundledSubagentId, systemPrompt: "全局覆盖内置" }
    ]);
    writeSubagentConfig(join(workspace, ".pidesktop-subagents.json"), [{ id: subagentId, systemPrompt: "项目版" }]);

    const hookName = `${RUN_ID}-precedence-hook`;
    writeHookConfig(join(agentDir, "pidesktop-hooks.json"), [{ name: hookName, body: "全局版" }]);
    writeHookConfig(join(workspace, ".pidesktop-hooks.json"), [{ name: hookName, body: "项目版" }]);

    const resources = createWorkspaceResources({ agentDir, bundledSkillsDir, bundledSubagentsDir }).load(workspace);

    expect(resources.discoveredSkills.find((skill) => skill.slug === skillSlug)).toMatchObject({ name: "项目版", scope: "project" });
    expect(resources.discoveredSkills.find((skill) => skill.slug === globalOverBundledSlug)).toMatchObject({ name: globalOverBundledName, scope: "global" });
    expect(names(resources.skills)).toContain(bundledOnlyName);

    expect(resources.commands.find((command) => command.name === commandName)).toMatchObject({ description: "项目版", scope: "project" });
    expect(resources.discoveredCommands.find((command) => command.name === commandName)?.scope).toBe("project");

    expect(resources.subagents.find((entry) => entry.id === subagentId)).toMatchObject({ systemPrompt: "项目版", scope: "project" });
    expect(resources.subagents.find((entry) => entry.id === globalOverBundledSubagentId)).toMatchObject({ systemPrompt: "全局覆盖内置", scope: "global" });

    expect(resources.hooks.find((hook) => hook.name === hookName)).toMatchObject({
      scope: "project",
      rule: { action: { kind: "notify", body: "项目版" } }
    });
  });
});

describe("TTL 与失效", () => {
  it("默认 TTL 内命中返回同一对象，过期后重新扫描", () => {
    const agentDir = makeTempDir();
    const workspace = makeTempDir("workspace-resources-ttl-");
    let current = 10_000;
    const cache = createWorkspaceResources({ agentDir, now: () => current });

    const first = cache.load(workspace);
    const projectSkill = `${RUN_ID}-ttl-skill`;
    expect(names(first.skills)).not.toContain(projectSkill);

    // 磁盘已变，但 TTL 内仍返回旧对象（同一引用）。
    writeSkill(join(workspace, ".pidesktop-skills"), projectSkill);
    expect(cache.load(workspace)).toBe(first);

    current += 4_999;
    expect(cache.load(workspace)).toBe(first);

    // 恰好 5s：过期，重新读取并看到新文件。
    current += 1;
    const refreshed = cache.load(workspace);
    expect(refreshed).not.toBe(first);
    expect(names(refreshed.skills)).toContain(projectSkill);
  });

  it("invalidate(workspace) 只清指定工作区；不传参数或 clear() 清全部", () => {
    const agentDir = makeTempDir();
    const workspaceA = makeTempDir("workspace-resources-invalidate-a-");
    const workspaceB = makeTempDir("workspace-resources-invalidate-b-");
    const cache = createWorkspaceResources({ agentDir, now: () => 0 });

    const firstA = cache.load(workspaceA);
    const firstB = cache.load(workspaceB);
    const skillA = `${RUN_ID}-invalidate-a`;
    const skillB = `${RUN_ID}-invalidate-b`;
    writeSkill(join(workspaceA, ".pidesktop-skills"), skillA);
    writeSkill(join(workspaceB, ".pidesktop-skills"), skillB);
    expect(cache.load(workspaceA)).toBe(firstA);
    expect(cache.load(workspaceB)).toBe(firstB);

    // 大小写差异也应命中同一个键。
    expect(cache.load(workspaceA.toUpperCase())).toBe(firstA);
    cache.invalidate(workspaceA.toUpperCase());
    const secondA = cache.load(workspaceA);
    expect(secondA).not.toBe(firstA);
    expect(names(secondA.skills)).toContain(skillA);
    // B 未被误伤。
    expect(cache.load(workspaceB)).toBe(firstB);
    expect(names(firstB.skills)).not.toContain(skillB);

    // 不传参数 = 全清；A 即使没新变化也会重新对象化，B 能看到期间新增的文件。
    cache.invalidate();
    const thirdA = cache.load(workspaceA);
    const secondB = cache.load(workspaceB);
    expect(thirdA).not.toBe(secondA);
    expect(secondB).not.toBe(firstB);
    expect(names(secondB.skills)).toContain(skillB);

    // clear() 与 invalidate() 同义。
    const beforeClearA = cache.load(workspaceA);
    const beforeClearB = cache.load(workspaceB);
    cache.clear();
    expect(cache.load(workspaceA)).not.toBe(beforeClearA);
    expect(cache.load(workspaceB)).not.toBe(beforeClearB);
  });

  it("workspace 缺省使用独立缓存键，不读取当前工作目录的项目来源", () => {
    const agentDir = makeTempDir();
    const workspace = makeTempDir("workspace-resources-none-");
    const globalSkill = `${RUN_ID}-none-global`;
    const projectSkill = `${RUN_ID}-none-project`;
    writeSkill(join(agentDir, "pidesktop-skills"), globalSkill);
    writeSkill(join(workspace, ".pidesktop-skills"), projectSkill);

    const cache = createWorkspaceResources({ agentDir });
    const none = cache.load();
    expect(names(none.skills)).toContain(globalSkill);
    expect(names(none.skills)).not.toContain(projectSkill);
    expect(cache.load()).toBe(none);

    const withWorkspace = cache.load(workspace);
    expect(withWorkspace).not.toBe(none);
    expect(names(withWorkspace.skills)).toContain(projectSkill);

    cache.invalidate();
    expect(cache.load()).not.toBe(none);
  });
});

describe("依赖延迟读取", () => {
  it("agentDir 为函数时在 load 时才调用，TTL 过期后重新取值", () => {
    const agentDirA = makeTempDir("workspace-resources-agent-a-");
    const agentDirB = makeTempDir("workspace-resources-agent-b-");
    const workspace = makeTempDir("workspace-resources-lazy-");
    const globalSkillA = `${RUN_ID}-global-a`;
    const globalSkillB = `${RUN_ID}-global-b`;
    writeSkill(join(agentDirA, "pidesktop-skills"), globalSkillA);
    writeSkill(join(agentDirB, "pidesktop-skills"), globalSkillB);

    let activeAgentDir = agentDirA;
    let calls = 0;
    let current = 1_000;
    const cache = createWorkspaceResources({
      agentDir: () => {
        calls += 1;
        return activeAgentDir;
      },
      ttlMs: 1_000,
      now: () => current
    });

    expect(calls).toBe(0);

    const first = cache.load(workspace);
    expect(calls).toBeGreaterThan(0);
    const callsAfterFirstLoad = calls;
    expect(names(first.skills)).toContain(globalSkillA);
    expect(names(first.skills)).not.toContain(globalSkillB);

    // 缓存命中不重复调用依赖函数。
    cache.load(workspace);
    expect(calls).toBe(callsAfterFirstLoad);

    // 切换底层目录但 TTL 未到：继续用缓存。
    activeAgentDir = agentDirB;
    expect(cache.load(workspace)).toBe(first);

    current += 1_001;
    const refreshed = cache.load(workspace);
    expect(refreshed).not.toBe(first);
    expect(names(refreshed.skills)).toContain(globalSkillB);
    expect(names(refreshed.skills)).not.toContain(globalSkillA);
    expect(calls).toBeGreaterThan(callsAfterFirstLoad);
  });
});

describe("失败稳健性", () => {
  it("单个来源损坏/缺失时其它来源仍可用，load 不抛错", () => {
    const agentDir = makeTempDir();
    const workspace = makeTempDir("workspace-resources-broken-");
    const globalSkill = `${RUN_ID}-broken-global-skill`;
    const globalCommand = `${RUN_ID}-broken-global-command`;
    const globalSubagent = `${RUN_ID}-broken-global-subagent`;
    const globalHook = `${RUN_ID}-broken-global-hook`;
    writeSkill(join(agentDir, "pidesktop-skills"), globalSkill);
    writeCommand(join(agentDir, "pidesktop-commands"), globalCommand, "全局命令");
    writeSubagentConfig(join(agentDir, "pidesktop-subagents.json"), [{ id: globalSubagent }]);
    writeHookConfig(join(agentDir, "pidesktop-hooks.json"), [globalHook]);

    // 项目侧的目录被文件占位（ENOTDIR）与 JSON 损坏：各自只影响自己那一档。
    writeFileSync(join(workspace, ".pidesktop-skills"), "not a directory", "utf8");
    writeFileSync(join(workspace, ".pidesktop-commands"), "not a directory", "utf8");
    writeFileSync(join(workspace, ".pidesktop-subagents.json"), "{ not json", "utf8");
    writeFileSync(join(workspace, ".pidesktop-hooks.json"), "{ not json", "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resources = createWorkspaceResources({ agentDir }).load(workspace);
      expect(names(resources.skills)).toContain(globalSkill);
      expect(names(resources.commands)).toContain(globalCommand);
      expect(resources.subagents.map((entry) => entry.id)).toContain(globalSubagent);
      expect(names(resources.hooks)).toContain(globalHook);
      // 项目资源缺失只体现为空，不会把全局结果一起丢掉。
      expect(resources.discoveredSkills.every((skill) => skill.scope !== "project")).toBe(true);
      expect(resources.hooks.every((hook) => hook.scope !== "project")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
