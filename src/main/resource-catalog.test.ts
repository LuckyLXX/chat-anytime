import { describe, expect, it } from "vitest";
import type { McpServerSummary, SkillSummary, WorkflowSummary } from "../shared/protocol.js";
import { buildResourceCatalog, emptyResourceCatalog } from "./resource-catalog.js";

describe("buildResourceCatalog", () => {
  it("returns an empty catalog when no providers are given", () => {
    expect(buildResourceCatalog({})).toEqual({
      workflows: { items: [] },
      skills: [],
      commands: [],
      mcpServers: [],
      todos: [],
      memory: [],
      subagents: [],
      hooks: [],
      hooksEnabled: true,
      automation: [],
      automationRuns: [],
      gallery: [],
      diagnostics: []
    });
  });

  it("passes through skills, mcp servers and diagnostics", () => {
    const skill: SkillSummary = {
      id: "skill:abc",
      name: "review",
      description: "Review code",
      source: "用户资源",
      scope: "global",
      defaultEnabled: true,
      enabled: true,
      toggleable: true,
      disableModelInvocation: false
    };
    const server: McpServerSummary = {
      name: "context7",
      scope: "project",
      transport: "stdio",
      command: "npx",
      status: "connected",
      toolCount: 3,
      disabled: false
    };

    const catalog = buildResourceCatalog({ skills: [skill], mcpServers: [server], diagnostics: ["boom"] });

    expect(catalog.skills).toEqual([skill]);
    expect(catalog.mcpServers).toEqual([server]);
    expect(catalog.diagnostics).toEqual(["boom"]);
  });

  it("clones inputs so later mutation does not leak into the catalog", () => {
    const skills: SkillSummary[] = [{
      id: "skill:x",
      name: "x",
      description: "d",
      source: "s",
      scope: "global",
      defaultEnabled: true,
      enabled: true,
      toggleable: true,
      disableModelInvocation: false
    }];
    const catalog = buildResourceCatalog({ skills });
    skills.push({ ...skills[0]!, id: "skill:y" });

    expect(catalog.skills).toHaveLength(1);
  });

  // 工作流目录是 `{ workspace?, items }` 的轻量快照（方案 §8.2）：
  // 只有摘要字段，全文走 workflow.get。这里钉住形状、workspace 的可缺省语义与克隆。
  it("carries the lightweight workflow catalog with its workspace", () => {
    const item: WorkflowSummary = {
      id: "wf-1",
      name: "实施—验收",
      description: "六节点起步模板",
      whenToUse: "需要先审查再验收时",
      nodeCount: 6,
      updatedAt: 1_700_000_000_000,
      runnable: true,
      issueCount: 0
    };

    const catalog = buildResourceCatalog({ workflows: { workspace: "D:/w", items: [item] } });

    expect(catalog.workflows).toEqual({ workspace: "D:/w", items: [item] });
    // 目录里只允许出现摘要字段：整份定义（nodes / edges / prompt）在这一层没有入口。
    expect(Object.keys(catalog.workflows.items[0]!)).toEqual([
      "id",
      "name",
      "description",
      "whenToUse",
      "nodeCount",
      "updatedAt",
      "runnable",
      "issueCount"
    ]);
  });

  it("omits workspace when the directory is not scoped (no workspace -> items empty)", () => {
    const catalog = buildResourceCatalog({ workflows: { items: [] } });

    expect(catalog.workflows).toEqual({ items: [] });
    // 缺省不能写成 `workspace: undefined`：快照要能区分「没有工作区」与「空工作区」。
    expect(Object.keys(catalog.workflows)).toEqual(["items"]);
  });

  it("clones workflow items so later mutation does not leak into the catalog", () => {
    const items: WorkflowSummary[] = [
      { id: "wf-1", name: "甲", nodeCount: 2, updatedAt: 1, runnable: false, issueCount: 3 }
    ];
    const catalog = buildResourceCatalog({ workflows: { workspace: "D:/w", items } });
    items[0]!.name = "乙";
    items.push({ id: "wf-2", name: "丙", nodeCount: 1, updatedAt: 2, runnable: true, issueCount: 0 });

    expect(catalog.workflows.items).toHaveLength(1);
    expect(catalog.workflows.items[0]!.name).toBe("甲");
  });

  it("exposes an empty catalog constant with the new shape", () => {
    expect(emptyResourceCatalog).toEqual({
      workflows: { items: [] },
      skills: [],
      commands: [],
      mcpServers: [],
      todos: [],
      memory: [],
      subagents: [],
      hooks: [],
      hooksEnabled: true,
      automation: [],
      automationRuns: [],
      gallery: [],
      diagnostics: []
    });
  });
});
