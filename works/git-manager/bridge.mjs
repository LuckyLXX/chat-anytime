#!/usr/bin/env node
/**
 * Git Bridge —— 面板作品「Git 管理器」的本地数据源（零依赖，Node 18+）。
 *
 * 为什么需要它：面板作品页跑在 `pidesktop-file://w-<作品 id>` 上（无 preload、无 IPC、
 * 跑不了外部命令），而 git 数据必须现算。平台在开面板窗前把本服务拉起来（作品声明
 * command + url，见 gallery_publish 与 shared/gallery.ts 的 start-panel-service），
 * 面板页再 fetch 本服务取 JSON。
 *
 * 设计纪律（每一条都有代价可讲）：
 * - **零依赖**：只用 node 内置模块，`node bridge.mjs` 就能跑，用户不需要 npm install。
 * - **只监听 127.0.0.1**：本机服务，不对外暴露；端口默认 8791（`--port` 可覆盖）。
 * - **只读**：全部是查询类 git 命令，不写仓库、不碰工作区文件（作品不做写操作）。
 * - **不开 shell**：一律 `spawn("git", [args])`，仓库路径与文件名不进命令行解释器。
 * - **无状态**：仓库路径每次请求自带（`?path=`），服务不记任何仓库、不落任何盘。
 * - **自带 CORS**：`Access-Control-Allow-Origin: *`。面板窗口有平台级跨域放宽
 *   （main/panel-cors.ts），但**在内置浏览器里开发同一个页面**时是另一个 origin
 *   （http 随机端口 = 正常浏览器语义），那里没有放宽 —— 头必须由服务自己给。
 * - **同源降级**：顺手把作品目录的静态文件也发出去，于是「面板页 fetch 被拦」时有
 *   退路：面板里打开 http://127.0.0.1:8791 就是同一份 UI，同源零跨域。
 *
 * 端点（全部 GET，错误也是 200 + `{ ok:false, error }`，前端一套判据处理）：
 *   /api/health                     存活探针（作品声明的 url 就是它）
 *   /api/repo?path=                 仓库概要（根、当前分支、HEAD、origin）
 *   /api/refs?path=                 分支 / 远程分支 / 标签
 *   /api/log?path=&skip=&limit=&all= 提交列表（默认全部分支，新→旧）
 *   /api/commit?path=&sha=          单提交详情 + 变更文件（状态 + 增删行）
 *   /api/diff?path=&sha=&file=      单个文件的补丁文本（mode=worktree|index|untracked 看未提交改动）
 *   /api/status?path=               工作区状态（已暂存 / 未暂存 / 未跟踪 + ahead/behind）
 *   /                               index.html（静态降级通道）
 *   /*.css|*.js|*.svg|*.png|*.json  同目录静态文件
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8791;
/** 单次 git 输出上限：超大补丁不撑爆面板内存（超出截断并如实标记）。 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** 单次 git 调用超时：本机查询命令不该慢到需要等更久（大仓库首次 status 可能几秒）。 */
const GIT_TIMEOUT_MS = 20_000;
/** 提交列表单页上限（前端分页加载，避免一次拉几万条）。 */
const MAX_LOG_LIMIT = 200;
const DEFAULT_LOG_LIMIT = 60;

/** 记录分隔符（RS）与字段分隔符（US）：提交正文可能含换行与任意文本，普通分隔符会被内容破坏。 */
const RS = "\x1e";
const US = "\x1f";
const LOG_FORMAT = ["%H", "%h", "%P", "%an", "%ae", "%ad", "%at", "%D", "%s", "%b"].join("%x1f") + "%x1e";

/**
 * 跑一条 git 命令。**永远 resolve**（失败也是一个结果对象），调用方按 `ok` 分支处理。
 * 路径参数一律走 `cwd`，不进命令行字符串。
 */
