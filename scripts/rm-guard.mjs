/**
 * 危险删除守卫 —— PiDesktop 钩子命令（event=tool_call / blocking=true）。
 *
 * **故意不写 `#!/usr/bin/env node`**（2026-11-10 踩坑）：钩子与测试都用 `node <脚本>` 调用，
 * 不需要 shebang；而 GitHub Actions 的 Windows runner 检出 CRLF 后，Vite/vitest 的 shebang
 * 剥离会把这一行搬到 import 语句之后，生成 `#!/usr/bin/env node` 夹在文件中间 ⇒ `SyntaxError:
 * Invalid or unexpected token`（本地 LF 全绿、CI 全红）。`rm-guard.test.ts` 有断言钉住这一点。
 *
 * 定位：只拦「不可挽回的一击」，不做安全沙箱。
 *   · 拦：递归删除的目标是根路径（工作区根 / 工作区父级 / 盘符根 / 家目录 / `.` `..` `*` `~`）、
 *         整个 `.git`、以及「整仓未跟踪文件」的 `git clean -fdx`（没写具体路径时）。
 *   · 放：白名单里的构建/临时产物目录（node_modules、dist、build、out、coverage、.tmp*、
 *         `.pidesktop/{smoke-*,dl-*,rel-*,probe*,browser-probe,tmp*,logs,screenshots,downloads}`）。
 *   · 留痕：其他递归删除放行，但向对话尾部注入一行审计说明（additionalContext）。
 *   · fail-open：任何解析/异常一律放行（退出码 0，无输出）——一条守卫不该让所有 bash 卡死。
 *
 * 为什么不用正则匹配整条命令：旧规则只认「命令开头或 ; & | ( 之后的 rm -r」，
 * `sh -c "rm -rf ."`、`sudo rm -rf .`、`find . -delete`、node 的 fs.rmSync 全都能绕过，
 * 同时又会误拦 echo / 提交信息里出现的 `&& rm -rf` 文本。这里按 shell 词法切分命令、
 * 逐个「命令位」识别删除动词，再按「目标路径」判定，两个坑一起收。
 *
 * 用法（钩子 action.command）：
 *   node "<仓库>/scripts/rm-guard.mjs"                       ← 读 stdin JSON（钩子运行时）
 *   node scripts/rm-guard.mjs --check '{"command":"rm -rf ."}'  ← 手动试一条，打印裁决
 *
 * 依赖：只需要 node ≥18（无第三方包）。找不到 node / 脚本被移动时钩子 fail-open，
 * 也就是说把它挪走等同于关掉这条守卫——换机器或移动仓库时记得同步改钩子命令。
 */

