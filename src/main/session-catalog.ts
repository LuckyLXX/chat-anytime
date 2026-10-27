import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentProfile, SessionSummary } from "../shared/protocol.js";
import { listSessionSummaries, type CachedSessionSummary, type SessionFileSummary } from "./session-summary-cache.js";
import { isSessionArchived, isSessionPinned, sessionPathKey, sortSessionSummaries } from "./session-scope.js";

/**
 * 全局会话目录（workspace-first 改造，方案 A §2.3）。
 *
 * 为什么单独成模块：跨助手会话列表让“会话属于哪个助手/哪个工作区”变成所有
 * rename/delete/archive/pin 命令的公共前提。把这些判定散在 `pi-runtime` 里，
 * 每个入口都容易各写一套路径比较（大小写、分隔符、前缀边界）——而任何一个漏掉
 * 都会把另一个助手的会话误认成自己的。这里只保留纯函数 + fs 扫描，便于单测
 * 覆盖所有边界。
 */

/** 一个助手在会话目录里的作用域（含磁盘孤儿与已归档助手）。 */
export interface SessionScope {
  agentId: string;
  agentName: string;
  agentArchived: boolean;
  /** 该助手 `chatanytime-sessions/<agentId>` 下所有工作区会话目录（已排除 delegations）。 */
  dirs: string[];
}

/** 工作区目录存在性缓存项（TTL 由调用方传入；所有会话共享同一份探测结果）。 */
export interface WorkspaceExistsEntry {
  exists: boolean;
  checkedAt: number;
}

export interface SummarizeOptions {
  cache?: Map<string, CachedSessionSummary>;
  liveSummaries?: readonly SessionFileSummary[];
  pinnedPaths?: readonly string[];
  archivedPaths?: readonly string[];
  workspaceExistsCache?: Map<string, WorkspaceExistsEntry>;
  now?: () => number;
  /** 工作区存在性结果的有效期；默认 10 秒。 */
  workspaceExistsTtlMs?: number;
  isDirectory?: (path: string) => Promise<boolean> | boolean;
}

/** 与 session-summary-cache 的“未知工作区”展示口径保持一致。 */
const UNKNOWN_WORKSPACE = "未知工作区";
const NEW_SESSION_TITLE = "新会话";
export const DEFAULT_WORKSPACE_EXISTS_TTL_MS = 10_000;

/**
 * 助手根目录下的非工作区 sidecar。它们与工作区哈希目录同级，但存的是应用状态
 * 而非会话（delegations 则是子代理），扫描会话时排除可以少走一层目录、也避免
 * 将来这些目录里出现 .jsonl 时被误当作会话。
 */
