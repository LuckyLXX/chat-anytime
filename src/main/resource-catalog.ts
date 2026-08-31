import type { CommandSummary, HookSummary, McpServerSummary, MemoryTopic, ResourceCatalog, SkillSummary, Todo } from "../shared/protocol.js";

/**
 * The resource catalog is now a thin aggregate over the self-built capability
 * providers (own MCP client, own Skill discovery, own Todo store). Pi's
 * extension/package plumbing has been removed, so there is no longer any
 * trust/approval layer here — every entry comes from app-owned sources.
 */

export interface ResourceCatalogInput {
  skills?: SkillSummary[];
  commands?: CommandSummary[];
  mcpServers?: McpServerSummary[];
  todos?: Todo[];
  /** 激活助手的全量记忆主题（面板治理视图，不经工作区过滤）。 */
  memory?: MemoryTopic[];
  /** 双作用域合并后的钩子规则（项目覆盖全局）。 */
  hooks?: HookSummary[];
  /** 钩子总开关（settings.hooks 的实时投影）。 */
  hooksEnabled?: boolean;
  diagnostics?: string[];
}

export const emptyResourceCatalog: ResourceCatalog = {
  skills: [],
  commands: [],
  mcpServers: [],
  todos: [],
  memory: [],
  hooks: [],
  hooksEnabled: true,
  diagnostics: []
};

export function buildResourceCatalog(input: ResourceCatalogInput): ResourceCatalog {
  return {
    skills: input.skills ? structuredClone(input.skills) : [],
    commands: input.commands ? structuredClone(input.commands) : [],
    mcpServers: input.mcpServers ? structuredClone(input.mcpServers) : [],
    todos: input.todos ? structuredClone(input.todos) : [],
    memory: input.memory ? structuredClone(input.memory) : [],
    hooks: input.hooks ? structuredClone(input.hooks) : [],
    hooksEnabled: input.hooksEnabled !== false,
    diagnostics: input.diagnostics ? [...input.diagnostics] : []
  };
}
