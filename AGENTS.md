# Project Conventions

- Keep Pi runtime objects behind `src/shared/protocol.ts`; the renderer consumes only the desktop protocol.
- Keep Electron main focused on native lifecycle, dialogs, persistence, and process supervision.
- Run Pi sessions and tools in the utility process, not in the renderer or main process.
- Pi is used only as the Agent runtime core. Its third-party extension access (loading, approval, binding, `pi-mcp-adapter`, subagent CLI shim) has been removed; do not reintroduce it. The one retained extension hook is the app-owned `createPermissionExtension` that gates risky tool calls.
- Self-built capabilities (MCP / Skill / Subagent / Todo) live in the utility process and are exposed to Pi as `customTools` (`ToolDefinition[]`) on `createAgentSession`, plus system-prompt injection for Skills. Do not run them in the renderer or main.
  - MCP: `src/main/mcp-client.ts` (`McpClientManager`) connects via `@modelcontextprotocol/sdk`; each tool becomes `mcp__<server>__<tool>`. Config in `.mcp.json` (project) / `mcp.json` (global).
  - Skill: `src/main/skill-catalog.ts` scans `pidesktop-skills/` (global) and `.pidesktop-skills/` (project) for `SKILL.md`; enable state in `pidesktop-skill-state.json`.
  - Subagent: `src/main/subagent.ts` `delegate_agent` creates a single-level child `AgentSession` under `chatanytime-sessions/<agentId>/delegations/`.
  - Todo: `src/main/todo-store.ts` atomic JSON, session-scoped at `chatanytime-sessions/<agentId>/todos/<sessionId>.json`; the store is rebuilt in `createSession` so the task panel follows the active session.
- Preserve the permission boundary for bash, writes, and paths outside the selected workspace.
- Keep provider secrets process-local unless a dedicated secure-storage design is added.
- Render complete HTML/SVG documents only inside the sandboxed Artifact preview.
- Prefer focused changes. Do not copy ChatAnyTime plugin runtime code into this project.
- Before handoff, run `npm test`, `npm run build`, and a packaged Windows smoke test when packaging behavior changes.
