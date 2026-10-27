// 自动化定时任务自定义工具（自建能力，utility 进程内，暴露给 Pi 会话）。
// 工具是「怎么落库」的载体，系统的 DSL 与参数在此统一；skill 是「怎么建」的指引。
// 工具执行直接读写当前 Agent 的 store（经回调），不重建会话、不依赖全局状态。
//
// 2026-10-21 对齐 deepseek-harness 的 schedule：
// - 支持 cron 周期 + after_seconds/at 一次性；
// - 默认 target:"session"：任务绑定当前会话，到期把提醒作为普通消息投递回原对话；
// - target:"background" 保留旧的「新建后台会话执行」形态。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AccessMode, AutomationSchedule, AutomationTask } from "../shared/protocol.js";
import { formatAutomationSchedule } from "../shared/automation.js";
import { isValidCron } from "./automation-cron.js";

const ACCESS_MODES: readonly AccessMode[] = ["read-only", "ask", "workspace", "full"];

export type AutomationTarget = "session" | "background";

/** 当前会话的快照：创建会话绑定任务时由 pi-runtime 注入。 */
export interface AutomationSessionInfo {
  id: string;
  path?: string;
  title?: string;
  workspace?: string;
}

export interface AutomationCreateInput {
  name: string;
  schedule: AutomationSchedule;
  prompt: string;
  target: AutomationTarget;
  model?: { provider: string; id: string };
  workspace?: string;
  accessMode: AccessMode;
  skillName?: string;
  subagentName?: string;
}

export interface AutomationUpdateInput {
  name?: string;
  prompt?: string;
  schedule?: AutomationSchedule;
  target?: AutomationTarget;
  model?: { provider: string; id: string };
  accessMode?: AccessMode;
  enabled?: boolean;
}

export interface AutomationToolContext {
  /** 当前会话信息（创建/改绑 target:"session" 时写进任务）。 */
  getSession: () => AutomationSessionInfo;
  /** 归一化并插入/覆盖一条任务，返回最新列表与落库后的任务。 */
  addTask: (input: AutomationCreateInput) => { task: AutomationTask; tasks: AutomationTask[] };
  /** 按 id 更新任务；返回 undefined 表示任务不存在。 */
  updateTask?: (id: string, patch: AutomationUpdateInput) => { task: AutomationTask; tasks: AutomationTask[] } | undefined;
  /** 当前 Agent 的任务列表。 */
  listTasks: () => AutomationTask[];
  removeTask: (id: string) => AutomationTask[];
  setTaskEnabled: (id: string, enabled: boolean) => AutomationTask[];
  /** 手动运行一次（pi-runtime 的 runAutomationTask 回调）。 */
  runTaskNow: (id: string) => Promise<{ ok: boolean; message?: string }>;
  /** 校验模型是否已配置可用（命中返回 true）；缺省恒 true（不校验）。 */
  modelAvailable?: (provider: string, id: string) => boolean;
}

function normalizeAccessMode(raw: unknown): AccessMode {
  return ACCESS_MODES.includes(raw as AccessMode) ? (raw as AccessMode) : "full";
}

function trimmedString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function parseModel(raw: unknown): { provider: string; id: string } | undefined {
  const value = raw as Record<string, unknown> | undefined;
  if (!value || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
  const provider = value.provider.trim();
  const id = value.id.trim();
  return provider && id ? { provider, id } : undefined;
}

/** 校验 IANA 时区；非法直接拒绝，避免任务静默永不触发。 */
function validateTimezone(raw: unknown): string | undefined {
  const timezone = trimmedString(raw);
  if (!timezone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`时区非法：${JSON.stringify(timezone)}（需 IANA 名称，如 Asia/Shanghai）`);
  }
  return timezone;
}

/**
 * 从工具参数里解析「恰好一个」调度选择器。
 *
 * - cron：5 字段表达式；
 * - after_seconds：正安全整数，scheduledAt 从调用时刻起算；
 * - at：Date.parse 可解析的字符串（推荐带时区偏移的 ISO 8601），必须晚于当前时间。
 */
