import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceDirectoryEntry, WorkspaceDirectoryListing, WorkspaceEntryResult, WorkspaceFilePreview, WorkspaceFileWriteResult } from "../shared/protocol.js";
import { IMAGE_PREVIEW_LIMIT_BYTES } from "../shared/protocol.js";

const textPreviewLimit = 1024 * 1024;
// 与聊天附件（readAttachmentSelection）保持一致：大于该体积的图片无法内联为
// base64 数据 URL 预览，渲染端会提示图片过大。
const imagePreviewLimit = IMAGE_PREVIEW_LIMIT_BYTES;

const markdownExtensions = new Set([".md", ".markdown", ".mdx"]);
// 仅收录 Chromium 可解码的栅格格式（SVG 走下方文本/artifact 分支）。
const imageMimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
const codeLanguages: Record<string, string> = {
  ".bat": "dos",
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cmd": "dos",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".dockerfile": "dockerfile",
  ".env": "properties",
  ".go": "go",
  ".gql": "graphql",
  ".graphql": "graphql",
  ".h": "c",
  ".hpp": "cpp",
  ".htm": "html",
  ".html": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".less": "less",
  ".mjs": "javascript",
  ".php": "php",
  ".ps1": "powershell",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "bash",
  ".sql": "sql",
  ".svelte": "xml",
  ".toml": "ini",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "xml",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zsh": "bash"
};
const filenameLanguages: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile"
};

function safeRelativePath(workspace: string, filePath: string): string | undefined {
  if (!filePath.trim()) return undefined;
  const root = resolve(workspace);
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const value = relative(root, target);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined;
  return value.replaceAll(sep, "/");
}

export function changedWorkspaceFile(workspace: string | undefined, toolName: string, args: unknown): { relativePath: string } | undefined {
  if (!workspace || (toolName !== "edit" && toolName !== "write") || !args || typeof args !== "object") return undefined;
  const values = args as Record<string, unknown>;
  const path = values.path ?? values.file_path ?? values.filePath;
  if (typeof path !== "string") return undefined;
  const relativePath = safeRelativePath(workspace, path);
  return relativePath ? { relativePath } : undefined;
}

async function readPrefix(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  const text = buffer.toString("utf8");
  const replacements = [...text].filter((character) => character === "\uFFFD").length;
  return replacements > Math.max(2, text.length * 0.01);
}

export async function readWorkspaceFilePreview(workspace: string, requestedPath: string): Promise<WorkspaceFilePreview> {
  const relativePath = safeRelativePath(workspace, requestedPath);
  if (!relativePath || isAbsolute(requestedPath)) throw new Error("预览文件路径必须位于当前工作区内");

  // 工作区内的目录链接（Windows junction / 指向目录的符号链接）允许点击浏览与预览，
  // 与资源管理器一致——Windows 上 git 检出默认不产生链接，链接几乎必然是用户自建的。
  // 但目标文件自身若是逃逸到工作区外的符号链接仍然拒绝，防止仓库内预置链接读取任意文件。
  const root = resolve(workspace);
  const candidate = resolve(root, ...relativePath.split("/"));
  const entryInfo = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (entryInfo === undefined) throw new Error("文件不存在或已被删除");
  if (entryInfo.isSymbolicLink()) {
    const rootReal = await realpath(root);
    if (!safeRelativePath(rootReal, await realpath(candidate))) throw new Error("预览文件路径必须位于当前工作区内");
  }
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error("只能预览普通文件");

  const name = basename(candidate);
  const extension = extname(name).toLowerCase();
  const base = { relativePath, name, size: info.size, workspace: root };
  const imageMimeType = imageMimeTypes[extension];
  if (imageMimeType) {
    if (info.size > imagePreviewLimit) return { ...base, kind: "binary", mimeType: imageMimeType };
    const data = await readPrefix(candidate, imagePreviewLimit);
    return { ...base, kind: "image", mimeType: imageMimeType, data: data.toString("base64") };
  }

  const data = await readPrefix(candidate, textPreviewLimit);
  if (looksBinary(data)) return { ...base, kind: "binary" };
  const content = data.toString("utf8");
  const truncated = info.size > data.length || undefined;
  if (markdownExtensions.has(extension)) return { ...base, kind: "markdown", language: "markdown", content, truncated };
  if (extension === ".html" || extension === ".htm") return { ...base, kind: "html", language: "html", content, truncated };
  if (extension === ".svg") return { ...base, kind: "svg", language: "svg", content, truncated };
  const language = filenameLanguages[name.toLowerCase()] ?? codeLanguages[extension];
  if (language) return { ...base, kind: "code", language, content, truncated };
  return { ...base, kind: "text", language: "text", content, truncated };
}

