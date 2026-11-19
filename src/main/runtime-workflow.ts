/**
 * 工作流编排的模型工具面（实施方案 §8.3 / 步骤七）：`workflow_list` /
 * `workflow_run` / `workflow_status` 三个 customTool。
 *
 * 定位：**纯构建器**——只做参数校验、调用注入的 `WorkflowToolSurface`、把结果压成
 * 有界回执。owner/workspace 解析、定义读取、运行受理、状态回读全部留在
 * `pi-runtime.ts`（surface 由 `workflowToolSurfaceFor(record)` 提供，闭包绑定
 * **本次会话的 record**，绝不读 activeRuntime：parked 会话里调用也必须落在它自己
 * 身上；节点执行更不能反过来抢焦点会话）。
 *
 * 三条硬纪律（§8.3）：
 * - **注册常驻、默认不激活**：三个定义始终在 customTools 里，只有角色开关
 *   （`agent.toolOverrides.workflow === true` → `record.workflowEnabled`）打开时
 *   才进活动集/请求前缀。角色开关默认关闭，存量角色升级后前缀零变化。
 * - **执行端复核角色能力**：不能只靠「schema 没进前缀」当唯一控制。每个 execute
 *   先查 record 级开关投影，关闭时明确拒绝；不在这里读全局 settings（那是每回合
 *   偷读，违反回合边界 reconcile 的纪律）。
 * - **立即返回、不轮询、不唤醒**：`workflow_run` 只做受理并回 runId；后台运行有
 *   自己的停止路径。受理后**不跟随**父工具调用的 signal（否则用户点一次停止就会
 *   连带杀掉整个后台运行）；受理前已取消则不启动任何运行。
 *
 * 页面运行（工作流中心）是用户动作，不经过这里、不受角色开关限制。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "../shared/protocol.js";
import type { WorkflowRunSummary, WorkflowSummary } from "../shared/workflow-protocol.js";
import type { WorkflowRunStatusView, WorkflowToolSurface } from "./runtime-workflow-commands.js";

/** 开关关闭时的明确拒绝文案（不静默、不回落全局设置）。 */
const DISABLED_TEXT = "工作流工具未启用：该角色没有开启「工作流编排」（角色级开关默认关闭）。"
  + "请让用户在「设置 → Agent 角色 → 扩展能力」里开启后再调用；页面里的工作流中心可以直接运行，不受这个开关限制。";

/** 单次回执里最多列出的工作流条数（目录本身有 100 条硬上限，这里只保证回执有界）。 */
export const WORKFLOW_LIST_MAX_ENTRIES = 40;
/** 单次回执里最多列出的 gate 判定与产物条数（超出只给条数，全文走工作流页面）。 */
export const WORKFLOW_STATUS_MAX_ROWS = 20;
/** 单行文本的展示上限（用途/判定理由）：定义文件里各字段自身有上限，回执还要更紧。 */
export const WORKFLOW_RECEIPT_TEXT_MAX_CHARS = 160;

/** 三个工作流工具的接线面（全部是闭包，pi-runtime 在会话创建时注入）。 */
export interface WorkflowToolDeps {
  /** 本次会话的工具接线面；**每次调用现取**，绑定调用方自己的 record。 */
  surface(): WorkflowToolSurface;
  /** record 级开关投影（`record.workflowEnabled`）；缺省/false 都关闭。 */
  enabled(): boolean;
}

/**
 * 三个工作流工具是否进入活动集（`toolNamesFor` 消费）。
 *
 * 只有角色级开关，没有全局总闸：工作流的「能力下架」路径是关闭角色开关本身，
 * 页面运行不受它限制。默认 OFF——三个定义的 schema 只有在用户显式开启的角色里
 * 才产生前缀成本。
 */
export function shouldActivateWorkflowTools(input: { recordEnabled: boolean }): boolean {
  return input.recordEnabled === true;
}

/** 角色当前是否开启工作流编排（唯一归一化口径：只有 `=== true` 才算开）。 */
export function workflowOverrideEnabled(agent: { toolOverrides?: Record<string, boolean> } | undefined): boolean {
  return agent?.toolOverrides?.workflow === true;
}

/**
 * 这次保存是否是「**仅**角色级 workflow 开关变化」。
 *
 * 用途（§8.3）：仅开关变化时**不重建会话**——重建会销毁活跃工作流的 owner，
 * 也会让整段前缀缓存作废。其余任何字段变化仍按既有规则重建。
 * 键序无关：比较前把 toolOverrides 的 workflow 键摘掉并对键排序。
 */
