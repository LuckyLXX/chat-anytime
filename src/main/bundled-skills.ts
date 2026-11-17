import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Bundled assets = the `resources/` tree shipped with the installer
 * (electron-builder `extraResources` copies `resources/skills` → `<install>/skills`
 * and `resources/subagents` → `<install>/subagents`). They are the "built-in"
 * sources: read directly at runtime, never copied into the user's global/project
 * dirs — an installed app ships its own assets, and the user's own live in the
 * usual places (`~/.pi/agent/…`, `<workspace>/…`).
 *
 * The utility process has no Electron API, so the main process resolves the paths
 * here and hands them to the runtime through the `initialize` command.
 *
 * - packaged: `app.getAppPath()` is `<resources>/app.asar` → `<resources>/<name>`
 * - dev:      `app.getAppPath()` is the repo root      → `<repo>/resources/<name>`
 *
 * Returns undefined when the directory does not exist (a stripped build or a repo
 * checkout without it): callers then simply skip the bundled source.
 * `exists`/`appPathResolver` are injectable for tests.
 */
function resolveBundledDir(appPath: string, isPackaged: boolean, name: string, exists: (path: string) => boolean): string | undefined {
  const candidate = isPackaged
    ? join(dirname(resolve(appPath)), name)
    : join(resolve(appPath), "resources", name);
  return exists(candidate) ? candidate : undefined;
}

export function resolveBundledSkillsDir(appPath: string, isPackaged: boolean, exists: (path: string) => boolean = existsSync): string | undefined {
  return resolveBundledDir(appPath, isPackaged, "skills", exists);
}

/** 内置子智能体目录：与 skills 同布局（打包 `<安装目录>/subagents`，dev `<repo>/resources/subagents`）。 */
export function resolveBundledSubagentsDir(appPath: string, isPackaged: boolean, exists: (path: string) => boolean = existsSync): string | undefined {
  return resolveBundledDir(appPath, isPackaged, "subagents", exists);
}

/**
 * 内置查找工具目录（打包 `<安装目录>/tools`，dev `<repo>/resources/tools`）：里面是随包分发的
 * fd / rg 可执行文件。与 skills/subagents 不同，它们不能「直接读」——Pi 只认 `<agentDir>/bin`
 * 与系统 PATH，所以由 utility 进程启动时同步过去（见 bundled-tools.ts）。
 */
export function resolveBundledToolsDir(appPath: string, isPackaged: boolean, exists: (path: string) => boolean = existsSync): string | undefined {
  return resolveBundledDir(appPath, isPackaged, "tools", exists);
}
