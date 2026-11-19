// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCommand, RuntimeMessage, WorkflowRunSummary } from "../../../shared/protocol";
import type { WorkflowApi } from "../lib/workflow-client";
import { WorkflowRunStrip, resetWorkflowRunStripDismissed, type WorkflowRunStripProps } from "./WorkflowRunStrip";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // 「已关闭」是跨挂载的模块级记忆（见 WorkflowRunStrip）：同一文件里的用例要清掉，
  // 否则前一个用例关掉的 run-1 会让后一个用例少一行。
  resetWorkflowRunStripDismissed();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowName: "实施—验收工作流",
    workspace: "D:\\Ws\\Demo",
    agentId: "default",
    ownerSessionId: "owner-1",
    status: "running",
    currentAttempt: 2,
    maxAttempts: 3,
    currentNodeId: "n3",
    currentNodeTitle: "审查",
    nodeStates: { n1: "completed", n2: "completed", n3: "running" },
    pendingPermissionIds: [],
    startedAt: Date.now() - 5_000,
    ...overrides
  };
}

function fakeApi(): { api: WorkflowApi; sent: RuntimeCommand[]; emitResult(result: RuntimeMessage): void } {
  const listeners = new Set<(message: RuntimeMessage) => void>();
  const sent: RuntimeCommand[] = [];
  return {
    api: {
      send: (command) => {
        sent.push(command);
        return Promise.resolve();
      },
      onRuntimeMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    sent,
    emitResult: (message) => { for (const listener of [...listeners]) listener(message); }
  };
}

function props(overrides: Partial<WorkflowRunStripProps> = {}): WorkflowRunStripProps {
  return { runs: [run()], onDetails: vi.fn(), ...overrides };
}

function render(next: WorkflowRunStripProps): void {
  act(() => root.render(<WorkflowRunStrip {...next} />));
}

function click(selector: string): void {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`找不到 ${selector}`);
  act(() => element.click());
}

describe("运行条：状态展示", () => {
  it("显示名称/状态/当前节点/轮号，并挂在 composer 的 workflow zone", () => {
    render(props());
    const strip = container.querySelector('[data-composer-zone="workflow"]');
    expect(strip).not.toBeNull();
    expect(container.textContent).toContain("实施—验收工作流");
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).toContain("当前：审查");
    expect(container.textContent).toContain("第 2/3 轮");
    expect(container.querySelector('[data-run-status="running"]')).not.toBeNull();
  });

  it("没有运行时整条不渲染；结束态保留到用户点掉", () => {
    render(props({ runs: [] }));
    expect(container.querySelector('[data-pane="workflow-run-strip"]')).toBeNull();
    render(props({ runs: [run({ status: "completed", endedAt: Date.now() })] }));
    expect(container.textContent).toContain("已完成");
    expect(container.querySelector('[data-control="workflow-run-dismiss"]')).not.toBeNull();
  });

  it("待决权限显示 N 个待确认并可直接定位 owner 会话", () => {
    const onLocateOwner = vi.fn();
    const pendingRun = run({ status: "running", pendingPermissionIds: ["p-1", "p-2"] });
    render(props({ runs: [pendingRun], onLocateOwner }));
    expect(container.textContent).toContain("待确认 2");
    click('[data-control="workflow-pending-locate"]');
    expect(onLocateOwner).toHaveBeenCalledWith(pendingRun);
  });

  it("点击详情回调 runId（历史仍在工作流中心）", () => {
    const onDetails = vi.fn();
    render(props({ onDetails }));
    click('[data-control="workflow-run-details"]');
    expect(onDetails).toHaveBeenCalledWith("run-1");
  });
});

describe("运行条：精确停止", () => {
  it("停止走 workflow.stop + 本次 runId，回执未到时显示停止中", async () => {
    const harness = fakeApi();
    const next = props({ api: harness.api });
    render(next);
    click('[data-control="workflow-stop"]');
    const command = harness.sent[0] as Extract<RuntimeCommand, { type: "workflow.stop" }>;
    expect(command).toMatchObject({ type: "workflow.stop", runId: "run-1" });
    expect(container.querySelector<HTMLButtonElement>('[data-control="workflow-stop"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("停止中");
    await act(async () => {
      harness.emitResult({ type: "workflow.result", result: { requestId: command.requestId, ok: false, op: "workflow.stop", code: "io", errors: [{ code: "io", message: "运行实例已退出" }] } });
    });
    expect(container.textContent).toContain("运行实例已退出");
    expect(container.querySelector<HTMLButtonElement>('[data-control="workflow-stop"]')?.disabled).toBe(false);
  });

  it("终态不提供停止按钮，只提供关闭", () => {
    render(props({ runs: [run({ status: "failed", error: "节点等待权限超时" })] }));
    expect(container.querySelector('[data-control="workflow-stop"]')).toBeNull();
    expect(container.textContent).toContain("节点等待权限超时");
  });

  it("关闭终态行后本行消失并通知宿主", () => {
    const onDismiss = vi.fn();
    render(props({ runs: [run({ status: "stopped", endedAt: Date.now() })], onDismiss }));
    click('[data-control="workflow-run-dismiss"]');
    expect(onDismiss).toHaveBeenCalledWith("run-1");
    expect(container.querySelector('[data-pane="workflow-run-strip"]')).toBeNull();
  });

  it("关掉的终态行跨 pane 重挂载不再出现（换 runId 的新运行照常显示）", () => {
    render(props({ runs: [run({ status: "completed", endedAt: Date.now() })] }));
    click('[data-control="workflow-run-dismiss"]');
    expect(container.querySelector('[data-pane="workflow-run-strip"]')).toBeNull();
    // 模拟切话题/分屏重建：卸载整棵子树再挂一个全新的根。
    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render(props({ runs: [run({ status: "completed", endedAt: Date.now() })] }));
    expect(container.querySelector('[data-pane="workflow-run-strip"]')).toBeNull();
    // 下一次运行是新 runId：不受「已关闭」记忆影响。
    render(props({ runs: [run({ runId: "run-2", status: "running" })] }));
    expect(container.querySelector('[data-run-id="run-2"]')).not.toBeNull();
  });

  it("多条运行各自一行，停止只针对自己那一行", () => {
    const harness = fakeApi();
    render(props({ runs: [run(), run({ runId: "run-2", workflowName: "另一个流程" })], api: harness.api }));
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(2);
    const second = container.querySelectorAll<HTMLElement>('[data-control="workflow-stop"]')[1]!;
    act(() => second.click());
    expect((harness.sent[0] as Extract<RuntimeCommand, { type: "workflow.stop" }>).runId).toBe("run-2");
  });
});
