import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, AgentSessionEventListener, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, PermissionDecision } from "../shared/protocol.js";
import {
  WORKFLOW_CHILD_ABORT_GRACE_MS,
  createWorkflowChildExecutor,
  idleWorkflowChildCleanup,
  workflowChildSessionDirectory,
  type WorkflowChildAdapterOptions,
  type WorkflowChildCleanup,
  type WorkflowChildExecutionRequest,
  type WorkflowChildExecutor,
  type WorkflowChildLiveStatus,
  type WorkflowChildNodeConfig,
  type WorkflowChildPermissionRequest,
  type WorkflowChildSession,
  type WorkflowChildSessionContext,
  type WorkflowChildSessionCreated,
  type WorkflowChildSessionFactory
} from "./workflow-child.js";

/**
 * 节点执行适配器的编排单测：fake 子会话只替代 AgentSession 本身。真实 SDK 的创建
 * 配方、事件时序与落盘由 workflow-pi-integration.test.ts 用 faux provider 零网络
 * 覆盖。这里钉死的是「怎么收场、怎么清理」——正常完成、agent_end 不推进、最终
 * 错误/空输出、prompt 拒绝、preflight handled、abort、超时、权限拒绝、权限等待中
 * 停止，以及冻结配置与监听 / timer / 会话的释放。
 */

// ── 测试替身 ─────────────────────────────────────────────────────────────

type PromptOptionsLike = {
  expandPromptTemplates?: boolean;
  preflightResult?: (disposition: "handled" | "queued" | "started") => void;
};

type PromptBehavior = (child: FakeChild, text: string, options: PromptOptionsLike | undefined) => void | Promise<void>;

class FakeChild implements WorkflowChildSession {
  readonly listeners = new Set<AgentSessionEventListener>();
  readonly promptCalls: { text: string; options?: PromptOptionsLike }[] = [];
  /** prompt 被调用时监听器数量：必须 ≥1（先订阅再 prompt）。 */
  listenersAtPrompt = 0;
  abortCalls = 0;
  disposeCalls = 0;
  unsubscribeCalls = 0;
  /** 模拟「工具不退出」：abort 永远不 resolve。 */
  hangAbort = false;
  behavior?: PromptBehavior;

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.unsubscribeCalls += 1;
    };
  }

  async prompt(text: string, options?: PromptOptionsLike): Promise<void> {
    this.listenersAtPrompt = this.listeners.size;
    this.promptCalls.push({ text, ...(options === undefined ? {} : { options }) });
    await this.behavior?.(this, text, options);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.hangAbort) await new Promise<void>(() => undefined);
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** 可控的 AbortSignal 替身：能断言 abort 监听是否被解除。 */
class FakeSignal {
  aborted = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === "abort") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "abort") this.listeners.delete(listener);
  }

  throwIfAborted(): void {
    if (this.aborted) throw new Error("aborted");
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
  }

  asSignal(): AbortSignal {
    return this as unknown as AbortSignal;
  }
}

function assistantEvent(text: string, extra: { stopReason?: string; errorMessage?: string } = {}): AgentSessionEvent {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: extra.stopReason ?? "stop",
    ...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage })
  };
  return { type: "message_end", message: message as unknown as AgentMessage };
}

function userEvent(text: string): AgentSessionEvent {
  return { type: "message_end", message: { role: "user", content: text } as unknown as AgentMessage };
}

function agentEndEvent(): AgentSessionEvent {
  return { type: "agent_end", messages: [], willRetry: false };
}

function settledEvent(aborted = false): AgentSessionEvent {
  return { type: "agent_settled", aborted };
}

function nodeConfig(overrides: Partial<WorkflowChildNodeConfig> = {}): WorkflowChildNodeConfig {
  return {
    nodeId: "n1",
    source: "agent",
    model: { provider: "faux", id: "faux-1" },
    thinkingLevel: "medium",
    tools: ["read"],
    browserTools: false,
    systemPrompt: "你是节点执行者",
    ...overrides
  };
}

