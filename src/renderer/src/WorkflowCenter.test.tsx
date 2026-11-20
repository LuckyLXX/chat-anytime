// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelOption, ProviderOption, RuntimeCommand, RuntimeMessage, WorkflowCommand, WorkflowResult, WorkflowRunSummary, WorkflowSummary } from "../../shared/protocol";
import type { WorkflowDefinition, WorkflowDiagnostic, WorkflowRun } from "../../shared/workflow";
import { createStarterWorkflow, removeWorkflowEdge, updateWorkflowNode } from "./lib/workflow-canvas";
import type { WorkflowApi } from "./lib/workflow-client";
import { WorkflowCenter, type WorkflowLeaveGuard } from "./WorkflowCenter";
import { overlayLayersOpen } from "./lib/overlay-layers";
import { useDesktopStore } from "./store";

const WORKSPACE = "D:\\Ws";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const store = useDesktopStore.getState();
  useDesktopStore.setState({
    models: [
      { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", configured: true, input: ["text" as const], imageInput: false }
    ] satisfies ModelOption[],
    providers: [{ id: "anthropic", name: "Anthropic", configured: true }] satisfies ProviderOption[],
    resources: { ...store.resources, subagents: [] }
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 假的 workflow 后端：按命令类型回执，记录收到的命令，便于断言「保存先于运行」。 */
interface TranscriptPageFixture {
  messages: ChatMessage[];
  /** 这一页里有消息被截断（后端 clipped）。 */
  truncated?: boolean;
}

function createServer(options: {
  definitions?: WorkflowDefinition[];
  runs?: WorkflowRun[];
  runSummaries?: WorkflowRunSummary[];
  fail?: Partial<Record<RuntimeCommand["type"], { code?: string; errors: WorkflowDiagnostic[] }>>;
  /** 分页转写夹具：key 是 executionId，数组下标就是游标（0 起）。 */
  transcripts?: Record<string, TranscriptPageFixture[]>;
  /** 运行启动时冻结的定义（key 是 runId）；缺省用当前目录里的定义。 */
  frozen?: Record<string, WorkflowDefinition>;
} = {}) {
  const listeners = new Set<(message: RuntimeMessage) => void>();
  const sent: RuntimeCommand[] = [];
  const definitions = new Map<string, WorkflowDefinition>();
  const hashes = new Map<string, string>();
  let seq = 0;
  for (const definition of options.definitions ?? []) {
    definitions.set(definition.id, definition);
    hashes.set(definition.id, `hash-${definition.id}`);
  }
  const runs = options.runs ?? [];

  function catalog(): WorkflowSummary[] {
    return [...definitions.values()].map((definition) => ({
      id: definition.id,
      name: definition.name,
      nodeCount: definition.nodes.length,
      updatedAt: definition.updatedAt,
      runnable: true,
      issueCount: 0
    }));
  }

  function respond(command: RuntimeCommand): WorkflowResult {
    // 测试只关心工作流命令：先窄化，再按 op 分支取值。
    const wf = command as WorkflowCommand;
    const failure = options.fail?.[wf.type];
    if (failure) return { requestId: wf.requestId, ok: false, op: wf.type, code: failure.code ?? "invalid-draft", errors: failure.errors };
    switch (wf.type) {
      case "workflow.sync":
        return { requestId: wf.requestId, ok: true, op: "workflow.sync", result: { workspace: wf.workspace, workflows: catalog(), diagnostics: [] } };
      case "workflow.get": {
        const definition = definitions.get(wf.workflowId);
        if (!definition) return { requestId: wf.requestId, ok: false, op: "workflow.get", code: "not-found", errors: [{ code: "not-found", message: "工作流不存在" }] };
        return { requestId: wf.requestId, ok: true, op: "workflow.get", result: { definition, baseHash: hashes.get(wf.workflowId) ?? "hash", issues: [] } };
      }
      case "workflow.save": {
        const workflowId = wf.workflowId ?? `wf-00000000-0000-4000-8000-00000000000${++seq}`;
        const saved: WorkflowDefinition = { ...wf.draft, id: workflowId, revision: (definitions.get(workflowId)?.revision ?? 0) + 1, updatedAt: 5_000 };
        definitions.set(workflowId, saved);
        hashes.set(workflowId, `hash-${workflowId}-${saved.revision}`);
        return { requestId: wf.requestId, ok: true, op: "workflow.save", result: { definition: saved, baseHash: hashes.get(workflowId)!, issues: [] } };
      }
      case "workflow.delete":
        definitions.delete(wf.workflowId);
        return { requestId: wf.requestId, ok: true, op: "workflow.delete", result: { workflowId: wf.workflowId } };
      case "workflow.run":
        return { requestId: wf.requestId, ok: true, op: "workflow.run", result: { runId: "run-9", status: "starting" } };
      case "workflow.runs.list":
        return { requestId: wf.requestId, ok: true, op: "workflow.runs.list", result: { runs: options.runSummaries ?? runs.map(summarize), diagnostics: [] } };
      case "workflow.run.get": {
        const run = runs.find((item) => item.runId === wf.runId);
        if (!run) return { requestId: wf.requestId, ok: false, op: "workflow.run.get", code: "not-found", errors: [{ code: "not-found", message: "运行记录不存在" }] };
        const definition = options.frozen?.[run.runId] ?? definitions.get(run.workflowId) ?? createStarterWorkflow(1_000, run.workflowId);
        return { requestId: wf.requestId, ok: true, op: "workflow.run.get", result: { run, definition } };
      }
      case "workflow.node.get": {
        if (wf.content === "artifact") {
          return { requestId: wf.requestId, ok: true, op: "workflow.node.get", result: { executionId: wf.executionId, artifact: "产物正文\n第二行", truncated: false } };
        }
        // 转写按 executionId 各自分页：游标就是页下标。
        const pages = options.transcripts?.[wf.executionId] ?? [];
        const index = wf.cursor ? Number(wf.cursor) : 0;
        const page = pages[index];
        if (!page) return { requestId: wf.requestId, ok: true, op: "workflow.node.get", result: { executionId: wf.executionId, messages: [], truncated: false } };
        return {
          requestId: wf.requestId, ok: true, op: "workflow.node.get",
          result: {
            executionId: wf.executionId,
            messages: page.messages,
            ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}),
            ...(page.truncated ? { truncated: true } : {})
          }
        };
      }
      default:
        return { requestId: wf.requestId, ok: false, op: wf.type, code: "unsupported", errors: [{ code: "unsupported", message: `未实现 ${wf.type}` }] };
    }
  }

  const api: WorkflowApi = {
    send: (command) => {
      sent.push(command);
      // 回执放到微任务里：封装本身是「先订阅再发」，这样才像真实时序。
      queueMicrotask(() => {
        const result = respond(command);
        for (const listener of [...listeners]) listener({ type: "workflow.result", result });
      });
      return Promise.resolve();
    },
    onRuntimeMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return { api, sent, definitions, hashes, catalog };
}

function summarize(run: WorkflowRun): WorkflowRunSummary {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    workspace: run.workspace,
    agentId: run.agentId,
    ownerSessionId: run.ownerSessionId,
    status: run.status,
    currentAttempt: run.currentAttempt,
    maxAttempts: run.maxAttempts,
    nodeStates: {},
    pendingPermissionIds: [],
    startedAt: run.startedAt
  };
}

function sampleRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "run-1",
    workflowId: "wf-00000000-0000-4000-8000-000000000001",
    workflowName: "实施—验收工作流",
    workspace: "D:\\Ws",
    agentId: "default",
    ownerSessionId: "owner-1",
    definitionHash: "hash",
    runnerInstanceId: "instance-1",
    runnerPid: 1,
    status: "completed",
    startedAt: 1_000,
    endedAt: 2_000,
    currentAttempt: 1,
    maxAttempts: 3,
    executions: [{ executionId: "ex-1", nodeId: "n1", nodeTitle: "规划", attempt: 1, status: "completed" }],
    resolvedNodes: [],
    ...overrides
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render(element: ReactElement): void {
  act(() => root.render(element));
}

function click(selector: string): void {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`找不到 ${selector}`);
  act(() => element.click());
}

