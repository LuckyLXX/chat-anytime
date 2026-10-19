// Todo capability cluster extracted from pi-runtime.ts. dsh（deepseek-harness）
// 式单一所有者语义：唯一的 todo_write 工具整表替换清单，清单状态只通过
// 工具调用参数出现在对话尾部（纯追加，不破坏前缀 KV cache），结果只回
// 计数不回显整表；没有每轮系统提示注入，也没有部分更新或回读工具。
//
// 验收闭环（2026-10-19）：条目可带 verify（一条 shell 命令）。条目从非
// completed 转为 completed 时由本工具直接执行，失败即退回 in_progress 并把
// 输出尾部回给模型——这是「完成」这个动作唯一的声明点，也是唯一能保证模型
// 不跳过验证的位置。已 completed 的条目重复发送不会重复执行。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Todo, TodoStatus } from "../shared/protocol.js";
import type { TodoStore } from "./todo-store.js";
import { TODO_VERIFY_MAX_CHARS, truncateVerifyOutput, VERIFY_OUTPUT_CAP, type VerifyResult } from "./todo-verify.js";
import { Type } from "typebox";

export interface TodoVerifyDeps {
  /** 在工作区执行一条验收命令；实现方保证永不 reject（失败信息进结果字段）。 */
  run: (command: string, signal?: AbortSignal) => Promise<VerifyResult>;
  /** 会话的 shell 能力是否开启（角色工具开关）。关闭时验收一律不执行。 */
  shellEnabled: () => boolean;
  /** 走权限门（与 bash 同风险轴）；false = 用户拒绝或访问模式拒绝。 */
  requestPermission: (command: string, toolCallId: string) => Promise<boolean>;
  /**
   * 用户的 tool_call block 钩子（按 bash 规则匹配）。验收命令不是一次真的
   * bash 调用，但能起 shell 的通路都该过同一道用户规则；未注入时跳过。
   */
  checkBlock?: (command: string) => { blocked: boolean; reason?: string };
}

export interface TodoToolContext {
  store: TodoStore;
  /** Per-session tool-call pacer backing the anti-batching reminder. */
  pace: TodoPaceTracker;
  /** 未注入时（单测 / 子代理）验收一律按「不可用」处理，不会静默放行。 */
  verify?: TodoVerifyDeps;
}

/**
 * 距上次清单更新多少个工具调用后，todo_write 的返回文本开始附攒批提醒。
 * 审计实测模型平均隔 8~16 个调用才更新一次；理想节奏是每 1~2 步一更，
 * 取 4 作为提醒门槛——低于此不打扰，超过即温和戳一下。
 */
export const PACE_REMINDER_THRESHOLD = 4;

/** 单次 todo_write 返回文本的上限：验收输出再多也不能把工具结果撑爆。 */
export const TODO_RESULT_TEXT_CAP = 8_000;

/**
 * Per-session counter of tool executions since the last todo_write. The audit
 * extension's tool_execution_start hook calls {@link TodoPaceTracker.record};
 * todo_write itself calls {@link TodoPaceTracker.consume} to read and reset.
 * A write's own start event lands before execute runs, so it is counted and
 * then wiped by the same call — no special-casing needed.
 */
export interface TodoPaceTracker {
  record(): void;
  /** Read the count of tool calls since the last write and reset it to zero. */
  consume(): number;
}

export function createTodoPaceTracker(): TodoPaceTracker {
  let count = 0;
  return {
    record: () => { count += 1; },
    consume: () => {
      const value = count;
      count = 0;
      return value;
    }
  };
}

export interface TodoVerifyReport {
  passed: { content: string; command: string }[];
  failed: { content: string; command: string; result: VerifyResult }[];
  /** 用户中止本轮导致没跑完：不是失败，不写 verifyOk。 */
  aborted: { content: string; command: string; result: VerifyResult }[];
  blocked: { content: string; command: string; reason: string }[];
}

function formatSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Result text for one todo_write. Beyond the compact counts, a large gap since
 * the previous write appends a batching nudge — appended at the conversation
 * tail only, so the prefix KV cache stays intact. The verification report is
 * likewise tail-only prose; the list itself is never echoed.
 */
export function todoWriteResultText(
  counts: { pending: number; inProgress: number; completed: number },
  toolsSinceLastWrite: number,
  report?: TodoVerifyReport
): string {
  const base = `已更新任务清单：${counts.pending} 项待办、${counts.inProgress} 项进行中、${counts.completed} 项已完成。`;
  const sections = [base];

  // 多条失败时给每条输出均分预算，保证最后一个失败的原因也落在 8000 字符内
  // （旧实现直接切头部，最后一条的输出尾部恰恰先被切掉）。
  const failureBudget = Math.max(
    200,
    Math.floor((TODO_RESULT_TEXT_CAP - 1_000) / Math.max(1, report?.failed.length ?? 0)) - 200
  );

  if (report && report.passed.length > 0) {
    sections.push(`验收通过 ${String(report.passed.length)} 项：${report.passed.map((item) => item.command).join("；")}`);
  }
  if (report && report.failed.length > 0) {
    sections.push(
      [
        `验收未通过 ${String(report.failed.length)} 项，已退回未完成（保持最多一项 in_progress）：`,
        ...report.failed.map((item) =>
          `✗ ${item.content} — ${item.command}（${item.result.timedOut ? "超时" : `退出码 ${String(item.result.exitCode ?? "?")}`}，耗时 ${formatSeconds(item.result.durationMs)}）${item.result.output ? `\n${truncateVerifyOutput(item.result.output, Math.min(VERIFY_OUTPUT_CAP, failureBudget))}` : ""}`
        )
      ].join("\n")
    );
  }
  if (report && report.aborted.length > 0) {
    sections.push(
      [
        `验收被中止 ${String(report.aborted.length)} 项（用户中止了本轮，不是验收失败），已退回未完成：`,
        ...report.aborted.map((item) => `· ${item.content} — ${item.command}：已中止`)
      ].join("\n")
    );
  }
  if (report && report.blocked.length > 0) {
    sections.push(
      [
        `验收未执行 ${String(report.blocked.length)} 项，已退回未完成（修好环境或去掉 verify 后重发清单）：`,
        ...report.blocked.map((item) => `· ${item.content} — ${item.command}：${item.reason}`)
      ].join("\n")
    );
  }

  if (toolsSinceLastWrite >= PACE_REMINDER_THRESHOLD) {
    sections.push(`提示：距上次清单更新已执行 ${String(toolsSinceLastWrite)} 个工具调用——一项完成立即标记 completed，不要攒批。`);
  }

  const text = sections.join("\n");
  return text.length > TODO_RESULT_TEXT_CAP
    ? `${text.slice(0, TODO_RESULT_TEXT_CAP)}\n…（工具结果已截断）`
    : text;
}

/**
 * Validate the constraints the parameter schema can't express and build the
 * canonical list: trimmed non-empty unique content, at most one item
 * `in_progress`（串行推进纪律，对齐 dsh allowParallelInProgress: false）,
 * and an optional verify command bounded in length.
 */
function toTodoList(raw: readonly { content?: unknown; status?: unknown; verify?: unknown }[]): Todo[] {
  const todos: Todo[] = [];
  const seen = new Set<string>();
  let active = 0;
  for (const item of raw) {
    const content = String(item?.content ?? "").trim();
    if (!content) throw new Error("invalid todo：content 必须是非空字符串");
    if (seen.has(content)) throw new Error(`invalid todos：content 重复「${content}」`);
    seen.add(content);
    const status = item?.status as TodoStatus;
    if (status === "in_progress") active += 1;
    const verify = typeof item?.verify === "string" ? item.verify.trim() : "";
    if (verify.length > TODO_VERIFY_MAX_CHARS) {
      throw new Error(`invalid todo：verify 最多 ${String(TODO_VERIFY_MAX_CHARS)} 字符（「${content}」）`);
    }
    todos.push(verify ? { content, status, verify } : { content, status });
  }
  if (active > 1) throw new Error(`invalid todos：最多只能有一项 in_progress（当前 ${String(active)} 项）`);
  return todos;
}

