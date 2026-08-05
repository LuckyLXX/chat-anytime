# Project Conventions

- Keep Pi runtime objects behind `src/shared/protocol.ts`; the renderer consumes only the desktop protocol.
- Keep Electron main focused on native lifecycle, dialogs, persistence, and process supervision.
- Run Pi sessions and tools in the utility process, not in the renderer or main process.
- Preserve the permission boundary for bash, writes, and paths outside the selected workspace.
- Keep provider secrets process-local unless a dedicated secure-storage design is added.
- Render complete HTML/SVG documents only inside the sandboxed Artifact preview.
- Prefer focused changes. Do not copy ChatAnyTime plugin runtime code into this project.
- Before handoff, run `npm test`, `npm run build`, and a packaged Windows smoke test when packaging behavior changes.
