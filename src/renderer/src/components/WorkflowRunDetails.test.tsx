// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../shared/protocol";
import type { WorkflowRun } from "../../../shared/workflow";
import { createStarterWorkflow } from "../lib/workflow-canvas";
import { WorkflowRunDetails, type WorkflowRunDetailsProps } from "./WorkflowRunDetails";

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

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowName: "实施—验收工作流",
    workspace: "D:\\Ws\\Demo",
    agentId: "default",
    ownerSessionId: "owner-1",
    definitionHash: "hash",
    runnerInstanceId: "instance-1",
    runnerPid: 4_242,
    status: "running",
    startedAt: 1_000,
    currentAttempt: 2,
    maxAttempts: 3,
    currentExecutionId: "ex-6",
    executions: [
      { executionId: "ex-1", nodeId: "n1", nodeTitle: "规划", attempt: 1, status: "completed", startedAt: 1_000, endedAt: 2_000 },
      { executionId: "ex-2", nodeId: "n2", nodeTitle: "实施", attempt: 1, status: "completed", artifactPath: "artifacts/a1/n2.txt" },
      { executionId: "ex-3", nodeId: "n3", nodeTitle: "审查", attempt: 1, status: "completed" },
      { executionId: "ex-4", nodeId: "n4", nodeTitle: "测试", attempt: 1, status: "failed", error: "命令超时" },
      { executionId: "ex-5", nodeId: "n5", nodeTitle: "验收", attempt: 1, status: "completed", decision: { verdict: "retry", reason: "测试仍有两个失败用例" } },
      { executionId: "ex-6", nodeId: "n2", nodeTitle: "实施", attempt: 2, status: "running" }
    ],
    resolvedNodes: [],
    ...overrides
  };
}

function props(overrides: Partial<WorkflowRunDetailsProps> = {}): WorkflowRunDetailsProps {
  return {
    run: run(),
    definition: createStarterWorkflow(1_000),
    contents: {},
    onSelectExecution: vi.fn(),
    onLoadArtifact: vi.fn(),
    onLoadTranscript: vi.fn(),
    ...overrides
  };
}

function render(next: WorkflowRunDetailsProps): void {
  act(() => root.render(<WorkflowRunDetails {...next} />));
}

function click(selector: string): void {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`找不到 ${selector}`);
  act(() => element.click());
}

describe("运行详情：冻结快照与按轮次分组", () => {
  it("同轮节点归组，轮号与 gate 裁决一起显示", () => {
    render(props());
    const groups = [...container.querySelectorAll(".workflow-run-attempt-group h4")].map((element) => element.textContent);
    expect(groups).toEqual(["第 1/3 轮", "第 2/3 轮"]);
    expect(container.querySelector('[data-pane="workflow-run-details"]')).not.toBeNull();
    expect(container.textContent).toContain("gate: retry");
    expect(container.textContent).toContain("测试仍有两个失败用例");
    expect(container.textContent).toContain("命令超时");
  });

  it("明确标注使用的是启动时冻结的定义快照", () => {
    render(props());
    expect(container.querySelector(".workflow-run-note")?.textContent).toContain("定义快照：启动时冻结");
    expect(container.querySelector(".workflow-run-note")?.textContent).toContain("6 节点");
  });

  it("点执行行回调选中的 executionId", () => {
    const next = props();
    render(next);
    click('[data-execution-id="ex-5"]');
    expect(next.onSelectExecution).toHaveBeenCalledWith("ex-5");
  });

  it("默认选中最后一次执行（正在跑的那个）", () => {
    render(props());
    // 未传 selectedExecutionId 时回落到 at(-1)：ex-6 实施
    expect(container.querySelector(".workflow-run-content-head")?.textContent).toContain("实施");
    expect(container.querySelector(".workflow-run-content-head")?.textContent).toContain("执行中");
  });
});