function runGit(repo, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, { cwd: repo, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: `无法启动 git：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const chunks = [];
    const errors = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
      resolve({ ok: false, error: `git 命令超时（${Math.round(GIT_TIMEOUT_MS / 1000)} 秒）：git ${args[0]}` });
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
      else truncated = true;
    });
    child.stderr.on("data", (chunk) => {
      if (size + chunk.length <= MAX_OUTPUT_BYTES) errors.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = /ENOENT/u.test(String(error.code)) ? "（机器上没有找到 git，请先安装 Git 并确保它在 PATH 里）" : "";
      resolve({ ok: false, error: `git 启动失败：${error.message}${hint}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (code === 0) resolve({ ok: true, stdout, stderr, truncated });
      else resolve({ ok: false, error: stderr || `git ${args[0]} 退出代码 ${code}`, exitCode: code });
    });
  });
}

/** git 输出按行切（去掉尾部空行）。 */
function lines(text) {
  return text.split(/\r?\n/u).filter((line) => line.length > 0);
}

/** 参数校验：仓库路径必须是存在的绝对路径，且在 `git rev-parse` 层面确实是个仓库。 */
function validRepoPath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !isAbsolute(text)) return undefined;
  return text;
}

/** sha / 引用表达式：字母数字与 `~^._-/@{` 一类符号，绝不允许以 `-` 开头（防选项注入）。 */
function validRevision(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 80 || text.startsWith("-")) return undefined;
  if (!/^[0-9a-zA-Z_~^.@/{}-]+$/u.test(text)) return undefined;
  return text;
}

/** 文件名：不能以 `-` 开头（否则会被 git 当成选项），长度设上限。 */
function validFile(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > 1024 || text.startsWith("-") || text.includes("\0")) return undefined;
  return text;
}

/** 解析 `for-each-ref` 的一行（tab 分隔，ref 名里不会有 tab）。 */
function parseRefLine(line) {
  const [refname, objectname, deref, upstream, head] = line.split("\t");
  if (!refname) return undefined;
  const sha = (deref || objectname || "").trim();
  const name = refname
    .replace(/^refs\/heads\//u, "")
    .replace(/^refs\/remotes\//u, "")
    .replace(/^refs\/tags\//u, "");
  const kind = refname.startsWith("refs/heads/") ? "local" : refname.startsWith("refs/remotes/") ? "remote" : "tag";
  // origin/HEAD 是符号引用，指向默认分支，列表里没有意义
  if (kind === "remote" && name.endsWith("/HEAD")) return undefined;
  return { name, kind, sha, current: head === "*", upstream: (upstream || "").trim() || undefined };
}

/** 解析 `%D` 的装饰串（`HEAD -> main, origin/main, tag: v1.0`）。 */
function parseDecorations(text) {
  if (!text) return [];
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((label) => {
      if (label.startsWith("HEAD -> ")) return { name: label.slice(8), kind: "head" };
      if (label === "HEAD") return { name: "HEAD", kind: "detached" };
      if (label.startsWith("tag: ")) return { name: label.slice(5), kind: "tag" };
      return { name: label, kind: label.includes("/") ? "remote" : "branch" };
    });
}

/** 解析 `--pretty=format:...%x1e` 的输出。正文可能多行，所以先按 RS 切记录。 */
function parseLog(text) {
  return text
    .split(RS)
    .map((record) => record.replace(/^\r?\n/u, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha, shortSha, parents, author, email, date, epoch, decorations, subject, body] = record.split(US);
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        parents: (parents ?? "").split(" ").filter(Boolean),
        author: author ?? "",
        email: email ?? "",
        date: date ?? "",
        epoch: Number.parseInt(epoch ?? "0", 10) || 0,
        subject: subject ?? "",
        body: (body ?? "").replace(/\s+$/u, ""),
        refs: parseDecorations(decorations ?? "")
      };
    });
}

/** `diff-tree --numstat` 的一行：`12	3	path`（二进制是 `-	-	path`）。 */
function parseNumstat(text) {
  const map = new Map();
  for (const line of lines(text)) {
    const [add, del, ...rest] = line.split("\t");
    if (!rest.length) continue;
    const path = rest.join("\t");
    const binary = add === "-" || del === "-";
    map.set(path, { add: binary ? 0 : Number.parseInt(add, 10) || 0, del: binary ? 0 : Number.parseInt(del, 10) || 0, binary });
  }
  return map;
}

/** `diff-tree --name-status` 的一行：`M	path` / `R100	old	new`。 */
function parseNameStatus(text) {
  const map = new Map();
  for (const line of lines(text)) {
    const parts = line.split("\t");
    const statusRaw = parts[0] ?? "";
    if (statusRaw.startsWith("R") || statusRaw.startsWith("C")) {
      const to = parts[2] ?? parts[1] ?? "";
      map.set(to, { status: statusRaw.slice(0, 1), oldPath: parts[1] });
      continue;
    }
    const path = parts[1] ?? "";
    map.set(path, { status: statusRaw.slice(0, 1) });
  }
  return map;
}

/**
 * `status --porcelain=v1 -z` 的解析。
 * -z 模式下重命名会多带一段原路径（`R  new\0old\0`），所以用索引推进而不是按行切。
 */
function parseStatus(text) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const fields = text.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry || entry.length < 3) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === "?" && y === "?") {
      untracked.push({ path });
      continue;
    }
    let oldPath;
    if (x === "R" || x === "C") {
      index += 1;
      oldPath = fields[index];
    }
    if (x !== " " && x !== "?") staged.push({ path, status: x, oldPath });
    if (y !== " " && y !== "?") unstaged.push({ path, status: y, oldPath });
  }
  return { staged, unstaged, untracked };
}

