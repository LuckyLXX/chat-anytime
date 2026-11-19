// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RuntimeSnapshot, TeamSnapshot, WorkflowRunSummary } from "../../shared/protocol";
import { ConversationPane, type ConversationPaneProps } from "./ConversationPane";
import { useDesktopStore } from "./store";

/**
 * composer 状态条堆栈（2026-11-19，方案 §9）。
 *
 * 计划 / 团队 / 工作流三条状态条原来各自占 composer 的一行，组合数按
 * has-plan×has-team×has-queue 指数增长，漏一格就是两条叠在同一行（视觉上像
 * 「计划模式压住了团队」）。现在它们共用一个 `composer-status-stack` 容器，
 * composer 只认「有没有堆栈」+「有没有排队」两件事。
 *
 * 这个用例钉的是**组合行为**而不是某个 CSS 类名本身：
 *  - 三条同时出现时都进同一个容器、队列仍在容器外（各占各的位）；
 *  - 运行条按 owner 过滤（分屏各看各的，别的格的运行不许冒进来）；
 *  - 详情/定位两个入口把正确参数交回 App（接线契约）。
 */

const noop = (): void => undefined;

function message(id: string): ChatMessage {
  return { id, uuid: id, role: "assistant", timestamp: 0, blocks: [{ type: "text", text: `消息 ${id}` }] };
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agentId: "default",
    agentName: "默认助手",
    thinkingLevel: "medium",
    busy: false,
    status: "",
    sessionId: "owner-a",
    workspace: "D:/w",
    messages: [message("m1")],
    executions: [],
    queuedMessages: [{ kind: "followUp", index: 0, text: "排队的一条" }],
    backgroundProcesses: [],
    sessions: [],
    recentWorkspaces: [],
    ...overrides
  };
}

function team(): TeamSnapshot {
  return { members: [{ name: "审查员", status: "running" }], running: 1 };
}

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    runId: "run-a",
    workflowId: "wf-1",
    workflowName: "实施—验收工作流",
    workspace: "D:/w",
    agentId: "default",
    ownerSessionId: "owner-a",
    status: "running",
    currentAttempt: 2,
    maxAttempts: 3,
    currentNodeId: "n3",
    currentNodeTitle: "审查",
    nodeStates: { n1: "completed", n3: "running" },
    pendingPermissionIds: ["p-1"],
    startedAt: 1_000,
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = globalThis as unknown as { ResizeObserver?: unknown; IntersectionObserver?: unknown; window: unknown; piDesktop?: unknown };
  host.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  host.IntersectionObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } };
  host.window ??= host;
  host.piDesktop = { send: async () => undefined, onRuntimeMessage: () => () => undefined, searchWorkspaceFiles: async () => ({ entries: [] }) };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useDesktopStore.setState({
    ready: true,
    snapshot: snapshot(),
    paneStates: {},
    parkedPanels: {},
    workflowRuns: undefined,
    error: undefined,
    commandError: undefined
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDesktopStore.setState({ workflowRuns: undefined });
});

function render(extra: Partial<ConversationPaneProps> = {}): void {
  const props: ConversationPaneProps = {
    sessionId: "owner-a",
    focused: true,
    onNewSession: noop,
    onOpenArtifact: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
    onOpenPlanDetail: noop,
    onOpenMemoryTopic: noop,
    onActionError: noop,
    ...extra
  };
  act(() => root.render(<ConversationPane {...props} /> as ReactNode));
}

function click(selector: string): void {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`找不到 ${selector}`);
  act(() => element.click());
}

