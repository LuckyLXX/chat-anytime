import { describe, expect, it } from "vitest";
import type { McpServerSummary, SkillSummary } from "../shared/protocol.js";
import { buildResourceCatalog, emptyResourceCatalog } from "./resource-catalog.js";

describe("buildResourceCatalog", () => {
  it("returns an empty catalog when no providers are given", () => {
    expect(buildResourceCatalog({})).toEqual({
      skills: [],
      mcpServers: [],
      todos: [],
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

  it("exposes an empty catalog constant with the new shape", () => {
    expect(emptyResourceCatalog).toEqual({
      skills: [],
      mcpServers: [],
      todos: [],
      diagnostics: []
    });
  });
});
