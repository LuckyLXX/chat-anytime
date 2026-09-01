import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccessMode, AutomationTask } from "../shared/protocol.js";
import { isValidCron } from "./automation-cron.js";

/**
 * 自动化定时任务持久化：按 Agent 划分，原子写（tmp+rename，同 todo/plan 风格）
 * 于 `<agentDir>/pidesktop-automation/<agentId>.json`。任务携带 agentId/workspace/
 * model/accessMode 作为执行参数（v1 模型已生效，工作区/跨 Agent 为元数据）。
 */

const ACCESS_MODES: readonly AccessMode[] = ["read-only", "ask", "workspace", "full"];

/** 任务文件路径（按 Agent 划分）。 */
export function automationPathFor(agentDir: string, agentId: string): string {
  return join(agentDir, "pidesktop-automation", `${agentId}.json`);
}

/**
 * 归一化一条任务：校验/净化字段。非法即返回 undefined（调用方丢弃）。
 * 缺省 id 用随机 UUID；enabled 缺省 true；accessMode 缺省 "full"（无人值守）。
 * model 必须是 `{provider,id}` 形状；cron 必须合法。
 */
export function normalizeAutomation(raw: unknown): AutomationTask | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const task = raw as Record<string, unknown>;
  if (typeof task.name !== "string" || !task.name.trim()) return undefined;
  if (typeof task.prompt !== "string" || !task.prompt.trim()) return undefined;

  const schedule = task.schedule as Record<string, unknown> | undefined;
  const cron = typeof schedule?.cron === "string" ? schedule.cron.trim() : "";
  if (!isValidCron(cron)) return undefined;

  const accessMode = ACCESS_MODES.includes(task.accessMode as AccessMode) ? (task.accessMode as AccessMode) : "full";
  const agentId = typeof task.agentId === "string" && task.agentId.trim() ? task.agentId.trim() : "default";

  let model: AutomationTask["model"];
  const rawModel = task.model as Record<string, unknown> | undefined;
  if (rawModel && typeof rawModel.provider === "string" && typeof rawModel.id === "string" && rawModel.provider.trim() && rawModel.id.trim()) {
    model = { provider: rawModel.provider.trim(), id: rawModel.id.trim() };
  }

  const id = typeof task.id === "string" && task.id.trim() ? task.id.trim() : randomUUID();
  const workspace = typeof task.workspace === "string" && task.workspace.trim() ? task.workspace.trim() : undefined;
  // 校验时区：非法 IANA 名会让 cronMatches 抛 RangeError 而被调度器跳过（任务静默永不触发）。
  // 这里用 Intl 试构造校验，非法则回退为跟随系统（留空）。
  const rawTimezone = typeof schedule?.timezone === "string" && schedule.timezone.trim() ? schedule.timezone.trim() : undefined;
  let timezone = rawTimezone;
  if (rawTimezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: rawTimezone });
    } catch {
      timezone = undefined;
    }
  }

  return {
    id,
    name: task.name.trim(),
    schedule: { cron, ...(timezone ? { timezone } : {}) },
    prompt: task.prompt.trim(),
    agentId,
    ...(workspace ? { workspace } : {}),
    ...(model ? { model } : {}),
    accessMode,
    ...(typeof task.skillName === "string" && task.skillName.trim() ? { skillName: task.skillName.trim() } : {}),
    ...(typeof task.subagentName === "string" && task.subagentName.trim() ? { subagentName: task.subagentName.trim() } : {}),
    enabled: task.enabled !== false,
    createdAt: typeof task.createdAt === "number" && Number.isFinite(task.createdAt) ? task.createdAt : Date.now(),
    ...(task.lastRun && typeof task.lastRun === "object"
      ? {
          lastRun: ((): AutomationTask["lastRun"] => {
            const run = task.lastRun as Record<string, unknown>;
            if (typeof run.sessionId !== "string" || !run.sessionId) return undefined;
            const startedAt = typeof run.startedAt === "number" && Number.isFinite(run.startedAt) ? run.startedAt : Date.now();
            const status = run.status === "error" ? "error" : "ok";
            return {
              sessionId: run.sessionId,
              startedAt,
              status,
              ...(typeof run.preview === "string" && run.preview ? { preview: run.preview } : {}),
              ...(typeof run.error === "string" && run.error ? { error: run.error } : {})
            };
          })()
        }
      : {})
  };
}

/** 读取任务列表；缺省/损坏返回空数组。 */
export function readAutomation(filePath: string): AutomationTask[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const rawTasks = parsed && typeof parsed === "object" ? (parsed as { tasks?: unknown[] }).tasks : undefined;
    if (!Array.isArray(rawTasks)) return [];
    return rawTasks.map(normalizeAutomation).filter((task): task is AutomationTask => Boolean(task));
  } catch {
    return [];
  }
}

/** 原子写入任务列表（tmp+rename）。 */
export function writeAutomation(filePath: string, tasks: readonly AutomationTask[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ tasks }, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

/**
 * 聚合读取全部角色的任务：遍历 `pidesktop-automation/*.json` 合并（容错跳过
 * 缺失/损坏文件）。排序稳定：按 agentId 分组相邻（同名任务混杂时易对齐），
 * 组内按 createdAt 升序。设置页与对话侧工具据此看到全角色任务。
 */
export function readAllAutomations(agentDir: string): AutomationTask[] {
  let files: string[];
  try {
    files = readdirSync(join(agentDir, "pidesktop-automation")).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const tasks: AutomationTask[] = [];
  for (const name of files) tasks.push(...readAutomation(join(agentDir, "pidesktop-automation", name)));
  tasks.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.createdAt - b.createdAt);
  return tasks;
}

/** 保存（按 id 覆盖或追加）。任务必须在 normalize 后传入。返回最新列表。 */
export function upsertAutomation(filePath: string, task: AutomationTask): AutomationTask[] {
  const tasks = readAutomation(filePath);
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  const next = index >= 0 ? tasks.map((candidate) => (candidate.id === task.id ? task : candidate)) : [...tasks, task];
  writeAutomation(filePath, next);
  return next;
}

/** 删除任务；返回最新列表（不存在时原样返回）。 */
export function deleteAutomation(filePath: string, id: string): AutomationTask[] {
  const tasks = readAutomation(filePath);
  const next = tasks.filter((candidate) => candidate.id !== id);
  if (next.length !== tasks.length) writeAutomation(filePath, next);
  return next;
}

/** 切换任务启用状态；返回最新列表。 */
export function toggleAutomation(filePath: string, id: string, enabled: boolean): AutomationTask[] {
  const tasks = readAutomation(filePath);
  const next = tasks.map((candidate) => (candidate.id === id ? { ...candidate, enabled } : candidate));
  writeAutomation(filePath, next);
  return next;
}

/** 更新某任务的近一次运行信息；返回最新列表。 */
export function recordAutomationRun(filePath: string, id: string, run: AutomationTask["lastRun"]): AutomationTask[] {
  const tasks = readAutomation(filePath);
  const next = tasks.map((candidate) => (candidate.id === id ? { ...candidate, lastRun: run } : candidate));
  if (next.some((candidate) => candidate.id === id)) writeAutomation(filePath, next);
  return next;
}