// —— 端点实现 ——

async function apiRepo(repo) {
  const root = await runGit(repo, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return { ok: false, error: "这不是一个 Git 仓库（或路径不可访问）" };
  const top = root.stdout.trim().replace(/\\/gu, "/");
  const branchResult = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headResult = await runGit(repo, ["rev-parse", "HEAD"]);
  const remoteResult = await runGit(repo, ["remote", "get-url", "origin"]);
  const branch = branchResult.ok ? branchResult.stdout.trim() : "";
  return {
    ok: true,
    path: repo.replace(/\\/gu, "/"),
    root: top,
    name: basename(top),
    branch,
    detached: branch === "HEAD",
    head: headResult.ok ? headResult.stdout.trim() : undefined,
    empty: !headResult.ok,
    remote: remoteResult.ok ? remoteResult.stdout.trim() : undefined
  };
}

async function apiRefs(repo) {
  const result = await runGit(repo, [
    "for-each-ref",
    `--format=%(refname)%09%(objectname)%09%(*objectname)%09%(upstream:short)%09%(HEAD)`,
    "refs/heads",
    "refs/remotes",
    "refs/tags"
  ]);
  if (!result.ok) return { ok: false, error: result.error };
  const branches = [];
  const tags = [];
  for (const line of lines(result.stdout)) {
    const ref = parseRefLine(line);
    if (!ref) continue;
    if (ref.kind === "tag") tags.push({ name: ref.name, sha: ref.sha });
    else branches.push(ref);
  }
  return { ok: true, branches, tags };
}

async function apiLog(repo, query) {
  const limitRaw = Number.parseInt(query.get("limit") ?? "", 10);
  const skipRaw = Number.parseInt(query.get("skip") ?? "", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LOG_LIMIT, 1), MAX_LOG_LIMIT);
  const skip = Math.max(Number.isFinite(skipRaw) && skipRaw > 0 ? skipRaw : 0, 0);
  const all = query.get("all") !== "0";
  const args = ["log", `--max-count=${limit + 1}`, `--skip=${skip}`, "--date=iso-strict", `--pretty=format:${LOG_FORMAT}`];
  if (all) args.push("--all");
  const result = await runGit(repo, args);
  if (!result.ok) {
    // 空仓库：`git log` 会以非 0 退出，但这不是错误，而是「还没有提交」
    const head = await runGit(repo, ["rev-parse", "HEAD"]);
    if (!head.ok) return { ok: true, commits: [], hasMore: false, empty: true };
    return { ok: false, error: result.error };
  }
  const commits = parseLog(result.stdout);
  const hasMore = commits.length > limit;
  return { ok: true, commits: commits.slice(0, limit), hasMore, skip, truncated: Boolean(result.truncated) };
}