import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 包装命令：跳过它们，真正的命令在下一个 token。 */
const PREFIX_WRAPPERS = new Set(["sudo", "doas", "env", "command", "nohup", "time", "nice", "exec", "builtin", "cross-env"]);
/** shell 关键字：`for …; do rm -rf "$d"; done` 里 do/then 之类不是命令本体。 */
const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "for", "case", "esac", "fi", "done", "in", "{", "}", "(", ")", "!"]);
/** shell 类命令：`sh -c "…"` 里还要再解析一层（这也是旧正则最大的绕过口子）。 */
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "cmd", "cmd.exe", "pwsh", "pwsh.exe", "powershell", "powershell.exe"]);
/** 删除动词（POSIX rm / cmd del、rd、rmdir / PowerShell Remove-Item 及其别名）。 */
const DELETE_COMMANDS = new Set(["rm", "del", "erase", "rd", "rmdir", "rmdir.exe", "remove-item", "ri"]);
/** 可能内含递归删除调用的运行时（node/python/… 的 `fs.rmSync(x,{recursive:true})`、`shutil.rmtree(x)`）。 */
const SCRIPT_RUNTIMES = new Set(["node", "node.exe", "python", "python3", "py", "deno", "perl", "ruby"]);
/** 工作区内「删了也不心疼」的首段目录：放行且不留痕。 */
const ALLOW_FIRST_SEGMENTS = new Set(["node_modules", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache", "target", "tmp", "temp"]);
const ALLOW_DOT_TMP = /^\.tmp[^/]*$/u;
/** `.pidesktop/` 下的发布/调试/下载产物。`.pidesktop` 根自身不在白名单（可能含用户下载物）。 */
const ALLOW_PIDESKTOP_CHILD = /^(smoke|dl|rel|probe|browser-probe|tmp|logs|screenshots|downloads|backups)/u;
/** find 的「收窄条件」：带了这些谓词就不是「整个目录连根删」。 */
const FIND_NARROWERS = new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-mtime", "-mmin", "-size", "-type", "-newer", "-perm", "-user", "-group", "-empty", "-depth", "-maxdepth", "-mindepth"]);
/** 远端主机上等于「整台机器」的路径，删了无法挽回。 */
const REMOTE_ROOT_EXACT = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt", "/proc", "/root", "/sbin", "/srv", "/sys", "/usr", "/var", "~", "/~", "/.", "*", "/*", "/home/*", "/var/*", "/etc/*", "/usr/*", "/opt/*"]);

const MAX_NOTES = 3;
const NOTE_PREVIEW = 160;
/**
 * 反斜杠只在这些字符前当转义（bash 的 `\ ` `\|` 之类）；其他情况保留字面量，
 * 否则 Windows 路径 `C:\Users\li857` 会被吃成 `C:Usersli857`（PowerShell 的路径
 * 不靠反斜杠转义）。引号内按该引号的规则单独处理。
 */
const ESCAPABLE = new Set(["\\", '"', "'", " ", "$", "`", "|", "&", ";", "(", ")", "{", "}", "<", ">", "!", "#", "*", "?", "~", "[", "]", "\t"]);

/**
 * 按 shell 词法切分：返回「命令段」数组，每段是去掉引号后的 token 数组。
 * 只在未加引号的位置识别 `;`、`\n`、`|`、`||`、`&&` 作为分段符——所以
 * `echo "a && rm -rf ."` 是一整段（不会误判），`sh -c "rm -rf ."` 里的
 * `rm -rf .` 会作为单个 token 保留下来供递归解析。
 * 单个 `&`（后台 / `2>&1`）不分段，避免把重定向拆坏。
 */
export function tokenize(command) {
  const segments = [[]];
  let token = "";
  let hasToken = false;
  let quote = "";
  const flush = () => {
    if (hasToken) {
      segments[segments.length - 1].push(token);
      token = "";
      hasToken = false;
    }
  };
  const cut = () => {
    flush();
    segments.push([]);
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        i += 1;
        token += command[i];
      } else token += ch;
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      const next = command[i + 1];
      if (ESCAPABLE.has(next)) {
        token += next;
        i += 1;
      } else {
        token += ch; // Windows 路径分隔符原样保留
      }
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      // 括号/大括号只当空白：`(rm -rf .)` 里的 rm 才能落到命令位；
      // 反斜杠转义的 `\(` 已在上面被吃掉，`2>&1` 不受影响。
      flush();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      cut();
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") i += 1;
      cut();
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      i += 1;
      cut();
      continue;
    }
    token += ch;
    hasToken = true;
  }
  flush();
  return segments.filter((segment) => segment.length > 0);
}

function commandName(token) {
  return basename(String(token ?? "").replace(/\\/gu, "/")).toLowerCase();
}

