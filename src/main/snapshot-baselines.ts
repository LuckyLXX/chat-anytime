/**
 * main 进程的 active 快照缓存（渲染端重载后的 bootstrap 数据源）。
 *
 * 为什么必须按会话键控：`state.patch` 的底座是**该会话自己**的上一帧快照。A→B→A
 * 时如果把它套到当前 `latestSnapshot`（那时是 B）上，bootstrap 就会吐出一份「B 的
 * 外框 + A 的差量」的假数据——渲染端拿到的是错的会话，而且看起来一切正常。
 *
 * 因此这里与 utility / 渲染端用同一套键（`snapshot.sessionId`）、同一容量与同一
 * LRU 规则（`shared/session-baseline-cache.ts`）：
 * - `state` / `state.recovery` 建立或重置该会话的基线（两者都是全量帧）；
 * - `state.patch` 只合并到帧 `sessionId` 对应的基线，并按 revision 单调去重；
 * - `state.resume.patch` 必须先通过目标会话的**精确**基线校验（`applyResumeStatePatch`）。
 *
 * 基线缺失、补丁失配、resume 令牌不对时**只发定向恢复**（`state.recover`），不再用
 * 全局 `state.sync`：全量重同步会顺带让渲染端丢掉所有会话的基线，一次坏帧就退化成
 * 「每次切会话都重传历史」。
 *
 * 本模块是纯内存逻辑（可单测）：喂消息 → 读快照/取恢复请求。IPC 在调用方。
 */

import type { RuntimeCommand, RuntimeMessage, RuntimeSnapshot } from "../shared/protocol.js";
import { applyResumeStatePatch, applyRuntimeStatePatch } from "../shared/snapshot-patch.js";
import { MAX_SESSION_BASELINES, createSessionBaselineCache } from "../shared/session-baseline-cache.js";

/** 一次 active 快照基线：只留快照本身（main 不需要消息/执行数组的额外视图）。 */
interface MainSnapshotBaseline {
  sessionId: string;
  revision?: number;
  snapshot: RuntimeSnapshot;
}

export interface MainSnapshotIngest {
  /** 更新后的当前 active 快照（= bootstrap 要返回的那一份；未变化时不提供）。 */
  latest?: RuntimeSnapshot;
  /** 需要发给 utility 的定向恢复请求（基线缺失/补丁失配时）。 */
  recover?: Extract<RuntimeCommand, { type: "state.recover" }>;
}

export interface MainSnapshotCache {
  /** 喂一条 active 通道推送（其余消息返回空结果，调用方可无条件调用）。 */
  ingest(message: RuntimeMessage): MainSnapshotIngest;
  /** 当前 active 快照（从未收到全量帧时为 undefined）。 */
  latest(): RuntimeSnapshot | undefined;
  /** 会话销毁/清空（测试与诊断用；生产上基线由 LRU 自行约束）。 */
  reset(): void;
}

export function createMainSnapshotCache(options: { nextRequestId: () => string }): MainSnapshotCache {
  const baselines = createSessionBaselineCache<MainSnapshotBaseline>(MAX_SESSION_BASELINES);
  let current: RuntimeSnapshot | undefined;
  let pending: { requestId: string; sessionId: string } | undefined;

  function remember(snapshot: RuntimeSnapshot): void {
    if (!snapshot.sessionId) return;
    baselines.set({ sessionId: snapshot.sessionId, revision: snapshot.revision, snapshot });
  }

  /** 清理已不再需要的在途请求（同一目标已有答案时）。 */
  function settle(sessionId: string): void {
    if (pending?.sessionId === sessionId) pending = undefined;
  }

  function requestRecovery(sessionId: string): MainSnapshotIngest {
    // 同一目标已有在途请求就不要重复发（帧速率可达 20fps）。
    if (pending?.sessionId === sessionId) return {};
    const requestId = options.nextRequestId();
    pending = { requestId, sessionId };
    return { recover: { type: "state.recover", sessionId, requestId } };
  }

  return {
    ingest(message: RuntimeMessage): MainSnapshotIngest {
      switch (message.type) {
        case "state": {
          current = message.snapshot;
          remember(message.snapshot);
          pending = undefined;
          return { latest: message.snapshot };
        }
        case "state.recovery": {
          const snapshot = message.snapshot;
          if (snapshot.sessionId !== message.sessionId) return {};
          // 恢复帧可能是回应 main 自己的请求，也可能是回应**渲染端直接发出的**
          // state.recover（它自带 requestId，main 认不出来）。两者都是目标会话的全量
          // 快照：基线无条件换成这一份（不换的话后续 state.patch 会套在旧基线上，
          // 消息差量算错）。当前快照能不能换分两种：
          //  - 自己请求的：主动要过该会话的快照，utility 只会为**当前 active** 回帧 ⇒ 权威；
          //  - 别人请求的：只在目标本就是当前 active 时跟上，过期帧不得覆盖后来激活的会话。
          const owned = Boolean(pending && pending.requestId === message.requestId && pending.sessionId === message.sessionId);
          remember(snapshot);
          settle(message.sessionId);
          if (owned || current?.sessionId === message.sessionId) {
            current = snapshot;
            return { latest: snapshot };
          }
          return {};
        }
        case "state.patch": {
          const sessionId = message.snapshot.sessionId ?? current?.sessionId;
          if (!sessionId) return {};
          const baseline = baselines.get(sessionId);
          if (!baseline) return requestRecovery(sessionId);
          const revision = message.snapshot.revision;
          if (revision !== undefined && baseline.revision !== undefined) {
            // 重复/重放帧（≤ 基线 revision）直接丢弃：增量补丁重复应用会重复 append。
            if (revision <= baseline.revision) return {};
            // 断档 = main 的基线落后于 utility（典型原因：渲染端自己发起的恢复帧
            // 没被认领、或中间漏帧）。此时套用差量会把消息算错，只请求定向恢复。
            if (revision !== baseline.revision + 1) return requestRecovery(sessionId);
          }
          const merged = applyRuntimeStatePatch(baseline.snapshot, message);
          if (!merged) return requestRecovery(sessionId);
          current = merged;
          remember(merged);
          settle(sessionId);
          return { latest: merged };
        }
        case "state.resume.patch": {
          const sessionId = message.sessionId;
          const baseline = baselines.get(sessionId);
          if (!baseline) return requestRecovery(sessionId);
          const revision = message.snapshot.revision;
          // 切回帧的新 revision **合法跳号**（中间夹着别的会话用掉的全局序号），
          // 所以这里只去重、不做连号判定；基线是否匹配由 baseRevision 校验。
          if (revision !== undefined && baseline.revision !== undefined && revision <= baseline.revision) return {};
          const merged = applyResumeStatePatch(baseline.snapshot, message);
          if (!merged) return requestRecovery(sessionId);
          current = merged;
          remember(merged);
          settle(sessionId);
          return { latest: merged };
        }
        default:
          return {};
      }
    },
    latest(): RuntimeSnapshot | undefined {
      return current;
    },
    reset(): void {
      baselines.clear();
      current = undefined;
      pending = undefined;
    }
  };
}