async function apiCommit(repo, sha) {
  const head = await runGit(repo, ["show", "--no-patch", "--date=iso-strict", `--pretty=format:${LOG_FORMAT}`, sha]);
  if (!head.ok) return { ok: false, error: head.error };
  const [commit] = parseLog(head.stdout);
  if (!commit) return { ok: false, error: "找不到这个提交" };
  // --root：根提交（没有父）也能列出全部文件；-M 让重命名按「改名」而不是「删+增」呈现。
  const [numstat, nameStatus] = await Promise.all([
    runGit(repo, ["diff-tree", "-r", "-M", "--root", "--no-commit-id", "--numstat", sha]),
    runGit(repo, ["diff-tree", "-r", "-M", "--root", "--no-commit-id", "--name-status", sha])
  ]);
  const numbers = numstat.ok ? parseNumstat(numstat.stdout) : new Map();
  const statuses = nameStatus.ok ? parseNameStatus(nameStatus.stdout) : new Map();
  const paths = new Set([...statuses.keys(), ...numbers.keys()]);
  const files = [];
  let add = 0;
  let del = 0;
  for (const path of paths) {
    const status = statuses.get(path) ?? {};
    const stat = numbers.get(path) ?? {};
    files.push({
      path,
      oldPath: status.oldPath,
      status: status.status ?? "M",
      add: stat.add ?? 0,
      del: stat.del ?? 0,
      binary: Boolean(stat.binary)
    });
    add += stat.add ?? 0;
    del += stat.del ?? 0;
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { ok: true, commit, files, stats: { files: files.length, add, del } };
}

async function apiDiff(repo, sha, file, mode) {
  // mode=worktree 是「工作区 vs 已暂存」，mode=index 是「已暂存 vs HEAD」，
  // mode=untracked 是「还没纳入版本控制的新文件」—— 第三种 git 给不出补丁，
  // 由本服务把文件内容合成一个「全是新增行」的补丁，让面板能直接看内容。
  if (mode === "untracked") return apiUntrackedDiff(repo, file);
  const args =
    mode === "worktree"
      ? ["diff", "--no-color", "-M", "--", file]
      : mode === "index"
        ? ["diff", "--cached", "--no-color", "-M", "--", file]
        : ["show", "--format=", "--patch", "--no-color", "-M", sha, "--", file];
  const result = await runGit(repo, args);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, patch: result.stdout, truncated: Boolean(result.truncated) };
}

