// 人工下载（用户在预览面板里自己点的下载）的纯逻辑：默认目录解析、同名避让、
// 以及「另存为」时的文件搬移。
//
// 背景（真机探针 p8b/p8c 实测，Electron 43）：`will-download` 里**必须同步**
// 调用 `item.setSavePath()`——不在回调里定路径的下载永不 finish（字节到齐、
// 文件停在 <downloads>/<uuid>.tmp、state 一直 progressing）；下载启动后再改
// 路径也不生效（getSavePath() 返回新值，实际文件仍落在旧路径）。所以决策卡片
// 不是「先暂停再定路径」，而是「先按默认目录同步定路径，用户选另存为时再把
// 文件搬过去」。这里放的就是与 Electron 无关的那部分，可直接单测。

import { copyFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** 人工下载的生效配置（dir 永远是绝对路径）。 */
export interface ManualDownloadPrefs {
  /** 默认保存目录。 */
  dir: string;
  /** 每次下载是否弹出决策卡片（缺省 true）。 */
  ask: boolean;
}

/** 配置里的下载目录：空/非字符串回退到系统下载目录（由调用方传入）。 */
export function resolveDownloadDir(configured: unknown, fallback: string): string {
  if (typeof configured === "string" && configured.trim()) return resolve(configured.trim());
  return fallback;
}

/** `settings.browser` → 生效配置（询问开关缺省视为开启）。 */
export function manualDownloadPrefs(browser: { downloadDir?: unknown; downloadAsk?: unknown } | undefined, fallbackDir: string): ManualDownloadPrefs {
  return { dir: resolveDownloadDir(browser?.downloadDir, fallbackDir), ask: browser?.downloadAsk !== false };
}

/**
 * 目录内不冲突的文件名：`photo.png` → `photo-1.png` → `photo-2.png`…
 * 与 `browser-save-image.ts` 的落盘口径一致（绝不覆盖已有文件）。
 */
export function uniqueDownloadName(dir: string, filename: string, isTaken: (path: string) => boolean = existsSync): string {
  if (!isTaken(join(dir, filename))) return filename;
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let attempt = 1; attempt < 500; attempt += 1) {
    const candidate = `${base}-${attempt}${extension}`;
    if (!isTaken(join(dir, candidate))) return candidate;
  }
  return `${base}-${Date.now()}${extension}`;
}

/** `moveDownloadedFile` 的结局：same=源与目标同一路径；failed=见调用方的提示文案。 */
export type MoveDownloadResult = "moved" | "same" | "failed";

/**
 * 把已落盘（或下载完成后落盘）的文件搬到用户选定的位置。
 * 先 rename（同盘瞬时），失败则 copyFile + unlink（跨盘 EXDEV，或 Windows 上目标
 * 已存在——系统保存窗口已就覆盖问过用户，这里照覆盖语义执行）。
 */
export async function moveDownloadedFile(from: string, to: string): Promise<MoveDownloadResult> {
  if (resolve(from) === resolve(to)) return "same";
  try {
    await rename(from, to);
    return "moved";
  } catch {
    // fall through → 跨盘或目标已存在
  }
  try {
    await copyFile(from, to);
    await unlink(from);
    return "moved";
  } catch {
    return "failed";
  }
}