describe("运行详情：产物与完整记录按需读取", () => {
  it("产物/完整记录按钮分别触发按需读取", () => {
    const next = props({ selectedExecutionId: "ex-2" });
    render(next);
    click('[data-control="workflow-run-content-artifact"]');
    expect(next.onLoadArtifact).toHaveBeenCalledWith("ex-2");
    click('[data-control="workflow-run-content-transcript"]');
    expect(next.onLoadTranscript).toHaveBeenCalledWith("ex-2");
  });

  it("产物文本保留换行，截断时说明只显示前 8 KiB", () => {
    render(props({ selectedExecutionId: "ex-2", contents: { "ex-2": { artifact: "第一行\n第二行", truncated: true } } }));
    expect(container.querySelector(".workflow-run-artifact")?.textContent).toBe("第一行\n第二行");
    expect(container.textContent).toContain("只显示前 8 KiB");
  });

  it("完整记录复用只读时间线渲染，无输入框", () => {
    const messages: ChatMessage[] = [
      { id: "m-1", role: "user", timestamp: 1, blocks: [{ type: "text", text: "按规划实施改动" }] },
      { id: "m-2", role: "assistant", timestamp: 2, blocks: [{ type: "text", text: "已完成三个文件" }] }
    ];
    render(props({ selectedExecutionId: "ex-2", contents: { "ex-2": { messages } } }));
    expect(container.querySelector(".workflow-run-transcript")).not.toBeNull();
    expect(container.textContent).toContain("已完成三个文件");
    expect(container.querySelector("textarea, input")).toBeNull();
  });

  it("加载中与错误状态各自有文案", () => {
    render(props({ selectedExecutionId: "ex-2", contents: { "ex-2": { loading: true } } }));
    expect(container.textContent).toContain("正在读取");
    render(props({ selectedExecutionId: "ex-2", contents: { "ex-2": { error: "读取节点记录失败：路径越界" } } }));
    expect(container.textContent).toContain("路径越界");
  });

  it("未读取时提示按需加载，而不是假装没有内容", () => {
    render(props({ selectedExecutionId: "ex-2" }));
    expect(container.textContent).toContain("按需读取");
  });
});

describe("运行详情：状态与停止", () => {
  it("运行中显示停止并可回调，终态不显示", () => {
    const next = props({ onStop: vi.fn() });
    render(next);
    expect(container.textContent).toContain("停止工作流");
    click('[data-control="workflow-run-stop"]');
    expect(next.onStop).toHaveBeenCalled();
    render(props({ run: run({ status: "completed", endedAt: 9_000 }), onStop: vi.fn() }));
    expect(container.querySelector('[data-control="workflow-run-stop"]')).toBeNull();
    expect(container.textContent).toContain("已完成");
  });

  it("stopping 状态时停止按钮禁用并写「停止中」", () => {
    render(props({ run: run({ status: "stopping" }), onStop: vi.fn() }));
    const stop = container.querySelector<HTMLButtonElement>('[data-control="workflow-run-stop"]');
    expect(stop?.disabled).toBe(true);
    expect(stop?.textContent).toContain("停止中");
  });

  it("rejected / interrupted 用中性或失败文案，不误报完成", () => {
    render(props({ run: run({ status: "rejected", endedAt: 5_000 }) }));
    expect(container.textContent).toContain("未通过");
    render(props({ run: run({ status: "interrupted" }) }));
    expect(container.textContent).toContain("已中断");
  });

  it("运行错误与加载错误都摊在界面上，不静默", () => {
    render(props({ run: run({ status: "failed", error: "节点等待权限超时" }) }));
    expect(container.textContent).toContain("节点等待权限超时");
    render(props({ error: "读取运行记录失败：找不到 run.json" }));
    expect(container.textContent).toContain("找不到 run.json");
  });

  it("关闭按钮只在传入 onClose 时出现", () => {
    render(props());
    expect(container.querySelector('[data-control="workflow-run-close"]')).toBeNull();
    const next = props({ onClose: vi.fn() });
    render(next);
    click('[data-control="workflow-run-close"]');
    expect(next.onClose).toHaveBeenCalled();
  });

  it("没有执行记录时如实显示空态", () => {
    render(props({ run: run({ executions: [], currentExecutionId: undefined }), loading: false }));
    expect(container.textContent).toContain("还没有节点执行记录");
  });
});

