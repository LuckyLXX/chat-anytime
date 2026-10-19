/**
 * 团队能力的工具面：九个 `team_*` 工具，纯构建器（只做参数校验与调用
 * `TeamService`），与 runtime-todo / runtime-computer 同款分层。
 *
 * 角色纪律：Lead 拿到 spawn/interrupt + 全部协作工具；teammate 只拿
 * send/list/wait/task_*（不能创建成员、不能中断别人）。运行时会再校验一次，
 * 工具可见性只是省 token 的第一道门。
 *
 * 协作纪律写在 `team_list` 的 promptGuidelines 上（Pi 只把**激活工具**的
 * guidelines 追加进系统提示词）：团队模式关闭时零成本；开启时每个成员各一份，
 * 但不改动 Lead 的固定系统提示词，前缀缓存只在开关切换那一次失效。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type TeamMembership,
  type TeamService
} from "./team-contract.js";
import type { TeamTaskAction, TeamTaskMutation } from "./team-tasks.js";

function json(value: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

const TEAM_POLICY_GUIDELINES = [
  "团队成员共享同一工作区，文件改动对所有成员立即可见；把写入工作拆成互不重叠的范围，最终 diff 由 Team Lead 检查。",
  "只有 Team Lead 能创建或中断成员；成员名字永久占用，创建失败也不复用。",
  "team_send 发给 running 成员会在其最近步骤边界送达；发给 inactive 成员会唤醒或冷恢复它。成功只代表投递到收件箱，不代表已处理。",
  "先 team_list 再 team_wait；没有其他成员 running/provisioning 时 team_wait 会立即返回 noProgress，不要轮询。",
  "任务板用 revision 做 compare-and-set：先 team_task_get，再用最新 revision 更新；write_scopes 只做重叠告警，不是文件锁。",
  "一次性拿结果的独立子任务用 delegate_agent；需要跨轮续存、互发消息或共享任务板时用 team_*。"
];

/**
 * 构建一个成员可用的团队工具集。
 * @param service - 该团队的运行时（Lead 与全部成员共享同一个实例）。
 * @param membership - 工具所属成员的身份（闭包捕获，不来自模型参数）。
 */
