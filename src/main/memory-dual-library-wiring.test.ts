// 双库记忆（2026-11-09，GitHub issue #2 配套）的接线断言：store / 工具的行为
// 由 memory-store*.test 与 runtime-memory-tools*.test 覆盖，这里只钉「线」——
// 会话创建时是否真的按 recordWorkspace 建项目库、快照是否按双库分段注入、
// 启动时是否真的跑迁移。源断言是本仓库对「纯组件测试全绿但 App 根本没接」
// 的标准防线（见 memory-v4-wiring / memory-overview-wiring）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDualMemorySnapshotBlock, buildMemoryTools } from "./runtime-memory-tools.js";
import { createMemoryStore, workspaceMemoryDirFor } from "./memory-store.js";
import { MEMORY_SNAPSHOT_AGENT_CHARS, MEMORY_SNAPSHOT_BUDGET_CHARS, MEMORY_SNAPSHOT_PROJECT_CHARS } from "../shared/memory.js";

const root = join(__dirname, "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8").replace(/\r\n?/gu, "\n");

describe("dual memory snapshot block", () => {
  it("labels the project section and the agent section separately", () => {
    const block = buildDualMemorySnapshotBlock("- 构建命令 — 本项目怎么打包", "- 写作偏好 — 先确认再动工");
    expect(block).toBeDefined();
    expect(block).toContain("【本项目记忆（工作区项目库，任意助手共享）】");
    expect(block).toContain("【助手记忆（用户偏好/协作纪律，跟人走）】");
    // 项目段在前：项目知识是双库改造的主目标，模型更容易先看到。
    expect(block!.indexOf("本项目记忆")).toBeLessThan(block!.indexOf("助手记忆"));
    // 归库指引必须在场：否则模型会把项目知识写进助手库（改造等于白做）。
    expect(block).toContain("agent_scoped=true");
  });

  it("skips empty sections and returns undefined when both are empty", () => {
    expect(buildDualMemorySnapshotBlock("", "")).toBeUndefined();
    expect(buildDualMemorySnapshotBlock("   \n  ", "")).toBeUndefined();
    const projectOnly = buildDualMemorySnapshotBlock("- 只有项目知识", "");
    expect(projectOnly).toContain("本项目记忆");
    expect(projectOnly).not.toContain("【助手记忆");
    const agentOnly = buildDualMemorySnapshotBlock("", "- 只有助手记忆");
    expect(agentOnly).toContain("助手记忆");
    expect(agentOnly).not.toContain("【本项目记忆");
  });

  it("keeps the two budget constants inside the total budget", () => {
    // 分段预算是「总预算不变」的前提：两段之和不得超过会话注入总量，
    // 否则双库形态会悄悄多付前缀 token（缓存与成本都会疼）。
    expect(MEMORY_SNAPSHOT_PROJECT_CHARS + MEMORY_SNAPSHOT_AGENT_CHARS).toBe(MEMORY_SNAPSHOT_BUDGET_CHARS);
  });
});

describe("dual library tools", () => {
  it("exposes agent_scoped instead of the retired workspace_scoped parameter", () => {
    const tools = buildMemoryTools({ store: createMemoryStore(workspaceMemoryDirFor("."), () => {}), workspace: undefined, enabled: () => true });
    const write = tools.find((tool) => tool.name === "memory_write");
    const schema = JSON.stringify(write?.parameters ?? {});
    expect(schema).toContain("agent_scoped");
    expect(schema).not.toContain("workspace_scoped");
    // 描述里必须写明「缺省写项目库」——这是模型选库的唯一依据。
    expect(write?.description ?? "").toContain("项目库");
  });
});

describe("dual memory wiring", () => {
  it("builds a project store from the record workspace and injects both snapshots", () => {
    const runtime = read("src/main/pi-runtime.ts");
    expect(runtime).toContain("const recordWorkspaceMemoryStore = createMemoryStore(workspaceMemoryDirFor(recordWorkspace), refreshMemory);");
    expect(runtime).toContain("runtimeMemoryTools.buildDualMemorySnapshotBlock(");
    expect(runtime).toContain("recordWorkspaceMemoryStore.snapshotMarkdown(recordWorkspace, MEMORY_SNAPSHOT_PROJECT_CHARS)");
    expect(runtime).toContain("recordMemoryStore.snapshotMarkdown(recordWorkspace, MEMORY_SNAPSHOT_AGENT_CHARS)");
    // 工具上下文要带上项目库，否则 write 仍然只能落助手库。
    expect(runtime).toContain("workspaceStore: recordWorkspaceMemoryStore,");
    // record 字段与快照投影。
    expect(runtime).toContain("workspaceMemoryStore: MemoryStore;");
    expect(runtime).toContain("workspaceMemoryStore: recordWorkspaceMemoryStore,");
  });

  it("runs the workspace split migration once at startup and reports the outcome", () => {
    const runtime = read("src/main/pi-runtime.ts");
    expect(runtime).toContain("migrateWorkspaceBoundTopics(getAgentDir())");
    expect(runtime).toContain("记忆库按工作区拆分：搬走");
    // 迁移失败不能让启动挂掉（只是下次重试）。
    expect(runtime).toContain("记忆库按工作区拆分失败（下次启动重试）");
  });

  it("mirrors both libraries into the renderer and the overview", () => {
    const runtime = read("src/main/pi-runtime.ts");
    expect(runtime).toContain("function recordMemorySummaries(record: SessionRuntimeRecord)");
    expect(runtime).toContain('library: "project" as const');
    expect(runtime).toContain('library: "agent" as const');
    expect(runtime).toContain("function activeMemoryIndexMarkdown()");
    // 记忆中心要能看到项目库（否则用户没有任何治理入口）。
    expect(runtime).toContain("projectRows");
    expect(runtime).toContain("agentName: `项目库 · ${label}`");
  });

  it("keeps the project store reachable for panel commands by virtual row id", () => {
    const runtime = read("src/main/pi-runtime.ts");
    expect(runtime).toContain("const PROJECT_ROW_PREFIX = \"project:\";");
    expect(runtime).toContain("function projectMemoryStoreFromCommand");
    expect(runtime).toContain("function locateMemoryTopicForCommand");
    const protocol = read("src/shared/protocol.ts");
    expect(protocol).toContain("export type MemoryLibrary = \"project\" | \"agent\";");
    expect(protocol).toContain("library?: MemoryLibrary;");
  });
});
