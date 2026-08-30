import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceDirectoryEntry, WorkspaceDirectoryListing, WorkspaceEntryResult, WorkspaceFilePreview, WorkspaceFileSearchEntry, WorkspaceFileSearchResult, WorkspaceFileWriteResult } from "../shared/protocol.js";
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

export function safeRelativePath(workspace: string, filePath: string): string | undefined {
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

/** edit/write 的产物数组形态（与 changedFile 单文件语义一致，供渲染端聚合）。 */
export function changedWorkspaceFiles(workspace: string | undefined, toolName: string, args: unknown): { relativePath: string }[] | undefined {
  const single = changedWorkspaceFile(workspace, toolName, args);
  return single ? [single] : undefined;
}

/**
 * 纯读类工具：输出是文件内容/目录列表本身，对其结果做路径扫描误报率高，
 * 不参与“交付产物”识别。
 */
const readerToolNames = new Set([
  "read", "grep", "find", "ls", "cat", "head", "tail", "wc", "echo", "sed", "awk", "sort", "less", "more", "file"
]);

/** 不落盘工作区的内置工具：输出是清单/记忆/网页/问答文本，路径扫描误报率高。 */
const nonProducingToolNames = new Set(["ask_question", "recognize_images", "subagent", "memory_read"]);
const nonProducingToolPrefixes = ["todo_", "memory_", "browser_"];

/** 该工具调用可能产出工作区文件（bash 落盘、MCP 生图、扩展工具等），结果文本值得做产物扫描。 */
export function isArtifactProducingTool(toolName: string): boolean {
  if (toolName === "edit" || toolName === "write" || readerToolNames.has(toolName) || nonProducingToolNames.has(toolName)) return false;
  return !nonProducingToolPrefixes.some((prefix) => toolName.startsWith(prefix));
}

/** 工具结果文本中可识别为“交付产物”的文件扩展名（图片优先，含常见交付格式）。 */
const artifactExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".ico", ".svg",
  ".pdf", ".zip", ".docx", ".xlsx", ".pptx", ".md", ".markdown",
  ".mp4", ".mov", ".mp3", ".wav", ".json", ".html", ".htm", ".csv", ".txt"
]);

