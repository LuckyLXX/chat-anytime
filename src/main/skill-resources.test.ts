import { describe, expect, it } from "vitest";
import type { ResolvedResource } from "@earendil-works/pi-coding-agent";
import { applyAgentSkillOverrides, enabledSkillResourcePaths, skillResourceId } from "./skill-resources.js";

function skillResource(overrides: Partial<ResolvedResource> = {}): ResolvedResource {
  return {
    path: "C:/Users/test/.agents/skills/review/SKILL.md",
    enabled: true,
    metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: "C:/Users/test/.agents" },
    ...overrides
  };
}

describe("Skill resource settings", () => {
  it("uses stable path-based resource ids", () => {
    expect(skillResourceId("C:\\Users\\test\\skill\\SKILL.md")).toBe(skillResourceId("c:/users/test/skill/SKILL.md"));
  });

  it("layers independent Agent states over the discovered Pi default", () => {
    const enabled = skillResource();
    const disabled = skillResource({ path: "C:/Users/test/.agents/skills/notes/SKILL.md", enabled: false });
    const first = applyAgentSkillOverrides([enabled, disabled], {
      [skillResourceId(enabled.path)]: false,
      [skillResourceId(disabled.path)]: true
    });
    const second = applyAgentSkillOverrides([enabled, disabled], undefined);

    expect(first.map((resource) => resource.enabled)).toEqual([false, true]);
    expect(second.map((resource) => resource.enabled)).toEqual([true, false]);
    expect(first.map((resource) => resource.defaultEnabled)).toEqual([true, false]);
    expect(enabled.enabled).toBe(true);
    expect(disabled.enabled).toBe(false);
    expect(enabledSkillResourcePaths(first)).toEqual([disabled.path]);
  });
});