/** 节点选中走 pointerdown/pointerup（与画布一致）；纯 click 不参与选中语义。 */
function pressNode(nodeId: string): void {
  const element = container.querySelector<HTMLElement>(`[data-workflow-node="${nodeId}"]`);
  if (!element) throw new Error(`找不到节点 ${nodeId}`);
  act(() => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: 5, clientY: 5 }));
    element.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: 5, clientY: 5 }));
  });
}

function typeInto(element: HTMLElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function commandTypes(sent: RuntimeCommand[]): string[] {
  return sent.map((command) => command.type);
}

describe("工作流中心：目录与草稿", () => {
  it("打开即拉目录并列出工作流；新建得到六节点起步模板且标记未保存", async () => {
    const server = createServer({ definitions: [createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001")] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    expect(commandTypes(server.sent)).toContain("workflow.sync");
    expect(container.querySelectorAll('[data-control="workflow-open"]')).toHaveLength(1);
    click('[data-control="workflow-create"]');
    expect(container.querySelector(".workflow-main-name")).not.toBeNull();
    expect(container.textContent).toContain("未保存");
    // 起步模板的六个节点都在画布上
    expect(container.querySelectorAll("[data-workflow-node]")).toHaveLength(6);
  });

  it("选中已有工作流读取定义，保存用读取时的 baseHash 乐观并发", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    expect(server.sent.some((command) => command.type === "workflow.get" && command.workflowId === definition.id)).toBe(true);
    expect(container.textContent).toContain("已保存");
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "改名后的流程");
    expect(container.textContent).toContain("未保存");
    click('[data-control="workflow-save"]');
    await flush();
    const save = server.sent.find((command) => command.type === "workflow.save") as Extract<RuntimeCommand, { type: "workflow.save" }>;
    expect(save).toMatchObject({ type: "workflow.save", workflowId: definition.id, baseHash: `hash-${definition.id}` });
    expect(save.draft.name).toBe("改名后的流程");
    expect(container.textContent).toContain("已保存");
  });

  it("打开旧工作流只投影位置，缩放不触发保存，拖动和重新启用排版才写入草稿", async () => {
    const { layout: _layout, ...legacy } = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [legacy] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    const node = container.querySelector<HTMLElement>('[data-workflow-node="n2"]')!;
    expect(node.style.top).not.toBe(`${legacy.nodes[1]?.position.y}px`);
    const saveButton = container.querySelector<HTMLButtonElement>('[data-control="workflow-save"]')!;
    click('[data-control="workflow-zoom-in"]');
    click('[data-control="workflow-view-fit"]');
    expect(saveButton.disabled).toBe(true);
    expect(commandTypes(server.sent)).not.toContain("workflow.save");
    expect(server.definitions.get(legacy.id)?.nodes).toEqual(legacy.nodes);

    act(() => {
      for (const [type, x] of [["pointerdown", 5], ["pointermove", 45], ["pointerup", 45]] as const) {
        node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: 5 }));
      }
    });
    expect(saveButton.disabled).toBe(false);
    click('[data-control="workflow-save"]');
    await flush();
    const saved = server.definitions.get(legacy.id)!;
    expect(saved.layout).toBe("manual");
    expect(saved.nodes[1]!.position.x).toBe(saved.nodes[0]!.position.x + 40);
    click('[data-control="workflow-layout-auto"]');
    expect(saveButton.disabled).toBe(false);
    click('[data-control="workflow-save"]');
    await flush();
    expect(server.definitions.get(legacy.id)?.layout).toBe("auto");
  });

  it("保存冲突时如实报冲突，不采纳服务端草稿", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition], fail: { "workflow.save": { code: "conflict", errors: [{ code: "conflict", message: "工作流已被其他操作修改" }] } } });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "本地改名");
    click('[data-control="workflow-save"]');
    await flush();
    expect(container.textContent).toContain("保存冲突");
    expect(container.textContent).toContain("未保存");
  });

  it("删除先确认，再带 baseHash 调 workflow.delete", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    click('[data-control="workflow-delete"]');
    expect(container.textContent).toContain("只删定义文件");
    click('[data-control="workflow-delete-confirm"]');
    await flush();
    expect(server.sent.some((command) => command.type === "workflow.delete" && command.workflowId === definition.id && command.baseHash === `hash-${definition.id}`)).toBe(true);
  });
});