/** Windows 路径比较不区分大小写；POSIX 保持原样。 */
function norm(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isAncestorOrSelf(ancestor, target) {
  const a = norm(ancestor);
  const t = norm(target);
  return t === a || t.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** 去掉尾部多余的 `/` 或 `\`（根路径本身保留）。 */
function trimTrailingSeparators(value) {
  const trimmed = value.trim();
  if (/^[\\/]+$/u.test(trimmed)) return trimmed[0];
  return trimmed.replace(/[\\/]+$/u, "");
}

/** 「删掉就等于删了整台机器」的裸文本目标：. .. * ~ / 盘符根 ./* 之类。 */
export function isRootLikeText(value) {
  const raw = value.trim();
  if (!raw) return false;
  const bare = trimTrailingSeparators(raw);
  if (bare === "/" || bare === "\\") return true;
  if (bare === "." || bare === ".." || bare === "*" || bare === "**") return true;
  if (/^\.[\\/]\*+$/u.test(bare) || /^\.[\\/]\.[\\/]\*+$/u.test(bare)) return true;
  if (/^[\\/]\*+$/u.test(bare)) return true;
  if (/^[a-zA-Z]:$/u.test(bare)) return true;
  if (/^[a-zA-Z]:[\\/]\*+$/u.test(bare)) return true;
  if (["~", "$HOME", "${HOME}", "%USERPROFILE%", "/~", "/*"].includes(raw)) return true;
  return false;
}

/** 工作区相对路径是否属于「删了也不心疼」的白名单目录。 */
export function isAllowlistedRelative(relPath) {
  const parts = relPath.split(/[\\/]+/u).filter(Boolean);
  const first = parts[0] ?? "";
  const second = parts[1] ?? "";
  if (ALLOW_FIRST_SEGMENTS.has(first)) return true;
  if (ALLOW_DOT_TMP.test(first)) return true;
  if (first === ".pidesktop" && ALLOW_PIDESKTOP_CHILD.test(second)) return true;
  return false;
}

/**
 * 判定单个删除目标。返回：
 *   { kind: "root" }                  → 拦
 *   { kind: "inside", rel }           → 工作区内（rel 相对路径，可能属于白名单）
 *   { kind: "outside" }               → 工作区外（具体路径，放行但留痕）
 *   { kind: "remote-root" }           → 远端根类路径（拦）
 *   { kind: "opaque", display }       → 含变量/通配基路径，无法判定（放行但留痕）
 */
export function classifyTarget(target, { workspace, remote } = {}) {
  const raw = String(target ?? "").trim();
  if (!raw) return { kind: "opaque", display: "" };
  const wildcard = raw.match(/^(.*?)[\\/]\*+$/u);
  const base = wildcard ? wildcard[1] || "." : raw;
  const rootLike = isRootLikeText(base) || isRootLikeText(raw);

  if (remote) {
    if (rootLike) return { kind: "remote-root", display: raw };
    const bare = trimTrailingSeparators(base);
    if (REMOTE_ROOT_EXACT.has(bare)) return { kind: "remote-root", display: raw };
    if (bare.startsWith("/home/") || bare.startsWith("/root/")) {
      // /home 与 /root 本身已在集合里；子路径是具体目标，放行留痕
      return { kind: "outside", display: raw };
    }
    if (rootLike) return { kind: "remote-root", display: raw };
    return { kind: "outside", display: raw };
  }

  if (rootLike) return { kind: "root", display: raw };
  if (/[$%`]/u.test(base)) return { kind: "opaque", display: raw };
  if (!workspace || !workspace.trim()) return { kind: "opaque", display: raw };

  const root = resolve(workspace);
  const absolute = isAbsolute(base) ? resolve(base) : resolve(root, base);
  const rootResolved = resolve(absolute === "" ? root : absolute);

  if (norm(rootResolved) === norm(root)) return { kind: "root", display: raw };
  if (isAncestorOrSelf(rootResolved, root)) return { kind: "root", display: raw }; // 工作区父级/盘符根
  if (norm(rootResolved) === norm(resolve(homedir()))) return { kind: "root", display: raw };
  if (norm(rootResolved) === norm(join(root, ".git")) || norm(rootResolved).startsWith(norm(join(root, ".git")) + sep)) {
    return { kind: "root", display: raw };
  }
  const rel = relative(root, rootResolved);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return { kind: "inside", rel: rel.split(sep).join("/"), display: raw };
  }
  return { kind: "outside", display: raw };
}

function preview(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > NOTE_PREVIEW ? `${text.slice(0, NOTE_PREVIEW)}…` : text;
}

/** rm / del / rd / rmdir / Remove-Item 家族：解析选项与目标，只对递归删除做判定。 */
function evaluateDeleteCommand(name, args, state) {
  let recursive = false;
  let endOfOptions = false;
  const targets = [];
  for (const token of args) {
    if (!endOfOptions && token === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && token.startsWith("-") && token.length > 1) {
      // 长选项只认 --recursive（`rm --interactive file` 里的 r 不该被当成递归）；
      // 短选项按字母簇判：-rf / -Rf / PowerShell 的 -Recurse 都含 r。
      const flags = token.toLowerCase();
      if (flags.startsWith("--")) {
        if (flags === "--recursive") recursive = true;
      } else if (/^-[a-z]*r/u.test(flags)) recursive = true;
      continue;
    }
    if (!endOfOptions && /^\/[a-zA-Z]/u.test(token) && /^(rd|rmdir|del|erase)$/u.test(name)) {
      if (/s/iu.test(token)) recursive = true;
      continue;
    }
    targets.push(token);
  }
  if (!recursive || targets.length === 0) {
    if (recursive && targets.length === 0) state.notes.push(`递归删除没有明确目标：${preview([name, ...args].join(" "))}`);
    return;
  }
  for (const target of targets) evaluateTarget(target, state);
}

