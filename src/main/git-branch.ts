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
 * 只做文件读取，不依赖 git CLI，无需常驻监听。
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