describe("工作流中心：复制与停止", () => {
  it("复制得到未保存副本：名字带（副本），节点 id 与模板引用保持原样", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    click('[data-control="workflow-copy"]');
    expect((container.querySelector(".workflow-main-name") as HTMLInputElement).value).toBe("实施—验收工作流（副本）");
    expect(container.textContent).toContain("未保存");
    expect(container.querySelectorAll("[data-workflow-node]")).toHaveLength(6);
    click('[data-control="workflow-save"]');
    await flush();
    const save = server.sent.find((command) => command.type === "workflow.save") as Extract<RuntimeCommand, { type: "workflow.save" }>;
    expect(save.workflowId).toBeUndefined();
    expect(save.draft.nodes.map((node) => node.id)).toEqual(definition.nodes.map((node) => node.id));
  });

  it("中心页的「停止运行」精确停这一条 run，不影响 owner 会话", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const activeRun = sampleRun({ status: "running", endedAt: undefined, workflowId: definition.id });
    const server = createServer({ definitions: [definition], runs: [activeRun] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[summarize(activeRun)]} ownerSessionId="owner-1" api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    click('[data-control="workflow-stop"]');
    await flush();
    const stop = server.sent.find((command) => command.type === "workflow.stop") as Extract<RuntimeCommand, { type: "workflow.stop" }>;
    expect(stop.runId).toBe("run-1");
    expect(server.sent.some((command) => command.type.startsWith("session."))).toBe(false);
  });
});