describe("运行详情：完整记录分页与截断提示", () => {
  const pageMessages: ChatMessage[] = [
    { id: "m-1", role: "user", timestamp: 1, blocks: [{ type: "text", text: "第一页内容" }] }
  ];

  it("还有下一页时给「加载更多」，按当前执行回调（不新造 data-control）", () => {
    const onLoadMoreTranscript = vi.fn();
    render(props({ selectedExecutionId: "ex-2", onLoadMoreTranscript, contents: { "ex-2": { messages: pageMessages, nextCursor: "1", pages: 1 } } }));
    const more = container.querySelector<HTMLElement>('[aria-label="加载更多完整记录"]');
    expect(more).not.toBeNull();
    expect(more?.hasAttribute("data-control")).toBe(false);
    act(() => more!.click());
    expect(onLoadMoreTranscript).toHaveBeenCalledWith("ex-2");
    expect(container.textContent).toContain("第一页内容");
  });

  it("追加下一页时按钮禁用并写「正在加载更多」，已看过的内容不消失", () => {
    render(props({ selectedExecutionId: "ex-2", onLoadMoreTranscript: vi.fn(), contents: { "ex-2": { messages: pageMessages, nextCursor: "1", pages: 1, loadingMore: true } } }));
    const more = container.querySelector<HTMLButtonElement>('[aria-label="加载更多完整记录"]');
    expect(more?.disabled).toBe(true);
    expect(more?.textContent).toContain("正在加载更多");
    expect(container.textContent).toContain("第一页内容");
  });

  it("窗口满且还有后续：给「查看后续记录」推进游标，明说不是完整记录（不再把入口藏掉）", () => {
    const onLoadNextWindow = vi.fn();
    render(props({
      selectedExecutionId: "ex-2",
      onLoadMoreTranscript: vi.fn(),
      onLoadNextWindow,
      contents: { "ex-2": { messages: pageMessages, nextCursor: "5", pages: 5, windowStartPage: 1, windowFull: true } }
    }));
    // 窗口满：窗口内「加载更多」收起，换成推进窗口的入口。
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).toBeNull();
    const note = container.querySelector('[data-workflow-transcript-window="full"]');
    expect(note?.textContent).toContain("当前窗口：第 1–5 页");
    expect(note?.textContent).toContain("这不是完整记录");
    expect(note?.textContent).toContain("后面还有内容没有显示");
    const forward = container.querySelector<HTMLElement>('[aria-label="查看后续记录"]');
    expect(forward).not.toBeNull();
    act(() => forward!.click());
    expect(onLoadNextWindow).toHaveBeenCalledWith("ex-2");
    expect(container.textContent).toContain("第一页内容");
  });

  it("推进到后续窗口：明说前文已移出，并可上一窗口 / 从头查看（窗口没满时仍给加载更多）", () => {
    const onLoadPreviousWindow = vi.fn();
    const onRestartTranscript = vi.fn();
    render(props({
      selectedExecutionId: "ex-2",
      onLoadMoreTranscript: vi.fn(),
      onLoadNextWindow: vi.fn(),
      onLoadPreviousWindow,
      onRestartTranscript,
      contents: {
        "ex-2": {
          messages: pageMessages,
          nextCursor: "6",
          pages: 1,
          windowStartPage: 6,
          hasEarlier: true,
          windowBack: [{ cursor: "0", pageStart: 1 }]
        }
      }
    }));
    const note = container.querySelector('[data-workflow-transcript-window="partial"]');
    expect(note?.textContent).toContain("当前窗口：第 6 页");
    expect(note?.textContent).toContain("前面第 1–5 页已移出窗口");
    // 窗口没满：仍是窗口内「加载更多」，不重复给「查看后续记录」。
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="查看后续记录"]')).toBeNull();
    act(() => container.querySelector<HTMLElement>('[aria-label="查看上一窗口"]')!.click());
    expect(onLoadPreviousWindow).toHaveBeenCalledWith("ex-2");
    act(() => container.querySelector<HTMLElement>('[aria-label="从头查看完整记录"]')!.click());
    expect(onRestartTranscript).toHaveBeenCalledWith("ex-2");
  });

  it("后续窗口读到末尾：明说已到记录末尾，不再给前进入口（回退仍可用）", () => {
    render(props({
      selectedExecutionId: "ex-2",
      onLoadNextWindow: vi.fn(),
      onLoadPreviousWindow: vi.fn(),
      onRestartTranscript: vi.fn(),
      contents: {
        "ex-2": { messages: pageMessages, pages: 4, windowStartPage: 6, hasEarlier: true, windowBack: [{ cursor: "0", pageStart: 1 }] }
      }
    }));
    const note = container.querySelector('[data-workflow-transcript-window="partial"]');
    expect(note?.textContent).toContain("当前窗口：第 6–9 页");
    expect(note?.textContent).toContain("已到记录末尾");
    expect(container.querySelector('[aria-label="查看后续记录"]')).toBeNull();
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).toBeNull();
    expect(container.querySelector('[aria-label="查看上一窗口"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="从头查看完整记录"]')).not.toBeNull();
  });

  it("单页且没有后续时不额外提示（本来就是全部记录）", () => {
    render(props({ selectedExecutionId: "ex-2", onLoadMoreTranscript: vi.fn(), contents: { "ex-2": { messages: pageMessages, pages: 1 } } }));
    expect(container.querySelector("[data-workflow-transcript-window]")).toBeNull();
    expect(container.querySelector("[data-workflow-transcript-clipped]")).toBeNull();
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).toBeNull();
    expect(container.querySelector('[aria-label="查看后续记录"]')).toBeNull();
  });

  it("消息被后端截断时标注只截了尾部，不是完整记录", () => {
    render(props({ selectedExecutionId: "ex-2", contents: { "ex-2": { messages: pageMessages, pages: 1, transcriptTruncated: true } } }));
    expect(container.querySelector('[data-workflow-transcript-clipped="true"]')?.textContent).toContain("不是完整记录");
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).toBeNull();
  });
});