function nodeRequest(overrides: Partial<WorkflowChildExecutionRequest> = {}): WorkflowChildExecutionRequest {
  return {
    runId: "run-1",
    executionId: "exec-1",
    nodeId: "n1",
    nodeTitle: "实施",
    attempt: 1,
    config: nodeConfig(),
    prompt: "请实施这一步",
    ownerSessionId: "owner-1",
    ...overrides
  };
}

function agentProfile(): AgentProfile {
  return {
    id: "agent-1",
    name: "测试助手",
    description: "",
    systemPrompt: "你是测试助手",
    divMode: "auto",
    defaultThinkingLevel: "medium",
    tools: { read: true, bash: true, edit: true, write: true, powershell: false, grep: true, find: true, ls: true }
  };
}

interface PermissionRecorder {
  calls: { toolName: string; toolCallId: string; node: unknown }[];
  handler: (request: WorkflowChildPermissionRequest) => Promise<PermissionDecision>;
}

interface Harness {
  executor: WorkflowChildExecutor;
  child: FakeChild;
  statuses: WorkflowChildLiveStatus[];
  denials: { toolName: string; reason: string }[];
  contexts: WorkflowChildSessionContext[];
  permission: PermissionRecorder;
}

function makeHarness(options: {
  child?: FakeChild;
  createChildSession?: WorkflowChildSessionFactory;
  handler?: (request: { toolName: string; toolCallId: string }) => Promise<PermissionDecision>;
  nodeTimeoutMs?: number;
  abortGraceMs?: number;
  buildBrowserTools?: () => ToolDefinition[];
} = {}): Harness {
  const child = options.child ?? new FakeChild();
  const statuses: WorkflowChildLiveStatus[] = [];
  const denials: { toolName: string; reason: string }[] = [];
  const contexts: WorkflowChildSessionContext[] = [];
  const calls: PermissionRecorder["calls"] = [];
  const decide = options.handler ?? (() => Promise.resolve<PermissionDecision>("allow-once"));
  const permission: PermissionRecorder = {
    calls,
    handler: async (request) => {
      calls.push({ toolName: request.toolName, toolCallId: request.toolCallId, node: request.node });
      return await decide({ toolName: request.toolName, toolCallId: request.toolCallId });
    }
  };
  let sessionSeq = 0;
  const defaultFactory: WorkflowChildSessionFactory = async (context) => {
    contexts.push(context);
    sessionSeq += 1;
    const sessionFile = `/tmp/pi-desktop-workflow/child-${sessionSeq}.jsonl`;
    return {
      handle: child,
      sessionId: `child-session-${sessionSeq}`,
      sessionFile,
      dispose: () => child.dispose()
    };
  };
  const executor = createWorkflowChildExecutor({
    workspace: "C:/workspace",
    agentDir: "C:/agent",
    agent: agentProfile(),
    modelRuntime: {} as WorkflowChildAdapterOptions["modelRuntime"],
    requestPermission: permission.handler,
    ...(options.nodeTimeoutMs === undefined ? {} : { nodeTimeoutMs: options.nodeTimeoutMs }),
    ...(options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs }),
    ...(options.buildBrowserTools === undefined ? {} : { buildBrowserTools: options.buildBrowserTools }),
    createChildSession: options.createChildSession ?? defaultFactory
  });
  return { executor, child, statuses, denials, contexts, permission };
}