describe("工作流中心：dirty 守卫", () => {
  it("有未保存修改时切定义给出保存/放弃/取消，取消不切换", async () => {
    const first = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const second = { ...createStarterWorkflow(2_000, "wf-00000000-0000-4000-8000-000000000002"), name: "另一个流程" };
    const server = createServer({ definitions: [first, second] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "本地改名");
    const rows = container.querySelectorAll<HTMLElement>('[data-control="workflow-open"]');
    act(() => rows[1]!.click());
    expect(container.querySelector('[aria-label="有未保存的修改"]')).not.toBeNull();
    click('[data-control="workflow-dirty-cancel"]');
    expect(container.querySelector('[aria-label="有未保存的修改"]')).toBeNull();
    expect((container.querySelector(".workflow-main-name") as HTMLInputElement).value).toBe("本地改名");
  });

  it("「放弃修改」直接切换；「保存并继续」先成交再切换", async () => {
    const first = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const second = { ...createStarterWorkflow(2_000, "wf-00000000-0000-4000-8000-000000000002"), name: "另一个流程" };
    const server = createServer({ definitions: [first, second] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "丢弃的改动");
    act(() => container.querySelectorAll<HTMLElement>('[data-control="workflow-open"]')[1]!.click());
    click('[data-control="workflow-dirty-discard"]');
    await flush();
    expect(server.sent.some((command) => command.type === "workflow.save")).toBe(false);
    expect((container.querySelector(".workflow-main-name") as HTMLInputElement).value).toBe("另一个流程");

    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "要保存的改动");
    act(() => container.querySelectorAll<HTMLElement>('[data-control="workflow-open"]')[0]!.click());
    click('[data-control="workflow-dirty-save"]');
    await flush();
    const save = server.sent.find((command) => command.type === "workflow.save") as Extract<RuntimeCommand, { type: "workflow.save" }>;
    expect(save.draft.name).toBe("要保存的改动");
    expect((container.querySelector(".workflow-main-name") as HTMLInputElement).value).toBe("实施—验收工作流");
  });

  it("关闭中心页也走同一道 dirty 守卫", async () => {
    const server = createServer();
    const onClose = vi.fn();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={onClose} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-create"]');
    click('[data-control="workflow-center-close"]');
    expect(container.querySelector('[aria-label="有未保存的修改"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    click('[data-control="workflow-dirty-discard"]');
    expect(onClose).toHaveBeenCalled();
  });
});

describe("工作流中心：运行", () => {
  it("运行前先保存并拿到成功回执，再用 owner + workflowId + 输入受理", async () => {
    const server = createServer();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} ownerSessionId="owner-7" api={server.api} />);
    await flush();
    click('[data-control="workflow-create"]');
    click('[data-control="workflow-run"]');
    const input = container.querySelector<HTMLElement>('[data-control="workflow-run-input"]')!;
    typeInto(input, "把登录页改成暗色");
    click('[data-control="workflow-run-start"]');
    await flush();
    const types = commandTypes(server.sent);
    expect(types.indexOf("workflow.save")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("workflow.save")).toBeLessThan(types.indexOf("workflow.run"));
    const run = server.sent.find((command) => command.type === "workflow.run") as Extract<RuntimeCommand, { type: "workflow.run" }>;
    expect(run.ownerSessionId).toBe("owner-7");
    expect(run.workspace).toBe("D:\\Ws");
    expect(run.input).toBe("把登录页改成暗色");
    expect(run.workflowId).toMatch(/^wf-/u);
    expect(container.textContent).toContain("已受理");
  });

  it("保存失败就不运行（不会用旧稿启动）", async () => {
    const server = createServer({ fail: { "workflow.save": { code: "invalid-draft", errors: [{ code: "invalid-draft", message: "工作流结构非法" }] } } });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} ownerSessionId="owner-7" api={server.api} />);
    await flush();
    click('[data-control="workflow-create"]');
    click('[data-control="workflow-run"]');
    click('[data-control="workflow-run-start"]');
    await flush();
    expect(server.sent.some((command) => command.type === "workflow.run")).toBe(false);
    expect(container.textContent).toContain("保存失败，已取消本次运行");
  });

  it("没有 owner 时走 onOwnerRequired 现开一个；拿不到就本地报错且不启动", async () => {
    const server = createServer();
    const onOwnerRequired = vi.fn(async () => "owner-new");
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} onOwnerRequired={onOwnerRequired} api={server.api} />);
    await flush();
    click('[data-control="workflow-create"]');
    click('[data-control="workflow-run"]');
    click('[data-control="workflow-run-start"]');
    await flush();
    expect(onOwnerRequired).toHaveBeenCalled();
    const run = server.sent.find((command) => command.type === "workflow.run") as Extract<RuntimeCommand, { type: "workflow.run" }>;
    expect(run.ownerSessionId).toBe("owner-new");

    const noOwnerServer = createServer();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={noOwnerServer.api} />);
    await flush();
    click('[data-control="workflow-create"]');
    click('[data-control="workflow-run"]');
    click('[data-control="workflow-run-start"]');
    await flush();
    expect(noOwnerServer.sent.some((command) => command.type === "workflow.run")).toBe(false);
    expect(container.textContent).toContain("没有可用的 owner 会话");
  });

  it("输入超过 16 KiB 时禁止提交并给出字节数", async () => {
    const server = createServer();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} ownerSessionId="owner-7" api={server.api} />);
    await flush();
    click('[data-control="workflow-create"]');
    click('[data-control="workflow-run"]');
    const input = container.querySelector<HTMLElement>('[data-control="workflow-run-input"]')!;
    typeInto(input, "x".repeat(16 * 1024 + 1));
    expect(container.querySelector<HTMLButtonElement>('[data-control="workflow-run-start"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("16.0 KiB / 16 KiB");
  });
});

describe("工作流中心：运行历史与详情", () => {
  it("历史页拉 runs.list，点一条读 run.get 并展示冻结快照", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition], runs: [sampleRun()] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-view-runs"]');
    await flush();
    expect(container.querySelectorAll('[data-control="workflow-run-open"]')).toHaveLength(1);
    click('[data-control="workflow-run-open"]');
    await flush();
    expect(server.sent.some((command) => command.type === "workflow.run.get" && command.runId === "run-1")).toBe(true);
    expect(container.querySelector('[data-pane="workflow-run-details"]')).not.toBeNull();
    expect(container.textContent).toContain("定义快照：启动时冻结");
  });

  it("initialRunId 打开就落在运行历史页", async () => {
    const server = createServer({ runs: [sampleRun()] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} initialRunId="run-1" api={server.api} />);
    await flush();
    expect(container.querySelector('[data-pane="workflow-runs"]')).not.toBeNull();
    expect(server.sent.some((command) => command.type === "workflow.run.get" && command.runId === "run-1")).toBe(true);
  });

  it("按需读产物：点「产物」只拉那一次执行", async () => {
    const server = createServer({ runs: [sampleRun()] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} initialRunId="run-1" api={server.api} />);
    await flush();
    click('[data-control="workflow-run-content-artifact"]');
    await flush();
    const node = server.sent.find((command) => command.type === "workflow.node.get") as Extract<RuntimeCommand, { type: "workflow.node.get" }>;
    expect(node).toMatchObject({ runId: "run-1", executionId: "ex-1", content: "artifact" });
    expect(container.textContent).toContain("产物正文");
  });
});

describe("工作流中心：画布联动与钩子", () => {
  it("断图后本地校验把问题按节点/边摊出来（不阻断保存）", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const broken = removeWorkflowEdge(definition, "e2");
    const server = createServer({ definitions: [broken] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    expect(container.textContent).toContain("个运行问题");
    // 保存按钮在未 dirty 时禁用，但草稿本身仍可保存（图未完成不算错）
    expect(container.querySelector<HTMLButtonElement>('[data-control="workflow-save"]')?.disabled).toBe(true);
  });

  it("检查器改节点标题会写进草稿并标记未保存", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    pressNode("n2");
    const title = container.querySelector<HTMLElement>('[aria-label="节点标题"]')!;
    typeInto(title, "写代码");
    expect(container.querySelector('[data-workflow-node="n2"]')?.textContent).toContain("写代码");
    expect(container.textContent).toContain("未保存");
  });

  it("中心页登记全屏弹层（原生预览视图必须让位），卸载后释放", async () => {
    const server = createServer();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} />);
    await flush();
    expect(overlayLayersOpen()).toBe(true);
    act(() => root.unmount());
    expect(overlayLayersOpen()).toBe(false);
    // 重新挂载给 afterEach 的 unmount 用
    root = createRoot(container);
  });
});