export async function writeWorkspaceFile(workspace: string, requestedPath: string, content: string): Promise<WorkspaceFileWriteResult> {
  const relativePath = safeRelativePath(workspace, requestedPath);
  if (!relativePath || isAbsolute(requestedPath)) throw new Error("写入文件路径必须位于当前工作区内");
  const rootReal = await realpath(resolve(workspace));
  const withinRoot = (real: string): boolean => real === rootReal || Boolean(safeRelativePath(rootReal, real));
  const candidate = resolve(rootReal, ...relativePath.split("/"));
  // 逐级向上找到已存在的最近祖先：已存在的路径段必须落在工作区内，防止符号链接把写入
  // 目标劫持到工作区之外；尚不存在的段是全新创建的，无 symlink 风险。
  let existingAncestor = candidate;
  for (;;) {
    const real = await realpath(existingAncestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (real !== undefined) {
      if (!withinRoot(real)) throw new Error("写入文件路径必须位于当前工作区内");
      break;
    }
    const parent = resolve(existingAncestor, "..");
    if (existingAncestor === parent) break;
    existingAncestor = parent;
  }
  await mkdir(resolve(candidate, ".."), { recursive: true });
  // 目标若已存在，其自身 realpath 必须落在工作区内。
  const existingTarget = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existingTarget && !withinRoot(existingTarget)) throw new Error("写入文件路径必须位于当前工作区内");
  await writeFile(candidate, content, "utf8");
  const info = await stat(candidate);
  const realRelativePath = safeRelativePath(rootReal, await realpath(candidate));
  if (!realRelativePath) throw new Error("写入文件路径必须位于当前工作区内");
  return { saved: true, size: info.size, relativePath: realRelativePath };
}

const ignoredWorkspaceEntries = new Set([
  "node_modules", ".git", ".svn", ".hg", ".next", ".nuxt", ".cache", ".turbo",
  "dist", "out", "build", "coverage", ".DS_Store", "Thumbs.db"
]);

export async function listWorkspaceDirectory(workspace: string, requestedPath?: string): Promise<WorkspaceDirectoryListing> {
  const requested = requestedPath?.trim() ?? "";
  // 词法包含校验后以工作区路径为界浏览：realpath 会把目录链接解析到工作区之外，
  // 但链接是用户放进工作区的入口，展开浏览不应被拒（写入类操作仍走 realpath 严格校验）。
  let realRelative = "";
  if (requested) {
    const probed = safeRelativePath(workspace, requested);
    if (!probed || isAbsolute(requested)) throw new Error("预览目录路径必须位于当前工作区内");
    realRelative = probed;
  }

  const root = resolve(workspace);
  const candidate = realRelative ? resolve(root, ...realRelative.split("/")) : root;
  const info = await stat(candidate);
  if (!info.isDirectory()) throw new Error("只能列出目录");

  const dirents = await readdir(candidate, { withFileTypes: true });
  const entries: WorkspaceDirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.name || ignoredWorkspaceEntries.has(dirent.name)) continue;
    // junction / 符号链接在 readdir 中报为 link 而非 directory：跟随一次 stat 判定
    // 是否目录链接（可展开），断链仍按文件展示。
    let kind: WorkspaceDirectoryEntry["kind"] = dirent.isDirectory() ? "directory" : "file";
    if (kind === "file" && dirent.isSymbolicLink()) {
      const followed = await stat(join(candidate, dirent.name)).catch(() => undefined);
      if (followed?.isDirectory()) kind = "directory";
    }
    const childRelative = realRelative ? `${realRelative}/${dirent.name}` : dirent.name;
    entries.push({ name: dirent.name, relativePath: childRelative, kind });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
  return { relativePath: realRelative, entries };
}

async function statOptional(path: string): Promise<import("node:fs").Stats | undefined> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
}

/**
 * 新建类操作（目标尚不存在）的路径校验：返回工作区内目标的绝对路径。
 * 逐级向上找到已存在的最近祖先并校验其真实路径落在工作区内，防止符号链接
 * 把新建目标劫持到工作区之外；尚不存在的段是全新创建的，无 symlink 风险。
 */
