import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 从 .git/HEAD 内容解析分支名。
 * - 普通分支：`ref: refs/heads/<name>` → 返回 name；
 * - detached HEAD：内容为 40 位提交哈希 → 返回前 7 位短哈希（VS Code 同款口径）；
 * - 其它畸形内容 → undefined。
 */
export function parseGitHead(head: string): string | undefined {
  const ref = head.trim();
  const match = /^ref:\s*refs\/heads\/(.+)$/u.exec(ref);
  if (match) return match[1]?.trim() || undefined;
  if (/^[0-9a-fA-F]{40}$/u.test(ref)) return ref.slice(0, 7).toLowerCase();
  return undefined;
}

/**
 * 解析工作区的 .git 条目：普通仓库是目录，直接返回；linked worktree / 子模块
 * 场景下是一个文件，内容形如 `gitdir: <path>`（相对工作区或绝对路径）。
 * 不存在或解析失败返回 undefined（非 git 项目）。
 */
async function resolveGitDir(workspace: string): Promise<string | undefined> {
  const gitEntry = join(workspace, ".git");
  let entryStat;
  try {
    entryStat = await stat(gitEntry);
  } catch {
    return undefined;
  }
  if (entryStat.isDirectory()) return gitEntry;
  if (!entryStat.isFile()) return undefined;
  try {
    const content = await readFile(gitEntry, "utf8");
    const match = /^gitdir:\s*(.+)$/u.exec(content.trim());
    if (!match) return undefined;
    const gitDir = match[1]!.trim();
    return isAbsolute(gitDir) ? gitDir : resolve(workspace, gitDir);
  } catch {
    return undefined;
  }
}

/**
 * 读取工作区当前 git 分支；非 git 项目或任何读取失败都返回 undefined。
 * 只做文件读取，不依赖 git CLI；准实时监听见 watchGitBranch。
 */
export async function readGitBranch(workspace: string): Promise<string | undefined> {
  try {
    const gitDir = await resolveGitDir(workspace);
    if (!gitDir) return undefined;
    const head = await readFile(join(gitDir, "HEAD"), "utf8");
    return parseGitHead(head);
  } catch {
    return undefined;
  }
}

/** 分支监听的去抖窗口：git checkout/switch 会连续写 HEAD.lock、rename 覆盖 HEAD。 */
const GIT_BRANCH_WATCH_DEBOUNCE_MS = 150;

export interface GitBranchWatchHandle {
  /** 停止监听（幂等）。 */
  close(): void;
}

/**
 * 准实时监听工作区的当前分支变化（.git/HEAD）。
 *
 * 监听的是 **gitdir 目录**而不是 HEAD 文件本身：git checkout/switch 走
 * 「写 HEAD.lock → rename 覆盖 HEAD」，文件级 watcher 在 inode 被替换后就失效了
 * （Linux/macOS 上尤其明显）；目录级 watch 跨 rename 继续有效，也覆盖 HEAD 被
 * 删除重建的情况。
 *
 * 非 git 工作区或挂载失败返回 undefined——调用方可以在后续轮询里重试，这样
 * `git init` 之后无需切换工作区也能从「无监听」升级为常驻监听。
 * fs.watch 在个别平台/网络盘可能静默漏事件，调用方应保留低频轮询兜底。
 */
export async function watchGitBranch(workspace: string, onChange: () => void): Promise<GitBranchWatchHandle | undefined> {
  const gitDir = await resolveGitDir(workspace);
  if (!gitDir) return undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(gitDir, { persistent: false }, (_event, filename) => {
      // filename 为 null 表示平台没给出名字（无法过滤），按 HEAD 处理。
      const name = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
      if (name && name.toLowerCase() !== "head") return;
      // 一次 checkout 往往连续触发多个事件，合并成一次读取。
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onChange();
      }, GIT_BRANCH_WATCH_DEBOUNCE_MS);
    });
  } catch {
    return undefined;
  }
  // 监听器出错（目录被删/权限变化）不能抛出：读取侧还有轮询兜底。
  watcher.on("error", () => undefined);

  return {
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher.close();
    }
  };
}