interface VerifyOutcome {
  /** true=通过；false=失败/未执行。 */
  ok: boolean;
  /** 真正跑过命令才有时间戳；被拒绝/环境不满足时保持 undefined。 */
  at?: number;
  result?: VerifyResult;
  reason?: string;
}

/**
 * Carry verification state across whole-list rewrites. Only a matching
 * content + verify pair inherits: changing either means the claim is new and
 * any earlier pass/fail no longer applies.
 */
function inheritVerification(incoming: Todo[], previous: ReadonlyMap<string, Todo>): Todo[] {
  return incoming.map((todo) => {
    const before = previous.get(todo.content);
    if (!before || before.verify !== todo.verify) return todo;
    const verifiedAt = before.verifiedAt ? { verifiedAt: before.verifiedAt } : {};
    // 通过标记只在条目仍处于 completed 时继承：条目被重新打开说明代码已经变了，
    // 上一次通过不再背书；失败标记保留（它是有信息量的上一次结果）。
    const verifyOk =
      before.verifyOk === true
        ? todo.status === "completed" ? { verifyOk: true } : {}
        : before.verifyOk === false
          ? { verifyOk: false }
          : {};
    return { ...todo, ...verifiedAt, ...verifyOk };
  });
}

/** Build the Todo customTool（todo_write，整表替换 + 攒批软提醒 + 完成时验收）. */
export function buildTodoTools({ store, pace, verify }: TodoToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "todo_write",
      label: "更新任务清单",
      description: [
        "记录并更新当前工作的结构化任务清单。每次调用发送完整清单，整体替换上一次（没有部分更新、没有单项编辑）。",
        "多步骤任务请在动手前用它拆出每个具体步骤；串行推进时保持恰好一项 in_progress；一项完成立即标记 completed，不要攒批；全部完成后才允许没有 in_progress 项。琐碎的单步任务不用建清单。",
        "status 三态：pending（未开始）/ in_progress（正在进行）/ completed（已完成）。",
        "关键步骤请给 verify：一条真的能判定结果、且在当前工作区能跑完的 shell 命令（如 npm test、tsc --noEmit、curl -f http://localhost:3000）。条目从非完成转为 completed 时会自动执行；失败会把它退回未完成状态并把输出尾部返回给你。不要写 true / echo 这类空验证；读书、调研类步骤可以不给。verify 随条目一起发送，省略即视为没有。"
      ].join(""),
      promptSnippet: "todo_write: 整表更新任务清单（可带验收命令）",
      // 本工具的 execute 会在 store.list() 与 replaceAll 之间等待验收命令/权限卡，
      // 而 Pi 默认让同批工具并行——两次并行 todo_write 会基于同一份快照互相覆盖，
      // 后完成者能把先完成者的失败回滚抹成「已完成」。声明串行让整批排队执行。
      executionMode: "sequential",
      parameters: Type.Object({
        todos: Type.Array(
          Type.Object({
            content: Type.String({ description: "任务内容——一句简短的祈使句" }),
            status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], { description: "pending（未开始）| in_progress（进行中）| completed（已完成）" }),
            verify: Type.Optional(Type.String({ description: `验收命令（可选）：标记 completed 时自动执行，退出码非 0 即失败（最多 ${String(TODO_VERIFY_MAX_CHARS)} 字符）` }))
          }),
          { description: "完整任务清单，整体替换之前的清单" }
        )
      }),
      execute: async (toolCallId, params, signal) => {
        const incoming = toTodoList((params?.todos ?? []) as { content?: unknown; status?: unknown; verify?: unknown }[]);
        const previous = new Map(store.list().map((todo) => [todo.content, todo]));
        const list = inheritVerification(incoming, previous);

        // 只验证「这一版才完成」的条目：已 completed 的条目重复发送不重跑测试。
        const fresh = list.filter((todo) => todo.status === "completed" && todo.verify && previous.get(todo.content)?.status !== "completed");

        const report: TodoVerifyReport = { passed: [], failed: [], aborted: [], blocked: [] };
        const outcomes = new Map<string, VerifyOutcome>();
        // 同一命令（常见于多个条目的「跑测试」）只执行一次，结果复用到所有条目。
        const cache = new Map<string, Promise<{ result?: VerifyResult; reason?: string }>>();
        const runOne = (command: string): Promise<{ result?: VerifyResult; reason?: string }> => {
          const cached = cache.get(command);
          if (cached) return cached;
          const pending = (async () => {
            if (!verify) return { reason: "当前会话未启用验收执行" };
            if (!verify.shellEnabled()) return { reason: "当前会话未启用 shell 工具" };
            const hookVerdict = verify.checkBlock?.(command);
            if (hookVerdict?.blocked) return { reason: hookVerdict.reason ?? "验收命令被用户钩子拦截" };
            if (!(await verify.requestPermission(command, toolCallId))) return { reason: "验收命令未获授权" };
            try {
              return { result: await verify.run(command, signal) };
            } catch (error) {
              return { reason: `验收执行失败：${error instanceof Error ? error.message : String(error)}` };
            }
          })();
          cache.set(command, pending);
          return pending;
        };

        for (const todo of fresh) {
          const command = todo.verify!;
          const outcome = await runOne(command);
          if (!outcome.result) {
            report.blocked.push({ content: todo.content, command, reason: outcome.reason ?? "验收未执行" });
            outcomes.set(todo.content, { ok: false });
            continue;
          }
          if (outcome.result.ok) {
            report.passed.push({ content: todo.content, command });
            outcomes.set(todo.content, { ok: true, at: Date.now(), result: outcome.result });
          } else if (outcome.result.aborted) {
            // 用户停掉了本轮：没跑完不等于没通过，不写 verifyOk（也不当失败上报）。
            report.aborted.push({ content: todo.content, command, result: outcome.result });
            outcomes.set(todo.content, { ok: false });
          } else {
            report.failed.push({ content: todo.content, command, result: outcome.result });
            outcomes.set(todo.content, { ok: false, at: Date.now(), result: outcome.result });
          }
        }

        // 失败/未执行一律退回未完成：宁可让模型看到未完成，也不留下假的「已完成」。
        // 整表校验要求最多一项 in_progress，所以已有进行中任务时把退回项落成 pending，
        // 否则模型下一轮原样回显存储状态会被自己的校验拒绝。
        let activeTaken = list.some((todo) => todo.status === "in_progress" && !outcomes.has(todo.content));
        const finalList = list.map((todo): Todo => {
          const outcome = outcomes.get(todo.content);
          if (!outcome) return todo;
          if (outcome.ok) return { ...todo, verifiedAt: outcome.at ?? Date.now(), verifyOk: true };
          const status: TodoStatus = activeTaken ? "pending" : "in_progress";
          activeTaken = true;
          if (outcome.at) return { ...todo, status, verifiedAt: outcome.at, verifyOk: false };
          // 被拒绝/环境不满足/被中止：连旧的「通过」标记一起清掉，否则 UI 会同时
          // 显示通过与进行中。
          const { verifyOk: _verifyOk, verifiedAt: _verifiedAt, ...rest } = todo;
          return { ...rest, status };
        });

        store.replaceAll(finalList);
        const count = (status: TodoStatus): number => finalList.filter((todo) => todo.status === status).length;
        const counts = { pending: count("pending"), inProgress: count("in_progress"), completed: count("completed") };
        return {
          content: [{ type: "text" as const, text: todoWriteResultText(counts, pace.consume(), report) }],
          details: {
            count: finalList.length,
            ...counts,
            verify: {
              ran: report.passed.length + report.failed.length,
              passed: report.passed.length,
              failed: report.failed.length,
              aborted: report.aborted.length,
              blocked: report.blocked.length
            }
          },
          ...(report.failed.length > 0 || report.blocked.length > 0 ? { isError: true } : {})
        };
      }
    })
  ];
}
