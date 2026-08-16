# Project Conventions

- Keep Pi runtime objects behind `src/shared/protocol.ts`; the renderer consumes only the desktop protocol.
- Keep Electron main focused on native lifecycle, dialogs, persistence, and process supervision.
- Run Pi sessions and tools in the utility process, not in the renderer or main process.
- Pi is used only as the Agent runtime core. Its third-party extension access (loading, approval, binding, `pi-mcp-adapter`, subagent CLI shim) has been removed; do not reintroduce it. The only retained extension hooks are app-owned inline extensions: the permission gate and the tool-audit logger.
- Tool pipeline (`src/main/tool-audit.ts`, `src/main/tool-delta.ts`): every tool execution is appended to `chatanytime-sessions/<agentId>/tool-audit.jsonl` (best-effort), and MCP `callTool` is bounded by a 120s `AbortSignal` timeout. MCP tool additions/replacements hot-apply to the live session via `pi.registerTool()` on the captured `ExtensionAPI` (no session rebuild); removals still rebuild the session because Pi has no tool-removal API.
- Capability clusters extracted from `pi-runtime.ts` live in `src/main/runtime-*.ts` (todo-tools / skills / vision / permissions / mcp) as pure builders over explicit inputs; session lifecycle and command dispatch stay in `pi-runtime.ts`.
- Multi-session runtime: `pi-runtime.ts` keeps several sessions alive concurrently as `SessionRuntimeRecord`s (session/busy/status/executions/todos/permission-gate/customTools are per-record) in `liveSessions`, with `activeRuntime` selecting the record that feeds `RuntimeSnapshot`. Switching or creating a session parks the previous one (it keeps executing in the background and can be reactivated as the same live record); only same-session rebuilds, workspace removal, or idle-LRU eviction (`MAX_PARKED_SESSIONS`) dispose records. Sidebar status dots (`SessionSummary.runStatus`): running=yellow is live state; completed=green / failed=red are unseen-outcome notifications that clear on activation (`setTerminalRunStatus`/`activate`) and are never set for the session the user is already viewing.
- Self-built capabilities (MCP / Skill / Subagent / Todo) live in the utility process and are exposed to Pi as `customTools` (`ToolDefinition[]`) on `createAgentSession`, plus system-prompt injection for Skills. Do not run them in the renderer or main.
  - MCP: `src/main/mcp-client.ts` (`McpClientManager`) connects via `@modelcontextprotocol/sdk`; each tool becomes `mcp__<server>__<tool>`. Config in `.mcp.json` (project) / `mcp.json` (global).
  - Skill: `src/main/skill-catalog.ts` scans `pidesktop-skills/` (global) and `.pidesktop-skills/` (project) for `SKILL.md`; enable state in `pidesktop-skill-state.json`.
  - Subagent: `src/main/subagent.ts` `delegate_agent` creates a single-level child `AgentSession` under `chatanytime-sessions/<agentId>/delegations/`.
  - Todo: `src/main/todo-store.ts` atomic JSON, session-scoped at `chatanytime-sessions/<agentId>/todos/<sessionId>.json`; the store is rebuilt in `createSession` so the task panel follows the active session.
- Vision fallback (`src/main/vision.ts`) is NOT a `customTools` injection: when a text-only model receives image attachments, the utility process pre-processes the prompt by calling a user-selected multimodal model from the already-configured provider catalog (`settings.vision` `{ enabled, provider, model }`, resolved via the shared `ModelRuntime`) and injects the recognized text; raw image parts never reach the text-only model.
- Preserve the permission boundary for bash, writes, and paths outside the selected workspace.
- Keep provider secrets process-local unless a dedicated secure-storage design is added.
- Render complete HTML/SVG documents only inside the sandboxed Artifact preview.
- Prefer focused changes. Do not copy ChatAnyTime plugin runtime code into this project.
- Before handoff, run `npm test`, `npm run build`, and a packaged Windows smoke test when packaging behavior changes.