function evaluateTarget(target, state) {
  const verdict = classifyTarget(target, { workspace: state.workspace, remote: state.remote });
  if (verdict.kind === "root" || verdict.kind === "remote-root") {
    state.blocked.push(verdict.display);
    return;
  }
  if (verdict.kind === "inside" && isAllowlistedRelative(verdict.rel)) return; // 白名单：静默放行
  if (verdict.kind === "inside") state.notes.push(`已放行删除 ${preview(verdict.display)}（工作区内非白名单路径）`);
  else if (verdict.kind === "outside") state.notes.push(`已放行删除 ${preview(verdict.display)}（${state.remote ? "远端主机" : "工作区外"}）`);
  else state.notes.push(`已放行删除 ${preview(verdict.display)}（目标含变量/通配，无法判定）`);
}

/** find <path…> <predicates> -delete */
function evaluateFind(args, state) {
  const deleteIndex = args.findIndex((token) => token === "-delete" || token === "-deleteAll");
  if (deleteIndex < 0) return;
  const paths = [];
  for (const token of args) {
    if (token.startsWith("-") || token === "(" || token === "!" || token === "\\(") break;
    paths.push(token);
  }
  const narrowed = args.some((token) => FIND_NARROWERS.has(token.toLowerCase()));
  if (narrowed) {
    const shown = paths.length > 0 ? paths.join(" ") : ".";
    state.notes.push(`已放行 find -delete（带收窄条件）：${preview([shown, "…"].join(" "))}`);
    return;
  }
  if (paths.length === 0) {
    state.blocked.push(".");
    return;
  }
  for (const target of paths) evaluateTarget(target, state);
}

/** git clean -fdx：没写具体路径就是「清掉整个仓库的未跟踪文件」，不可回滚。 */
function evaluateGitClean(args, state) {
  const flags = [];
  const paths = [];
  for (const token of args) {
    if (token.startsWith("-")) flags.push(token);
    else paths.push(token);
  }
  const forced = flags.some((flag) => /^-[a-z]*f/u.test(flag));
  if (!forced) return;
  if (paths.length === 0) {
    state.blocked.push("git clean -f（整仓未跟踪文件）");
    return;
  }
  for (const target of paths) evaluateTarget(target, state);
}