/** 把 onStatus / onDenied 记到 harness 上（运行器接线时也是这两个回调）。 */
function tracked(request: WorkflowChildExecutionRequest, harness: Harness): WorkflowChildExecutionRequest {
  return {
    ...request,
    onStatus: (status) => harness.statuses.push(status),
    onDenied: (info) => harness.denials.push(info)
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 正常路径 ─────────────────────────────────────────────────────────────

describe("workflow child adapter: 正常创建与收口", () => {
  it("先订阅再 prompt，只在 agent_settled 结算并保留换行", async () => {
    const harness = makeHarness();
    const text = "第一行\n\n  - 列表项\n```ts\nconst a = 1;\n```\n";
    harness.child.behavior = (child) => {
      child.emit(userEvent("请实施这一步"));
      child.emit(assistantEvent("中间过程"));
      child.emit(agentEndEvent());
    };
    const running = harness.executor(tracked(nodeRequest(), harness));
    await waitFor(() => harness.child.promptCalls.length === 1);
    // agent_end 只是底层 run 边界：此刻绝不能结算。
    let resolved = false;
    void running.then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);

    harness.child.emit(assistantEvent(text));
    harness.child.emit(settledEvent());

    const outcome = await running;
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe(text);
    expect(outcome.stopReason).toBe("stop");
    expect(outcome.startedAt).toBeGreaterThan(0);
    expect(outcome.endedAt).toBeGreaterThanOrEqual(outcome.startedAt);
    expect(outcome.sessionId).toBe("child-session-1");
    expect(outcome.sessionFile).toBe("/tmp/pi-desktop-workflow/child-1.jsonl");
    // 先订阅再 prompt：监听器在 prompt 时已经挂好。
    expect(harness.child.listenersAtPrompt).toBe(1);
    expect(harness.child.promptCalls[0]?.text).toBe("请实施这一步");
    expect(harness.child.promptCalls[0]?.options?.expandPromptTemplates).toBe(false);
    expect(harness.statuses).toEqual(["starting", "running"]);
    expect(outcome.cleanup).toEqual({
      confirmed: true,
      listenersReleased: true,
      timersCleared: true,
      sessionDisposed: true,
      abortAcknowledged: true,
      errors: []
    });
    expect(harness.child.unsubscribeCalls).toBe(1);
    expect(harness.child.disposeCalls).toBe(1);
    expect(harness.child.listeners.size).toBe(0);
    expect(harness.child.abortCalls).toBe(0);
  });

  it("每次执行用独立的会话 id 与 sessionFile（返工每轮不复用）", async () => {
    const harness = makeHarness();
    harness.child.behavior = (child, text) => {
      child.emit(assistantEvent(`done:${text}`));
      child.emit(settledEvent());
    };
    const first = await harness.executor(tracked(nodeRequest({ attempt: 1 }), harness));
    const second = await harness.executor(tracked(nodeRequest({ attempt: 2, executionId: "exec-2" }), harness));
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(first.text).toBe("done:请实施这一步");
    expect(first.sessionId).toBe("child-session-1");
    expect(second.sessionId).toBe("child-session-2");
    expect(first.sessionFile).not.toBe(second.sessionFile);
    expect(harness.child.disposeCalls).toBe(2);
  });

  it("冻结配置是副本：调用方事后修改不影响本次执行", async () => {
    const harness = makeHarness();
    const config = nodeConfig({ tools: ["read"] });
    const running = harness.executor(tracked(nodeRequest({ config }), harness));
    await waitFor(() => harness.contexts.length === 1 && harness.child.listeners.size === 1);
    // 运行开始后再改调用方对象：不得影响已冻结的本次执行。
    config.tools.push("write");
    config.browserTools = true;
    config.model.id = "other-model";
    harness.child.emit(assistantEvent("ok"));
    harness.child.emit(settledEvent());
    const outcome = await running;
    expect(outcome.status).toBe("completed");
    const frozen = harness.contexts[0]!.request.config;
    expect(frozen.tools).toEqual(["read"]);
    expect(frozen.browserTools).toBe(false);
    expect(frozen.model.id).toBe("faux-1");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.model)).toBe(true);
  });
});

// ── 失败与停止 ───────────────────────────────────────────────────────────