async function resolveNewTarget(rootReal: string, relativePath: string): Promise<string> {
  const candidate = resolve(rootReal, ...relativePath.split("/"));
  let existingAncestor = candidate;
  for (;;) {
    const real = await realpath(existingAncestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (real !== undefined) {
      if (real !== rootReal && !safeRelativePath(rootReal, real)) throw new Error("路径必须位于当前工作区内");
      return candidate;
    }
    const parent = resolve(existingAncestor, "..");
    if (existingAncestor === parent) break;
    existingAncestor = parent;
  }
  throw new Error("路径必须位于当前工作区内");
}

/** 校验已存在条目（或指向它的符号链接）的真实路径位于工作区内，返回其绝对路径。 */
async function resolveExistingTarget(rootReal: string, relativePath: string, action: string): Promise<string> {
  const candidate = resolve(rootReal, ...relativePath.split("/"));
  const candidateReal = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (candidateReal === undefined) throw new Error("条目不存在或已被删除");
  if (candidateReal !== rootReal && !safeRelativePath(rootReal, candidateReal)) {
    // 目录链接（junction / 指向目录的符号链接）指向工作区外时放行：删除/重命名
    // 只作用于工作区内的链接节点，不触碰其目标。文件符号链接仍拒绝。
    const linkInfo = await lstat(candidate);
    const targetInfo = await stat(candidate).catch(() => undefined);
    const isDirectoryLink = linkInfo.isSymbolicLink() && targetInfo?.isDirectory() === true;
    if (!isDirectoryLink) throw new Error(`${action}路径必须位于当前工作区内`);
  }
  return candidate;
}

export async function createWorkspaceFile(workspace: string, requestedPath: string): Promise<WorkspaceEntryResult> {
  const relativePath = safeRelativePath(workspace, requestedPath);
  if (!relativePath || isAbsolute(requestedPath)) throw new Error("新建文件路径必须位于当前工作区内");
  const rootReal = await realpath(resolve(workspace));
  const candidate = await resolveNewTarget(rootReal, relativePath);
  const existing = await statOptional(candidate);
  if (existing) throw new Error(`已存在同名条目：${basename(candidate)}`);
  await mkdir(resolve(candidate, ".."), { recursive: true });
  await writeFile(candidate, "", "utf8");
  const resolved = safeRelativePath(rootReal, await realpath(candidate));
  if (!resolved) throw new Error("新建文件路径必须位于当前工作区内");
  return { relativePath: resolved };
}

export async function createWorkspaceDirectory(workspace: string, requestedPath: string): Promise<WorkspaceEntryResult> {
  const relativePath = safeRelativePath(workspace, requestedPath);
  if (!relativePath || isAbsolute(requestedPath)) throw new Error("新建文件夹路径必须位于当前工作区内");
  const rootReal = await realpath(resolve(workspace));
  const candidate = await resolveNewTarget(rootReal, relativePath);
  const existing = await statOptional(candidate);
  if (existing) throw new Error(`已存在同名条目：${basename(candidate)}`);
  await mkdir(candidate, { recursive: true });
  return { relativePath };
}

export async function deleteWorkspaceEntry(workspace: string, requestedPath: string): Promise<WorkspaceEntryResult> {
  const relativePath = safeRelativePath(workspace, requestedPath);
  if (!relativePath || isAbsolute(requestedPath)) throw new Error("删除路径必须位于当前工作区内");
  const rootReal = await realpath(resolve(workspace));
  const candidate = await resolveExistingTarget(rootReal, relativePath, "删除");
  const info = await lstat(candidate);
  // 对符号链接本身删除（不跟随目标）；对真实目录递归删除其全部内容。
  await rm(candidate, { recursive: info.isDirectory(), force: false });
  return { relativePath };
}

export async function renameWorkspaceEntry(workspace: string, requestedPath: string, newName: string): Promise<WorkspaceEntryResult> {
  const relativePath = safeRelativePath(workspace, requestedPath);
  if (!relativePath || isAbsolute(requestedPath)) throw new Error("重命名路径必须位于当前工作区内");
  const name = newName.trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error("名称无效");
  const rootReal = await realpath(resolve(workspace));
  const from = await resolveExistingTarget(rootReal, relativePath, "重命名");
  const to = resolve(from, "..", name);
  // Windows 大小写不敏感：仅大小写不同的重命名（README.md → readme.md）视为同一条目，放行。
  const sameEntry = process.platform === "win32" ? to.toLowerCase() === from.toLowerCase() : to === from;
  const existing = await statOptional(to);
  if (existing && !sameEntry) throw new Error(`已存在同名条目：${name}`);
  await rename(from, to);
  const parent = relativePath.split("/").slice(0, -1).join("/");
  return { relativePath: parent ? `${parent}/${name}` : name };
}