export function createTeamTools(service: TeamService, membership: TeamMembership): ToolDefinition[] {
  const isLead = membership.role === "lead";
  const tools: ToolDefinition[] = [];

  if (isLead) {
    tools.push(defineTool({
      name: "team_spawn",
      label: "创建团队成员",
      description: "创建一名有名字的常驻团队成员（独立子会话，共享当前工作区），并让它立即开始执行 prompt。只有 Team Lead 能调用。成员默认继承 Lead 的模型、系统提示与内置工具；subagent 可指定一个已定义的子智能体来覆盖模型/提示词/工具/颜色。名字必须小写 kebab-case、全团队唯一且永不复用（创建失败也不复用）。返回成员行；创建完成后成员状态为 running。",
      promptSnippet: "team_spawn: 创建有名字的常驻团队成员（仅 Lead）",
      parameters: Type.Object({
        name: Type.String({ description: "唯一的小写 kebab-case 成员名（如 reviewer，最多 64 字符，不能是 lead）" }),
        description: Type.String({ description: "这名成员负责什么（简短，最多 200 字符）" }),
        prompt: Type.String({ description: "成员的完整初始任务；它看不到 Lead 的对话历史，必须自包含" }),
        subagent: Type.Optional(Type.String({ description: "可选：现有自定义子智能体的名称或 id；指定后用它的人设/模型/工具/颜色" }))
      }),
      execute: async (_toolCallId, params, signal) => {
        const args = params as { name: string; description: string; prompt: string; subagent?: string };
        return json(await service.spawn(membership, {
          name: args.name,
          description: args.description,
          prompt: args.prompt,
          ...(args.subagent === undefined ? {} : { subagent: args.subagent })
        }, signal));
      }
    }));

    tools.push(defineTool({
      name: "team_interrupt",
      label: "中断团队成员",
      description: "中断一名成员当前的回合，但保留它排队的消息与任务归属（只有 Team Lead 能调用）。成员不会被删除，之后仍可 team_send 唤醒。",
      parameters: Type.Object({
        target: Type.String({ description: "成员名（来自 team_spawn / team_list）" })
      }),
      execute: (_toolCallId, params) => {
        const args = params as { target: string };
        return Promise.resolve(json(service.interrupt(membership, args.target)));
      }
    }));
  }

  tools.push(defineTool({
    name: "team_send",
    label: "给团队成员发消息",
    description: "给另一名成员或 Lead 发一条点对点消息。发给 running 目标会在其最近步骤边界送达；发给 inactive 目标会启动/冷恢复它的下一轮。成功只代表投递到收件箱，不代表模型已处理。不能给自己发消息；单条消息上限 64KB。",
    promptSnippet: "team_send: 给成员或 Lead 发一条点对点消息",
    parameters: Type.Object({
      target: Type.String({ description: "成员名或 lead（来自 team_spawn / team_list）" }),
      message: Type.String({ description: "自包含的消息正文" })
    }),
    execute: async (_toolCallId, params, signal) => {
      const args = params as { target: string; message: string };
      return json(await service.send(membership, args.target, args.message, signal));
    }
  }));

  tools.push(defineTool({
    name: "team_list",
    label: "列出团队成员",
    description: "列出 Lead 与全部成员的可寻址名字、当前状态、模型与诊断。inactive 只表示当前没有回合在跑，不代表任务完成/失败；provisioning 表示创建中，failed 表示创建失败（名字仍被占用）。",
    promptSnippet: "team_list: 查看团队成员、状态与诊断",
    promptGuidelines: TEAM_POLICY_GUIDELINES,
    parameters: Type.Object({}),
    execute: () => Promise.resolve(json({ members: service.list(membership) }))
  }));

  tools.push(defineTool({
    name: "team_wait",
    label: "等待团队变化",
    description: "等待调用之后的下一次团队变化（成员状态、消息接收或任务更新），避免轮询。不会唤醒 inactive 成员；没有其他成员 running/provisioning 时立即返回 noProgress。醒来或超时后重新 team_list / team_task_list。",
    promptSnippet: "team_wait: 等下一次团队变化（不唤醒 inactive 成员）",
    parameters: Type.Object({
      timeout_ms: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 3_600_000, description: "等待毫秒数（10000–3600000，默认 30000）" }))
    }),
    execute: async (_toolCallId, params, signal) => {
      const args = params as { timeout_ms?: number };
      return json(await service.wait(membership, args.timeout_ms ?? 30_000, signal ?? new AbortController().signal));
    }
  }));

  tools.push(defineTool({
    name: "team_task_create",
    label: "创建共享任务",
    description: "在团队共享任务板上创建一条无主 pending 任务。blocked_by 指定必须先完成的任务（DAG，不允许环）；write_scopes 是建议性的工作区相对写入范围（与其它 in_progress 任务重叠时只告警，不加锁）。",
    parameters: Type.Object({
      subject: Type.String({ description: "简短标题（最多 200 字符）" }),
      description: Type.String({ description: "完整任务说明与验收标准" }),
      blocked_by: Type.Optional(Type.Array(Type.String(), { description: "必须先行完成的任务 id" })),
      write_scopes: Type.Optional(Type.Array(Type.String(), { description: "建议性的工作区相对文件/目录前缀" }))
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { subject: string; description: string; blocked_by?: string[]; write_scopes?: string[] };
      return json(await service.createTask(membership, {
        subject: args.subject,
        description: args.description,
        ...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by }),
        ...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes })
      }));
    }
  }));

  tools.push(defineTool({
    name: "team_task_list",
    label: "列出共享任务",
    description: "列出共享任务（含 owner、revision、依赖、就绪状态与写入范围重叠告警）。ready 只在任务为 pending 且全部依赖已完成时为 true。",
    parameters: Type.Object({
      status: Type.Optional(Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed")
      ], { description: "可选：精确状态过滤" })),
      owner: Type.Optional(Type.String({ description: "可选：成员名 / lead / unowned" })),
      ready: Type.Optional(Type.Boolean({ description: "可选：就绪过滤" })),
      cursor: Type.Optional(Type.Integer({ minimum: 0, description: "结果偏移（默认 0）" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "返回条数（默认 50）" }))
    }),
    execute: (_toolCallId, params) => {
      const args = params as { status?: "pending" | "in_progress" | "completed"; owner?: string; ready?: boolean; cursor?: number; limit?: number };
      return Promise.resolve(json(service.listTasks(membership, {
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.owner === undefined ? {} : { owner: args.owner }),
        ...(args.ready === undefined ? {} : { ready: args.ready }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        ...(args.limit === undefined ? {} : { limit: args.limit })
      })));
    }
  }));

  tools.push(defineTool({
    name: "team_task_get",
    label: "读取共享任务",
    description: "读取一条共享任务的最新完整值（含 revision）；修改前先读，变更后 revision 会递增。",
    parameters: Type.Object({
      task_id: Type.String({ description: "任务 id（如 task-3）" })
    }),
    execute: (_toolCallId, params) => {
      const args = params as { task_id: string };
      return Promise.resolve(json(service.getTask(membership, args.task_id)));
    }
  }));

  tools.push(defineTool({
    name: "team_task_update",
    label: "更新共享任务",
    description: "用 expected_revision 做 compare-and-set 更新共享任务。过期 revision 会被拒绝（先 team_task_get 重读）。claim 只能认领 ready 且无主的任务；complete 只能从 in_progress；reassign 只有 Lead 能用；delete 会保留 tombstone 且拒绝删除仍被依赖的任务。",
    parameters: Type.Object({
      task_id: Type.String({ description: "任务 id" }),
      expected_revision: Type.Integer({ minimum: 1, description: "当前 revision（CAS 前置条件）" }),
      action: Type.Union([
        Type.Literal("claim"),
        Type.Literal("release"),
        Type.Literal("edit"),
        Type.Literal("set_dependencies"),
        Type.Literal("complete"),
        Type.Literal("reopen"),
        Type.Literal("reassign"),
        Type.Literal("delete")
      ], { description: "任务转换动作" }),
      subject: Type.Optional(Type.String({ description: "edit：新标题" })),
      description: Type.Optional(Type.String({ description: "edit：新说明" })),
      blocked_by: Type.Optional(Type.Array(Type.String(), { description: "set_dependencies：完整依赖列表" })),
      write_scopes: Type.Optional(Type.Array(Type.String(), { description: "edit：新写入范围" })),
      owner: Type.Optional(Type.String({ description: "reassign：成员名或 lead；空/unowned 表示释放" }))
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        task_id: string;
        expected_revision: number;
        action: TeamTaskAction;
        subject?: string;
        description?: string;
        blocked_by?: string[];
        write_scopes?: string[];
        owner?: string;
      };
      const mutation: TeamTaskMutation = {
        taskId: args.task_id,
        expectedRevision: args.expected_revision,
        action: args.action,
        ...(args.subject === undefined ? {} : { subject: args.subject }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by }),
        ...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes }),
        ...(args.owner === undefined ? {} : { owner: args.owner })
      };
      return json(await service.updateTask(membership, mutation));
    }
  }));

  return tools;
}
