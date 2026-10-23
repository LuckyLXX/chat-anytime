import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * 最近关闭会话的 SessionManager 缓存（冷打开加速）。
 *
 * 为什么需要：`SessionManager.open` 是同步整文件解析（45.8MB 实测 273–278ms），
 * parked 会话超过上限被淘汰后，用户切回就要重新付这笔 CPU/IO。记录销毁时把
 * manager 留在有界 LRU 里，下一次 open 先校验文件 mtime+size 再复用——文件没变
 * 就完全跳过 JSONL 解析；文件变了/换了 agent/工作区则丢弃并走原路径。
 *
 * 只缓存 manager（entries/byId/leafId），不缓存 AgentSession：MCP、团队、todo
 * 等仍按正常 createSession 装配，语义不变。容量按「条数 + 文件字节」双限，
 * 避免再引入一个无界内存池。
 */
export interface CachedSessionManagerInput {
  path: string;
  agentId: string;
  workspace: string;
  mtimeMs: number;
  size: number;
  manager: SessionManager;
}

interface CacheEntry extends CachedSessionManagerInput {
  key: string;
}

export const DEFAULT_SESSION_MANAGER_CACHE_ENTRIES = 2;
export const DEFAULT_SESSION_MANAGER_CACHE_BYTES = 96 * 1024 * 1024;

function pathKey(path: string): string {
  return path.split(String.fromCharCode(92)).join("/").toLowerCase();
}

export class SessionManagerCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries = DEFAULT_SESSION_MANAGER_CACHE_ENTRIES,
    private readonly maxBytes = DEFAULT_SESSION_MANAGER_CACHE_BYTES
  ) {}

  remember(input: CachedSessionManagerInput): void {
    if (!input.path || input.size <= 0 || input.size > this.maxBytes) return;
    const key = pathKey(input.path);
    this.entries.delete(key);
    this.entries.set(key, { ...input, key });
    this.trim();
  }

  /**
   * 取出可复用的 manager：必须同时命中路径、agent、工作区，且文件
   * mtime/size 与缓存时一致；命中即从缓存删除（一个 manager 只复用一次）。
   */
  take(
    path: string,
    agentId: string,
    workspace: string,
    stat: { mtimeMs: number; size: number }
  ): SessionManager | undefined {
    const key = pathKey(path);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.agentId !== agentId
      || pathKey(entry.workspace) !== pathKey(workspace)
      || entry.mtimeMs !== stat.mtimeMs
      || entry.size !== stat.size) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    return entry.manager;
  }

  forget(path: string): void {
    this.entries.delete(pathKey(path));
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private trim(): void {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    while (this.entries.size > this.maxEntries || total > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (entry) total -= entry.size;
    }
  }
}