describe("工作流中心：切工作区的 dirty 守卫", () => {
  it("无未保存修改时直接切换工作区（不弹窗）", async () => {
    const server = createServer();
    const onWorkspaceSwitch = vi.fn();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onWorkspaceSwitch={onWorkspaceSwitch} />);
    await flush();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onWorkspaceSwitch={onWorkspaceSwitch} workspaceSwitch={{ workspace: "D:\\Other", requestId: 1 }} />);
    await flush();
    expect(container.querySelector('[aria-label="有未保存的修改"]')).toBeNull();
    expect(onWorkspaceSwitch).toHaveBeenCalledWith("D:\\Other");
  });

  it("脏草稿切工作区走保存/放弃/取消：取消不切换且草稿保留", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition] });
    const onWorkspaceSwitch = vi.fn();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onWorkspaceSwitch={onWorkspaceSwitch} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "本地改名");
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onWorkspaceSwitch={onWorkspaceSwitch} workspaceSwitch={{ workspace: "D:\\Other", requestId: 1 }} />);
    expect(container.querySelector('[aria-label="有未保存的修改"]')).not.toBeNull();
    click('[data-control="workflow-dirty-cancel"]');
    expect(container.querySelector('[aria-label="有未保存的修改"]')).toBeNull();
    expect(onWorkspaceSwitch).not.toHaveBeenCalled();
    expect((container.querySelector(".workflow-main-name") as HTMLInputElement).value).toBe("本地改名");
  });

  it("「保存并继续」把草稿写回它自己的工作区，再切换工作区", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition] });
    const onWorkspaceSwitch = vi.fn();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onWorkspaceSwitch={onWorkspaceSwitch} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "要保存的改动");
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onWorkspaceSwitch={onWorkspaceSwitch} workspaceSwitch={{ workspace: "D:\\Other", requestId: 7 }} />);
    click('[data-control="workflow-dirty-save"]');
    await flush();
    const save = server.sent.find((command) => command.type === "workflow.save") as Extract<RuntimeCommand, { type: "workflow.save" }>;
    expect(save.workspace).toBe(WORKSPACE);
    expect(save.draft.name).toBe("要保存的改动");
    expect(onWorkspaceSwitch).toHaveBeenCalledWith("D:\\Other");
  });

  it("「放弃修改」不保存也要切换；同一个 requestId 不重复问", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition] });
    const onWorkspaceSwitch = vi.fn();
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onWorkspaceSwitch={onWorkspaceSwitch} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "丢弃的改动");
    const nextProps = { workspace: WORKSPACE, onClose: vi.fn(), runs: [] as WorkflowRunSummary[], api: server.api, onWorkspaceSwitch, workspaceSwitch: { workspace: "D:\\Other", requestId: 3 } };
    render(<WorkflowCenter {...nextProps} />);
    expect(container.querySelector('[aria-label="有未保存的修改"]')).not.toBeNull();
    // 同一请求重渲染（App 其他状态变化）不重复弹窗。
    render(<WorkflowCenter {...nextProps} />);
    expect(container.querySelectorAll('[aria-label="有未保存的修改"]')).toHaveLength(1);
    click('[data-control="workflow-dirty-discard"]');
    await flush();
    expect(server.sent.some((command) => command.type === "workflow.save")).toBe(false);
    expect(onWorkspaceSwitch).toHaveBeenCalledWith("D:\\Other");
  });
});

describe("工作流中心：离开守卫（App 的所有离开路径都走它）", () => {
  function register(store: { guard?: WorkflowLeaveGuard }): (guard: WorkflowLeaveGuard | undefined) => void {
    return (guard) => { store.guard = guard; };
  }

  it("不脏时守卫立刻放行动作，不弹窗", async () => {
    const server = createServer();
    const store: { guard?: WorkflowLeaveGuard } = {};
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onRegisterLeaveGuard={register(store)} />);
    await flush();
    expect(typeof store.guard).toBe("function");
    const proceed = vi.fn();
    act(() => store.guard?.(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="有未保存的修改"]')).toBeNull();
  });

  it("脏草稿走保存/放弃/取消：取消不执行动作且草稿留着，放弃与保存才放行", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition] });
    const store: { guard?: WorkflowLeaveGuard } = {};
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onRegisterLeaveGuard={register(store)} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "本地改名");

    // ① 取消：App 的动作一次都不执行，页面与草稿原样留着（不丢内容、不换页）。
    const cancelled = vi.fn();
    act(() => store.guard?.(cancelled));
    expect(container.querySelector('[aria-label="有未保存的修改"]')).not.toBeNull();
    expect(cancelled).not.toHaveBeenCalled();
    click('[data-control="workflow-dirty-cancel"]');
    expect(cancelled).not.toHaveBeenCalled();
    expect((container.querySelector(".workflow-main-name") as HTMLInputElement).value).toBe("本地改名");
    expect(container.querySelector('[aria-label="有未保存的修改"]')).toBeNull();

    // ② 放弃：放行，但不写盘。
    const discarded = vi.fn();
    act(() => store.guard?.(discarded));
    click('[data-control="workflow-dirty-discard"]');
    await flush();
    expect(discarded).toHaveBeenCalledTimes(1);
    expect(server.sent.some((command) => command.type === "workflow.save")).toBe(false);

    // ③ 保存：先拿到保存回执，再放行（冲突/失败就不放行）。
    const saved = vi.fn();
    act(() => store.guard?.(saved));
    click('[data-control="workflow-dirty-save"]');
    await flush();
    const save = server.sent.find((command) => command.type === "workflow.save") as Extract<RuntimeCommand, { type: "workflow.save" }>;
    expect(save.draft.name).toBe("本地改名");
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("保存失败时不放行（动作不执行，界面摊开错误）", async () => {
    const definition = createStarterWorkflow(1_000, "wf-00000000-0000-4000-8000-000000000001");
    const server = createServer({ definitions: [definition], fail: { "workflow.save": { code: "conflict", errors: [{ code: "conflict", message: "工作流已被其他操作修改" }] } } });
    const store: { guard?: WorkflowLeaveGuard } = {};
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onRegisterLeaveGuard={register(store)} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "本地改名");
    const proceed = vi.fn();
    act(() => store.guard?.(proceed));
    click('[data-control="workflow-dirty-save"]');
    await flush();
    expect(proceed).not.toHaveBeenCalled();
    expect(container.textContent).toContain("保存冲突");
  });

  it("卸载时注销守卫（不留悬空引用）", async () => {
    const server = createServer();
    const store: { guard?: WorkflowLeaveGuard } = {};
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} api={server.api} onRegisterLeaveGuard={register(store)} />);
    await flush();
    expect(store.guard).toBeDefined();
    act(() => root.unmount());
    expect(store.guard).toBeUndefined();
    // 重新挂载给 afterEach 的 unmount 用。
    root = createRoot(container);
  });
});

