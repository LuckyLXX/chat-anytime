import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeGalleryApp, trimGalleryApps, type GalleryApp } from "../shared/gallery.js";

/**
 * 作品清单的持久化：`<agentDir>/pidesktop-gallery/gallery.json`（原子 tmp+rename），
 * 缩略图同目录下的 `thumbs/`。
 *
 * 为什么是 agentDir 而不是 settings.json（`settings.ts` 的教训：`persistSettings`
 * 整体重写内存副本，任何「磁盘上有、内存里没有」的字段会在下一次任何设置写入时
 * 被静默删除），也不是工作区目录（清单是**全局跨工作区**的，换工作区不能失效）。
 *
 * 纯函数 + 调用方传绝对路径（照 recent-workspaces.ts 的形状），因此可独立单测。
 */

/** 清单上限与 shared 层一致（超出淘汰最旧并清理其缩略图）。 */
const FILE_NAME = "gallery.json";
const THUMBS_DIR = "thumbs";

export function galleryDirFor(agentDir: string): string {
  return join(agentDir, "pidesktop-gallery");
}

/**
 * 主进程侧的 agentDir 解析：utility 进程用 SDK 的 getAgentDir()，而 main 不能
 * 引 SDK；两者必须指向同一目录，否则「发布的缩略图主进程读不到」。口径照
 * runtime-skills.ts / runtime-computer.ts 的 `homedir()/.pi/agent` 先例。
 *（本机未设 `<APP>_CODING_AGENT_DIR` 环境变量，utilityProcess.fork 也不传 env。）
 */
export function resolveGalleryAgentDir(home = homedir()): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  return join(home, ".pi", "agent");
}

export function galleryPathFor(agentDir: string): string {
  return join(galleryDirFor(agentDir), FILE_NAME);
}

export function galleryThumbsDirFor(agentDir: string): string {
  return join(galleryDirFor(agentDir), THUMBS_DIR);
}

interface GalleryFile {
  apps: GalleryApp[];
}

/** 读：坏 JSON / 缺文件一律回空表，坏条目逐条丢弃。 */
export function loadGallery(filePath: string): GalleryApp[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { apps?: unknown }).apps)) {
      return trimGalleryApps((parsed as { apps: unknown[] }).apps.map(normalizeGalleryApp).filter((app): app is GalleryApp => Boolean(app))).list;
    }
  } catch {
    // missing/corrupt file → start empty
  }
  return [];
}

export function writeGallery(filePath: string, apps: readonly GalleryApp[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const file: GalleryFile = { apps: [...apps] };
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

/**
 * 写回并淘汰超限条目：被淘汰项的缩略图一并删除（否则 thumbs 目录只增不减）。
 * 返回写盘后的清单。
 */
export function persistGallery(filePath: string, apps: readonly GalleryApp[], thumbsDir?: string): GalleryApp[] {
  const { list, dropped } = trimGalleryApps(apps);
  writeGallery(filePath, list);
  if (thumbsDir) for (const app of dropped) removeGalleryThumb(thumbsDir, app.thumb);
  return list;
}

/** 缩略图写盘（调用方已拿到 PNG 字节）：返回文件名（存进条目的 thumb 字段）。 */
export function writeGalleryThumb(thumbsDir: string, fileName: string, data: Buffer): void {
  mkdirSync(thumbsDir, { recursive: true });
  writeFileSync(join(thumbsDir, fileName), data);
}

/** 读缩略图字节；文件缺失返回 undefined（卡片降级为类型徽标，不是错误）。 */
export function readGalleryThumb(thumbsDir: string, fileName: string): Buffer | undefined {
  // 只允许目录内的纯文件名：条目来自可手改的 json，防 `..` 越界读。
  if (!isSafeThumbName(fileName)) return undefined;
  try {
    return readFileSync(join(thumbsDir, fileName));
  } catch {
    return undefined;
  }
}

export function removeGalleryThumb(thumbsDir: string, fileName: string | undefined): void {
  if (!fileName || !isSafeThumbName(fileName)) return;
  try {
    rmSync(join(thumbsDir, fileName), { force: true });
  } catch {
    // 删除失败不影响清单一致性（残留文件在下次同名写入时覆盖）
  }
}

/** 清理孤儿缩略图：清单里已不存在的 `gallery-*.png`（手工删条目、外部工具改过 json 的兜底）。 */
export function pruneGalleryThumbs(thumbsDir: string, apps: readonly GalleryApp[]): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(thumbsDir);
  } catch {
    return 0;
  }
  const keep = new Set(apps.map((app) => app.thumb).filter((name): name is string => Boolean(name)));
  for (const name of entries) {
    if (!/^gallery-.*\.png$/iu.test(name) || keep.has(name)) continue;
    removeGalleryThumb(thumbsDir, name);
    removed += 1;
  }
  return removed;
}

/** 目录内的纯文件名（拒绝路径分隔符与 `..`）。 */
export function isSafeThumbName(name: string): boolean {
  return Boolean(name) && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";
}
