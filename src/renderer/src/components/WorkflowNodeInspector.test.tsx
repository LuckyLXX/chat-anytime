// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption, ProviderOption, SubagentDefinition } from "../../../shared/protocol";
import type { WorkflowDiagnostic, WorkflowExecution } from "../../../shared/workflow";
import { createStarterWorkflow, updateWorkflowNode } from "../lib/workflow-canvas";
import { WorkflowNodeInspector, type WorkflowNodeInspectorProps } from "./WorkflowNodeInspector";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const models: ModelOption[] = [
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", configured: true, input: ["text"], imageInput: false },
  { provider: "anthropic", id: "claude-off", name: "Claude 停用", configured: true, input: ["text"], imageInput: false, enabled: false }
];
const providers: ProviderOption[] = [{ id: "anthropic", name: "Anthropic", configured: true }];
const subagents: SubagentDefinition[] = [
  {
    id: "reviewer",
    name: "审查子代理",
    description: "只读审查",
    systemPrompt: "只审查",
    tools: { read: true, grep: true, bash: false, powershell: false, edit: false, write: false, find: false, ls: false },
    scope: "global"
  }
];

function props(overrides: Partial<WorkflowNodeInspectorProps> = {}): WorkflowNodeInspectorProps {
  return {
    definition: createStarterWorkflow(1_000),
    models,
    providers,
    subagents,
    issues: [],
    onChangeNode: vi.fn(),
    onChangeDefinition: vi.fn(),
    onChangeRework: vi.fn(),
    onDeleteNode: vi.fn(),
    ...overrides
  };
}

function render(next: WorkflowNodeInspectorProps): void {
  act(() => root.render(<WorkflowNodeInspector {...next} />));
}

function byLabel(label: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`找不到控件 ${label}`);
  return element;
}