describe("工作流中心：画布叠加层只认同 owner + 同定义内容", () => {
  const WORKFLOW_ID = "wf-00000000-0000-4000-8000-000000000001";

  function twoStepRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return sampleRun({
      workflowId: WORKFLOW_ID,
      status: "running",
      endedAt: undefined,
      executions: [
        { executionId: "ex-1", nodeId: "n1", nodeTitle: "规划", attempt: 1, status: "completed" },
        { executionId: "ex-2", nodeId: "n2", nodeTitle: "实施", attempt: 1, status: "running" }
      ],
      ...overrides
    });
  }

  it("定义内容一致时按冻结运行给节点着色（状态来自 run.get，不是摘要副本）", async () => {
    const definition = createStarterWorkflow(1_000, WORKFLOW_ID);
    const run = twoStepRun();
    const server = createServer({ definitions: [definition], runs: [run] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[summarize(run)]} ownerSessionId="owner-1" api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    await flush();
    expect(server.sent.some((command) => command.type === "workflow.run.get" && command.runId === "run-1")).toBe(true);
    expect(container.querySelector('[data-workflow-node="n1"]')?.getAttribute("data-workflow-node-state")).toBe("completed");
    expect(container.querySelector('[data-workflow-node="n2"]')?.getAttribute("data-workflow-node-state")).toBe("running");
    expect(container.querySelector('[data-workflow-run-snapshot-mismatch="true"]')).toBeNull();
  });

  it("草稿改过就不给旧 run 着色，并明确说去运行历史看冻结快照", async () => {
    const definition = createStarterWorkflow(1_000, WORKFLOW_ID);
    const run = twoStepRun();
    const server = createServer({ definitions: [definition], runs: [run] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[summarize(run)]} ownerSessionId="owner-1" api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    await flush();
    expect(container.querySelector("[data-workflow-node-state]")).not.toBeNull();
    typeInto(container.querySelector<HTMLElement>(".workflow-main-name")!, "改过的流程");
    expect(container.querySelector("[data-workflow-node-state]")).toBeNull();
    expect(container.querySelector('[data-workflow-run-snapshot-mismatch="true"]')).not.toBeNull();
  });

  it("运行启动时冻结的定义与现在的文件不同（旧版定义）时也不着色", async () => {
    const definition = createStarterWorkflow(1_000, WORKFLOW_ID);
    // 冻结快照是旧版：节点标题被改过（内容指纹不同 = 另一版定义）。
    const frozen = updateWorkflowNode(definition, "n1", { title: "旧版规划" });
    const run = twoStepRun();
    const server = createServer({ definitions: [definition], runs: [run], frozen: { "run-1": frozen } });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[summarize(run)]} ownerSessionId="owner-1" api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    await flush();
    expect(container.querySelector("[data-workflow-node-state]")).toBeNull();
    expect(container.querySelector('[data-workflow-run-snapshot-mismatch="true"]')).not.toBeNull();
  });

  it("别的 owner 的运行既不着色也不回读（分屏各看各的）", async () => {
    const definition = createStarterWorkflow(1_000, WORKFLOW_ID);
    const run = twoStepRun({ ownerSessionId: "owner-2" });
    const server = createServer({ definitions: [definition], runs: [run] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[summarize(run)]} ownerSessionId="owner-1" api={server.api} />);
    await flush();
    click('[data-control="workflow-open"]');
    await flush();
    await flush();
    expect(server.sent.some((command) => command.type === "workflow.run.get")).toBe(false);
    expect(container.querySelector("[data-workflow-node-state]")).toBeNull();
  });
});

