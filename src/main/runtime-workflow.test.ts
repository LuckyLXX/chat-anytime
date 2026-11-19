import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "../shared/protocol.js";
import type { WorkflowRunSummary, WorkflowSummary } from "../shared/workflow-protocol.js";
import { estimateToolTokens } from "./context-breakdown.js";
import type { WorkflowRunStatusView, WorkflowToolSurface } from "./runtime-workflow-commands.js";
import {
  WORKFLOW_LIST_MAX_ENTRIES,
  WORKFLOW_STATUS_MAX_ROWS,
  buildWorkflowTools,
  isWorkflowSwitchOnlyChange,
  shouldActivateWorkflowTools,
  workflowOverrideEnabled
} from "./runtime-workflow.js";

/**
 * 工作流模型工具的契约网（§8.3 / 步骤七）。
 *
 * 钉住的是「开关关闭时绝不执行」「立即受理、不轮询、不跟随父 signal」「回执有界」
 * 这几条会静默坏掉的行为——它们是默认 OFF 这套设计成立的前提：开关关着时既不能
 * 花前缀成本，也不能在模型误调时偷偷起一个后台运行。
 */

function summaryEntry(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return { id: "wf-1", name: "发布流程", nodeCount: 6, updatedAt: 1, runnable: true, issueCount: 0, ...overrides };
}

function runSummary(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowName: "发布流程",
    workspace: "D:/ws",
    agentId: "default",
    ownerSessionId: "sess-1",
    status: "running",
    currentAttempt: 2,
    maxAttempts: 3,
    nodeStates: { n1: "completed", n2: "running" },
    pendingPermissionIds: [],
    startedAt: 10,
    ...overrides
  };
}

interface SurfaceCalls {
  list: number;
  start: Array<{ workflowRef: string; input: string; signal: AbortSignal | undefined }>;
  status: Array<string | undefined>;
}

function makeSurface(overrides: Partial<WorkflowToolSurface> = {}): { surface: WorkflowToolSurface; calls: SurfaceCalls } {
  const calls: SurfaceCalls = { list: 0, start: [], status: [] };
  const surface: WorkflowToolSurface = {
    list: () => {
      calls.list += 1;
      return { workflows: [summaryEntry()], diagnostics: [] };
    },
    start: async (workflowRef, input, options) => {
      calls.start.push({ workflowRef, input, signal: options?.signal });
      return { runId: "run-1", status: "running", workflowName: "发布流程" };
    },
    status: (runId) => {
      calls.status.push(runId);
      return { summary: runSummary(), decisions: [], artifacts: [], external: false };
    },
    ...overrides
  };
  return { surface, calls };
}

function toolsFor(surface: WorkflowToolSurface, enabled: () => boolean = () => true): ToolDefinition[] {
  return buildWorkflowTools({ surface: () => surface, enabled });
}

/** 工具执行在单测里没有扩展上下文：统一从这里进（ctx 传 undefined）。 */
function exec(tool: ToolDefinition, params: unknown, signal?: AbortSignal) {
  return tool.execute("call-1", params as never, signal, undefined, undefined as never);
}

function toolText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((entry) => entry.text ?? "").join("");
}

