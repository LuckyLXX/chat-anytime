import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AutomationRunRecord } from "../shared/protocol.js";

/**
 * 自动化运行历史持久化：全角色共用一份 append-only 事件流
 * `<agentDir>/pidesktop-automation/runs.jsonl`（与任务文件同目录；
 * `readAllAutomations` 只读 `*.json`，不受影响）。运行历史是全局事件流，
 * 不按角色分文件，与「跨角色调度、全角色聚合展示」的既有口径一致。
 * 容量：全局保留最近 {@link MAX_RUNS} 条，追加后超限即整表重写（tmp+rename，
 * 低频事件可接受读-过滤-写）。
 */

export const MAX_RUNS = 200;

/** 运行历史文件路径（全局共用一份）。 */
export function automationRunsPath(agentDir: string): string {
  return join(agentDir, "pidesktop-automation", "runs.jsonl");
}

/**
 * 归一化一条运行记录：校验必填字段（id/taskId/taskName/agentId/agentName/
 * sessionId/startedAt/durationMs/status/trigger），非法即 undefined（调用方丢弃）。
 * 可选字段（modelId/preview/error）仅当非空字符串时携带。
 */
export function normalizeAutomationRun(raw: unknown): AutomationRunRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const run = raw as Record<string, unknown>;
  const str = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!str(run.id) || !str(run.taskId) || !str(run.taskName) || !str(run.agentId) || !str(run.agentName)) return undefined;
  if (typeof run.startedAt !== "number" || !Number.isFinite(run.startedAt)) return undefined;
  if (typeof run.durationMs !== "number" || !Number.isFinite(run.durationMs)) return undefined;
  if (run.status !== "ok" && run.status !== "error" && run.status !== "aborted" && run.status !== "skipped") return undefined;
  // sessionId 对 skipped 放宽（跳过没有会话），普通运行仍必填——放宽时不能过头，
  // 因此测试同时钉住「skipped 无会话通过」与「ok 无会话仍被丢弃」两条。
  if (run.status !== "skipped" && !str(run.sessionId)) return undefined;
  if (run.trigger !== "cron" && run.trigger !== "manual") return undefined;
  return {
    id: run.id,
    taskId: run.taskId,
    taskName: run.taskName,
    agentId: run.agentId,
    agentName: run.agentName,
    ...(str(run.sessionId) ? { sessionId: run.sessionId } : {}),
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    status: run.status,
    trigger: run.trigger,
    ...(str(run.skipReason) ? { skipReason: run.skipReason } : {}),
    ...(str(run.modelId) ? { modelId: run.modelId } : {}),
    ...(str(run.preview) ? { preview: run.preview } : {}),
    ...(str(run.error) ? { error: run.error } : {})
  };
}

/** 读取全部运行记录；逐行解析，坏行跳过，按 startedAt 倒序。缺失/损坏文件返回空数组。 */
export function readAutomationRuns(agentDir: string): AutomationRunRecord[] {
  let content: string;
  try {
    content = readFileSync(automationRunsPath(agentDir), "utf8");
  } catch {
    return [];
  }
  const runs: AutomationRunRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const normalized = normalizeAutomationRun(JSON.parse(trimmed) as unknown);
      if (normalized) runs.push(normalized);
    } catch {
      // 坏行跳过
    }
  }
  runs.sort((left, right) => right.startedAt - left.startedAt);
  return runs;
}

/**
 * 追加一条运行记录；追加后若超 {@link MAX_RUNS} 条则重写文件保留最新
 * MAX_RUNS 条（tmp+rename 原子写）。返回全量最新列表（按 startedAt 倒序）。
 */
export function appendAutomationRun(agentDir: string, record: AutomationRunRecord): AutomationRunRecord[] {
  const file = automationRunsPath(agentDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [record];
  }
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length <= MAX_RUNS) return readAutomationRuns(agentDir);
  // 超限裁剪：读-过滤-写（低频事件，可接受）。
  const runs: AutomationRunRecord[] = [];
  for (const line of lines) {
    try {
      const normalized = normalizeAutomationRun(JSON.parse(line) as unknown);
      if (normalized) runs.push(normalized);
    } catch {
      // 坏行随裁剪一并丢弃
    }
  }
  const keep = runs.sort((left, right) => right.startedAt - left.startedAt).slice(0, MAX_RUNS);
  const tempPath = `${file}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${keep.map((run) => JSON.stringify(run)).join("\n")}\n`, "utf8");
  renameSync(tempPath, file);
  return keep;
}