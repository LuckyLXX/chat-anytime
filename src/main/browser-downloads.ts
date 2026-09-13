// Download policy for the built-in browser preview (pure helpers).
//
// The preview tabs are a safe read-only surface by default: every download was
// cancelled outright (`will-download → item.cancel()`), which is the right
// posture for a page the user is merely looking at, but a silent failure for
// browser automation — the model clicks 「导出 CSV」, gets a success receipt and
// no file. Automation-bound tabs therefore get a workspace-scoped drop
// directory instead, and every download (saved or cancelled) is reported back
// in the next operation's receipt.
//
// This module owns the parts that are pure and testable without Electron:
// where automation downloads land, the per-tab cap, and the filename sanitizer
// that keeps a page-supplied `Content-Disposition` name from escaping the drop
// directory (the directory itself is chosen by us; the NAME comes from the
// page, so it is the second line of defence).

import { join } from "node:path";

/** Automation downloads land here (workspace-relative), next to screenshots. */
export const DOWNLOAD_DIR_SEGMENTS = [".pidesktop", "downloads"] as const;

/**
 * How many downloads one automation-bound tab may save per bound round.
 * A hostile or runaway page must not fill the disk; past the cap every further
 * download is cancelled and reported (same order of magnitude as the 20-file
 * `browser_upload` cap).
 */
export const MAX_TAB_DOWNLOADS = 20;

/** Longest sanitized basename; the extension is preserved on truncation. */
export const MAX_DOWNLOAD_NAME_CHARS = 120;

// Windows reserved device names (case-insensitive, any extension) — writing
// `CON.csv` there is either an error or a device write, never a file.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;
// Characters Windows forbids in a file name plus path separators.
const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f]/gu;

/**
 * Turn a page-supplied download filename into a safe basename inside the drop
 * directory:
 * - strips any directory component (`../../etc/passwd` → `passwd`, `a/b.txt` → `b.txt`)
 *   and drops `..` / `.` segments entirely;
 * - removes control characters and Windows-forbidden characters;
 * - collapses whitespace runs and trims leading/trailing dots (trailing dots
 *   are invalid on Windows; a leading dot would hide the file);
 * - escapes reserved device names (`CON`, `NUL`, …);
 * - falls back to `download-<timestamp>` when nothing usable remains;
 * - truncates to {@link MAX_DOWNLOAD_NAME_CHARS} keeping the extension.
 */
export function sanitizeDownloadName(raw: string, now = new Date()): string {
  const fallback = `download-${timestampSlug(now)}`;
  const input = typeof raw === "string" ? raw : "";
  // Take the last path component for BOTH separators, then split again so a
  // mixed `..\../a/b.txt` still yields `b.txt`.
  const segments = input
    .split(/[/\\]+/u)
    .map((segment) => segment.replace(FORBIDDEN_CHARS, "_").replace(/\s+/gu, " ").trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  let name = segments.at(-1) ?? "";
  // A name that was nothing but dots/separators (`..`, `...`) is not usable.
  name = name.replace(/^\.+/u, "").replace(/\.+$/u, "").trim();
  if (!name) return fallback;
  if (WINDOWS_RESERVED.test(name) || WINDOWS_RESERVED.test(name.split(".")[0] ?? "")) {
    name = `_${name}`;
  }
  return truncateKeepingExtension(name, MAX_DOWNLOAD_NAME_CHARS) || fallback;
}

/** `2026-09-13T10-15-30-123` — filesystem-safe and sortable. */
function timestampSlug(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

/** Cut to `limit` chars, keeping a short extension when there is room for one. */
function truncateKeepingExtension(name: string, limit: number): string {
  if (name.length <= limit) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  const room = Math.max(1, limit - ext.length);
  const cut = stem.slice(0, room).replace(/[\s.]+$/u, "");
  return `${cut || "download"}${ext}`;
}

/** Absolute drop directory for a workspace (the caller still mkdirs it). */
export function downloadDirFor(workspace: string): string {
  return join(workspace, ...DOWNLOAD_DIR_SEGMENTS);
}

/** Workspace-relative POSIX path used in receipts (always forward slashes). */
export function downloadRelativePath(filename: string): string {
  return [...DOWNLOAD_DIR_SEGMENTS, filename].join("/");
}

/**
 * 下载通知：AI 会话绑定且 navigate 过工作区的标签页 saved=true（已落盘），
 * 其余一律 saved=false（已取消，附原因）。
 */
export interface DownloadNotice {
  filename: string;
  url: string;
  saved: boolean;
  /** saved=false 时的取消原因；缺省表示预览页的默认安全策略。 */
  reason?: "limit" | "prepare-failed";
  /** 该标签页此后是否不再保存下载（触发了每轮上限）。 */
  limitReached?: boolean;
  /** saved=true：落盘字节数（done 事件后回填）与工作区相对路径。 */
  bytes?: number;
  relativePath?: string;
}