export function validateScheduleInput(raw: unknown): AutomationSchedule {
  const input = (raw ?? {}) as Record<string, unknown>;
  const cron = trimmedString(input.cron);
  const at = trimmedString(input.at);
  const afterSeconds = typeof input.after_seconds === "number" ? input.after_seconds : undefined;
  const provided = Number(cron.length > 0) + Number(at.length > 0) + Number(afterSeconds !== undefined);
  if (provided !== 1) {
    throw new Error("必须且只能提供 cron、after_seconds、at 三个调度参数之一");
  }

  if (cron) {
    if (!isValidCron(cron)) throw new Error(`cron 表达式非法：${JSON.stringify(cron)}（需 分 时 日 月 周 5 字段，如 "0 9 * * 1-5"）`);
    const timezone = validateTimezone(input.timezone);
    return { kind: "cron", cron, ...(timezone ? { timezone } : {}) };
  }

  if (afterSeconds !== undefined) {
    if (!Number.isSafeInteger(afterSeconds) || afterSeconds <= 0) {
      throw new Error("after_seconds 必须是正安全整数（秒；5 分钟 = 300）");
    }
    return { kind: "after", afterSeconds, scheduledAt: Date.now() + afterSeconds * 1_000 };
  }

  const scheduledAt = Date.parse(at);
  if (!Number.isFinite(scheduledAt)) {
    throw new Error(`at 不是可解析的时间：${JSON.stringify(at)}（推荐带时区偏移的 ISO 8601，如 2026-10-21T15:30:00+08:00）`);
  }
  if (scheduledAt <= Date.now()) throw new Error("at 必须是未来的时间");
  return { kind: "at", scheduledAt };
}

export function validateCreateInput(raw: unknown): AutomationCreateInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const name = trimmedString(input.name);
  const prompt = trimmedString(input.prompt);
  if (!name) throw new Error("任务名称不能为空");
  if (!prompt) throw new Error("任务提示词不能为空");

  if (input.target !== undefined && input.target !== "session" && input.target !== "background") {
    throw new Error("target 只能是 session 或 background");
  }
  const target: AutomationTarget = input.target === "background" ? "background" : "session";
  return {
    name,
    schedule: validateScheduleInput(input),
    prompt,
    target,
    ...(parseModel(input.model) ? { model: parseModel(input.model) } : {}),
    ...(trimmedString(input.workspace) ? { workspace: trimmedString(input.workspace) } : {}),
    accessMode: normalizeAccessMode(input.accessMode),
    ...(trimmedString(input.skillName) ? { skillName: trimmedString(input.skillName) } : {}),
    ...(trimmedString(input.subagentName) ? { subagentName: trimmedString(input.subagentName) } : {})
  };
}

export function validateUpdateInput(raw: unknown): AutomationUpdateInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const patch: AutomationUpdateInput = {};
  if (input.name !== undefined) {
    const name = trimmedString(input.name);
    if (!name) throw new Error("任务名称不能为空");
    patch.name = name;
  }
  if (input.prompt !== undefined) {
    const prompt = trimmedString(input.prompt);
    if (!prompt) throw new Error("任务提示词不能为空");
    patch.prompt = prompt;
  }
  if (input.cron !== undefined || input.after_seconds !== undefined || input.at !== undefined) {
    patch.schedule = validateScheduleInput(input);
  }
  if (input.target !== undefined) {
    if (input.target !== "session" && input.target !== "background") throw new Error("target 只能是 session 或 background");
    patch.target = input.target;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    patch.enabled = input.enabled;
  }
  if (input.model !== undefined) {
    const model = parseModel(input.model);
    if (!model) throw new Error("model 必须是 { provider, id } 形状");
    patch.model = model;
  }
  if (input.accessMode !== undefined) patch.accessMode = normalizeAccessMode(input.accessMode);
  return patch;
}

/** 建一条任务摘要（供模型回显，简短）。 */
function taskSummary(task: AutomationTask): string {
  const schedule = formatAutomationSchedule(task.schedule);
  const target = task.sessionId ? ` · 会话 ${task.sessionTitle ?? task.sessionId}` : " · 后台会话";
  const state = task.completedAt ? " · 已完成" : task.enabled ? "" : " · 已暂停";
  return `#${task.id} ${task.name}（${schedule}${state}${target}${task.model ? ` · ${task.model.id}` : ""}）`;
}