describe("工作流中心：完整记录分页（按 executionId，不串轮）", () => {
  const WORKFLOW_ID = "wf-00000000-0000-4000-8000-000000000001";

  function message(id: string, text: string): ChatMessage {
    return { id, role: "assistant", timestamp: 1, blocks: [{ type: "text", text }] };
  }

  function retriedRun(): WorkflowRun {
    return sampleRun({
      workflowId: WORKFLOW_ID,
      executions: [
        { executionId: "ex-1", nodeId: "n2", nodeTitle: "实施", attempt: 1, status: "completed" },
        { executionId: "ex-2", nodeId: "n2", nodeTitle: "实施", attempt: 2, status: "running" }
      ],
      currentAttempt: 2
    });
  }

  it("首屏一页，加载更多按同一 executionId 的游标追加；换一轮重新从头读", async () => {
    const server = createServer({
      runs: [retriedRun()],
      transcripts: {
        "ex-1": [
          { messages: [message("a-1", "第一轮第一页")] },
          { messages: [message("a-2", "第一轮第二页")] }
        ],
        "ex-2": [{ messages: [message("b-1", "第二轮唯一一页")] }]
      }
    });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} initialRunId="run-1" api={server.api} />);
    await flush();
    click('[data-execution-id="ex-1"]');
    click('[data-control="workflow-run-content-transcript"]');
    await flush();
    expect(container.textContent).toContain("第一轮第一页");
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).not.toBeNull();

    click('[aria-label="加载更多完整记录"]');
    await flush();
    expect(container.textContent).toContain("第一轮第一页");
    expect(container.textContent).toContain("第一轮第二页");
    const transcriptCommands = server.sent.filter((command) => command.type === "workflow.node.get" && (command as Extract<RuntimeCommand, { type: "workflow.node.get" }>).content === "transcript") as Extract<RuntimeCommand, { type: "workflow.node.get" }>[];
    expect(transcriptCommands.map((command) => `${command.executionId}:${command.cursor ?? "start"}`)).toEqual(["ex-1:start", "ex-1:1"]);
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).toBeNull();

    // 换第二轮：游标不能沿用 ex-1 的，必须从第一页重新读，也不能混进上一轮的消息。
    click('[data-execution-id="ex-2"]');
    click('[data-control="workflow-run-content-transcript"]');
    await flush();
    const last = server.sent.filter((command) => command.type === "workflow.node.get").at(-1) as Extract<RuntimeCommand, { type: "workflow.node.get" }>;
    expect(last.executionId).toBe("ex-2");
    expect(last.cursor).toBeUndefined();
    expect(container.textContent).toContain("第二轮唯一一页");
    expect(container.textContent).not.toContain("第一轮第一页");
  });

  /** 把当前窗口填满（窗口满了之后「加载更多」入口会换成「查看后续记录」）。 */
  async function fillTranscriptWindow(maxClicks = 10): Promise<void> {
    for (let index = 0; index < maxClicks; index += 1) {
      const more = container.querySelector<HTMLElement>('[aria-label="加载更多完整记录"]');
      if (!more) return;
      act(() => more.click());
      await flush();
    }
    throw new Error("窗口一直没填满");
  }

  function transcriptReads(server: ReturnType<typeof createServer>): string[] {
    return server.sent
      .filter((command) => command.type === "workflow.node.get" && (command as Extract<RuntimeCommand, { type: "workflow.node.get" }>).content === "transcript")
      .map((command) => {
        const read = command as Extract<RuntimeCommand, { type: "workflow.node.get" }>;
        return `${read.executionId}:${read.cursor ?? "start"}`;
      });
  }

  it("窗口满 5 页后仍可「查看后续记录」推进游标：替换窗口，不停在第 5 页冒充完整", async () => {
    const pages = Array.from({ length: 9 }, (_, index) => ({ messages: [message(`p-${index}`, `第 ${index + 1} 页`)] }));
    const server = createServer({ runs: [retriedRun()], transcripts: { "ex-1": pages } });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} initialRunId="run-1" api={server.api} />);
    await flush();
    click('[data-execution-id="ex-1"]');
    click('[data-control="workflow-run-content-transcript"]');
    await flush();
    await fillTranscriptWindow();
    // 窗口满：窗口内「加载更多」收起，但换成推进窗口的入口——不能没有任何前进路径。
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).toBeNull();
    const note = container.querySelector('[data-workflow-transcript-window="full"]');
    expect(note?.textContent).toContain("当前窗口：第 1–5 页");
    expect(note?.textContent).toContain("这不是完整记录");
    expect(note?.textContent).toContain("后面还有内容没有显示");
    expect(container.textContent).toContain("第 5 页");
    expect(container.textContent).not.toContain("第 6 页");

    click('[aria-label="查看后续记录"]');
    await flush();
    // 从窗口末尾的 nextCursor 继续读，并且**替换**窗口：旧窗口内容移出，不无限堆积。
    expect(transcriptReads(server)).toEqual(["ex-1:start", "ex-1:1", "ex-1:2", "ex-1:3", "ex-1:4", "ex-1:5"]);
    expect(container.textContent).toContain("第 6 页");
    expect(container.textContent).not.toContain("第 1 页");
    expect(container.textContent).not.toContain("第 5 页");
    const partial = container.querySelector('[data-workflow-transcript-window="partial"]');
    expect(partial?.textContent).toContain("当前窗口：第 6 页");
    expect(partial?.textContent).toContain("前面第 1–5 页已移出窗口");
    expect(container.querySelector('[aria-label="查看上一窗口"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="从头查看完整记录"]')).not.toBeNull();
    // 新窗口没满：继续在窗口内「加载更多」（不是又一次推进窗口）。
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="查看后续记录"]')).toBeNull();
  });

  it("跨窗口读到末尾：明说已到记录末尾，并能上一窗口 / 从头回看", async () => {
    const pages = Array.from({ length: 9 }, (_, index) => ({ messages: [message(`p-${index}`, `第 ${index + 1} 页`)] }));
    const server = createServer({ runs: [retriedRun()], transcripts: { "ex-1": pages } });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} initialRunId="run-1" api={server.api} />);
    await flush();
    click('[data-execution-id="ex-1"]');
    click('[data-control="workflow-run-content-transcript"]');
    await flush();
    await fillTranscriptWindow();
    click('[aria-label="查看后续记录"]');
    await flush();
    // 第二个窗口把剩下的 6–9 页读完：末尾没有 nextCursor，就不给任何前进入口。
    await fillTranscriptWindow();
    expect(transcriptReads(server)).toEqual(["ex-1:start", "ex-1:1", "ex-1:2", "ex-1:3", "ex-1:4", "ex-1:5", "ex-1:6", "ex-1:7", "ex-1:8"]);
    const end = container.querySelector('[data-workflow-transcript-window="partial"]');
    expect(end?.textContent).toContain("当前窗口：第 6–9 页");
    expect(end?.textContent).toContain("已到记录末尾");
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).toBeNull();
    expect(container.querySelector('[aria-label="查看后续记录"]')).toBeNull();
    expect(container.textContent).toContain("第 9 页");

    // 上一窗口：按保存的窗口起点游标回到第一窗口（从头开始的那个窗口记作 "0"）。
    click('[aria-label="查看上一窗口"]');
    await flush();
    expect(transcriptReads(server).at(-1)).toBe("ex-1:0");
    expect(container.textContent).toContain("第 1 页");
    expect(container.querySelector("[data-workflow-transcript-window]")).toBeNull();
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="查看上一窗口"]')).toBeNull();
  });

  it("窗口回退栈有界：回退到栈底后上一窗口收起，「从头查看」永远回得到第一页", async () => {
    // 35 页 = 7 个 5 页窗口；回退栈只留最近 5 个窗口，最早的第 1 窗口会被丢弃。
    const pages = Array.from({ length: 35 }, (_, index) => ({ messages: [message(`p-${index}`, `第 ${index + 1} 页`)] }));
    const server = createServer({ runs: [retriedRun()], transcripts: { "ex-1": pages } });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} initialRunId="run-1" api={server.api} />);
    await flush();
    click('[data-execution-id="ex-1"]');
    click('[data-control="workflow-run-content-transcript"]');
    await flush();
    for (let window = 1; window < 7; window += 1) {
      await fillTranscriptWindow();
      click('[aria-label="查看后续记录"]');
      await flush();
    }
    // 第 7 个窗口：前面 6 个窗口的起点里只留得住最近 5 个。
    expect(container.textContent).toContain("第 31 页");
    for (let step = 0; step < 5; step += 1) {
      click('[aria-label="查看上一窗口"]');
      await flush();
    }
    // 回退到栈底（第 2 窗口起点）：上一窗口入口收起，但「从头查看」还在。
    expect(container.querySelector('[aria-label="查看上一窗口"]')).toBeNull();
    expect(container.querySelector('[aria-label="从头查看完整记录"]')).not.toBeNull();
    expect(container.textContent).toContain("第 6 页");
    click('[aria-label="从头查看完整记录"]');
    await flush();
    expect(container.textContent).toContain("第 1 页");
    expect(container.querySelector("[data-workflow-transcript-window]")).toBeNull();
    // 从头读是**不带游标**的第一页（与首次打开一致）。
    expect(transcriptReads(server).at(-1)).toBe("ex-1:start");
  });

  it("响应按字节截断时如实提示，不把「还有下一页」也说成截断", async () => {
    const server = createServer({
      runs: [retriedRun()],
      transcripts: {
        "ex-1": [
          { messages: [message("c-1", "第一页有下一条")], truncated: true },
          { messages: [message("c-2", "最后一页被截断")], truncated: true }
        ]
      }
    });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} initialRunId="run-1" api={server.api} />);
    await flush();
    click('[data-execution-id="ex-1"]');
    click('[data-control="workflow-run-content-transcript"]');
    await flush();
    // 后端在有 nextCursor 时也会置 truncated（表示还有更多），那不是消息被截断。
    expect(container.querySelector('[data-workflow-transcript-clipped="true"]')).toBeNull();
    click('[aria-label="加载更多完整记录"]');
    await flush();
    expect(container.textContent).toContain("最后一页被截断");
    expect(container.querySelector('[data-workflow-transcript-clipped="true"]')?.textContent).toContain("不是完整记录");
    expect(container.querySelector('[aria-label="加载更多完整记录"]')).toBeNull();
  });

  it("产物/记录缓存有界：读得太多就淘汰最久没用的那条", async () => {
    const executions = Array.from({ length: 8 }, (_, index) => ({
      executionId: `ex-${index + 1}`,
      nodeId: `n${index + 1}`,
      nodeTitle: `节点${index + 1}`,
      attempt: 1,
      status: "completed" as const
    }));
    const server = createServer({ runs: [sampleRun({ workflowId: WORKFLOW_ID, executions })] });
    render(<WorkflowCenter workspace={WORKSPACE} onClose={vi.fn()} runs={[]} initialRunId="run-1" api={server.api} />);
    await flush();
    // 依次读 7 个执行（超过上限 6）：最早的 ex-1 被淘汰。
    for (const execution of executions.slice(0, 7)) {
      click(`[data-execution-id="${execution.executionId}"]`);
      click('[data-control="workflow-run-content-artifact"]');
      await flush();
    }
    // 最新读过的 ex-7 仍在缓存里（不用重新请求就能看到）。
    click('[data-execution-id="ex-7"]');
    expect(container.textContent).toContain("产物正文");
    // 最早的 ex-1 已被淘汰：切回去只有「按需读取」的提示，不假装还有内容。
    click('[data-execution-id="ex-1"]');
    expect(container.textContent).toContain("产物与完整记录按需读取");
    expect(container.textContent).not.toContain("产物正文");
  });
});
