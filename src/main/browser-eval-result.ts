// Persist oversized browser_eval results so the model can read them back in
// full instead of receiving a JSON fragment cut mid-token. Mirrors
// browser-screenshot.ts: workspace-bounded dir, timestamped unique name,
// best-effort retention, never throws for the caller's critical path.
//
// Why this exists: `evaluateJs` caps its serialized return at
// MAX_EVAL_RESULT_CHARS and truncates head-first, so a 2000-row JSON.stringify
// arrives as `[{"id":1,"name":"a"},{"id":2,"na` — the model either burns a
// round trip narrowing the expression or (worse) treats the fragment as the
// whole result. Spilling to disk lets the receipt carry the TOTAL size plus a
// readable path, so "how much am I missing" is answerable without guessing.

import { mkdir, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const EVAL_DIR_SEGMENTS = [".pidesktop", "eval"] as const;
// Keep only the most recent N spills: an extraction loop can produce rolls of
// large results, and the file is only useful while the model is still reading
// it back (same turn / same task).
export const EVAL_KEEP = 20;
const EVAL_FILE_PATTERN = /^eval-.*\.(json|txt)$/u;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** A sortable, filesystem-safe timestamp: yyyyMMdd-HHmmss-mmm. */
function evalTimestamp(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Whether a serialized eval result is JSON-looking. Only decides the file
 * extension (readability), never correctness: a misjudged value degrades to
 * `.txt`, which read tools handle identically.
 */
export function isJsonLikeText(text: string): boolean {
  const head = text.trimStart()[0];
  return head === "{" || head === "[";
}

/**
 * Best-effort retention: delete the oldest spills beyond {@link EVAL_KEEP}.
 * Never throws — cleanup must not break a spill that already succeeded.
 */
async function pruneEvalResults(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const spills = entries.filter((name) => EVAL_FILE_PATTERN.test(name)).sort();
  const excess = spills.length - EVAL_KEEP;
  if (excess <= 0) return;
  for (const name of spills.slice(0, excess)) {
    try {
      await unlink(join(dir, name));
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Write one oversized eval result into the workspace's `.pidesktop/eval/` dir
 * and return the workspace-relative path (forward slashes) for the model to
 * `read` in chunks. Timestamped names (plus a uniqueness bump) mean two spills
 * in the same millisecond never clobber each other.
 */
export async function saveBrowserEvalResult(workspace: string, text: string, isJson: boolean): Promise<string> {
  const rootReal = await realpath(resolve(workspace));
  const targetDir = join(rootReal, ...EVAL_DIR_SEGMENTS);
  await mkdir(targetDir, { recursive: true });
  const ext = isJson ? "json" : "txt";
  const base = `eval-${evalTimestamp()}`;
  let name = `${base}.${ext}`;
  let target = join(targetDir, name);
  // Guarantee a unique name even within the same millisecond.
  for (let attempt = 1; ; attempt++) {
    try {
      await writeFile(target, text, { flag: "wx", encoding: "utf8" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      name = `${base}-${attempt}.${ext}`;
      target = join(targetDir, name);
    }
  }
  await pruneEvalResults(targetDir).catch(() => undefined);
  return relative(rootReal, target).replaceAll(sep, "/");
}