function typeInto(element: HTMLElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(select: HTMLElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("节点检查器：基本字段", () => {
  it("标题/prompt 输入走长度裁剪，并显示字数", () => {
    const next = props({ nodeId: "n2" });
    render(next);
    expect(container.querySelector('[data-pane="workflow-inspector"]')).not.toBeNull();
    expect((byLabel("节点标题") as HTMLInputElement).value).toBe("实施");
    typeInto(byLabel("节点标题"), "写代码");
    expect(next.onChangeNode).toHaveBeenCalledWith({ title: "写代码" });
    typeInto(byLabel("节点 prompt"), "第一行\n第二行");
    // 换行原样保留，不做 trim/折叠
    expect(next.onChangeNode).toHaveBeenLastCalledWith({ prompt: "第一行\n第二行" });
    // 受控组件在 mock 回调下不会自更新，计数反映当前节点 prompt 的真实长度
    const starterPrompt = createStarterWorkflow(1_000).nodes.find((node) => node.id === "n2")!.prompt;
    expect(container.querySelector(".workflow-field-count")?.textContent).toBe(`${starterPrompt.length}/8000`);
    // 超长输入按 8000 字裁剪后再回调（不把超限内容塞进定义）
    typeInto(byLabel("节点 prompt"), "x".repeat(8_050));
    const payload = (next.onChangeNode as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { prompt: string };
    expect(payload.prompt).toHaveLength(8_000);
  });

  it("类型切换只改 kind；角色留空回填 undefined", () => {
    const next = props({ nodeId: "n2" });
    render(next);
    choose(byLabel("节点类型"), "review");
    expect(next.onChangeNode).toHaveBeenCalledWith({ kind: "review" });
    typeInto(byLabel("节点职责标签"), "  ");
    expect(next.onChangeNode).toHaveBeenLastCalledWith({ role: undefined });
  });

  it("节点问题就地展示（按 nodeId 过滤）", () => {
    const issues: WorkflowDiagnostic[] = [
      { code: "empty-prompt", message: "节点 prompt 不能为空", nodeId: "n2" },
      { code: "cycle", message: "普通依赖边不能形成环" }
    ];
    render(props({ nodeId: "n2", issues }));
    const list = container.querySelector('[aria-label="该节点的运行问题"]');
    expect(list?.textContent).toContain("节点 prompt 不能为空");
    expect(list?.textContent).not.toContain("形成环");
    expect(container.querySelector('[aria-label="整体运行问题"]')?.textContent).toContain("形成环");
  });
});

describe("节点检查器：来源、模型与权限上限", () => {
  it("来源切到 agent 时清掉子智能体（不残留另一来源的配置）", () => {
    const definition = updateWorkflowNode(createStarterWorkflow(1_000), "n2", { exec: { kind: "subagent", subagent: "reviewer" } });
    const next = props({ definition, nodeId: "n2" });
    render(next);
    choose(byLabel("节点执行来源"), "agent");
    expect(next.onChangeNode).toHaveBeenCalledWith({ exec: { kind: "agent", subagent: undefined } });
  });

  it("子智能体来源显示选择器，找不到定义时如实标出", () => {
    const definition = updateWorkflowNode(createStarterWorkflow(1_000), "n2", { exec: { kind: "subagent", subagent: "ghost" } });
    render(props({ definition, nodeId: "n2" }));
    const select = byLabel("子智能体") as HTMLSelectElement;
    expect(select.value).toBe("ghost");
    expect(select.textContent).toContain("找不到定义");
    expect(select.textContent).toContain("审查子代理");
  });

  it("模型下拉复用 ModelSelect：可切换、缺省显示跟随来源、已停用值有兜底提示", () => {
    const next = props({ nodeId: "n2" });
    render(next);
    // ModelSelect 不接受 aria-label；用它的稳定 class 定位（组件本身不改造）。
    const modelSelect = container.querySelector<HTMLSelectElement>(".workflow-model-select")!;
    expect(modelSelect.value).toBe("");
    expect(modelSelect.textContent).toContain("跟随 owner 当前模型");
    choose(modelSelect, "anthropic/claude-sonnet");
    expect(next.onChangeNode).toHaveBeenCalledWith({ exec: { kind: "agent", model: { provider: "anthropic", id: "claude-sonnet" } } });
    choose(modelSelect, "");
    expect(next.onChangeNode).toHaveBeenLastCalledWith({ exec: { kind: "agent", model: undefined } });
  });

  it("节点写了已停用模型时给出回落提示，而不是静默使用", () => {
    const definition = updateWorkflowNode(createStarterWorkflow(1_000), "n2", { exec: { kind: "agent", model: { provider: "anthropic", id: "claude-off" } } });
    render(props({ definition, nodeId: "n2" }));
    expect(container.querySelector(".workflow-model-select")?.textContent).toContain("已停用");
    expect(container.textContent).toContain("该模型当前已停用或未配置");
  });

  it("工具白名单：缺省按来源继承；取消继承后从来源工具集起步", () => {
    const next = props({ nodeId: "n2" });
    render(next);
    const inherit = container.querySelector<HTMLInputElement>('[data-control="workflow-node-tools-inherit"]')!;
    expect(inherit.checked).toBe(true);
    expect(container.querySelectorAll('[data-control="workflow-node-tool"]')).toHaveLength(0);
    act(() => inherit.click());
    expect(next.onChangeNode).toHaveBeenCalledWith({ exec: { kind: "agent", tools: ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"] } });
  });

  it("子智能体来源的工具清单只放行来源已启用的工具", () => {
    const definition = updateWorkflowNode(createStarterWorkflow(1_000), "n2", { exec: { kind: "subagent", subagent: "reviewer", tools: ["read"] } });
    const next = props({ definition, nodeId: "n2" });
    render(next);
    const boxes = [...container.querySelectorAll<HTMLInputElement>('[data-control="workflow-node-tool"]')];
    const byTool = new Map(boxes.map((box) => [box.dataset.tool, box]));
    expect(byTool.get("read")!.checked).toBe(true);
    expect(byTool.get("read")!.disabled).toBe(false);
    expect(byTool.get("edit")!.disabled).toBe(true);
    expect(byTool.get("bash")!.disabled).toBe(true);
    act(() => byTool.get("grep")!.click());
    expect(next.onChangeNode).toHaveBeenCalledWith({ exec: { kind: "subagent", subagent: "reviewer", tools: ["read", "grep"] } });
  });

  it("访问上限下拉含「跟随 owner」与四档，只写 cap 字段", () => {
    const next = props({ nodeId: "n2" });
    render(next);
    const select = byLabel("节点访问上限") as HTMLSelectElement;
    expect(select.textContent).toContain("跟随 owner 当前访问权限");
    expect(select.options).toHaveLength(5);
    choose(select, "read-only");
    expect(next.onChangeNode).toHaveBeenCalledWith({ exec: { kind: "agent", accessModeCap: "read-only" } });
  });
});

describe("节点检查器：返工结构与历史轮次", () => {
  it("启用返工用 gate 的上游作为默认入口", () => {
    const definition = { ...createStarterWorkflow(1_000), rework: undefined };
    const next = props({ definition, nodeId: "n2" });
    render(next);
    const toggle = container.querySelector<HTMLInputElement>('[data-control="workflow-rework-toggle"]')!;
    expect(toggle.checked).toBe(false);
    act(() => toggle.click());
    expect(next.onChangeRework).toHaveBeenCalledWith({ entryNodeId: "n4", gateNodeId: "n5", maxAttempts: 3 });
  });

  it("关掉返工写 undefined；改轮数只回传结构化 rework", () => {
    const next = props({ nodeId: "n2" });
    render(next);
    act(() => container.querySelector<HTMLInputElement>('[data-control="workflow-rework-toggle"]')!.click());
    expect(next.onChangeRework).toHaveBeenLastCalledWith(undefined);
    choose(byLabel("返工区间入口"), "n3");
    expect(next.onChangeRework).toHaveBeenLastCalledWith({ entryNodeId: "n3", gateNodeId: "n5", maxAttempts: 3 });
    expect((byLabel("返工区间 gate") as HTMLSelectElement).options).toHaveLength(2);
    expect(container.textContent).toContain("最多返工 2 次");
  });

  it("历史轮次按 attempt 列出，选中后回调并展示有界产物", () => {
    const executions: WorkflowExecution[] = [
      { executionId: "e-1", nodeId: "n2", nodeTitle: "实施", attempt: 1, status: "completed" },
      { executionId: "e-2", nodeId: "n2", nodeTitle: "实施", attempt: 2, status: "completed" }
    ];
    const next = props({ nodeId: "n2", executions, onSelectExecution: vi.fn(), onOpenRunDetails: vi.fn() });
    render(next);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-control="workflow-node-execution"]')];
    expect(buttons.map((button) => button.textContent)).toEqual(["第 1/3 轮已完成", "第 2/3 轮已完成"]);
    act(() => buttons[0]!.click());
    expect(next.onSelectExecution).toHaveBeenCalledWith("e-1");
    act(() => container.querySelector<HTMLButtonElement>('[data-control="workflow-node-run-details"]')!.click());
    expect(next.onOpenRunDetails).toHaveBeenCalled();
  });

  it("产物预览：加载中/错误/截断各自有明确文案", () => {
    const executions: WorkflowExecution[] = [{ executionId: "e-1", nodeId: "n2", nodeTitle: "实施", attempt: 1, status: "completed" }];
    render(props({ nodeId: "n2", executions, artifact: { executionId: "e-1", loading: true } }));
    expect(container.textContent).toContain("正在读取产物");
    render(props({ nodeId: "n2", executions, artifact: { executionId: "e-1", error: "读取失败" } }));
    expect(container.textContent).toContain("读取失败");
    render(props({ nodeId: "n2", executions, artifact: { executionId: "e-1", text: "产物正文", truncated: true } }));
    expect(container.querySelector(".workflow-artifact-text")?.textContent).toBe("产物正文");
    expect(container.textContent).toContain("只显示前 8 KiB");
  });
});

describe("节点检查器：未选中节点时是工作流设置", () => {
  it("显示名称/描述/输入提示，并提示去画布选节点", () => {
    const next = props();
    render(next);
    expect((byLabel("工作流名称") as HTMLInputElement).value).toBe("实施—验收工作流");
    typeInto(byLabel("工作流名称"), "新名字");
    expect(next.onChangeDefinition).toHaveBeenCalledWith({ name: "新名字" });
    typeInto(byLabel("输入提示"), "需求与验收标准");
    expect(next.onChangeDefinition).toHaveBeenLastCalledWith({ inputHint: "需求与验收标准" });
    expect(container.textContent).toContain("在画布上点一个节点");
  });

  it("只读模式禁用编辑入口，但不隐藏已有内容", () => {
    render(props({ nodeId: "n2", readOnly: true }));
    expect((byLabel("节点标题") as HTMLInputElement).disabled).toBe(true);
    expect((byLabel("节点 prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect(container.querySelector('[data-control="workflow-node-delete"]')).toBeNull();
  });

  it("删除节点按钮回传删除意图", () => {
    const next = props({ nodeId: "n3" });
    render(next);
    act(() => container.querySelector<HTMLButtonElement>('[data-control="workflow-node-delete"]')!.click());
    expect(next.onDeleteNode).toHaveBeenCalled();
  });
});