describe("workflow child adapter: 失败与停止的收场", () => {
  it("最终 assistant 是错误时即便前面有文本也判失败", async () => {
    const harness = makeHarness();
    harness.child.behavior = (child) => {
      child.emit(assistantEvent("看起来完成了"));
      child.emit(assistantEvent("", { stopReason: "error", errorMessage: "503 Service Unavailable" }));
      child.emit(settledEvent());
    };
    const outcome = await harness.executor(tracked(nodeRequest(), harness));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("503 Service Unavailable");
    expect(outcome.text).toBeUndefined();
    expect(outcome.cleanup.confirmed).toBe(true);
  });

  it("空输出与没有 assistant 消息都判失败", async () => {
    const empty = makeHarness();
    empty.child.behavior = (child) => {
      child.emit(assistantEvent("   \n\t "));
      child.emit(settledEvent());
    };
    const emptyOutcome = await empty.executor(tracked(nodeRequest(), empty));
    expect(emptyOutcome.status).toBe("failed");
    expect(emptyOutcome.error).toContain("空输出");

    const missing = makeHarness();
    missing.child.behavior = (child) => {
      child.emit(userEvent("请实施这一步"));
      child.emit(settledEvent());
    };
    const missingOutcome = await missing.executor(tracked(nodeRequest(), missing));
    expect(missingOutcome.status).toBe("failed");
    expect(missingOutcome.error).toContain("assistant");
  });

  it("settled 标记 aborted 时按中性 stopped 收场", async () => {
    const harness = makeHarness();
    harness.child.behavior = (child) => {
      child.emit(assistantEvent("", { stopReason: "aborted", errorMessage: "This operation was aborted" }));
      child.emit(settledEvent(true));
    };
    const outcome = await harness.executor(tracked(nodeRequest(), harness));
    expect(outcome.status).toBe("stopped");
    expect(outcome.error).toBeUndefined();
    expect(outcome.stoppedReason).toContain("中止");
    expect(outcome.cleanup.confirmed).toBe(true);
  });

  it("prompt 被拒绝时立刻失败，不等不会来的 settle", async () => {
    const harness = makeHarness();
    harness.child.behavior = () => {
      throw new Error("Agent is already processing.");
    };
    const outcome = await harness.executor(tracked(nodeRequest(), harness));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("already processing");
    expect(outcome.cleanup.confirmed).toBe(true);
    // prompt 失败也要拿 abort 证据：dispose 本身不能证明工具已停。
    expect(harness.child.abortCalls).toBe(1);
    expect(harness.child.disposeCalls).toBe(1);
    expect(outcome.retryCleanup).toBeUndefined();
    expect(outcome.cleanupSettled).toBeUndefined();
  });

  it("preflight handled 时判失败（节点从未真正开始）", async () => {
    const harness = makeHarness();
    harness.child.behavior = (child, _text, options) => {
      options?.preflightResult?.("handled");
      child.emit(settledEvent());
    };
    const outcome = await harness.executor(tracked(nodeRequest(), harness));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("preflight handled");
    // 同样要求 abort 证据（空闲会话的 abort 立即返回）。
    expect(harness.child.abortCalls).toBe(1);
    expect(outcome.cleanup.confirmed).toBe(true);
  });

  it("创建失败返回可诊断失败，且清理报告为已确认", async () => {
    const harness = makeHarness({
      createChildSession: async () => {
        throw new Error("节点模型不可用：faux/nope");
      }
    });
    const outcome = await harness.executor(tracked(nodeRequest(), harness));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("节点模型不可用");
    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.cleanup).toEqual(idleWorkflowChildCleanup());
  });

  it("abort 走 §7.3 顺序：先 abort，再解监听 / 清 timer / dispose", async () => {
    const harness = makeHarness();
    const signal = new FakeSignal();
    const order: string[] = [];
    const abortSpy = harness.child.abort.bind(harness.child);
    harness.child.abort = async () => {
      order.push("abort");
      await abortSpy();
    };
    harness.child.behavior = (child) => {
      order.push(`prompt:${child.listeners.size}`);
    };
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await waitFor(() => harness.child.promptCalls.length === 1);
    expect(signal.listenerCount).toBe(1);
    signal.abort();
    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(outcome.stoppedReason).toContain("停止");
    expect(order).toEqual(["prompt:1", "abort"]);
    expect(harness.child.abortCalls).toBe(1);
    expect(harness.child.unsubscribeCalls).toBe(1);
    expect(harness.child.disposeCalls).toBe(1);
    expect(signal.listenerCount).toBe(0);
    expect(outcome.cleanup.confirmed).toBe(true);
  });

  it("停止与完成竞争只结算一次，事后 abort 不再触发清理", async () => {
    const harness = makeHarness();
    const signal = new FakeSignal();
    harness.child.behavior = (child) => {
      child.emit(assistantEvent("完成"));
      child.emit(settledEvent());
    };
    const outcome = await harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    expect(outcome.status).toBe("completed");
    signal.abort();
    await tick();
    expect(harness.child.abortCalls).toBe(0);
    expect(harness.child.disposeCalls).toBe(1);
    expect(signal.listenerCount).toBe(0);
  });

  it("abort 在创建飞行中到达：仍回收随后出现的会话且不再 prompt", async () => {
    const child = new FakeChild();
    let releaseFactory!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const harness = makeHarness({
      child,
      createChildSession: async (): Promise<WorkflowChildSessionCreated> => {
        await gate;
        return { handle: child, sessionId: "child-late", sessionFile: "/tmp/late.jsonl", dispose: () => child.dispose() };
      }
    });
    const signal = new FakeSignal();
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await tick();
    signal.abort();
    releaseFactory();
    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(outcome.sessionId).toBe("child-late");
    expect(child.disposeCalls).toBe(1);
    expect(outcome.cleanup.confirmed).toBe(true);
    expect(child.promptCalls).toHaveLength(0);
  });

  it("创建迟迟不返回时如实报未确认，并在它迟到收场时兜底回收", async () => {
    const child = new FakeChild();
    let releaseFactory!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const harness = makeHarness({
      child,
      abortGraceMs: 30,
      createChildSession: async (): Promise<WorkflowChildSessionCreated> => {
        await gate;
        return { handle: child, sessionId: "child-late", sessionFile: "/tmp/late.jsonl", dispose: () => child.dispose() };
      }
    });
    const signal = new FakeSignal();
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await tick();
    signal.abort();
    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(outcome.cleanup.confirmed).toBe(false);
    expect(outcome.cleanup.sessionDisposed).toBe(false);
    expect(outcome.cleanup.errors.join("\n")).toContain("会话创建未在");
    // 创建随后成功：必须被回收，不能留下无主会话。
    expect(child.disposeCalls).toBe(0);
    releaseFactory();
    await waitFor(() => child.disposeCalls === 1);
    expect(child.promptCalls).toHaveLength(0);
  });

  it("迟到创建成功：cleanupSettled 推送已确认的最终清理（运行器据此放锁）", async () => {
    const child = new FakeChild();
    let releaseFactory!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const harness = makeHarness({
      child,
      abortGraceMs: 30,
      createChildSession: async (): Promise<WorkflowChildSessionCreated> => {
        await gate;
        return { handle: child, sessionId: "child-late", sessionFile: "/tmp/late.jsonl", dispose: () => child.dispose() };
      }
    });
    const signal = new FakeSignal();
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await tick();
    signal.abort();
    const outcome = await running;
    expect(outcome.cleanup.confirmed).toBe(false);
    expect(outcome.cleanupSettled).toBeInstanceOf(Promise);
    let settled: WorkflowChildCleanup | undefined;
    void outcome.cleanupSettled!.then((cleanup) => {
      settled = cleanup;
    });
    releaseFactory();
    await waitFor(() => settled !== undefined && settled.confirmed);
    expect(settled).toMatchObject({
      confirmed: true,
      listenersReleased: true,
      timersCleared: true,
      sessionDisposed: true,
      abortAcknowledged: true,
      errors: []
    });
    expect(child.disposeCalls).toBe(1);
    expect(child.promptCalls).toHaveLength(0);
    expect(signal.listenerCount).toBe(0);
  });

  it("迟到创建最终失败：没有会话可回收，迟到确认同样送达", async () => {
    let rejectFactory!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => {
      rejectFactory = reject;
    });
    const harness = makeHarness({
      abortGraceMs: 30,
      createChildSession: async (): Promise<WorkflowChildSessionCreated> => {
        await gate;
        throw new Error("model runtime gone");
      }
    });
    const signal = new FakeSignal();
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await tick();
    signal.abort();
    const outcome = await running;
    expect(outcome.cleanup.confirmed).toBe(false);
    rejectFactory(new Error("model runtime gone"));
    const settled = await outcome.cleanupSettled!;
    expect(settled.confirmed).toBe(true);
    expect(settled.errors).toEqual([]);
  });

  it("abort 超过宽限后才收场：迟到确认经 cleanupSettled 推送", async () => {
    const harness = makeHarness({ abortGraceMs: 30 });
    const signal = new FakeSignal();
    let releaseAbort!: () => void;
    harness.child.abort = async () => {
      harness.child.abortCalls += 1;
      await new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
    };
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await waitFor(() => harness.child.promptCalls.length === 1);
    signal.abort();
    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(outcome.cleanup.confirmed).toBe(false);
    expect(outcome.cleanup.abortAcknowledged).toBe(false);
    expect(typeof outcome.retryCleanup).toBe("function");
    expect(outcome.cleanupSettled).toBeInstanceOf(Promise);
    // 迟到的 abort 收场：推送通道必须翻成已确认。
    let settled: WorkflowChildCleanup | undefined;
    void outcome.cleanupSettled!.then((cleanup) => {
      settled = cleanup;
    });
    releaseAbort();
    await waitFor(() => settled !== undefined && settled.confirmed);
    expect(settled).toMatchObject({ confirmed: true, abortAcknowledged: true, sessionDisposed: true, errors: [] });
    expect(harness.child.abortCalls).toBe(1);
    expect(harness.child.disposeCalls).toBe(1);
    expect(signal.listenerCount).toBe(0);
    expect(harness.child.listeners.size).toBe(0);
  });

  it("retryCleanup 有界且幂等：卡死的 abort 不无限等，也不重复 abort/dispose", async () => {
    const harness = makeHarness({ abortGraceMs: 30 });
    const signal = new FakeSignal();
    harness.child.hangAbort = true;
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await waitFor(() => harness.child.promptCalls.length === 1);
    signal.abort();
    const outcome = await running;
    expect(outcome.cleanup.confirmed).toBe(false);
    const startedAt = Date.now();
    const first = await outcome.retryCleanup!();
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(2_000);
    expect(first.confirmed).toBe(false);
    expect(first.abortAcknowledged).toBe(false);
    const second = await outcome.retryCleanup!();
    expect(second.confirmed).toBe(false);
    // 幂等：重试不重复 abort、不二次 dispose。
    expect(harness.child.abortCalls).toBe(1);
    expect(harness.child.disposeCalls).toBe(1);
    expect(signal.listenerCount).toBe(0);
  });

  it("会话回收暂时失败可经 retryCleanup 重试成功", async () => {
    const harness = makeHarness();
    const signal = new FakeSignal();
    const child = harness.child;
    let disposeFailures = 1;
    child.dispose = () => {
      child.disposeCalls += 1;
      if (disposeFailures > 0) {
        disposeFailures -= 1;
        throw new Error("EBUSY: session busy");
      }
    };
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await waitFor(() => child.promptCalls.length === 1);
    signal.abort();
    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(outcome.cleanup.confirmed).toBe(false);
    expect(outcome.cleanup.sessionDisposed).toBe(false);
    expect(outcome.cleanup.errors.join("\n")).toContain("会话回收失败");
    const retried = await outcome.retryCleanup!();
    expect(retried.confirmed).toBe(true);
    expect(retried.errors).toEqual([]);
    expect(child.disposeCalls).toBe(2);
  });

  it("abort 未确认时如实报告未确认（不能假报停止完成）", async () => {
    const harness = makeHarness({ abortGraceMs: 30 });
    const signal = new FakeSignal();
    harness.child.hangAbort = true;
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await waitFor(() => harness.child.promptCalls.length === 1);
    signal.abort();
    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(outcome.cleanup.confirmed).toBe(false);
    expect(outcome.cleanup.abortAcknowledged).toBe(false);
    expect(outcome.cleanup.timersCleared).toBe(true);
    expect(outcome.cleanup.sessionDisposed).toBe(true);
    expect(outcome.cleanup.errors.join("\n")).toContain("确认停止");
  });

  it("超时按 failed 收场并 abort 当前 child", async () => {
    const harness = makeHarness({ nodeTimeoutMs: 40 });
    const outcome = await harness.executor(tracked(nodeRequest(), harness));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("超时");
    expect(harness.child.abortCalls).toBe(1);
    expect(outcome.cleanup.confirmed).toBe(true);
    expect(harness.child.disposeCalls).toBe(1);
  });

  it("创建前已 abort 或消息为空时不创建会话", async () => {
    const harness = makeHarness();
    const signal = new FakeSignal();
    signal.aborted = true;
    const aborted = await harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    expect(aborted.status).toBe("stopped");
    expect(harness.contexts).toHaveLength(0);

    const empty = await harness.executor(tracked(nodeRequest({ prompt: "  \n " }), harness));
    expect(empty.status).toBe("failed");
    expect(empty.error).toContain("为空");
    expect(harness.contexts).toHaveLength(0);
  });

  it("拒绝不合法的路径分量（防越界目录）", async () => {
    const harness = makeHarness();
    await expect(harness.executor(tracked(nodeRequest({ runId: "../escape" }), harness))).rejects.toThrow(/runId/u);
    await expect(harness.executor(tracked(nodeRequest({ ownerSessionId: "a/b" }), harness))).rejects.toThrow(/ownerSessionId/u);
    await expect(harness.executor(tracked(nodeRequest({ attempt: 0 }), harness))).rejects.toThrow(/attempt/u);
  });
});