describe("composer 状态条堆栈：组合布局", () => {
  it("计划 + 团队 + 工作流共用同一个堆栈容器，队列各占各的位", () => {
    useDesktopStore.setState({
      snapshot: snapshot({ planMode: true, team: team() }),
      workflowRuns: { epoch: "e1", revision: 1, runs: [run()] }
    });
    render();

    const composer = container.querySelector<HTMLElement>(".composer")!;
    expect(composer.className).toContain("has-status-stack");
    expect(composer.className).toContain("has-queue");
    // 收敛后不再有 per-strip 的组合类（有的话说明又长回了指数矩阵）。
    expect(composer.className).not.toContain("has-plan");
    expect(composer.className).not.toContain("has-team");
    expect(composer.className).not.toContain("has-workflow");

    const stack = container.querySelector<HTMLElement>('[data-composer-zone="status-stack"]')!;
    expect(stack).not.toBeNull();
    expect(stack.getAttribute("data-pane")).toBe("composer-status-stack");
    // 三条状态条都在堆栈里，且顺序稳定（计划 → 团队 → 工作流）。
    expect([...stack.children].map((child) => child.getAttribute("data-composer-zone"))).toEqual(["plan", "team", "workflow"]);
    // 队列不在堆栈里：它是 composer 自己的行。
    expect(stack.querySelector('[data-composer-zone="queue"]')).toBeNull();
    expect(composer.querySelector('[data-composer-zone="queue"]')).not.toBeNull();
    expect(composer.querySelector('[data-composer-zone="input"]')).not.toBeNull();
  });

  it("只有一条状态条时也进堆栈（不因数量不同换布局路径）", () => {
    useDesktopStore.setState({ snapshot: snapshot({ planMode: true }), workflowRuns: undefined });
    render();
    const stack = container.querySelector<HTMLElement>('[data-composer-zone="status-stack"]')!;
    expect(stack).not.toBeNull();
    expect([...stack.children].map((child) => child.getAttribute("data-composer-zone"))).toEqual(["plan"]);
  });

  it("一条状态条都没有时堆栈与 has-status-stack 一并消失", () => {
    useDesktopStore.setState({ snapshot: snapshot(), workflowRuns: undefined });
    render();
    expect(container.querySelector('[data-composer-zone="status-stack"]')).toBeNull();
    expect(container.querySelector<HTMLElement>(".composer")!.className).not.toContain("has-status-stack");
    // 排队条仍在（独立占位）。
    expect(container.querySelector('[data-composer-zone="queue"]')).not.toBeNull();
  });
});

describe("composer 状态条堆栈：工作流运行条接线", () => {
  it("只显示本格 owner 的运行（分屏各看各的）", () => {
    useDesktopStore.setState({
      snapshot: snapshot(),
      workflowRuns: {
        epoch: "e1",
        revision: 2,
        runs: [run({ runId: "run-mine" }), run({ runId: "run-other", ownerSessionId: "owner-b", workflowName: "别人的流程" })]
      }
    });
    render();
    const rows = container.querySelectorAll("[data-run-id]");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-run-id")).toBe("run-mine");
    expect(container.textContent).not.toContain("别人的流程");
  });

  it("详情把 runId + 本格 owner 交回 App；待确认把整条摘要交回（定位复用权限弹窗）", () => {
    const onOpenWorkflowRun = vi.fn();
    const onLocateWorkflowOwner = vi.fn();
    useDesktopStore.setState({ snapshot: snapshot(), workflowRuns: { epoch: "e1", revision: 1, runs: [run()] } });
    render({ onOpenWorkflowRun, onLocateWorkflowOwner });

    click('[data-control="workflow-run-details"]');
    expect(onOpenWorkflowRun).toHaveBeenCalledWith("run-a", "owner-a");

    click('[data-control="workflow-pending-locate"]');
    expect(onLocateWorkflowOwner).toHaveBeenCalledTimes(1);
    expect(onLocateWorkflowOwner.mock.calls[0]![0]).toMatchObject({ runId: "run-a", ownerSessionId: "owner-a", pendingPermissionIds: ["p-1"] });
  });

  it("终态保留在运行条里，点关闭只影响这一格", () => {
    useDesktopStore.setState({
      snapshot: snapshot(),
      workflowRuns: { epoch: "e1", revision: 1, runs: [run({ status: "completed", endedAt: 2_000, pendingPermissionIds: [] })] }
    });
    render();
    expect(container.textContent).toContain("已完成");
    expect(container.querySelector('[data-control="workflow-run-dismiss"]')).not.toBeNull();
    click('[data-control="workflow-run-dismiss"]');
    expect(container.querySelector('[data-composer-zone="workflow"]')).toBeNull();
  });
});
