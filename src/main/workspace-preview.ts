import { mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceDirectoryEntry, WorkspaceDirectoryListing, WorkspaceFilePreview, WorkspaceFileWriteResult } from "../shared/protocol.js";

const textPreviewLimit = 1024 * 1024;
const imagePreviewLimit = 5 * 1024 * 1024;

const markdownExtensions = new Set([".md", ".markdown", ".mdx"]);
const imageMimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
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

  const rootReal = await realpath(resolve(workspace));
  const candidateReal = await realpath(resolve(rootReal, ...relativePath.split("/")));
  const realRelativePath = safeRelativePath(rootReal, candidateReal);
  if (!realRelativePath) throw new Error("预览文件路径必须位于当前工作区内");

  const info = await stat(candidateReal);
  if (!info.isFile()) throw new Error("只能预览普通文件");

  const name = basename(candidateReal);
  const extension = extname(name).toLowerCase();
  const base = { relativePath: realRelativePath, name, size: info.size };
  const imageMimeType = imageMimeTypes[extension];
  if (imageMimeType) {
    if (info.size > imagePreviewLimit) return { ...base, kind: "binary", mimeType: imageMimeType };
    const data = await readPrefix(candidateReal, imagePreviewLimit);
    return { ...base, kind: "image", mimeType: imageMimeType, data: data.toString("base64") };
  }

  const data = await readPrefix(candidateReal, textPreviewLimit);
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
  if (requested) {
    const probed = safeRelativePath(workspace, requested);
    if (!probed || isAbsolute(requested)) throw new Error("预览目录路径必须位于当前工作区内");
  }

  const rootReal = await realpath(resolve(workspace));
  const candidateReal = requested ? await realpath(resolve(rootReal, ...requested.split("/"))) : rootReal;
  let realRelative = "";
  if (requested) {
    const resolved = safeRelativePath(rootReal, candidateReal);
    if (!resolved) throw new Error("预览目录路径必须位于当前工作区内");
    realRelative = resolved;
  }

  const info = await stat(candidateReal);
  if (!info.isDirectory()) throw new Error("只能列出目录");

  const dirents = await readdir(candidateReal, { withFileTypes: true });
  const entries: WorkspaceDirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.name || ignoredWorkspaceEntries.has(dirent.name)) continue;
    const childRelative = realRelative ? `${realRelative}/${dirent.name}` : dirent.name;
    entries.push({ name: dirent.name, relativePath: childRelative, kind: dirent.isDirectory() ? "directory" : "file" });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
  return { relativePath: realRelative, entries };
}
