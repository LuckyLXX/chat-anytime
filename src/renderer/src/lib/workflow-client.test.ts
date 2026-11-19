import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCommand, RuntimeMessage, WorkflowResult, WorkflowRunSummary } from "../../../shared/protocol";
import { belongsToOwner, loadWorkflowNode, nextWorkflowRequestId, requestWorkflow, stopWorkflowRun, subscribeWorkflowRuns, workflowFailureMessage, type WorkflowApi } from "./workflow-client";

afterEach(() => vi.useRealTimers());

function fakeApi(onSend?: (command: RuntimeCommand) => void): { api: WorkflowApi; sent: RuntimeCommand[]; emit(message: RuntimeMessage): void; listenerCount(): number } {
  const listeners = new Set<(message: RuntimeMessage) => void>();
  const sent: RuntimeCommand[] = [];
  return {
    api: {
      send: (command) => {
        sent.push(command);
        onSend?.(command);
        return Promise.resolve();
      },
      onRuntimeMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    sent,
    emit: (message) => { for (const listener of [...listeners]) listener(message); },
    listenerCount: () => listeners.size
  };
}

function success<T extends WorkflowResult["op"]>(requestId: string, op: T, result: unknown): RuntimeMessage {
  return { type: "workflow.result", result: { requestId, ok: true, op, result } as WorkflowResult } as RuntimeMessage;
}

describe("工作流请求封装", () => {
  it("先订阅再发：send 内部同步派发的回执也能收到（不会永久停在读取中）", async () => {
    const harness = fakeApi((command) => {
      // 极端时序：回执在 send 的 Promise 结算之前就到达。
      harness.emit(success((command as { requestId: string }).requestId, "workflow.stop", { runId: "run-1", status: "stopping" }));
    });
    const outcome = await requestWorkflow(harness.api, { type: "workflow.stop", requestId: "r1", runId: "run-1" });
    expect(outcome).toEqual({ ok: true, result: { runId: "run-1", status: "stopping" } });
    expect(harness.listenerCount()).toBe(0);
  });

  it("只认自己的 requestId，其他人的回执不会提前结算", async () => {
    const harness = fakeApi();
    const outcome = requestWorkflow(harness.api, { type: "workflow.stop", requestId: "r2", runId: "run-2" });
    harness.emit(success("other", "workflow.stop", { runId: "run-9", status: "stopped" }));
    expect(harness.listenerCount()).toBe(1);
    harness.emit(success("r2", "workflow.stop", { runId: "run-2", status: "stopped" }));
    await expect(outcome).resolves.toEqual({ ok: true, result: { runId: "run-2", status: "stopped" } });
    expect(harness.listenerCount()).toBe(0);
  });

  it("失败回执保留 utility 的错误码与节点诊断", async () => {
    const harness = fakeApi();
    const outcome = requestWorkflow(harness.api, { type: "workflow.stop", requestId: "r3", runId: "run-3" });
    harness.emit({
      type: "workflow.result",
      result: {
        requestId: "r3",
        op: "workflow.stop",
        ok: false,
        code: "conflict",
        errors: [{ code: "conflict", message: "工作流已被其他操作修改" }, { code: "cycle", message: "普通依赖边不能形成环" }, { code: "extra", message: "第三条" }]
      }
    });
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("conflict");
    expect(workflowFailureMessage(result)).toBe("工作流已被其他操作修改；普通依赖边不能形成环；第三条");
  });

  it("超时回执给可读错误并释放订阅", async () => {
    vi.useFakeTimers();
    const harness = fakeApi();
    const outcome = requestWorkflow(harness.api, { type: "workflow.stop", requestId: "r4", runId: "run-4" }, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await outcome;
    expect(result).toMatchObject({ ok: false, code: "timeout" });
    expect(harness.listenerCount()).toBe(0);
  });

  it("主进程转发失败立即回报 transport，不会等到超时", async () => {
    const harness = fakeApi();
    const outcome = requestWorkflow(harness.api, { type: "workflow.stop", requestId: "r5", runId: "run-5" });
    expect(harness.sent).toHaveLength(1);
    harness.emit({ type: "workflow.result", result: { requestId: "r5", op: "workflow.stop", ok: false, code: "io", errors: [] } });
    await expect(outcome).resolves.toMatchObject({ ok: false, code: "io" });
    const failing: WorkflowApi = { send: () => Promise.reject(new Error("运行时不可用")), onRuntimeMessage: () => () => undefined };
    await expect(requestWorkflow(failing, { type: "workflow.stop", requestId: "r6", runId: "run-6" })).resolves.toMatchObject({ ok: false, code: "transport", errors: [{ message: "运行时不可用" }] });
  });

  it("回执 op 与请求不一致时按失败处理（防止串号回执把别的结果当成本次结果）", async () => {
    const harness = fakeApi();
    const outcome = requestWorkflow(harness.api, { type: "workflow.stop", requestId: "r7", runId: "run-7" });
    harness.emit(success("r7", "workflow.run", { runId: "run-7", status: "running" }));
    await expect(outcome).resolves.toMatchObject({ ok: false, code: "op-mismatch" });
  });

  it("命令薄封装带上真实参数，requestId 每次唯一", async () => {
    const harness = fakeApi();
    void stopWorkflowRun(harness.api, "run-8");
    void loadWorkflowNode(harness.api, "run-8", "exec-1", "artifact");
    expect(harness.sent[0]).toMatchObject({ type: "workflow.stop", runId: "run-8" });
    expect(harness.sent[1]).toMatchObject({ type: "workflow.node.get", runId: "run-8", executionId: "exec-1", content: "artifact" });
    expect((harness.sent[0] as { requestId: string }).requestId).not.toBe((harness.sent[1] as { requestId: string }).requestId);
    expect(nextWorkflowRequestId("x")).not.toBe(nextWorkflowRequestId("x"));
  });
});

describe("运行摘要订阅与归属过滤", () => {
  it("subscribeWorkflowRuns 只透传 workflow.runs，退订后不再回调", () => {
    const harness = fakeApi();
    const seen: string[] = [];
    const unsubscribe = subscribeWorkflowRuns(harness.api, (snapshot) => seen.push(`${snapshot.epoch}:${snapshot.revision}`));
    harness.emit({ type: "workflow.runs", snapshot: { epoch: "e1", revision: 2, runs: [] } });
    harness.emit({ type: "workflow.result", result: { requestId: "x", op: "workflow.sync", ok: false, code: "x", errors: [] } });
    unsubscribe();
    harness.emit({ type: "workflow.runs", snapshot: { epoch: "e1", revision: 3, runs: [] } });
    expect(seen).toEqual(["e1:2"]);
  });

  it("belongsToOwner：无 owner 时不过滤（历史视图），有 owner 时严格比对", () => {
    const run = { runId: "run-1", ownerSessionId: "owner-a" } as WorkflowRunSummary;
    expect(belongsToOwner(run, undefined)).toBe(true);
    expect(belongsToOwner(run, "owner-a")).toBe(true);
    expect(belongsToOwner(run, "owner-b")).toBe(false);
  });
});
