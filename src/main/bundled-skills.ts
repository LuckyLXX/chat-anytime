import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Bundled skills = the `resources/skills/` tree shipped with the installer
 * (electron-builder `extraResources` copies it next to `app.asar`). It is the
 * "built-in skill directory": read directly at runtime, never copied into the
 * user's global/project dirs — an installed app therefore ships its own skills
 * and the user's own skills live in the usual places
 * (`~/.pi/agent/pidesktop-skills/`, `<workspace>/.pidesktop-skills/`).
 *
 * The utility process has no Electron API, so the main process resolves the
 * path here and hands it to the runtime through the `initialize` command.
 *
 * - packaged: `app.getAppPath()` is `<resources>/app.asar` → `<resources>/skills`
 * - dev:      `app.getAppPath()` is the repo root      → `<repo>/resources/skills`
 *
 * Returns undefined when the directory does not exist (a stripped build or a
 * repo checkout without it): callers then simply skip the bundled source.
 * `exists` is injectable for tests.
 */
export function resolveBundledSkillsDir(appPath: string, isPackaged: boolean, exists: (path: string) => boolean = existsSync): string | undefined {
  const candidate = isPackaged
    ? join(dirname(resolve(appPath)), "skills")
    : join(resolve(appPath), "resources", "skills");
  return exists(candidate) ? candidate : undefined;
}
