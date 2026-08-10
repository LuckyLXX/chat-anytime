import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const desktopDataDirectoryName = ".pidesktop";
const attachmentImportDirectoryName = "attachments";

export function workspaceRelativeAttachment(workspace: string, attachmentPath: string): string {
  const root = resolve(workspace);
  const candidate = resolve(attachmentPath);
  const value = relative(root, candidate);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error("附件必须位于当前工作区内");
  return value.replaceAll(sep, "/");
}

function safeAttachmentName(name: string): string {
  const sanitized = basename(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/u, "")
    .slice(0, 120);
  return sanitized || "attachment";
}

async function ensureWorkspaceDirectory(rootReal: string, path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("附件导入目录必须是工作区内的普通目录");
  workspaceRelativeAttachment(rootReal, await realpath(path));
}

async function validateImportedTarget(rootReal: string, target: string): Promise<string> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("附件导入目标不是普通文件");
  return workspaceRelativeAttachment(rootReal, await realpath(target));
}

export async function importExternalAttachment(workspace: string, attachmentPath: string): Promise<string> {
  const rootReal = await realpath(resolve(workspace));
  const sourcePath = resolve(attachmentPath);
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`附件不是普通文件：${attachmentPath}`);
  const sourceReal = await realpath(sourcePath);

  const appDirectory = join(rootReal, desktopDataDirectoryName);
  const importDirectory = join(appDirectory, attachmentImportDirectoryName);
  await ensureWorkspaceDirectory(rootReal, appDirectory);
  await ensureWorkspaceDirectory(rootReal, importDirectory);

  const sourceData = await readFile(sourceReal);
  const contentHash = createHash("sha256").update(sourceData).digest("hex").slice(0, 16);
  const target = join(importDirectory, `${contentHash}-${safeAttachmentName(sourceReal)}`);
  let targetExisted = false;
  try {
    await writeFile(target, sourceData, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    targetExisted = true;
  }

  const relativePath = await validateImportedTarget(rootReal, target);
  if (targetExisted && !(await readFile(target)).equals(sourceData)) throw new Error("附件导入目标内容不一致");
  return relativePath;
}