const NON_WORKSPACE_DIR_NAMES = new Set([
  "delegations",
  "todos",
  "plans",
  "design-mode",
  "computer-mode",
  "team-mode",
  "checkpoints"
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 默认目录判定：任何 stat 异常都按“不是目录”处理（与列表展示的容错一致）。 */
async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 扫描 `<agentDir>/chatanytime-sessions/` 下所有助手作用域。
 *
 * 口径：
 * - settings 里的助手全部产出（即使磁盘无目录，dirs 为空）——这样归档助手与
 *   “尚未创建过会话的新助手”都能在全局列表里被解析；
 * - 磁盘上存在但 settings 已无记录的目录也产出（孤儿目录），名字直接当显示名，
 *   不能因为设置里删了助手就让历史会话从列表消失；
 * - 每个助手根目录下**只把子目录**当工作区会话目录。根目录本身不是工作区：
 *   sidecar 目录（todos/plans/...）与 delegations 都在这一层，混进来只会让扫描
 *   去解析一堆非会话文件；
 * - 结果按 agentId 稳定排序，调用方无需再排序。
 */
export async function listSessionScopes(
  agentDir: string,
  agents: readonly AgentProfile[],
  deps: {
    readdir?: (dir: string) => Promise<string[]>;
    stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
  } = {}
): Promise<SessionScope[]> {
  const readdirImpl = deps.readdir ?? readdir;
  const statImpl = deps.stat ?? stat;
  const sessionsRoot = join(agentDir, "chatanytime-sessions");

  // 磁盘上的助手目录（readdir 只给名字，必须逐项 stat 才能排除同名文件）。
  const diskAgentNames: string[] = [];
  try {
    for (const name of await readdirImpl(sessionsRoot)) {
      try {
        if ((await statImpl(join(sessionsRoot, name))).isDirectory()) diskAgentNames.push(name);
      } catch {
        // 单个条目不可读/已消失：跳过，不影响其它助手。
      }
    }
  } catch {
    // chatanytime-sessions 还不存在：settings 里的助手仍然要产出空 scope。
  }

  // agentId 作为地图键时大小写不敏感：Windows 目录名不区分大小写，settings 里
  // 的 id 大小写可能与磁盘目录不同，不能让同一个助手出现两个 scope。
  const profiles = new Map<string, AgentProfile>();
  for (const agent of agents) {
    const key = agent.id.toLowerCase();
    if (!key || profiles.has(key)) continue;
    profiles.set(key, agent);
  }
  const ids = new Map<string, string>();
  for (const profile of profiles.values()) ids.set(profile.id.toLowerCase(), profile.id);
  for (const name of diskAgentNames) {
    const key = name.toLowerCase();
    if (!ids.has(key)) ids.set(key, name);
  }
  const diskNames = new Map<string, string>();
  for (const name of diskAgentNames) {
    const key = name.toLowerCase();
    if (!diskNames.has(key)) diskNames.set(key, name);
  }

  const scopes: SessionScope[] = [];
  const sortedIds = [...ids.values()].sort((left, right) => {
    const byLower = compareText(left.toLowerCase(), right.toLowerCase());
    return byLower !== 0 ? byLower : compareText(left, right);
  });
  for (const agentId of sortedIds) {
    const profile = profiles.get(agentId.toLowerCase());
    const diskName = diskNames.get(agentId.toLowerCase());
    const dirs: string[] = [];
    if (diskName !== undefined) {
      const agentRoot = join(sessionsRoot, diskName);
      try {
        for (const name of await readdirImpl(agentRoot)) {
          if (NON_WORKSPACE_DIR_NAMES.has(name.toLowerCase())) continue;
          const candidate = join(agentRoot, name);
          try {
            if ((await statImpl(candidate)).isDirectory()) dirs.push(candidate);
          } catch {
            // 单个子目录不可读/已消失：跳过。
          }
        }
      } catch {
        // 助手目录刚好被删：scope 仍保留，dirs 为空。
      }
    }
    // 固定顺序，避免 readdir 顺序在不同文件系统上变化导致列表抖动。
    dirs.sort((left, right) => compareText(sessionPathKey(left), sessionPathKey(right)));
    const profileName = profile?.name?.trim();
    scopes.push({
      agentId,
      agentName: profileName || profile?.id || agentId,
      agentArchived: profile?.archived === true,
      dirs
    });
  }
  return scopes;
}

/**
 * 路径是否落在目录内：等于目录，或以 `<dir><sep>` 开头。
 *
 * 不能用裸 `startsWith`：那会把 `C:\a` 误判成 `C:\ab` 的父目录。这里先按会话
 * 路径键（绝对化、分隔符统一、大小写不敏感）归一，再用 `path.relative` 判边界；
 * 相等单独放行——调用方传工作区目录本身时也应归属于该 scope。
 */
function pathIsWithin(root: string, target: string): boolean {
  const rootKey = sessionPathKey(root);
  const targetKey = sessionPathKey(target);
  if (rootKey === targetKey) return true;
  const relation = relative(rootKey, targetKey);
  return Boolean(relation) && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function findScopeByAgentId(scopes: readonly SessionScope[], agentId: string): SessionScope | undefined {
  const key = agentId.toLowerCase();
  return scopes.find((scope) => scope.agentId.toLowerCase() === key);
}

/**
 * 汇总所有 scope 的会话摘要。
 *
 * 每个 scope 独立调用 `listSessionSummaries`：缓存是全局 path key，跨 scope 共享
 * 不会重复读文件；`liveSummaries` 也是全局数组，按路径覆盖磁盘结果（正在写的
 * 会话零 I/O）。工作区存在性探测按唯一 workspace 做 TTL 缓存——侧栏每轮刷新都
 * 会重建列表，不能每次都为几百个会话重复 stat 同一批工作区目录。
 */
export async function summarizeAllSessions(
  scopes: readonly SessionScope[],
  options: SummarizeOptions = {}
): Promise<SessionSummary[]> {
  const now = options.now ?? Date.now;
  const ttl = options.workspaceExistsTtlMs ?? DEFAULT_WORKSPACE_EXISTS_TTL_MS;
  const workspaceExistsCache = options.workspaceExistsCache ?? new Map<string, WorkspaceExistsEntry>();
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const pinnedPaths = options.pinnedPaths ?? [];
  const archivedPaths = options.archivedPaths ?? [];

  const workspaceMissing = async (workspace: string): Promise<boolean> => {
    const key = sessionPathKey(workspace);
    const cached = workspaceExistsCache.get(key);
    if (cached && now() - cached.checkedAt < ttl) return !cached.exists;
    let exists = false;
    try {
      exists = await isDirectory(workspace);
    } catch {
      // 权限/瞬时 IO 错误按不存在处理：宁可显示“目录不存在”，也不阻塞列表。
      exists = false;
    }
    workspaceExistsCache.set(key, { exists, checkedAt: now() });
    return !exists;
  };

  const sessions: SessionSummary[] = [];
  for (const scope of scopes) {
    if (scope.dirs.length === 0) continue;
    // 旧版会话可能直接落在助手根目录（历史上 SessionManager.listAll 扫过 root）；
    // 根目录里的大量 sidecar 由 listSessionSummaries 的首行校验自然过滤。
    const scanDirs = [...new Set([dirname(scope.dirs[0]!), ...scope.dirs])];
    const items = await listSessionSummaries(scanDirs, {
      ...(options.cache ? { cache: options.cache } : {}),
      ...(options.liveSummaries ? { liveSummaries: options.liveSummaries } : {})
    });
    for (const item of items) {
      // cwd 为空的会话没有可探测的工作区；按缺失处理，UI 至少不会把它归到某个
      // 真实目录组里。非空 cwd 才需要 stat。
      const missing = item.cwd ? await workspaceMissing(item.cwd) : true;
      sessions.push({
        id: item.id,
        path: item.path,
        workspace: item.cwd || UNKNOWN_WORKSPACE,
        title: item.name || item.firstMessage || NEW_SESSION_TITLE,
        modifiedAt: item.modified.getTime(),
        messageCount: item.messageCount,
        agentId: scope.agentId,
        pinned: isSessionPinned(pinnedPaths, item.path) || undefined,
        archived: isSessionArchived(archivedPaths, item.path) || undefined,
        ...(missing ? { workspaceMissing: true } : {})
      });
    }
  }
  return sortSessionSummaries(sessions);
}

/**
 * 判定会话路径的归属助手（rename/delete/archive/pin 的路径校验入口）。
 *
 * 优先级：摘要 → live 记录 → scope 目录前缀。前两者带 agentId，是权威身份；
 * 只有文件还没落盘/没有摘要时才退回目录前缀。前缀必须走边界判断，防止跨助手
 * 目录名字刚好互为前缀时误判。
 */
export function resolveSessionOwner(
  path: string,
  scopes: readonly SessionScope[],
  hints: {
    summaries?: readonly SessionSummary[];
    live?: readonly { path?: string; agentId: string }[];
  } = {}
): SessionScope | undefined {
  if (!path) return undefined;
  const targetKey = sessionPathKey(path);

  const summary = hints.summaries?.find((item) => sessionPathKey(item.path) === targetKey);
  if (summary) {
    const owner = findScopeByAgentId(scopes, summary.agentId);
    if (owner) return owner;
  }

  const live = hints.live?.find((item) => item.path !== undefined && sessionPathKey(item.path) === targetKey);
  if (live) {
    const owner = findScopeByAgentId(scopes, live.agentId);
    if (owner) return owner;
  }

  return scopes.find((scope) => scope.dirs.some((dir) => pathIsWithin(dir, path)));
}

/**
 * 在指定工作区里挑最近一条可打开会话。
 *
 * 默认跳过归档会话与归档助手的会话：`workspace.open` / 启动 / `agent.select`
 * 不应该把用户已经收起来的内容重新顶到前台。归档助手是否能判断取决于调用方
 * 是否传 agents（渲染端/主进程都有全量 settings.agents）；缺省视为未归档，
 * 不因为缺参数而隐藏会话。
 */
export function pickRecentSession(
  sessions: readonly SessionSummary[],
  workspace: string,
  options: {
    includeArchived?: boolean;
    excludeArchivedAgents?: boolean;
    agents?: readonly AgentProfile[];
  } = {}
): SessionSummary | undefined {
  const workspaceKey = sessionPathKey(workspace);
  const includeArchived = options.includeArchived === true;
  const excludeArchivedAgents = options.excludeArchivedAgents !== false;
  const agentById = new Map<string, AgentProfile>();
  for (const agent of options.agents ?? []) {
    const key = agent.id.toLowerCase();
    if (!agentById.has(key)) agentById.set(key, agent);
  }

  let best: SessionSummary | undefined;
  for (const session of sessions) {
    if (sessionPathKey(session.workspace) !== workspaceKey) continue;
    if (!includeArchived && session.archived) continue;
    if (excludeArchivedAgents) {
      const agent = agentById.get(session.agentId.toLowerCase());
      if (agent?.archived === true) continue;
    }
    // modifiedAt 降序取第一条；相等时保留入参顺序（稳定）。
    if (!best || session.modifiedAt > best.modifiedAt) best = session;
  }
  return best;
}