/** 未跟踪文件的伪补丁：把内容逐行加 `+`，与真补丁同形状（前端一套渲染）。 */
async function apiUntrackedDiff(repo, file) {
  // 路径必须落在仓库内（`file` 来自查询串，`../` 能直接把仓库外的文件读出来）。
  const target = resolve(repo, file);
  const inside = relative(resolve(repo), target);
  if (inside.startsWith("..") || isAbsolute(inside)) return { ok: false, error: "路径越出仓库范围" };
  try {
    const info = await stat(target);
    if (!info.isFile()) return { ok: false, error: "不是普通文件（目录或符号链接不支持预览）" };
    if (info.size > 1024 * 1024) return { ok: false, error: "文件超过 1MB，面板不预览（用编辑器打开）" };
    const buffer = await readFile(target);
    if (buffer.includes(0)) return { ok: true, patch: "", binary: true };
    const lines = buffer.toString("utf8").split(/\r?\n/u);
    const patch = [
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`)
    ].join("\n");
    return { ok: true, patch };
  } catch (error) {
    return { ok: false, error: `读不到这个文件：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function apiStatus(repo) {
  const [status, branch, upstream] = await Promise.all([
    runGit(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(repo, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
  ]);
  if (!status.ok) return { ok: false, error: status.error };
  const parsed = parseStatus(status.stdout);
  let ahead = 0;
  let behind = 0;
  if (upstream.ok) {
    const [behindText, aheadText] = upstream.stdout.trim().split(/\s+/u);
    behind = Number.parseInt(behindText ?? "0", 10) || 0;
    ahead = Number.parseInt(aheadText ?? "0", 10) || 0;
  }
  const current = branch.ok ? branch.stdout.trim() : "";
  return {
    ok: true,
    branch: current,
    detached: current === "HEAD",
    ahead,
    behind,
    hasUpstream: upstream.ok,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    stats: {
      staged: parsed.staged.length,
      unstaged: parsed.unstaged.length,
      untracked: parsed.untracked.length
    }
  };
}

/** 路由：返回 JSON 载荷（错误也是载荷，HTTP 一律 200，前端只认 ok）。 */
async function routeApi(pathname, query) {
  if (pathname === "/api/health") {
    return { ok: true, name: "git-bridge", version: 1, pid: process.pid, cwd: HERE.replace(/\\/gu, "/") };
  }
  const repo = validRepoPath(query.get("path"));
  if (!repo) return { ok: false, error: "缺少有效的 path 参数（必须是绝对路径）" };
  if (pathname === "/api/repo") return apiRepo(repo);
  if (pathname === "/api/refs") return apiRefs(repo);
  if (pathname === "/api/log") return apiLog(repo, query);
  if (pathname === "/api/status") return apiStatus(repo);
  if (pathname === "/api/commit") {
    const sha = validRevision(query.get("sha"));
    if (!sha) return { ok: false, error: "缺少有效的 sha 参数" };
    return apiCommit(repo, sha);
  }
  if (pathname === "/api/diff") {
    const file = validFile(query.get("file"));
    if (!file) return { ok: false, error: "缺少有效的 file 参数" };
    const mode = query.get("mode");
    if (mode === "worktree" || mode === "index" || mode === "untracked") return apiDiff(repo, undefined, file, mode);
    const sha = validRevision(query.get("sha"));
    if (!sha) return { ok: false, error: "缺少有效的 sha 参数" };
    return apiDiff(repo, sha, file);
  }
  return { ok: false, error: `未知接口：${pathname}` };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon"
};

/** 静态文件：只服务作品目录内的白名单扩展名（本服务是给面板页用的降级通道）。 */
async function serveStatic(pathname, res) {
  const name = pathname === "/" ? "index.html" : basename(pathname);
  if (!name || name.startsWith(".") || name.includes("..")) return false;
  const type = MIME[extname(name).toLowerCase()];
  if (!type) return false;
  try {
    const body = await readFile(join(HERE, name));
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "600"
};

function sendJson(res, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function parsePort(argv) {
  const index = argv.findIndex((arg) => arg === "--port" || arg.startsWith("--port="));
  if (index < 0) return DEFAULT_PORT;
  const raw = argv[index].startsWith("--port=") ? argv[index].slice(7) : argv[index + 1];
  const port = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

const port = parsePort(process.argv.slice(2));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      "Git Bridge —— 「Git 管理器」面板作品的本地数据源",
      "",
      "用法：node bridge.mjs [--port 8791]",
      "",
      "服务只监听 127.0.0.1，只读 git 仓库，不修改任何文件。"
    ].join("\n")
  );
  process.exit(0);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, { ok: false, error: "只支持 GET" });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    routeApi(url.pathname, url.searchParams)
      .then((payload) => sendJson(res, payload))
      .catch((error) => sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  serveStatic(url.pathname, res)
    .then((served) => {
      if (served) return;
      res.writeHead(404, { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 —— 只有 index.html / styles.css / app.js / graph.js 等静态文件可访问");
    })
    .catch(() => {
      res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("500");
    });
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(
      `端口 ${port} 已被占用：可能已经有一个 Git Bridge 在跑（那就不用重复起），\n` +
        `或者换个端口：node bridge.mjs --port 8792（面板页里的地址要跟着改）。`
    );
  } else {
    console.error(`Git Bridge 启动失败：${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    [
      `Git Bridge 已启动：http://127.0.0.1:${port}`,
      `静态页面（同源降级 / 本地开发）：http://127.0.0.1:${port}/`,
      "面板作品「Git 管理器」会连这个地址；Ctrl+C 停止。"
    ].join("\n")
  );
});