const artifactTokenPattern = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[^\s"'`<>\[\](){}|;，。；：、！？【】“”‘’*]+\.(?:png|jpe?g|webp|gif|bmp|avif|ico|svg|pdf|zip|docx|xlsx|pptx|md|markdown|mp4|mov|mp3|wav|json|html?|csv|txt)(?![A-Za-z0-9])/giu;

/**
 * 命令文本中显式写出的输出路径：-o/--output/--save* 的值、> / >> 重定向目标、
 * cp/mv/convert/tee 的目标参数（bash 与 powershell 通吃——PS 原生支持 >/>>
 * 重定向，CLI 工具的输出旗标也不随外壳变化）。
 * 这是“脚本把文件写到哪”的最强信号。
 */
const bashOutputFlagPattern = /(?:^|[\s;&|(])(?:-o|-O|--output|--save|--save-to|--out|--outdir|--export|--download|--write)(?:\s*=\s*|\s+)([^\s;&|()<>"'`]+)/giu;
const bashRedirectPattern = /(?:^|[;&|]\s*)[^;&|()<>"'`]*>{1,2}\s*([^\s;&|()<>"'`]+)/giu;
const bashCopyTargetPattern = /\b(?:cp|mv|move|copy|convert|tee)\s+[^\s;&|()<>"'`]+\s+([^\s;&|()<>"'`]+)/giu;
/** PowerShell 专属写文件 cmdlet（Out-File/Set-Content/Add-Content，-FilePath/-Path 可省略走位置参数）。 */
const powershellCmdletOutputPattern = /\b(?:Out-File|Set-Content|Add-Content)\s+(?:-(?:FilePath|Path)\s+)?([^\s;&|()<>"'`]+)/giu;

/**
 * 把单个疑似路径的 token 归一成工作区相对路径候选：工作区内、非忽略目录、
 * 扩展名属常见产物格式，去重并计入 totalCap 上限。
 */
function pushArtifactCandidate(root: string, rawToken: string, seen: Set<string>, candidates: string[], totalCap: number): void {
  if (candidates.length >= totalCap) return;
  let raw = rawToken.trim();
  // 去掉结尾可能粘连的标点/引号（如 “已保存 fox.png。”）。
  raw = raw.replace(/[^A-Za-z0-9_.\\/-]+$/u, "");
  if (!raw) return;
  const relativePath = safeRelativePath(root, raw);
  if (!relativePath) return;
  const key = relativePath.toLowerCase();
  if (seen.has(key)) return;
  if (relativePath.split("/").some((segment) => ignoredWorkspaceEntries.has(segment))) return;
  const extension = extname(relativePath).toLowerCase();
  if (!artifactExtensions.has(extension)) return;
  seen.add(key);
  candidates.push(relativePath);
}

/**
 * 从 bash 命令文本中提取“脚本显式写文件”的路径候选（-o/--output/重定向/cp/mv/tee）。
 * 纯函数不做磁盘校验，存在性由调用方异步 stat 完成。
 */
export function artifactCandidatesFromBashCommand(workspace: string | undefined, command: string): string[] {
  if (!workspace || !command) return [];
  const root = resolve(workspace);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const pattern of [bashOutputFlagPattern, bashRedirectPattern, bashCopyTargetPattern, powershellCmdletOutputPattern]) {
    for (const match of command.matchAll(pattern)) {
      pushArtifactCandidate(root, match[1] ?? "", seen, candidates, 16);
      if (candidates.length >= 16) break;
    }
    if (candidates.length >= 16) break;
  }
  return candidates;
}

/**
 * 从工具结果文本中提取“看起来像已落盘文件路径”的候选（相对路径或绝对路径均可，
 * 不做措辞判断——技能脚本常打印裸路径或 “[OK] 报告.pdf” 这类无保存指示词的行）。
 * cat 内容/git log/目录清单里的提及也在此阶段放行，误报由 existingWorkspaceFiles
 * 的 mtime 门槛剔除：本次调用没写过的文件修改时间早于执行开始。纯函数不做磁盘
 * 校验：候选需在工作区内、非忽略目录、扩展名属常见产物格式，去重并限制数量。
 */
export function artifactCandidatesFromOutput(workspace: string | undefined, output: string): string[] {
  if (!workspace || !output) return [];
  const root = resolve(workspace);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const match of output.matchAll(artifactTokenPattern)) {
    if (candidates.length >= 24) break;
    pushArtifactCandidate(root, match[0], seen, candidates, 24);
  }
  return candidates;
}

/**
 * 对候选产物做存在性校验：仅保留工作区内真实存在的普通文件（含符号链接落点校验）。
 * 传入 minModifiedAt（工具执行的开始时刻）时还要求文件修改时间不早于它——输出文本
 * “被提及”的旧文件不是本次调用写出的，据此剔除；命令里显式写出的路径（-o/重定向/
 * cp/mv）不传该门槛，cp -p/mv 保留旧 mtime 的目标也按产物对待。限制数量防止超长
 * 输出拖慢回填。供 pi-runtime 在工具结束后异步调用。
 */
export async function existingWorkspaceFiles(
  workspace: string | undefined,
  candidates: string[],
  options?: { minModifiedAt?: number }
): Promise<{ relativePath: string }[]> {
  if (!workspace) return [];
  const rootReal = await realpath(resolve(workspace));
  const found: { relativePath: string }[] = [];
  for (const relativePath of candidates) {
    if (found.length >= 12) break;
    const candidate = resolve(rootReal, ...relativePath.split("/"));
    const info = await stat(candidate).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (options?.minModifiedAt !== undefined && info.mtimeMs < options.minModifiedAt) continue;
    const real = await realpath(candidate).catch(() => candidate);
    if (real !== rootReal && !safeRelativePath(rootReal, real)) continue;
    found.push({ relativePath });
  }
  return found;
}

/** mtime 门槛的回退量：容忍事件时间戳与文件系统时间戳之间的微小偏差。 */
const ARTIFACT_MTIME_SLACK_MS = 5_000;

/**
 * 工具调用的交付产物判定（产出型工具专用，实时路径与会话恢复路径共用）：
 * bash 命令里显式写出的路径（-o/--output/重定向/cp/mv/tee）只做存在性校验；
 * 输出文本扫描到的候选还要通过 mtime 门槛——修改时间落在本次执行窗口内才算
 * 本调用写出的文件。返回去重后的工作区相对路径。
 */
export async function collectProducedArtifacts(
  workspace: string | undefined,
  toolName: string,
  args: unknown,
  output: string | undefined,
  startedAt: number
): Promise<{ relativePath: string }[]> {
  if (!workspace || !isArtifactProducingTool(toolName)) return [];
  const command = toolName === "bash" ? (args as { command?: unknown } | undefined)?.command : undefined;
  const commandCandidates = typeof command === "string" ? artifactCandidatesFromBashCommand(workspace, command) : [];
  const outputCandidates = artifactCandidatesFromOutput(workspace, output ?? "");
  const [commandFiles, outputFiles] = await Promise.all([
    commandCandidates.length > 0 ? existingWorkspaceFiles(workspace, commandCandidates) : Promise.resolve([]),
    outputCandidates.length > 0
      ? existingWorkspaceFiles(workspace, outputCandidates, { minModifiedAt: startedAt - ARTIFACT_MTIME_SLACK_MS })
      : Promise.resolve([])
  ]);
  const merged = new Map<string, { relativePath: string }>();
  for (const item of [...commandFiles, ...outputFiles]) merged.set(item.relativePath.toLowerCase(), item);
  return [...merged.values()];
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
  // PDF 由自定义协议 pidesktop-file:// 流式加载（渲染端 iframe 内 Chromium 查看器），
  // 不在此处读取内容，避免大文件在 IPC 与渲染内存中复制。
  if (extension === ".pdf") return { ...base, kind: "pdf" };

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
  invalidateWorkspaceFileIndex();
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

// @ 提及文件索引缓存：写入/新建/删除/重命名时置空，避免菜单里出现已删除的文件。
// 同一 workspace 只保留一份，且仅在工作区内文件变动时失效（Pi 会频繁编辑文件，
// 每次按键都全盘扫描大仓库太昂贵）。
let workspaceFileIndexCache: { workspace: string; root: string; version: number; entries: WorkspaceFileSearchEntry[] } | undefined;
let workspaceFileIndexVersion = 0;

function invalidateWorkspaceFileIndex(): void {
  workspaceFileIndexVersion++;
  workspaceFileIndexCache = undefined;
}

const fileIndexScanLimit = 20000;

/**
 * 递归扫描工作区（跳过忽略目录与符号链接目录），返回文件+目录扁平索引。
 * 超过条目上限时停止扫描，避免在巨型仓库里卡死 @ 菜单。
 */
async function collectWorkspaceFileIndex(workspace: string): Promise<WorkspaceFileSearchEntry[]> {
  if (workspaceFileIndexCache?.workspace === workspace && workspaceFileIndexCache.version === workspaceFileIndexVersion) {
    return workspaceFileIndexCache.entries;
  }
  const root = resolve(workspace);
  const entries: WorkspaceFileSearchEntry[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && entries.length < fileIndexScanLimit) {
    const current = queue.shift()!;
    const dirents = await readdir(current ? join(root, current) : root, { withFileTypes: true }).catch(() => []);
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (!dirent.name || ignoredWorkspaceEntries.has(dirent.name)) continue;
      if (entries.length >= fileIndexScanLimit) break;
      const relativePath = current ? `${current}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, relativePath, kind: "directory" });
        queue.push(relativePath);
      } else {
        entries.push({ name: dirent.name, relativePath, kind: "file" });
      }
    }
  }
  workspaceFileIndexCache = { workspace, root, version: workspaceFileIndexVersion, entries };
  return entries;
}

/** @ 提及评分：basename 精确 < basename 前缀 < basename 包含 < 路径包含；同分路径短者优先。 */
function scoreWorkspaceFileMatch(entry: WorkspaceFileSearchEntry, queryLower: string): number | undefined {
  const nameLower = entry.name.toLowerCase();
  if (nameLower === queryLower) return 0;
  if (nameLower.startsWith(queryLower)) return 1;
  if (nameLower.includes(queryLower)) return 2;
  if (entry.relativePath.toLowerCase().includes(queryLower)) return 3;
  return undefined;
}

export async function searchWorkspaceFiles(workspace: string, query: string, limit = 30): Promise<WorkspaceFileSearchResult> {
  if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请指定要搜索的工作区");
  const normalized = query.trim().replaceAll("\\", "/").replace(/^\/+/u, "");
  const entries = await collectWorkspaceFileIndex(workspace);
  if (!normalized) {
    // 空查询：浅层优先，目录在前，与文件树初印象一致。
    return { entries: entries.slice(0, limit) };
  }
  const queryLower = normalized.toLowerCase();
  const scored = entries
    .map((entry) => {
      const score = scoreWorkspaceFileMatch(entry, queryLower);
      return score === undefined ? undefined : { entry, score };
    })
    .filter((item): item is { entry: WorkspaceFileSearchEntry; score: number } => item !== undefined)
    .sort((a, b) => a.score - b.score
      || a.entry.relativePath.length - b.entry.relativePath.length
      || a.entry.relativePath.localeCompare(b.entry.relativePath));
  return { entries: scored.slice(0, limit).map((item) => item.entry) };
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
  invalidateWorkspaceFileIndex();
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
  invalidateWorkspaceFileIndex();
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
  invalidateWorkspaceFileIndex();
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
  invalidateWorkspaceFileIndex();
  const parent = relativePath.split("/").slice(0, -1).join("/");
  return { relativePath: parent ? `${parent}/${name}` : name };
}
