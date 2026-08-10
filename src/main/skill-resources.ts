import { createHash } from "node:crypto";
import type { ResolvedResource } from "@earendil-works/pi-coding-agent";

export interface AgentSkillResource extends ResolvedResource {
  defaultEnabled: boolean;
}

export function skillResourceId(path: string): string {
  const digest = createHash("sha256").update(path.replaceAll("\\", "/").toLowerCase()).digest("hex").slice(0, 20);
  return `skill:${digest}`;
}

export function canToggleSkillResource(resource: ResolvedResource): boolean {
  return (resource.metadata.scope === "user" || resource.metadata.scope === "project")
    && (resource.metadata.origin === "top-level" || resource.metadata.origin === "package");
}

export function applyAgentSkillOverrides(resources: ResolvedResource[], overrides: Record<string, boolean> | undefined): AgentSkillResource[] {
  return resources.map((resource) => {
    const override = overrides?.[skillResourceId(resource.path)];
    return {
      ...resource,
      defaultEnabled: resource.enabled,
      enabled: typeof override === "boolean" ? override : resource.enabled
    };
  });
}

export function enabledSkillResourcePaths(resources: ResolvedResource[]): string[] {
  return resources.filter((resource) => resource.enabled).map((resource) => resource.path);
}
