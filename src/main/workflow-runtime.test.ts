import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowDefinition, WorkflowNode } from "../shared/workflow.js";
import { idleWorkflowChildCleanup, type WorkflowChildCleanup, type WorkflowChildExecutionRequest, type WorkflowChildOutcome } from "./workflow-child.js";
import { createWorkflowCoordinator, type WorkflowCoordinator } from "./workflow-coordinator.js";
import { WorkflowRunStore } from "./workflow-run-store.js";
import { buildWorkflowNodeMessage, WorkflowRuntime, type WorkflowRuntimeOptions } from "./workflow-runtime.js";

let root: string;
let workspace: string;
let store: WorkflowRunStore;
const calls: WorkflowChildExecutionRequest[] = [];
function node(id: string, kind: WorkflowNode["kind"] = "task"): WorkflowNode {
  return { id, title: id, kind, prompt: "执行 {{input}} {{attempt}}", position: { x: 0, y: 0 }, exec: { kind: "agent" } };
}
function workflow(maxAttempts = 3): WorkflowDefinition {
  return { version: 1, id: "wf-test", name: "测试", revision: 1, createdAt: 1, updatedAt: 1,
    nodes: [node("plan"), node("work"), node("gate", "gate"), node("output", "output")],
    edges: [{ id: "e1", from: "plan", to: "work" }, { id: "e2", from: "work", to: "gate" }, { id: "e3", from: "gate", to: "output" }],
    rework: { entryNodeId: "work", gateNodeId: "gate", maxAttempts } };
}
function outcome(text: string, extra: Partial<WorkflowChildOutcome> = {}): WorkflowChildOutcome {
  return { status: "completed", startedAt: 1, endedAt: 2, text, cleanup: idleWorkflowChildCleanup(), ...extra };
}
function unconfirmedCleanup(errors: string[]): WorkflowChildCleanup {
  return { ...idleWorkflowChildCleanup(), confirmed: false, abortAcknowledged: false, errors };
}
function runtime(execute: (request: WorkflowChildExecutionRequest) => Promise<WorkflowChildOutcome>, timeout?: number, overrides: Partial<WorkflowRuntimeOptions> = {}): WorkflowRuntime {
  return new WorkflowRuntime({ workspace, agentId: "default", ownerSessionId: "owner", store,
    coordinator: createWorkflowCoordinator({ agentDir: join(root, "agent") }),
    executeChild: async (request) => { calls.push(request); return execute(request); }, cancelPermissions: () => {}, runTimeoutMs: timeout, ...overrides });
}
function start(rt: WorkflowRuntime, definition = workflow()) {
  return rt.start({ definition, definitionHash: "hash", input: "任务", configs: definition.nodes.map((item) => ({
    nodeId: item.id, source: "agent", model: { provider: "p", id: "m" }, thinkingLevel: "off", tools: ["read"], systemPrompt: "静态身份"
  })) });
}
async function finished(rt: WorkflowRuntime): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (!rt.hasActiveRun()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("runtime did not finish");
}
async function settled(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 8)); }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-runtime-")); workspace = join(root, "workspace"); mkdirSync(workspace);
  store = new WorkflowRunStore({ agentDir: join(root, "agent") }); calls.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("WorkflowRuntime serial rework", () => {
  it("returns before node execution and completes on first pass", async () => {
    const rt = runtime(async (request) => outcome(request.nodeId === "gate" ? '{"verdict":"pass","reason":"ok"}' : "text"));
    const accepted = start(rt);
    expect(accepted.status).toBe("starting"); expect(calls).toHaveLength(0);
    await finished(rt);
    expect(rt.snapshot()?.status).toBe("completed");
    expect(calls.map((request) => request.nodeId)).toEqual(["plan", "work", "gate", "output"]);
  });

  it("retries the region and keeps P and S executions single", async () => {
    const rt = runtime(async (request) => outcome(request.nodeId === "gate" ? JSON.stringify({ verdict: request.attempt === 1 ? "retry" : "pass", reason: "反馈" }) : `${request.nodeId}-a${request.attempt}`));
    start(rt); await finished(rt);
    expect(rt.snapshot()?.status).toBe("completed");
    expect(calls.map((request) => `${request.nodeId}:${request.attempt}`)).toEqual(["plan:1", "work:1", "gate:1", "work:2", "gate:2", "output:2"]);
    expect(calls.find((request) => request.nodeId === "work" && request.attempt === 2)?.prompt).toContain("上一轮验收反馈");
    const secondGate = calls.find((request) => request.nodeId === "gate" && request.attempt === 2)!;
    expect(secondGate.prompt).toContain("work-a2");
    expect(new Set(rt.snapshot()?.executions.map((execution) => execution.executionId)).size).toBe(6);
  });

  it.each([1, 3])("rejects after %i total attempts and skips suffix", async (maxAttempts) => {
    const rt = runtime(async (request) => outcome(request.nodeId === "gate" ? '{"verdict":"retry","reason":"still failing"}' : "text"));
    start(rt, workflow(maxAttempts)); await finished(rt);
    expect(rt.snapshot()?.status).toBe("rejected");
    expect(calls.filter((request) => request.nodeId === "work")).toHaveLength(maxAttempts);
    expect(rt.snapshot()?.executions.find((execution) => execution.nodeId === "output")?.status).toBe("skipped");
  });

  it("fails invalid gate output without an extra format repair attempt", async () => {
    const rt = runtime(async () => outcome("not json")); start(rt); await finished(rt);
    expect(rt.snapshot()?.status).toBe("failed"); expect(calls).toHaveLength(3);
  });

  it("stops only the active run before starting another node", async () => {
    const rt = runtime((request) => new Promise((resolve) => request.signal!.addEventListener("abort", () => resolve(outcome("", { status: "stopped" })), { once: true })));
    const accepted = start(rt);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rt.stop(accepted.runId)?.status).toBe("stopping");
    await finished(rt);
    expect(rt.snapshot()?.status).toBe("stopped"); expect(calls).toHaveLength(1);
  });

  it("fails run timeout through child cleanup", async () => {
    const rt = runtime((request) => new Promise((resolve) => request.signal!.addEventListener("abort", () => resolve(outcome("", { status: "stopped" })), { once: true })), 10);
    start(rt); await finished(rt); expect(rt.snapshot()?.status).toBe("failed");
  });

  it("retains stopping and the workspace lock when cleanup is unconfirmed", async () => {
    const rt = runtime(async () => outcome("", { status: "stopped", cleanup: { ...idleWorkflowChildCleanup(), confirmed: false, abortAcknowledged: false, errors: ["tool busy"] } }));
    start(rt); await new Promise((resolve) => setTimeout(resolve, 15));
    expect(rt.snapshot()?.status).toBe("stopping"); expect(rt.hasActiveRun()).toBe(true);
    const contender = createWorkflowCoordinator({ agentDir: join(root, "agent") });
    expect(contender.acquire({ workspace, runId: "other" })).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("marks the waiting execution failed with an end timestamp on the unconfirmed path", async () => {
    const rt = runtime(async () => outcome("", { status: "stopped", cleanup: unconfirmedCleanup(["tool busy"]) }));
    start(rt); await settled();
    const execution = rt.snapshot()?.executions.find((item) => item.nodeId === "plan");
    expect(execution?.status).toBe("failed");
    expect(execution?.error).toContain("tool busy");
    expect(execution?.endedAt).toBe(2);
    // stopping 期间拒绝新 run（不鉴惜竞态重复受理）。
    expect(() => start(rt)).toThrow(/正在停止|已有工作流/u);
  });

  it("late cleanup confirmation finalizes the run and releases the lock", async () => {
    let settleCleanup!: (cleanup: WorkflowChildCleanup) => void;
    const cleanupSettled = new Promise<WorkflowChildCleanup>((resolve) => { settleCleanup = resolve; });
    const rt = runtime(async () => outcome("", {
      status: "stopped", cleanup: unconfirmedCleanup(["tool busy"]), cleanupSettled, retryCleanup: () => cleanupSettled
    }));
    start(rt); await settled();
    expect(rt.snapshot()?.status).toBe("stopping");
    expect(rt.hasActiveRun()).toBe(true);
    const contender = createWorkflowCoordinator({ agentDir: join(root, "agent") });
    expect(contender.acquire({ workspace, runId: "other" }).ok).toBe(false);
    settleCleanup(idleWorkflowChildCleanup());
    await finished(rt);
    expect(rt.snapshot()?.status).toBe("failed");
    expect(rt.snapshot()?.error).toContain("tool busy");
    expect(rt.snapshot()?.endedAt).toBeGreaterThan(0);
    expect(contender.acquire({ workspace, runId: "other" }).ok).toBe(true);
  });

  it("user stop first: late confirmation keeps the neutral stopped outcome", async () => {
    let settleCleanup!: (cleanup: WorkflowChildCleanup) => void;
    const cleanupSettled = new Promise<WorkflowChildCleanup>((resolve) => { settleCleanup = resolve; });
    const rt = runtime((request) => new Promise((resolve) =>
      request.signal!.addEventListener("abort", () => resolve(outcome("", {
        status: "stopped", cleanup: unconfirmedCleanup(["tool busy"]), cleanupSettled, retryCleanup: () => cleanupSettled
      })), { once: true })));
    const accepted = start(rt);
    await settled();
    rt.stop(accepted.runId);
    await settled();
    expect(rt.snapshot()?.status).toBe("stopping");
    settleCleanup(idleWorkflowChildCleanup());
    await finished(rt);
    expect(rt.snapshot()?.status).toBe("stopped");
    expect(rt.snapshot()?.error).toBeUndefined();
    expect(rt.hasActiveRun()).toBe(false);
    const contender = createWorkflowCoordinator({ agentDir: join(root, "agent") });
    expect(contender.acquire({ workspace, runId: "other" }).ok).toBe(true);
  });

  it("a second stop re-kicks the bounded late-cleanup retry", async () => {
    let attempts = 0;
    let confirmed = false;
    const rt = runtime(async () => outcome("", {
      status: "stopped",
      cleanup: unconfirmedCleanup(["tool busy"]),
      retryCleanup: () => {
        attempts += 1;
        return confirmed ? Promise.resolve(idleWorkflowChildCleanup()) : Promise.resolve(unconfirmedCleanup(["tool busy"]));
      }
    }), undefined, { lateCleanupWaitMs: 40 });
    start(rt); await settled();
    expect(rt.snapshot()?.status).toBe("stopping");
    expect(attempts).toBe(0);
    confirmed = true;
    rt.stop();
    await finished(rt);
    expect(attempts).toBe(1);
    expect(rt.snapshot()?.status).toBe("failed");
    expect(rt.hasActiveRun()).toBe(false);
  });

  it("temporary lock release failure keeps the run; another stop retries the release", async () => {
    const base = createWorkflowCoordinator({ agentDir: join(root, "agent") });
    let failFirstRelease = true;
    const coordinator: WorkflowCoordinator = {
      instanceId: base.instanceId,
      pid: base.pid,
      agentDir: base.agentDir,
      acquire: (request) => {
        const result = base.acquire(request);
        if (!result.ok) return result;
        const lease = result.lease;
        return {
          ok: true,
          lease: {
            key: lease.key,
            owner: lease.owner,
            release: () => {
              if (failFirstRelease) {
                failFirstRelease = false;
                return { ok: false, reason: "error", message: "EPERM: 锁文件被占用" };
              }
              return lease.release();
            }
          }
        };
      },
      release: (request) => base.release(request),
      inspect: (target) => base.inspect(target),
      releaseAll: () => base.releaseAll()
    };
    const rt = runtime(async () => outcome("text"), undefined, { coordinator, lateCleanupWaitMs: 40 });
    const accepted = start(rt);
    rt.stop(accepted.runId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 终态已写但锁未释放：诊断可见，运行保留（不能放行另一个写入 run）。
    expect(rt.snapshot()?.status).toBe("stopped");
    expect(rt.snapshot()?.error).toContain("释放工作区锁失败");
    expect(rt.hasActiveRun()).toBe(true);
    const contender = createWorkflowCoordinator({ agentDir: join(root, "agent") });
    expect(contender.acquire({ workspace, runId: "other" }).ok).toBe(false);
    // 再次 stop：重试释放成功。
    rt.stop(accepted.runId);
    await finished(rt);
    expect(rt.hasActiveRun()).toBe(false);
    expect(contender.acquire({ workspace, runId: "other" }).ok).toBe(true);
  });

  it("terminal persist failure is recorded as an explicit failed run with diagnostics", async () => {
    const flaky = new (class extends WorkflowRunStore {
      public failNextTerminalSave = true;
      override save(run: Parameters<WorkflowRunStore["save"]>[0]): void {
        if (this.failNextTerminalSave && (run.status === "completed" || run.status === "failed" || run.status === "rejected" || run.status === "stopped")) {
          this.failNextTerminalSave = false;
          throw new Error("EIO: 磁盘暂时不可用");
        }
        super.save(run);
      }
    })({ agentDir: join(root, "agent") });
    const rt = runtime(async (request) => outcome(request.nodeId === "gate" ? '{"verdict":"pass","reason":"ok"}' : "text"), undefined, { store: flaky });
    const accepted = start(rt);
    await finished(rt);
    expect(rt.snapshot()?.status).toBe("failed");
    expect(rt.snapshot()?.error).toContain("写入运行终态失败");
    expect(rt.snapshot()?.error).toContain("EIO");
    // 重写为 failed 的第二次落盘成功：磁盘记录是显式 failed，不是假 completed。
    expect(flaky.get(accepted.runId).status).toBe("failed");
    expect(flaky.get(accepted.runId).error).toContain("写入运行终态失败");
    expect(rt.hasActiveRun()).toBe(false);
    const contender = createWorkflowCoordinator({ agentDir: join(root, "agent") });
    expect(contender.acquire({ workspace, runId: "other" }).ok).toBe(true);
  });

  it("executor rejection settles as failed and releases the lock (no unhandled rejection)", async () => {
    const rt = runtime(async () => { throw new Error("adapter exploded"); });
    start(rt); await finished(rt);
    expect(rt.snapshot()?.status).toBe("failed");
    expect(rt.snapshot()?.executions.find((item) => item.nodeId === "plan")?.error).toContain("adapter exploded");
    const contender = createWorkflowCoordinator({ agentDir: join(root, "agent") });
    expect(contender.acquire({ workspace, runId: "other" }).ok).toBe(true);
  });

  it("stopAndWait waits only a finite window for stuck cleanup", async () => {
    const rt = runtime(async () => outcome("", { status: "stopped", cleanup: unconfirmedCleanup(["tool busy"]) }), undefined, { lateCleanupWaitMs: 60 });
    start(rt); await settled();
    const startedAt = Date.now();
    await expect(rt.dispose()).rejects.toThrow("尚未确认退出");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(rt.snapshot()?.status).toBe("stopping");
    expect(rt.hasActiveRun()).toBe(true);
    const contender = createWorkflowCoordinator({ agentDir: join(root, "agent") });
    expect(contender.acquire({ workspace, runId: "other" }).ok).toBe(false);
  });
});

describe("node input budget", () => {
  it("references oversized artifacts and rejects an unreadable file handoff", () => {
    const definition = workflow();
    const artifacts = new Map([["plan", { text: "a".repeat(9_000), path: "/artifact" }]]);
    expect(buildWorkflowNodeMessage(definition, "work", "input", 1, "", artifacts, true)).toContain("产物未内联");
    expect(() => buildWorkflowNodeMessage(definition, "work", "input", 1, "", artifacts, false)).toThrow("禁用了 read");
  });
});
