/**
 * 按会话键控的**有界**补丁基线缓存（utility / main / renderer 三处共用）。
 *
 * 为什么必须共用一份：A→B→A 的增量恢复要求三个进程对「哪个会话还有基线、谁是
 * 最新的」有完全一致的判断。三处各写一套 LRU，淘汰序列一旦不同步，就会在最不该
 * 差分的时候差分（补丁底座不存在或序号对不上）——这是最难排查的一类错乱。这里
 * 只负责「有没有、是不是最新」，内容判断一律留给调用方。
 *
 * 语义：
 * - 键是目标会话 id（`snapshot.sessionId`），不是会话文件路径。
 * - `get` 也会把条目移到「最近使用」队尾（真 LRU），`set` 覆盖同名条目同样刷新。
 * - 超出容量时淘汰**最久未被使用**的条目；淘汰只是性能降级——命中失败的一方必须
 *   退化成全量（`state` / `state.recovery`），绝不能拿错基线凑合。
 * - 条目里的快照应当是与快照本身同引用的视图（消息/执行数组不复制），否则每次
 *   发帧都会多留一份大会话正文。
 */

/**
 * 最多保留几个会话的 active 基线。
 *
 * 取值口径：活跃会话 + 最近切走过的几个就够（`MAX_PARKED_SESSIONS = 6` 是 utility
 * 侧驻留上限，超过它的会话本来就被驱逐、基线也随之释放）。上限越大，越久的历史
 * 消息数组被钉在内存里。
 */
export const MAX_SESSION_BASELINES = 6;

/** 基线条目至少要有目标会话 id（缓存的键）。 */
export interface SessionBaselineEntry {
  sessionId: string;
}

export interface SessionBaselineCache<T extends SessionBaselineEntry> {
  /** 命中时刷新 LRU 位置；未命中/无 sessionId 返回 undefined。 */
  get(sessionId: string | undefined): T | undefined;
  /** 写入或整体替换同名条目（同样刷新 LRU 位置，必要时淘汰最久未用的）。 */
  set(entry: T): void;
  /** 会话销毁/失效：释放该会话的基线（之后切回会走全量）。 */
  delete(sessionId: string | undefined): void;
  /** 全局重同步：所有基线作废。 */
  clear(): void;
  /** 当前键集合（按 LRU 顺序，最久未用的在前；测试与诊断用）。 */
  ids(): string[];
  readonly size: number;
}

export function createSessionBaselineCache<T extends SessionBaselineEntry>(capacity: number = MAX_SESSION_BASELINES): SessionBaselineCache<T> {
  const entries = new Map<string, T>();
  const max = Math.max(1, Math.floor(capacity));
  return {
    get(sessionId: string | undefined): T | undefined {
      if (!sessionId) return undefined;
      const found = entries.get(sessionId);
      if (!found) return undefined;
      // 重新插入以刷新「最近使用」位置（Map 保持插入序）。
      entries.delete(sessionId);
      entries.set(sessionId, found);
      return found;
    },
    set(entry: T): void {
      entries.delete(entry.sessionId);
      entries.set(entry.sessionId, entry);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(sessionId: string | undefined): void {
      if (sessionId) entries.delete(sessionId);
    },
    clear(): void {
      entries.clear();
    },
    ids(): string[] {
      return [...entries.keys()];
    },
    get size(): number {
      return entries.size;
    }
  };
}