// ── 权限 ─────────────────────────────────────────────────────────────────

describe("workflow child adapter: 权限", () => {
  it("权限等待中可以停止：上报 waiting_permission，停止后清理已确认", async () => {
    const harness = makeHarness({ handler: () => new Promise<PermissionDecision>(() => undefined) });
    const signal = new FakeSignal();
    let permissionStarted = false;
    harness.child.behavior = () => {
      permissionStarted = true;
      void harness.contexts[0]!.requestPermission("bash", { command: "npm test" }, "call-1");
    };
    const running = harness.executor(tracked(nodeRequest({ signal: signal.asSignal() }), harness));
    await waitFor(() => permissionStarted && harness.statuses.includes("waiting_permission"));
    expect(harness.statuses).toEqual(["starting", "running", "waiting_permission"]);
    signal.abort();
    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(harness.child.abortCalls).toBe(1);
    expect(outcome.cleanup.confirmed).toBe(true);
  });

  it("权限被拒绝记为技术失败，模型换个工具继续也不算成功", async () => {
    const harness = makeHarness({ handler: async () => "deny" });
    harness.child.behavior = async (child) => {
      const decision = await harness.contexts[0]!.requestPermission("bash", { command: "rm -rf build" }, "call-1");
      expect(decision).toBe("deny");
      // 模型绕道：换了另一个工具并返回了「成功」文本。
      child.emit(assistantEvent("已经用别的方式完成"));
      child.emit(settledEvent());
    };
    const outcome = await harness.executor(tracked(nodeRequest(), harness));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("权限被拒绝");
    expect(outcome.text).toBeUndefined();
    expect(harness.denials).toHaveLength(1);
    expect(harness.denials[0]?.toolName).toBe("bash");
  });

  it("权限请求带节点归属（runId/nodeId/attempt/nodeTitle）", async () => {
    const harness = makeHarness();
    harness.child.behavior = async (child) => {
      await harness.contexts[0]!.requestPermission("edit", { path: "a.ts" }, "call-9");
      child.emit(assistantEvent("ok"));
      child.emit(settledEvent());
    };
    await harness.executor(tracked(nodeRequest({ attempt: 2, nodeTitle: "审查" }), harness));
    expect(harness.permission.calls[0]?.node).toEqual({
      runId: "run-1",
      nodeId: "n1",
      nodeTitle: "审查",
      attempt: 2
    });
  });
});

// ── 目录与常量 ───────────────────────────────────────────────────────────

describe("workflow child adapter: 磁盘布局", () => {
  it("会话目录按 owner/run/attempt/node 分层，且不写进用户仓库", () => {
    const directory = workflowChildSessionDirectory(
      { agentDir: "C:/agent", agent: agentProfile() },
      { ownerSessionId: "owner-1", runId: "run-1", attempt: 3, nodeId: "n1" }
    );
    expect(directory.replaceAll("\\", "/")).toContain(
      "chatanytime-sessions/agent-1/delegations/workflows/owner-1/run-1/a3/n1"
    );
  });

  it("abort 宽限常量可用于运行器的等待上限", () => {
    expect(WORKFLOW_CHILD_ABORT_GRACE_MS).toBeGreaterThan(0);
  });
});
