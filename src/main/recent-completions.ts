import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionSummary, SessionTerminalStatus } from "../shared/protocol.js";
import { writeJsonAtomic } from "./settings-store.js";

/**
 * 侧栏顶部「已完成」分区的持久化记录（2026-11-13 用户需求：顶部只有「运行中」，
 * 刚在别的工作区跑完的会话还得切回那个工作区翻分组才找得到）。
 *
 * 与 `runStatus` 的分工必须分清，否则要么重启就丢、要么点开就消失：
 * - `runStatus` 是**瞬时**运行时状态。磁盘摘要不带它（重启即丢），`activate` 还会
 *   把终态清成 undefined（看过即已读，绿/红点是「未读通知」）；
 * - 这里记录的是「最近一次回合结束」的**事实**：成功/失败/中止都记，跨重启保留，
 *   点开不清除（用户还要靠它把刚做完的会话找回来）。
 *
 * 只存 path + 时间 + 结局，不存标题/工作区/条目标题快照：会话列表本身就是权威，
 * 渲染端按 path join。会话被删除/归档/工作区被移除后自然不再出现，无需清理逻辑。
 * 保留条数宽于 UI 上限（UI 只显示 5 个），让「最近 5 个里有失效路径」时还能补位。
 *
 * 纪律（与 recent-workspaces / im-store 同）：坏文件当空处理，绝不能因为一份记录
 * 坏了而影响会话列表；原子写；写失败只告警（丢的只是顶部那一条快捷入口）。
 */

/** 单条记录：会话文件路径 → 最近一次回合结束的时间与结局。 */
export interface RecentCompletion {
  /** 会话 JSONL 绝对路径（与 `SessionSummary.path` 同源）。 */
  path: string;
  /** 回合结束时刻（ms）。 */
  completedAt: number;
  /** 结束方式（成功 / 失败 / 中止）。 */
  outcome: SessionTerminalStatus;
}

interface RecentCompletionsFile {
  version: 1;
  entries: RecentCompletion[];
}

/** UI 只显示 5 个，这里多留一些，避免失效路径（会话被删）把列表打空。 */
export const RECENT_COMPLETIONS_KEEP = 20;

export function recentCompletionsPath(agentDir: string): string {
  return join(agentDir, "pidesktop-recent-completions.json");
}

function pathKey(path: string): string {
  return resolve(path).toLowerCase();
}

function normalizeOutcome(value: unknown): SessionTerminalStatus | undefined {
  return value === "completed" || value === "failed" || value === "aborted" ? value : undefined;
}

function normalizeCompletion(value: unknown): RecentCompletion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim()) return undefined;
  if (typeof record.completedAt !== "number" || !Number.isFinite(record.completedAt)) return undefined;
  const outcome = normalizeOutcome(record.outcome);
  if (!outcome) return undefined;
  return { path: resolve(record.path), completedAt: record.completedAt, outcome };
}

/** 读记录：缺失/损坏/字段非法的条目一律跳过，按完成时间降序。 */
export function loadRecentCompletions(filePath: string): RecentCompletion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    // 缺失或坏 JSON：当作没有记录（下次回合结束会重新建文件）。
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) return [];
  const byPath = new Map<string, RecentCompletion>();
  for (const raw of (parsed as { entries: unknown[] }).entries) {
    const entry = normalizeCompletion(raw);
    if (!entry) continue;
    const key = pathKey(entry.path);
    const existing = byPath.get(key);
    if (existing && existing.completedAt >= entry.completedAt) continue;
    byPath.set(key, entry);
  }
  return [...byPath.values()].sort((left, right) => right.completedAt - left.completedAt).slice(0, RECENT_COMPLETIONS_KEEP);
}

/** 原子落盘（目录按需创建；失败回退直接写，与 writeJsonAtomic 同口径）。 */
export function saveRecentCompletions(filePath: string, entries: readonly RecentCompletion[]): void {
  const payload: RecentCompletionsFile = { version: 1, entries: [...entries] };
  writeJsonAtomic(filePath, payload);
}

/**
 * 记一次回合结束：同路径去重并置顶（同一会话连续跑多轮只有一条，时间取最新），
 * 再按上限裁剪。纯函数，便于单测。
 */
export function recordRecentCompletion(
  entries: readonly RecentCompletion[],
  input: { path: string; completedAt?: number; outcome: SessionTerminalStatus }
): RecentCompletion[] {
  const path = input.path.trim();
  if (!path) return [...entries];
  const next: RecentCompletion = {
    path: resolve(path),
    completedAt: input.completedAt ?? Date.now(),
    outcome: input.outcome
  };
  const key = pathKey(next.path);
  return [next, ...entries.filter((entry) => pathKey(entry.path) !== key)].slice(0, RECENT_COMPLETIONS_KEEP);
}

/**
 * 把记录贴到会话列表上（纯投影）：只给**记录里存在且列表里也有**的会话补
 * `completedAt`/`completedOutcome`，其余字段与条目引用原样保留。
 *
 * 为什么在 main 侧贴而不是给渲染端传一份记录：`SessionSummary` 已经是侧栏唯一的
 * 数据源（分组、搜索、运行中分区都读它），多一份旁路数据就多一处 join 与一处漏写。
 */
export function applyRecentCompletions(
  sessions: readonly SessionSummary[],
  entries: readonly RecentCompletion[]
): SessionSummary[] {
  if (entries.length === 0) return sessions as SessionSummary[];
  const byPath = new Map<string, RecentCompletion>();
  for (const entry of entries) byPath.set(pathKey(entry.path), entry);
  let changed = false;
  const next = sessions.map((session) => {
    const entry = byPath.get(pathKey(session.path));
    if (!entry) {
      if (session.completedAt === undefined && session.completedOutcome === undefined) return session;
      // 记录已被裁剪/清空：清掉旧标记，别让一条过期的「已完成」永远挂在侧栏。
      changed = true;
      const rest = { ...session };
      delete rest.completedAt;
      delete rest.completedOutcome;
      return rest;
    }
    if (session.completedAt === entry.completedAt && session.completedOutcome === entry.outcome) return session;
    changed = true;
    return { ...session, completedAt: entry.completedAt, completedOutcome: entry.outcome };
  });
  return changed ? next : (sessions as SessionSummary[]);
}
