// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStarterWorkflow, updateWorkflowNode } from "../lib/workflow-canvas";
import { WorkflowCanvas, type WorkflowCanvasProps } from "./WorkflowCanvas";

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

function handlers(overrides: Partial<WorkflowCanvasProps> = {}): WorkflowCanvasProps {
  return {
    definition: createStarterWorkflow(1_000),
    issues: [],
    onSelectNode: vi.fn(),
    onSelectEdge: vi.fn(),
    onMoveNode: vi.fn(),
    onAddNode: vi.fn(),
    onDeleteNode: vi.fn(),
    onDeleteEdge: vi.fn(),
    onConnect: vi.fn(),
    ...overrides
  };
}

function render(props: WorkflowCanvasProps): void {
  act(() => root.render(<WorkflowCanvas {...props} />));
}

function node(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-workflow-node="${id}"]`);
  if (!element) throw new Error(`找不到节点 ${id}`);
  return element;
}

function pointer(element: Element, type: string, init: { clientX: number; clientY: number; pointerId?: number; button?: number }): void {
  act(() => {
    element.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init }));
  });
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function key(target: EventTarget, value: string): void {
  act(() => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  });
}

describe("工作流画布渲染", () => {
  it("渲染节点卡（种类/来源）与依赖边，并标注返工区间", () => {
    render(handlers());
    expect(container.querySelector('[data-pane="workflow-canvas"]')).not.toBeNull();
    expect(node("n1").dataset.workflowNodeKind).toBe("task");
    expect(node("n5").dataset.workflowNodeKind).toBe("gate");
    // kind/state 必须走 data-workflow-node-*：data-node-kind/state 是时间线的公开主题钩子
    // （thinking/tool-call/text + running/completed/error/aborted），混用会污染主题规则。
    expect(node("n1").hasAttribute("data-node-kind")).toBe(false);
    expect(node("n1").hasAttribute("data-node-state")).toBe(false);
    expect(node("n1").textContent).toContain("规划");
    expect(node("n2").textContent).toContain("当前角色");
    expect(node("n2").textContent).toContain("返工区间");
    expect(container.querySelectorAll("[data-edge-id]")).toHaveLength(5);
    expect(container.querySelectorAll(".workflow-rework-edge")).toHaveLength(1);
    expect(container.querySelector(".workflow-rework-label")?.textContent).toContain("最多 3 轮");
  });

  it("运行叠加层显示节点状态与当前轮号（不影响编辑语义）", () => {
    render(handlers({ run: { nodeStates: { n1: "completed", n2: "running" }, currentNodeId: "n2", attempt: 2, maxAttempts: 3 } }));
    expect(node("n1").dataset.workflowNodeState).toBe("completed");
    expect(node("n2").dataset.workflowNodeState).toBe("running");
    expect(node("n2").hasAttribute("data-node-state")).toBe(false);
    expect(node("n2").className).toContain("is-current");
    expect(node("n2").textContent).toContain("第 2/3 轮");
  });

  it("选中态与问题标记来自 props，不在组件内部另存一份", () => {
    render(handlers({ selectedNodeId: "n3", issues: [{ code: "empty-prompt", message: "节点 prompt 不能为空", nodeId: "n3" }, { code: "cycle", message: "环" }] }));
    expect(node("n3").dataset.nodeSelected).toBe("true");
    expect(node("n3").className).toContain("has-issue");
    expect(node("n3").textContent).toContain("1");
    expect(container.querySelector(".workflow-canvas-count")?.textContent).toBe("6 节点 · 5 依赖");
  });
});

describe("两击连线", () => {
  it("点起点箭头再点目标节点建立依赖，随后清空起点", () => {
    const props = handlers();
    render(props);
    click(node("n1").querySelector('[data-control="workflow-connect"]')!);
    expect(props.onSelectNode).toHaveBeenCalledWith("n1");
    expect(container.querySelector(".workflow-canvas-hint")?.textContent).toContain("已选起点「规划」");
    pointer(node("n6"), "pointerdown", { clientX: 10, clientY: 10 });
    pointer(node("n6"), "pointerup", { clientX: 10, clientY: 10 });
    expect(props.onConnect).toHaveBeenCalledWith("n1", "n6");
    expect(container.querySelector(".workflow-canvas-hint")?.textContent).not.toContain("已选起点");
  });

  it("点同一节点取消起点；Esc 取消连线（不会误连）", () => {
    const props = handlers();
    render(props);
    click(node("n1").querySelector('[data-control="workflow-connect"]')!);
    click(node("n1").querySelector('[data-control="workflow-connect"]')!);
    expect(props.onConnect).not.toHaveBeenCalled();
    pointer(node("n6"), "pointerdown", { clientX: 10, clientY: 10 });
    pointer(node("n6"), "pointerup", { clientX: 10, clientY: 10 });
    expect(props.onSelectNode).toHaveBeenLastCalledWith("n6");

    click(node("n2").querySelector('[data-control="workflow-connect"]')!);
    key(window, "Escape");
    pointer(node("n3"), "pointerdown", { clientX: 10, clientY: 10 });
    pointer(node("n3"), "pointerup", { clientX: 10, clientY: 10 });
    expect(props.onConnect).not.toHaveBeenCalled();
  });
});

describe("拖拽与删除", () => {
  it("拖动超过死区才移动，落点按指针位移换算", () => {
    const props = handlers();
    render(props);
    pointer(node("n2"), "pointerdown", { clientX: 100, clientY: 100 });
    pointer(node("n2"), "pointermove", { clientX: 101, clientY: 101 });
    expect(props.onMoveNode).not.toHaveBeenCalled();
    pointer(node("n2"), "pointermove", { clientX: 140, clientY: 160 });
    // n2 初始在 (296,44)：位移 (+40,+60) 直接换算，不经画布 rect。
    expect(props.onMoveNode).toHaveBeenCalledWith("n2", { x: 336, y: 104 });
    pointer(node("n2"), "pointerup", { clientX: 140, clientY: 160 });
    // 拖拽结束不算点选
    expect(props.onSelectNode).not.toHaveBeenCalled();
  });

  it("未拖动的按下-抬起按点选处理", () => {
    const props = handlers();
    render(props);
    pointer(node("n4"), "pointerdown", { clientX: 10, clientY: 10 });
    pointer(node("n4"), "pointerup", { clientX: 11, clientY: 10 });
    expect(props.onSelectNode).toHaveBeenCalledWith("n4");
  });

  it("Delete 删除选中节点；输入框内的 Delete 被保护", () => {
    const props = handlers({ selectedNodeId: "n2" });
    render(props);
    const input = document.createElement("input");
    container.append(input);
    key(input, "Delete");
    expect(props.onDeleteNode).not.toHaveBeenCalled();
    key(window, "Delete");
    expect(props.onDeleteNode).toHaveBeenCalledWith("n2");
  });

  it("选中边时 Delete 删边（优先于节点）；点边选中、边操作条可删", () => {
    const props = handlers({ selectedNodeId: "n2", selectedEdgeId: "e1" });
    render(props);
    const path = container.querySelector('[data-edge-id="e1"]')!;
    click(path);
    expect(props.onSelectEdge).toHaveBeenCalledWith(undefined);
    key(window, "Delete");
    expect(props.onDeleteEdge).toHaveBeenCalledWith("e1");
    expect(props.onDeleteNode).not.toHaveBeenCalled();
    click(container.querySelector('[data-control="workflow-edge-delete"]')!);
    expect(props.onDeleteEdge).toHaveBeenCalledTimes(2);
  });

  it("节点卡删除按钮直接删节点，且不会顺带触发拖拽/点选", () => {
    const props = handlers();
    render(props);
    click(node("n3").querySelector('[data-control="workflow-node-delete"]')!);
    expect(props.onDeleteNode).toHaveBeenCalledWith("n3");
    expect(props.onSelectNode).not.toHaveBeenCalled();
  });

  it("只读模式不提供删除入口，也不响应 Delete", () => {
    const props = handlers({ readOnly: true, selectedNodeId: "n2" });
    render(props);
    expect(container.querySelector('[data-control="workflow-node-delete"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-control="workflow-node-add"]')?.disabled).toBe(true);
    key(window, "Delete");
    expect(props.onDeleteNode).not.toHaveBeenCalled();
  });
});

describe("空图提示", () => {
  it("没有节点时给出下一步引导", () => {
    render(handlers({ definition: { ...createStarterWorkflow(1_000), nodes: [], edges: [], rework: undefined } }));
    expect(container.querySelector(".workflow-canvas-empty")?.textContent).toContain("还没有节点");
    expect(container.querySelectorAll("[data-edge-id]")).toHaveLength(0);
  });

  it("新增节点按钮回传种类", () => {
    const props = handlers();
    render(props);
    click(container.querySelector('[data-control="workflow-node-add"]')!);
    expect(props.onAddNode).toHaveBeenCalledWith("task");
  });

  it("节点标题为空时显示占位而不是空白卡片", () => {
    const definition = updateWorkflowNode(createStarterWorkflow(1_000), "n1", { title: "" });
    render(handlers({ definition }));
    expect(node("n1").textContent).toContain("未命名节点");
  });
});
