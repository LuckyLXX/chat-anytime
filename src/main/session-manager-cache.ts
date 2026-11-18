import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * 最近关闭会话的 SessionManager 缓存（冷打开加速）。
 *
 * 为什么需要：`SessionManager.open` 是同步整文件解析（45.8MB 历史实测 273–278ms，
 * 2026-11-18 由 `scripts/benchmark-session-open.mjs` 复测，见该脚本输出），
 * parked 会话超过上限被淘汰后，用户切回就要重新付这笔 CPU/IO。记录销毁时把
 * manager 留在有界 LRU 里，下一次 open 先校验文件 mtime+size 再复用——文件没变
 * 就完全跳过 JSONL 解析；文件变了/换了 agent/工作区则丢弃并走原路径。
 *
 * 只缓存 manager（entries/byId/leafId），不缓存 AgentSession：MCP、团队、todo
 * 等仍按正常 createSession 装配，语义不变。容量按「条数 + 文件字节」双限，
 * 避免再引入一个无界内存池。
 *
 * 两个来源分开记账（2026-11-18 P0 冷开优化）：
 * - `release`：用户用过并释放的会话（parked 淘汰 / 会话被切走）。这是真正值得
 *   留下的命中机会，优先级高，按 `usedAt`（record.activatedAt）做 LRU。
 * - `scan`：摘要冷扫描顺手解析出来的 manager（列表刷新本来就要整读一次）。
 *   **只用剩余额度**：装不下就放弃，绝不为了它挤掉 release 条目；反过来
 *   release 准入时先淘汰 scan 条目。这样「列表扫一遍」不会把用户刚用过、
 *   正要在切回时命中的 manager 顶掉。
 *
 * 注意：条数/字节预算是**这一份缓存**的约束，不是整个运行时的内存上限；parked
 * 记录（6 条 / 96 MiB）与 active 基线（6 槽）各自另有预算，三者可以叠加。
 */
export interface CachedSessionManagerInput {
  path: string;
  agentId: string;
  workspace: string;
  mtimeMs: number;
  size: number;
  manager: SessionManager;
}

/** 缓存准入来源：用户使用后释放 vs 摘要扫描附带产生。 */
export type SessionManagerCacheOrigin = "release" | "scan";

export interface CachedSessionManagerEntry extends CachedSessionManagerInput {
  /** 来源；缺省按 `release` 处理（老调用点不带这个字段）。 */
  origin?: SessionManagerCacheOrigin;
  /**
   * 用户真实使用顺序（record.activatedAt，越大越新）。缺省 0。
   *
   * 为什么必须由调用方给：批量驱逐 parked 会话时循环顺序是「激活时间降序」，
   * 若用「入缓存顺序」当 LRU 键，最旧的那个会话会最后一个入缓存、被误判成最新。
   */
  usedAt?: number;
}

interface CacheEntry extends CachedSessionManagerInput {
  key: string;
  origin: SessionManagerCacheOrigin;
  usedAt: number;
  /** 入缓存序号（scan 条目之间的淘汰次序；也是同 usedAt 的兜底顺序）。 */
  order: number;
}

export const DEFAULT_SESSION_MANAGER_CACHE_ENTRIES = 8;
export const DEFAULT_SESSION_MANAGER_CACHE_BYTES = 96 * 1024 * 1024;

function pathKey(path: string): string {
  return path.split(String.fromCharCode(92)).join("/").toLowerCase();
}

export class SessionManagerCache {
  private readonly entries = new Map<string, CacheEntry>();
  private sequence = 0;

  constructor(
    private readonly maxEntries = DEFAULT_SESSION_MANAGER_CACHE_ENTRIES,
    private readonly maxBytes = DEFAULT_SESSION_MANAGER_CACHE_BYTES
  ) {}

  /**
   * 登记一个可复用的 manager。
   *
   * 拒绝的情况（调用方无须感知，只是没命中）：
   * - 空路径 / 空文件 / 单文件超过整份缓存预算（超大会话本来就会被淘汰）；
   * - `scan` 来源装不进「release 之外的剩余额度」（不挤掉用户近期使用的条目）。
   */
  remember(input: CachedSessionManagerEntry): void {
    if (!input.path || input.size <= 0 || input.size > this.maxBytes) return;
    const key = pathKey(input.path);
    const origin: SessionManagerCacheOrigin = input.origin === "scan" ? "scan" : "release";
    this.entries.delete(key);
    if (origin === "scan" && !this.fitsScanBudget(this.entries, input.size)) return;
    this.entries.set(key, {
      ...input,
      origin,
      usedAt: input.usedAt ?? 0,
      order: ++this.sequence,
      key
    });
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

  /** 缓存内会话路径（测试与诊断用；返回的是登记时的原始路径）。 */
  paths(origin?: SessionManagerCacheOrigin): string[] {
    return [...this.entries.values()]
      .filter((entry) => origin === undefined || entry.origin === origin)
      .map((entry) => entry.path);
  }

  /**
   * scan 准入的额度判断：只允许占用「release 条目之外」的条数与字节。
   * `existing` 已去掉同路径的旧条目（remember 先 delete）。
   */
  private fitsScanBudget(existing: Map<string, CacheEntry>, size: number): boolean {
    let releaseEntries = 0;
    let releaseBytes = 0;
    for (const entry of existing.values()) {
      if (entry.origin === "scan") continue;
      releaseEntries += 1;
      releaseBytes += entry.size;
    }
    if (releaseEntries >= this.maxEntries) return false;
    return releaseBytes + size <= this.maxBytes;
  }

  private trim(): void {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    while (this.entries.size > this.maxEntries || total > this.maxBytes) {
      const victim = this.pickVictim();
      if (!victim) break;
      this.entries.delete(victim.key);
      total -= victim.size;
    }
  }

  /**
   * 淘汰次序：scan 条目先走（最久未登记的先走），然后才是 release 条目按
   * `usedAt` 升序（同值按登记顺序）。这样一次列表扫描产生的 manager 不会
   * 把用户刚用过的会话挤出缓存。
   */
  private pickVictim(): CacheEntry | undefined {
    let victim: CacheEntry | undefined;
    for (const entry of this.entries.values()) {
      if (!victim) {
        victim = entry;
        continue;
      }
      if (this.outranks(entry, victim)) victim = entry;
    }
    return victim;
  }

  /** 是否应当**先于** `candidate` 被淘汰。 */
  private outranks(candidate: CacheEntry, candidateVictim: CacheEntry): boolean {
    const candidateScan = candidate.origin === "scan";
    const victimScan = candidateVictim.origin === "scan";
    if (candidateScan !== victimScan) return candidateScan;
    if (candidateScan) return candidate.order < candidateVictim.order;
    if (candidate.usedAt !== candidateVictim.usedAt) return candidate.usedAt < candidateVictim.usedAt;
    return candidate.order < candidateVictim.order;
  }
}