/** node/python 里显式写死的递归删除：fs.rmSync('.', {recursive:true}) / shutil.rmtree('.') */
function evaluateScriptRuntime(rawSegment, state) {
  const pattern = /(?:rmSync|rmdirSync|rm_rf|rmtree|rmTree|remove_dir_all)\s*\(\s*(['"`])([^'"`]*)\1/gu;
  for (const match of rawSegment.matchAll(pattern)) {
    const literal = match[2] ?? "";
    if (!literal) continue;
    if (/recursive|rm_rf|rmtree|rmTree|remove_dir_all|rmdirSync/iu.test(rawSegment) || match[0].toLowerCase().includes("rmsync")) {
      evaluateTarget(literal, state);
    }
  }
}

/** 分析一段命令（token 数组）：只在「命令位」识别删除动词，避免 echo "rm -rf ." 误报。 */
function analyzeSegment(tokens, state, depth = 0) {
  if (depth > 4 || tokens.length === 0) return;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      index += 1;
      continue;
    }
    const bare = commandName(token);
    if (PREFIX_WRAPPERS.has(bare) || SHELL_KEYWORDS.has(bare)) {
      index += 1;
      continue;
    }
    break;
  }
  const head = tokens[index];
  if (!head) return;
  const name = commandName(head);
  const args = tokens.slice(index + 1);

  if (SHELL_WRAPPERS.has(name)) {
    // `-c` / `-lc` / `-ec`（簇里有 c 也算）、cmd 的 `/c`、PowerShell 的 `-Command`
    const flagIndex = args.findIndex((token) => /^(-[a-zA-Z]*c[a-zA-Z]*|\/c|\/k|-+command|\/command)$/iu.test(token));
    if (flagIndex >= 0 && args[flagIndex + 1] !== undefined) {
      const nested = args.slice(flagIndex + 1).join(" ");
      for (const segment of tokenize(nested)) analyzeSegment(segment, state, depth + 1);
    } else {
      state.notes.push(`已放行 ${preview([name, ...args].join(" "))}（脚本内容无法静态判定）`);
    }
    return;
  }
  if (name === "eval") {
    for (const segment of tokenize(args.join(" "))) analyzeSegment(segment, state, depth + 1);
    return;
  }
  if (name === "xargs") {
    let rest = args;
    while (rest.length > 0 && (rest[0].startsWith("-") || rest[0] === "-0" || rest[0] === "-I")) rest = rest.slice(1);
    if (rest.length > 0) analyzeSegment(rest, state, depth + 1);
    else state.notes.push("已放行 xargs（目标来自管道）");
    return;
  }
  if (DELETE_COMMANDS.has(name)) {
    evaluateDeleteCommand(name, args, state);
    return;
  }
  if (name === "find" || name === "find.exe") {
    evaluateFind(args, state);
    return;
  }
  if (name === "git") {
    // 跳过 git 的全局选项（-C <dir> / -c k=v / --git-dir=… 等）再找子命令
    let cursor = 0;
    while (cursor < args.length) {
      const token = args[cursor];
      if (!token.startsWith("-")) break;
      const takesValue = ["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"].includes(token);
      cursor += takesValue ? 2 : 1;
    }
    if (commandName(args[cursor] ?? "") === "clean") evaluateGitClean(args.slice(cursor + 1), state);
    return;
  }
  if (SCRIPT_RUNTIMES.has(name)) {
    evaluateScriptRuntime([head, ...args].join(" "), state);
  }
}

/**
 * 主判定（纯函数，测试直接用）。
 * @param {{ command?: string, workspace?: string, remote?: boolean }} input
 * @returns {{ block: boolean, reason?: string, note?: string }}
 */
export function evaluateDeletion(input = {}) {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return { block: false };
  const state = { workspace: input.workspace, remote: input.remote === true, blocked: [], notes: [] };
  for (const segment of tokenize(command)) analyzeSegment(segment, state);
  if (state.blocked.length > 0) {
    const target = state.blocked[0];
    const where = state.remote ? "远端根路径" : "工作区/家目录/盘符根级别的路径";
    return {
      block: true,
      reason: `危险删除拦截：拒绝递归删除「${preview(target)}」——这是${where}，删掉无法回滚。请把目标写具体到某个子目录（例如 rm -rf .pidesktop/smoke-1.14.0），或由你本人手动执行。`
    };
  }
  const notes = [...new Set(state.notes)].slice(0, MAX_NOTES);
  return notes.length > 0 ? { block: false, note: `删除守卫：${notes.join("；")}` } : { block: false };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--check") {
    let parsed = {};
    try {
      parsed = JSON.parse(argv[1] ?? "{}");
    } catch {
      process.stderr.write("--check 需要一个 JSON 参数，例如 {\"command\":\"rm -rf .\"}\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(evaluateDeletion(parsed), null, 2)}\n`);
    return;
  }
  let payload = {};
  try {
    const text = await readStdin();
    payload = text.trim() ? JSON.parse(text) : {};
  } catch {
    return; // fail-open：钩子上下文读不出来就不拦
  }
  const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
  if (!["bash", "powershell", "ssh_exec"].includes(toolName)) return;
  const toolInput = payload && typeof payload.toolInput === "object" && payload.toolInput !== null ? payload.toolInput : {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  const workspace = typeof payload.workspace === "string" && payload.workspace.trim() ? payload.workspace : process.env.HOOK_WORKSPACE || undefined;
  let verdict;
  try {
    verdict = evaluateDeletion({ command, workspace, remote: toolName === "ssh_exec" });
  } catch {
    return; // fail-open
  }
  if (verdict.block) {
    process.stdout.write(`${JSON.stringify({ block: true, reason: verdict.reason })}\n`);
    return;
  }
  if (verdict.note) process.stdout.write(`${JSON.stringify({ additionalContext: verdict.note })}\n`);
}

if (basename(process.argv[1] ?? "").toLowerCase() === "rm-guard.mjs") {
  main().catch(() => undefined);
}
