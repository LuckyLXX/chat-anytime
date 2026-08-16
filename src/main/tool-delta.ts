/**
 * Diff helper for hot-reloading the Pi customTool registry.
 *
 * Pi's `pi.registerTool()` can add or replace tools on a live session but has
 * no removal API, so callers use the diff to decide between the hot path
 * (additions/replacements only) and a full session rebuild (any removal).
 */

export interface ToolNameDelta {
  /** Names present only in the new set (also covers same-name replacements). */
  added: string[];
  /** Names present only in the old set — these force the rebuild path. */
  removed: string[];
}

export function diffToolNames(oldNames: readonly string[], newNames: readonly string[]): ToolNameDelta {
  const oldSet = new Set(oldNames);
  const newSet = new Set(newNames);
  return {
    added: newNames.filter((name) => !oldSet.has(name)),
    removed: oldNames.filter((name) => !newSet.has(name))
  };
}
