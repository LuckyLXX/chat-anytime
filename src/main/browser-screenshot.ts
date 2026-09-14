// Persist browser screenshot captures so text-only conversation models can
// recognize them via the recognize_images `files` argument. A screenshot is
// captured in memory (base64) by browser_* tools; multimodal models see it
// directly, but text-only models get an image placeholder pointing at
// recognize_images. By saving every capture to a stable, workspace-bounded
// directory and returning a workspace-relative path, the model always has a
// real file path to feed recognize_images instead of inventing one.
//
// Scope: the save dir and retention live under the workspace's own
// `.pidesktop` data dir (same home as imported attachments), so the path stays
// inside the workspace boundary enforced by readImageFile (realpath +
// workspaceRelativeAttachment) and never clutters the project root.

import { mkdir, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const SCREENSHOT_DIR_NAME = ".pidesktop/screenshots";
// Keep only the most recent N captures so a long UI-automation loop does not
// grow the directory without bound. Recent captures are enough: a screenshot
// is recognized in the same turn, right after it was taken.
const SCREENSHOT_KEEP = 20;
const SCREENSHOT_FILE_PATTERN = /^(?:browser|design|computer)-.*\.(png|jpg)$/u;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** A sortable, filesystem-safe timestamp: yyyyMMdd-HHmmss-mmm. */
function screenshotTimestamp(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Best-effort retention: delete the oldest screenshots beyond
 * {@link SCREENSHOT_KEEP}. Never throws — cleanup must not break a capture.
 */
async function pruneScreenshots(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const shots = entries.filter((name) => SCREENSHOT_FILE_PATTERN.test(name)).sort();
  const excess = shots.length - SCREENSHOT_KEEP;
  if (excess <= 0) return;
  for (const name of shots.slice(0, excess)) {
    try {
      await unlink(join(dir, name));
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Write a captured screenshot into the workspace's default screenshots dir and
 * return the workspace-relative path (forward slashes) for the model to feed to
 * recognize_images. Timestamped names (plus a uniqueness bump) mean a capture
 * is never clobbered by a later one in the same turn. `prefix` separates the
 * capture sources in the shared dir (browser tabs vs design export thumbnails)
 * while the retention pattern above keeps pruning both.
 */
export async function saveBrowserScreenshot(workspace: string, data: string, mimeType: "image/png" | "image/jpeg", prefix = "browser"): Promise<string> {
  const rootReal = await realpath(resolve(workspace));
  const targetDir = join(rootReal, ...SCREENSHOT_DIR_NAME.split("/"));
  await mkdir(targetDir, { recursive: true });
  const ext = mimeType === "image/jpeg" ? "jpg" : "png";
  const buffer = Buffer.from(data, "base64");
  const base = `${prefix}-${screenshotTimestamp()}`;
  let name = `${base}.${ext}`;
  let target = join(targetDir, name);
  // Guarantee a unique name even within the same millisecond.
  for (let attempt = 1; ; attempt++) {
    try {
      await writeFile(target, buffer, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      name = `${base}-${attempt}.${ext}`;
      target = join(targetDir, name);
    }
  }
  await pruneScreenshots(targetDir).catch(() => undefined);
  return relative(rootReal, target).replaceAll(sep, "/");
}
