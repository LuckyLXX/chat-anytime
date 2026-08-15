import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RecentWorkspace } from "../shared/protocol.js";

/**
 * Persisted list of recently opened workspaces (atomic tmp+rename JSON at
 * `<agentDir>/pidesktop-recent-workspaces.json`). The sidebar shows these
 * groups even when a workspace has no sessions yet, so a freshly created
 * project directory appears immediately instead of waiting for the first
 * topic. Most recent first, capped to keep the sidebar tidy.
 */

const MAX_RECENT_WORKSPACES = 15;

interface RecentWorkspacesFile {
  workspaces: RecentWorkspace[];
}

function pathKey(path: string): string {
  return resolve(path).toLowerCase();
}

function normalizeRecord(value: unknown): RecentWorkspace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim() || typeof record.openedAt !== "number") return undefined;
  return { path: resolve(record.path), openedAt: record.openedAt };
}

export function loadRecentWorkspaces(filePath: string): RecentWorkspace[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { workspaces?: unknown }).workspaces)) {
      return (parsed as { workspaces: unknown[] }).workspaces
        .map(normalizeRecord)
        .filter((item): item is RecentWorkspace => Boolean(item))
        .sort((left, right) => right.openedAt - left.openedAt);
    }
  } catch {
    // missing/corrupt file → start empty
  }
  return [];
}

export function writeRecentWorkspaces(filePath: string, workspaces: RecentWorkspace[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const file: RecentWorkspacesFile = { workspaces };
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

/** Move `path` to the front (or add it) with a fresh openedAt; capped + deduped. */
export function recordRecentWorkspace(workspaces: RecentWorkspace[], path: string, openedAt = Date.now()): RecentWorkspace[] {
  if (!path.trim()) return workspaces;
  const key = pathKey(path);
  const rest = workspaces.filter((item) => pathKey(item.path) !== key);
  return [{ path: resolve(path), openedAt }, ...rest].slice(0, MAX_RECENT_WORKSPACES);
}

export function removeRecentWorkspace(workspaces: RecentWorkspace[], path: string): RecentWorkspace[] {
  if (!path.trim()) return workspaces;
  const key = pathKey(path);
  return workspaces.filter((item) => pathKey(item.path) !== key);
}