export function isWorkflowSwitchOnlyChange(previous: AgentProfile | undefined, next: AgentProfile): boolean {
  if (!previous || previous.id !== next.id) return false;
  if (workflowOverrideEnabled(previous) === workflowOverrideEnabled(next)) return false;
  return canonicalAgent(previous) === canonicalAgent(next);
}

/** 稳定序列化：递归按键名排序，避免对象键序被误当成配置变化。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "null";
}

/** 摘掉 workflow 键后的角色画像（仅用于「是否只有这一个字段变了」的判定）。 */
function canonicalAgent(agent: AgentProfile): string {
  const { toolOverrides, ...rest } = agent;
  const others: Record<string, boolean> = {};
  for (const key of Object.keys(toolOverrides ?? {}).sort()) {
    if (key !== "workflow") others[key] = toolOverrides![key]!;
  }
  return canonical({ ...rest, toolOverrides: Object.keys(others).length > 0 ? others : undefined });
}

function text(value: string, details?: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
  return { content: [{ type: "text", text: value }], details: details ?? null };
}

function checkEnabled(deps: WorkflowToolDeps): void {
  if (!deps.enabled()) throw new Error(DISABLED_TEXT);
}

/** 截断到上限（模型回执只给可判断的摘要，全文在工作流中心）。 */
function clamp(value: string, max = WORKFLOW_RECEIPT_TEXT_MAX_CHARS): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function formatWorkflowLine(entry: WorkflowSummary): string {
  const state = entry.runnable ? "可运行" : `不可运行（${entry.issueCount} 个问题）`;
  const purpose = clamp(entry.whenToUse?.trim() || entry.description?.trim() || "");
  return `- ${clamp(entry.name, 64)}［${entry.id}］ · ${entry.nodeCount} 节点 · ${state}${purpose ? ` · 适用：${purpose}` : ""}`;
}

function formatRunLine(summary: WorkflowRunSummary): string {
  const attempt = summary.maxAttempts > 0 ? `第 ${summary.currentAttempt}/${summary.maxAttempts} 轮` : "";
  const node = summary.currentNodeTitle ? `当前节点「${summary.currentNodeTitle}」` : "";
  const pending = summary.pendingPermissionIds.length > 0 ? `待确认权限 ${summary.pendingPermissionIds.length} 项` : "";
  const external = summary.external ? "（由其他实例执行）" : "";
  const error = summary.error ? `错误：${summary.error}` : "";
  return [
    `「${summary.workflowName}」（${summary.runId}）状态 ${summary.status}${external}`,
    [attempt, node, pending].filter(Boolean).join(" · "),
    error
  ].filter(Boolean).join("；");
}

/**
 * Build the workflow customTools (one set per session record).
 *
 * 三个定义注册常驻、描述短且稳定（不把工作流目录写进 description/system prompt：
 * 目录是动态内容，只在工具回执里出现）。激活由 `record.workflowEnabled` 决定，
 * 见 `shouldActivateWorkflowTools`。
 */
