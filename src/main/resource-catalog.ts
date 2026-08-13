import type { McpServerSummary, ResourceCatalog, SkillSummary, Todo } from "../shared/protocol.js";

/**
 * The resource catalog is now a thin aggregate over the self-built capability
 * providers (own MCP client, own Skill discovery, own Todo store). Pi's
 * extension/package plumbing has been removed, so there is no longer any
 * trust/approval layer here — every entry comes from app-owned sources.
 */

export interface ResourceCatalogInput {
  skills?: SkillSummary[];
  mcpServers?: McpServerSummary[];
  todos?: Todo[];
  diagnostics?: string[];
}

export const emptyResourceCatalog: ResourceCatalog = {
  skills: [],
  mcpServers: [],
  todos: [],
  diagnostics: []
};

export function buildResourceCatalog(input: ResourceCatalogInput): ResourceCatalog {
  return {
    skills: input.skills ? structuredClone(input.skills) : [],
    mcpServers: input.mcpServers ? structuredClone(input.mcpServers) : [],
    todos: input.todos ? structuredClone(input.todos) : [],
    diagnostics: input.diagnostics ? [...input.diagnostics] : []
  };
}