describe("三个工作流工具的注册面", () => {
  it("名字固定为 workflow_list / workflow_run / workflow_status（顺序稳定）", () => {
    const tools = toolsFor(makeSurface().surface);
    expect(tools.map((tool) => tool.name)).toEqual(["workflow_list", "workflow_run", "workflow_status"]);
  });

  it("三个定义的前缀成本有界（默认 OFF 是这套设计的全部理由，开启后也不能写成教程）", () => {
    const tools = toolsFor(makeSurface().surface);
    const tokens = estimateToolTokens(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThan(900);
  });
});

describe("执行端复核角色能力（不能只靠 schema 隐藏）", () => {
  it("开关关闭时三个工具全部明确拒绝，且不碰 surface（不起运行、不读目录）", async () => {
    const { surface, calls } = makeSurface();
    const tools = toolsFor(surface, () => false);
    for (const tool of tools) {
      await expect(exec(tool, {})).rejects.toThrow(/工作流工具未启用/u);
    }
    expect(calls).toEqual({ list: 0, start: [], status: [] });
  });

  it("开关打开后才真正调用 surface", async () => {
    const { surface, calls } = makeSurface();
    const tools = toolsFor(surface, () => true);
    await exec(tools[0]!, {});
    expect(calls.list).toBe(1);
  });
});

describe("workflow_list", () => {
  it("只回轻量目录（名称/id/节点数/可运行状态/用途），不带节点与提示词全文", async () => {
    const { surface } = makeSurface({
      list: () => ({
        workflows: [
          summaryEntry({ id: "wf-1", name: "发布流程", nodeCount: 6, runnable: true, whenToUse: "要发版时" }),
          summaryEntry({ id: "wf-2", name: "草稿流程", nodeCount: 2, runnable: false, issueCount: 3, whenToUse: undefined, description: undefined })
        ],
        diagnostics: []
      })
    });
    const text = toolText(await exec(toolsFor(surface)[0]!, {}));
    expect(text).toContain("发布流程［wf-1］");
    expect(text).toContain("6 节点");
    expect(text).toContain("可运行");
    expect(text).toContain("适用：要发版时");
    expect(text).toContain("草稿流程［wf-2］");
    expect(text).toContain("不可运行（3 个问题）");
    expect(text).not.toContain("nodes");
    expect(text).not.toContain("prompt");
  });

  it("空目录给可读空态，不报错", async () => {
    const { surface } = makeSurface({ list: () => ({ workflows: [], diagnostics: [] }) });
    const text = toolText(await exec(toolsFor(surface)[0]!, {}));
    expect(text).toContain("还没有保存的工作流");
  });

  it("条目数有界（目录上限 100，回执只列前 40）", async () => {
    const many = Array.from({ length: WORKFLOW_LIST_MAX_ENTRIES + 5 }, (_, index) => summaryEntry({ id: `wf-${index}`, name: `流程 ${index}` }));
    const { surface } = makeSurface({ list: () => ({ workflows: many, diagnostics: ["a", "b"] }) });
    const text = toolText(await exec(toolsFor(surface)[0]!, {}));
    expect(text).toContain("另有 5 个工作流未列出");
    expect(text).toContain("目录诊断：a；b");
  });

  it("单条用途文本也有上限（定义里的 whenToUse 可到 2000 字，回执不能照抄）", async () => {
    const long = "这是一个非常长的用途说明".repeat(200);
    const { surface } = makeSurface({ list: () => ({ workflows: [summaryEntry({ whenToUse: long })], diagnostics: [] }) });
    const text = toolText(await exec(toolsFor(surface)[0]!, {}));
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(600);
  });
});

describe("workflow_run", () => {
  it("把 workflow 引用、input 与 signal 原样交给 surface，并立即回 runId（不轮询）", async () => {
    const { surface, calls } = makeSurface();
    const controller = new AbortController();
    const text = toolText(await exec(toolsFor(surface)[1]!, { workflow: " 发布流程 ", input: "发布 1.19.0" }, controller.signal));
    expect(calls.start).toEqual([{ workflowRef: "发布流程", input: "发布 1.19.0", signal: controller.signal }]);
    expect(calls.status).toEqual([]);
    expect(text).toContain("run-1");
    expect(text).toContain("不要轮询");
  });

  it("受理后不跟随父 signal：abort 之后运行仍在（没人调用 surface 的停止路径）", async () => {
    const controller = new AbortController();
    const { surface, calls } = makeSurface();
    const tools = toolsFor(surface);
    await exec(tools[1]!, { workflow: "wf-1", input: "" }, controller.signal);
    controller.abort();
    expect(calls.start).toHaveLength(1);
    // 受理后再查状态也照常工作（后台运行有自己的停止路径，不靠这个 signal）。
    await exec(tools[2]!, { run_id: "run-1" }, controller.signal);
    expect(calls.status).toEqual(["run-1"]);
  });

  it("受理前已取消：直接失败且不启动任何运行（撤销准备）", async () => {
    const { surface, calls } = makeSurface();
    const controller = new AbortController();
    controller.abort();
    await expect(exec(toolsFor(surface)[1]!, { workflow: "wf-1", input: "" }, controller.signal)).rejects.toThrow(/已取消/u);
    expect(calls.start).toEqual([]);
  });

  it("空 workflow 引用在本地就拒绝（不落到 surface）", async () => {
    const { surface, calls } = makeSurface();
    await expect(exec(toolsFor(surface)[1]!, { workflow: "  ", input: "x" })).rejects.toThrow(/workflow_list/u);
    expect(calls.start).toEqual([]);
  });

  it("surface 的失败原样上抛（预检/冲突诊断不能被吞成成功回执）", async () => {
    const { surface } = makeSurface({ start: async () => { throw new Error("工作流「x」未通过运行校验"); } });
    await expect(exec(toolsFor(surface)[1]!, { workflow: "x", input: "" })).rejects.toThrow(/未通过运行校验/u);
  });
});

describe("workflow_status", () => {
  it("run_id 省略时交给 surface 取「最近一次」（undefined，不是空串）", async () => {
    const { surface, calls } = makeSurface();
    const tool = toolsFor(surface)[2]!;
    await exec(tool, {});
    await exec(tool, { run_id: "  " });
    expect(calls.status).toEqual([undefined, undefined]);
  });

  it("回执带状态/轮号/当前节点/节点状态/判定/产物路径，且不含无界全文", async () => {
    const view: WorkflowRunStatusView = {
      summary: runSummary({ status: "running", currentNodeTitle: "实施", pendingPermissionIds: ["p1"] }),
      decisions: [{ nodeId: "gate", nodeTitle: "验收", attempt: 2, verdict: "retry", reason: "测试未通过" }],
      artifacts: [{ executionId: "exec-1", nodeId: "n1", nodeTitle: "规划", attempt: 1, artifactPath: "D:/agent/workflows/run-1/n1.txt" }],
      external: true
    };
    const { surface } = makeSurface({ status: () => view });
    const text = toolText(await exec(toolsFor(surface)[2]!, { run_id: "run-1" }));
    expect(text).toContain("第 2/3 轮");
    expect(text).toContain("当前节点「实施」");
    expect(text).toContain("待确认权限 1 项");
    expect(text).toContain("n1 completed");
    expect(text).toContain("验收（gate）第 2 轮 → retry：测试未通过");
    expect(text).toContain("D:/agent/workflows/run-1/n1.txt");
    expect(text).toContain("其他实例执行");
  });

  it("判定理由也有上限（gate 输出不可信，不能整段塞进回执）", async () => {
    const longReason = "测试没通过".repeat(500);
    const { surface } = makeSurface({
      status: () => ({
        summary: runSummary(),
        decisions: [{ nodeId: "gate", nodeTitle: "验收", attempt: 1, verdict: "retry", reason: longReason }],
        artifacts: [],
        external: false
      })
    });
    const text = toolText(await exec(toolsFor(surface)[2]!, {}));
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(800);
  });

  it("判定与产物条数有界（超出只给条数）", async () => {
    const decisions = Array.from({ length: WORKFLOW_STATUS_MAX_ROWS + 2 }, (_, index) => ({
      nodeId: `gate-${index}`, nodeTitle: "验收", attempt: 1, verdict: "pass" as const, reason: ""
    }));
    const artifacts = Array.from({ length: WORKFLOW_STATUS_MAX_ROWS + 3 }, (_, index) => ({
      executionId: `exec-${index}`, nodeId: "n1", nodeTitle: "规划", attempt: 1, artifactPath: `D:/out/${index}.txt`
    }));
    const { surface } = makeSurface({ status: () => ({ summary: runSummary(), decisions, artifacts, external: false }) });
    const text = toolText(await exec(toolsFor(surface)[2]!, {}));
    expect(text).toContain("另有 2 条判定未列出");
    expect(text).toContain("另有 3 个产物未列出");
    expect(text).not.toContain("D:/out/25.txt");
  });
});

describe("角色开关判定（默认 OFF）", () => {
  const agent = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
    id: "coder",
    name: "代码助手",
    description: "",
    systemPrompt: "",
    divMode: "off",
    defaultThinkingLevel: "medium",
    tools: { read: true, bash: true, powershell: false, edit: true, write: true, grep: true, find: true, ls: true },
    ...overrides
  });

  it("只有显式 true 才算开启；缺省/false 都关闭", () => {
    expect(workflowOverrideEnabled(agent())).toBe(false);
    expect(workflowOverrideEnabled(agent({ toolOverrides: { workflow: false } }))).toBe(false);
    expect(workflowOverrideEnabled(agent({ toolOverrides: { workflow: true } }))).toBe(true);
    expect(workflowOverrideEnabled(undefined)).toBe(false);
    expect(shouldActivateWorkflowTools({ recordEnabled: true })).toBe(true);
    expect(shouldActivateWorkflowTools({ recordEnabled: false })).toBe(false);
  });

  it("「仅 workflow 开关变化」= 不重建会话的唯一判据", () => {
    const off = agent({ toolOverrides: { browser: false, ssh: true } });
    const on = agent({ toolOverrides: { browser: false, ssh: true, workflow: true } });
    expect(isWorkflowSwitchOnlyChange(off, on)).toBe(true);
    expect(isWorkflowSwitchOnlyChange(on, off)).toBe(true);
    // false → 缺省（都是关闭）不是「变化」：不需要 reconcile，更不需要重建。
    expect(isWorkflowSwitchOnlyChange(agent({ toolOverrides: { workflow: false } }), agent())).toBe(false);
    // 开关没动、别的字段变了 → 不是这条路径（走既有重建规则）。
    expect(isWorkflowSwitchOnlyChange(agent(), agent({ systemPrompt: "改了" }))).toBe(false);
    // 开关动了但**同时**改了别的字段 → 混合保存，仍按既有规则处理。
    expect(isWorkflowSwitchOnlyChange(off, agent({ toolOverrides: { browser: false, ssh: true, workflow: true }, name: "新名字" }))).toBe(false);
    // 键序不同不算变化（对象字面量顺序不能被当成配置差异）。
    const reordered = agent({ toolOverrides: { ssh: true, browser: false, workflow: true } });
    expect(isWorkflowSwitchOnlyChange(off, reordered)).toBe(true);
    // 不同角色 / 新建角色不走进这条路径。
    expect(isWorkflowSwitchOnlyChange(off, { ...on, id: "other" })).toBe(false);
    expect(isWorkflowSwitchOnlyChange(undefined, on)).toBe(false);
  });
});