export function buildWorkflowTools(deps: WorkflowToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "workflow_list",
      label: "列出工作流",
      description: "列出当前会话工作区里保存的工作流（名称/id/节点数/是否可运行/适用场景）。只读轻量目录，不含节点与提示词全文；拿到 id 或精确名称后用 workflow_run 启动。",
      promptSnippet: "workflow_list: 列出当前工作区的工作流",
      parameters: Type.Object({}),
      execute: async () => {
        checkEnabled(deps);
        const listed = deps.surface().list();
        const shown = listed.workflows.slice(0, WORKFLOW_LIST_MAX_ENTRIES);
        const lines = shown.map((entry) => formatWorkflowLine(entry));
        const overflow = listed.workflows.length > shown.length
          ? `\n另有 ${listed.workflows.length - shown.length} 个工作流未列出（在工作流中心查看）。`
          : "";
        const diagnostics = listed.diagnostics.slice(0, 5).map((line) => clamp(line, 200)).join("；");
        const body = shown.length > 0
          ? `当前工作区的工作流（${listed.workflows.length} 个）：\n${lines.join("\n")}${overflow}`
          : "当前工作区还没有保存的工作流（用户可以在工作流中心新建后再调用）。";
        return text(`${body}${diagnostics ? `\n目录诊断：${diagnostics}` : ""}`, { count: listed.workflows.length });
      }
    }),
    defineTool({
      name: "workflow_run",
      label: "启动工作流",
      description: "在当前会话绑定的工作区里启动一个已保存的工作流（参数 workflow 用 workflow_list 给出的 id 或精确名称，input 是本轮任务输入）。受理后立即返回 runId，节点在后台串行执行；不要轮询，也不要为此另开回合。",
      promptSnippet: "workflow_run: 启动工作流（立即返回，后台执行）",
      parameters: Type.Object({
        workflow: Type.String({ description: "工作流 id 或精确名称（来自 workflow_list）" }),
        input: Type.String({ description: "本轮任务的输入（用户需求原文或明确的任务说明）；空字符串表示按工作流自己的默认目标" })
      }),
      execute: async (_toolCallId, params, signal) => {
        checkEnabled(deps);
        const workflowRef = typeof params?.workflow === "string" ? params.workflow.trim() : "";
        if (!workflowRef) throw new Error("请提供工作流的 id 或精确名称（先用 workflow_list 查看）");
        const input = typeof params?.input === "string" ? params.input : "";
        // 受理前取消（用户中止了本轮/工具调用）：不启动任何运行，也不留下半套准备。
        if (signal?.aborted) throw new Error("工作流启动已取消：本轮工具调用已中止，未创建任何运行。");
        // 受理后**不再**接 parent signal：运行已交给后台运行器，停止走工作流页面。
        const accepted = await deps.surface().start(workflowRef, input, { signal });
        return text(
          `已受理工作流「${accepted.workflowName}」（runId ${accepted.runId}，状态 ${accepted.status}）。`
          + "节点在后台串行执行，本回合不需要等待；不要轮询，也不要用新回合盯进度。"
          + "用户问进度或结果时用 workflow_status 查询（runId 可省略 = 本会话最近一次）。",
          { runId: accepted.runId, workflowName: accepted.workflowName, status: accepted.status }
        );
      }
    }),
    defineTool({
      name: "workflow_status",
      label: "查询工作流运行",
      description: "读取本会话某次工作流运行的摘要（状态、轮号、各节点状态、待确认权限、验收 gate 判定、产物文件引用）。runId 省略时取本会话最近一次运行。只给摘要与文件路径，不返回节点全文（全文在工作流中心查看）。",
      promptSnippet: "workflow_status: 查询工作流运行摘要（缺省=最近一次）",
      parameters: Type.Object({
        run_id: Type.Optional(Type.String({ description: "运行 id（来自 workflow_run）；省略 = 本会话最近一次运行" }))
      }),
      execute: async (_toolCallId, params) => {
        checkEnabled(deps);
        const runId = typeof params?.run_id === "string" ? params.run_id.trim() : "";
        const view = deps.surface().status(runId || undefined);
        const decisions = view.decisions.slice(0, WORKFLOW_STATUS_MAX_ROWS);
        const artifacts = view.artifacts.slice(0, WORKFLOW_STATUS_MAX_ROWS);
        const nodes = Object.entries(view.summary.nodeStates)
          .slice(0, WORKFLOW_STATUS_MAX_ROWS)
          .map(([nodeId, status]) => `${nodeId} ${status}`)
          .join("；");
        const lines = [
          formatRunLine(view.summary),
          nodes ? `节点：${nodes}` : "",
          decisions.length > 0
            ? `验收判定：${decisions.map((decision) => `${decision.nodeTitle}（${decision.nodeId}）第 ${decision.attempt} 轮 → ${decision.verdict}${decision.reason ? `：${clamp(decision.reason)}` : ""}`).join("；")}`
            : "",
          view.decisions.length > decisions.length ? `（另有 ${view.decisions.length - decisions.length} 条判定未列出）` : "",
          artifacts.length > 0
            ? `产物文件：${artifacts.map((artifact) => `${artifact.nodeTitle} 第 ${artifact.attempt} 轮 → ${artifact.artifactPath}`).join("；")}`
            : "",
          view.artifacts.length > artifacts.length ? `（另有 ${view.artifacts.length - artifacts.length} 个产物未列出）` : "",
          view.external ? "该运行由其他实例执行：只能查看，不能从这里停止。" : ""
        ].filter(Boolean);
        return text(lines.join("\n"), {
          runId: view.summary.runId,
          status: view.summary.status,
          decisions: view.decisions.length,
          artifacts: view.artifacts.length
        });
      }
    })
  ];
}
