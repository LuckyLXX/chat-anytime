// 自动化定时任务自定义工具（自建能力，utility 进程内，暴露给 Pi 会话）。
// 工具是「怎么落库」的载体，系统的 DSL 与参数在此统一；skill 是「怎么建」的指引。
// 工具执行直接读写当前 Agent 的 store（经回调），不重建会话、不依赖全局状态。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AccessMode, AutomationTask } from "../shared/protocol.js";
import { isValidCron } from "./automation-cron.js";

export interface AutomationCreateInput {
  name: string;
  cron: string;
  prompt: string;
  timezone?: string;
  model?: { provider: string; id: string };
  workspace?: string;
  accessMode?: AccessMode;
  skillName?: string;
  subagentName?: string;
}

export interface AutomationToolContext {
  /** 归一化并插入/覆盖一条任务，返回最新列表与落库后的任务。 */
  addTask: (input: AutomationCreateInput) => { task: AutomationTask; tasks: AutomationTask[] };
  /** 当前 Agent 的任务列表。 */
  listTasks: () => AutomationTask[];
  removeTask: (id: string) => AutomationTask[];
  setTaskEnabled: (id: string, enabled: boolean) => AutomationTask[];
  /** 手动运行一次（pi-runtime 的 runAutomationTask 回调）。 */
  runTaskNow: (id: string) => Promise<{ ok: boolean; message?: string }>;
  /** 校验模型是否已配置可用（命中返回 true）；缺省恒 true（不校验）。 */
  modelAvailable?: (provider: string, id: string) => boolean;
}

const ACCESS_MODES: readonly AccessMode[] = ["read-only", "ask", "workspace", "full"];

function normalizeAccessMode(raw: unknown): AccessMode {
  return ACCESS_MODES.includes(raw as AccessMode) ? (raw as AccessMode) : "full";
}

export function validateCreateInput(raw: unknown): AutomationCreateInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const cron = typeof input.cron === "string" ? input.cron.trim() : "";
  if (!name) throw new Error("任务名称不能为空");
  if (!prompt) throw new Error("任务提示词不能为空");
  if (!isValidCron(cron)) throw new Error(`cron 表达式非法：${JSON.stringify(cron)}（需 分 时 日 月 周 5 字段，如 "0 9 * * 1-5"）`);

  let model: { provider: string; id: string } | undefined;
  const rawModel = input.model as Record<string, unknown> | undefined;
  if (rawModel && typeof rawModel.provider === "string" && rawModel.provider.trim() && typeof rawModel.id === "string" && rawModel.id.trim()) {
    model = { provider: rawModel.provider.trim(), id: rawModel.id.trim() };
  }

  const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : undefined;
  const workspace = typeof input.workspace === "string" && input.workspace.trim() ? input.workspace.trim() : undefined;
  const skillName = typeof input.skillName === "string" && input.skillName.trim() ? input.skillName.trim() : undefined;
  const subagentName = typeof input.subagentName === "string" && input.subagentName.trim() ? input.subagentName.trim() : undefined;

  return { name, cron, prompt, timezone, model, workspace, accessMode: normalizeAccessMode(input.accessMode), skillName, subagentName };
}

/** 建一条任务摘要（供模型回显，简短）。 */
function taskSummary(task: AutomationTask): string {
  return `#${task.id} ${task.name}（${task.schedule.cron}${task.schedule.timezone ? ` · ${task.schedule.timezone}` : ""}${task.model ? ` · ${task.model.id}` : ""}${task.enabled ? "" : " · 已暂停"}）`;
}

/** Build the automation customTools（create/list/delete/toggle/run）. */
export function buildAutomationTools(ctx: AutomationToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "automation.create",
      label: "创建定时任务",
      description: [
        "创建一条自动化定时任务：到点（cron）后让 Agent 用给定提示词在后台跑一次。",
        "cron 为 5 字段（分 时 日 月 周），如 \"0 9 * * 1-5\" = 工作日每天 09:00、\"0 18 * * *\" = 每天 18:00。",
        "model 可选（不指定则用该 Agent 默认模型）；accessMode 建议「完全访问」（full），否则无人值守时可能因权限确认而挂起。",
        "任务创建后即按 cron 自动调度；如需立即验证可用 automation.run。"
      ].join(""),
      promptSnippet: "automation.create: 创建定时任务",
      parameters: Type.Object({
        name: Type.String({ description: "任务名称" }),
        cron: Type.String({ description: "cron 5 字段：分 时 日 月 周" }),
        prompt: Type.String({ description: "触发后让 Agent 做什么" }),
        timezone: Type.Optional(Type.String({ description: "IANA 时区名；缺省跟随系统" })),
        model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() }, { description: "执行所用模型；缺省用该 Agent 默认模型" })),
        workspace: Type.Optional(Type.String({ description: "参照「空间」；v1 供展示，执行用当前工作区" })),
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
          content: [{ type: "text" as const, text: `已创建定时任务：${taskSummary(task)}。当前共有 ${tasks.length} 条。` }],
          details: { id: task.id, name: task.name, cron: task.schedule.cron, count: tasks.length }
        };
      }
    }),
    defineTool({
      name: "automation.list",
      label: "列出自定义定时任务",
      description: "列出当前 Agent 的全部定时任务（名称/cron/启用状态/近一次运行）。想查具体任务的运行结果，打开对应会话即可。",
      promptSnippet: "automation.list: 列出定时任务",
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
      name: "automation.delete",
      label: "删除定时任务",
      description: "按 id 删除一条定时任务。",
      promptSnippet: "automation.delete: 删除定时任务",
      parameters: Type.Object({ id: Type.String({ description: "任务 id" }) }),
      execute: async (_id, params) => {
        const id = String((params as { id?: unknown })?.id ?? "").trim();
        if (!id) throw new Error("任务 id 不能为空");
        const tasks = ctx.removeTask(id);
        return { content: [{ type: "text" as const, text: `已删除定时任务 ${id}。剩余 ${tasks.length} 条。` }], details: { count: tasks.length } };
      }
    }),
    defineTool({
      name: "automation.toggle",
      label: "启停定时任务",
      description: "启用/暂停一条定时任务（暂停后不再按 cron 自动触发）。",
      promptSnippet: "automation.toggle: 启停定时任务",
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
      name: "automation.run",
      label: "运行定时任务",
      description: "立即手动运行一条定时任务（不等待 cron），用于验证任务提示词与模型。",
      promptSnippet: "automation.run: 立即运行定时任务",
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