function createResultText(task: AutomationTask, tasks: readonly AutomationTask[]): string {
  const delivery = task.sessionId ? "到期会作为提醒消息投递回当前会话。" : "到期会在后台新会话执行。";
  return `已创建定时任务：${taskSummary(task)}。${delivery}当前共有 ${tasks.length} 条。`;
}

/** Build the automation customTools（automation_create/list/update/delete/toggle/run）. */
export function buildAutomationTools(ctx: AutomationToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "automation_create",
      label: "创建定时任务",
      description: [
        "创建定时任务。提供且只提供一种调度：cron（5 字段：分 时 日 月 周，如 \"0 9 * * 1-5\"）、after_seconds（相对延时一次性，5 分钟 = 300）、at（绝对时间，ISO 8601）。",
        "target 缺省 session：任务绑定当前会话，到期把提醒作为普通用户消息投递回本对话，可直接引用上文（适合「5 分钟后检查刚才的后台任务」）。target=background 才新建后台会话执行。",
        "accessMode 建议 full，无人值守时权限确认会挂起；model 缺省用该 Agent 默认模型。创建后即自动调度，需要立即验证用 automation_run。"
      ].join(""),
      promptSnippet: "automation_create: 创建定时任务（支持 cron / 延时一次性 / 会话绑定）",
      parameters: Type.Object({
        name: Type.String({ description: "任务名称" }),
        prompt: Type.String({ description: "触发后让 Agent 做什么" }),
        cron: Type.Optional(Type.String({ description: "cron 5 字段：分 时 日 月 周（周期任务）" })),
        after_seconds: Type.Optional(Type.Number({ description: "相对延时秒数（一次性任务；5 分钟 = 300）。与 cron/at 三选一" })),
        at: Type.Optional(Type.String({ description: "绝对时间（一次性任务；ISO 8601，如 2026-10-21T15:30:00+08:00）。与 cron/after_seconds 三选一" })),
        target: Type.Optional(Type.String({ description: "session（默认，投递回当前会话）| background（后台新会话）" })),
        timezone: Type.Optional(Type.String({ description: "cron 的 IANA 时区名；缺省跟随系统" })),
        model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() }, { description: "执行所用模型；缺省用该 Agent 默认模型" })),
        workspace: Type.Optional(Type.String({ description: "后台任务执行使用的工作区（完整绝对路径）；缺省用当前会话工作区" })),
        accessMode: Type.Optional(Type.String({ description: "read-only | ask | workspace | full（无人值守建议 full）" })),
        skillName: Type.Optional(Type.String({ description: "可选绑定技能名（v1 仅存，供展示）" })),
        subagentName: Type.Optional(Type.String({ description: "可选绑定子智能体名（v1 仅存，供展示）" }))
      }),
      execute: async (_id, params) => {
        const input = validateCreateInput(params);
        // 模型若指定但不可用，回退为不指定（沿用该 Agent 默认），并在结果中说明。
        const { model: requestedModel, ...rest } = input;
        const model = requestedModel && ctx.modelAvailable && !ctx.modelAvailable(requestedModel.provider, requestedModel.id) ? undefined : requestedModel;
        const { task, tasks } = ctx.addTask({ ...rest, ...(model ? { model } : {}) });
        return {
          content: [{ type: "text" as const, text: createResultText(task, tasks) }],
          details: { id: task.id, name: task.name, schedule: task.schedule, sessionId: task.sessionId, count: tasks.length }
        };
      }
    }),
    defineTool({
      name: "automation_list",
      label: "列出自定义定时任务",
      description: "列出当前 Agent 的全部定时任务（名称/调度/一次性或周期/绑定会话/启用状态/近一次运行）。想查具体任务的运行结果，打开对应会话即可。",
      promptSnippet: "automation_list: 列出定时任务",
      parameters: Type.Object({}),
      execute: async () => {
        const tasks = ctx.listTasks();
        if (tasks.length === 0) {
          return { content: [{ type: "text" as const, text: "当前没有定时任务。" }], details: { count: 0 } };
        }
        const lines = tasks.map(taskSummary);
        return { content: [{ type: "text" as const, text: `当前 ${tasks.length} 条定时任务：\n${lines.join("\n")}` }], details: { count: tasks.length } };
      }
    }),
    defineTool({
      name: "automation_update",
      label: "修改定时任务",
      description: "按 id 修改定时任务：名称、提示词、调度（cron/after_seconds/at 最多一个）、target（session/background）或启用状态。不传的字段保持原值。",
      promptSnippet: "automation_update: 修改定时任务",
      parameters: Type.Object({
        id: Type.String({ description: "任务 id" }),
        name: Type.Optional(Type.String()),
        prompt: Type.Optional(Type.String()),
        cron: Type.Optional(Type.String()),
        after_seconds: Type.Optional(Type.Number()),
        at: Type.Optional(Type.String()),
        target: Type.Optional(Type.String({ description: "session | background" })),
        enabled: Type.Optional(Type.Boolean()),
        model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
        accessMode: Type.Optional(Type.String({ description: "read-only | ask | workspace | full" }))
      }),
      execute: async (_id, params) => {
        const id = trimmedString((params as { id?: unknown })?.id);
        if (!id) throw new Error("任务 id 不能为空");
        if (!ctx.updateTask) throw new Error("当前会话不支持修改定时任务");
        const patch = validateUpdateInput(params);
        const result = ctx.updateTask(id, patch);
        if (!result) throw new Error(`未找到任务 ${id}`);
        return {
          content: [{ type: "text" as const, text: `已更新定时任务：${taskSummary(result.task)}。` }],
          details: { id: result.task.id, schedule: result.task.schedule, sessionId: result.task.sessionId, count: result.tasks.length }
        };
      }
    }),
    defineTool({
      name: "automation_delete",
      label: "删除定时任务",
      description: "按 id 删除一条定时任务。",
      promptSnippet: "automation_delete: 删除定时任务",
      parameters: Type.Object({ id: Type.String({ description: "任务 id" }) }),
      execute: async (_id, params) => {
        const id = String((params as { id?: unknown })?.id ?? "").trim();
        if (!id) throw new Error("任务 id 不能为空");
        const tasks = ctx.removeTask(id);
        return { content: [{ type: "text" as const, text: `已删除定时任务 ${id}。剩余 ${tasks.length} 条。` }], details: { count: tasks.length } };
      }
    }),
    defineTool({
      name: "automation_toggle",
      label: "启停定时任务",
      description: "启用/暂停一条定时任务（暂停后不再自动触发；一次性任务完成后编辑改期才会重新启用）。",
      promptSnippet: "automation_toggle: 启停定时任务",
      parameters: Type.Object({ id: Type.String(), enabled: Type.Boolean() }),
      execute: async (_id, params) => {
        const id = String((params as { id?: unknown })?.id ?? "").trim();
        const enabled = Boolean((params as { enabled?: unknown })?.enabled);
        if (!id) throw new Error("任务 id 不能为空");
        const tasks = ctx.setTaskEnabled(id, enabled);
        const found = tasks.some((task) => task.id === id);
        return { content: [{ type: "text" as const, text: found ? `已${enabled ? "启用" : "暂停"}定时任务 ${id}。` : `未找到任务 ${id}。` }], details: { found, count: tasks.length } };
      }
    }),
    defineTool({
      name: "automation_run",
      label: "运行定时任务",
      description: "立即手动运行一条定时任务（不等待 cron），用于验证任务提示词与模型。会话绑定任务会直接投递到原会话。",
      promptSnippet: "automation_run: 立即运行定时任务",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => {
        const id = String((params as { id?: unknown })?.id ?? "").trim();
        if (!id) throw new Error("任务 id 不能为空");
        const result = await ctx.runTaskNow(id);
        if (!result.ok) throw new Error(result.message || `任务 ${id} 运行失败`);
        return { content: [{ type: "text" as const, text: result.message || `已触发任务 ${id} 运行。` }], details: { id } };
      }
    })
  ];
}
