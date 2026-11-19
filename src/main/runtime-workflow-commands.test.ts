import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeMessage } from "../shared/protocol.js";
import type { WorkflowCommand, WorkflowRunsSnapshot, WorkflowSummary } from "../shared/workflow-protocol.js";
import type { WorkflowDefinition, WorkflowRun } from "../shared/workflow.js";
import {
  ACTIVE_WORKFLOW_STATUSES,
  createWorkflowCommandProcessor,
  createWorkflowRunsPublisher,
  matchWorkflowReference,
  MAX_WORKFLOW_NODE_GET_ARTIFACT_BYTES,
  projectResolvedNodeConfigs,
  TERMINAL_WORKFLOW_STATUSES,
  WorkflowCommandFailure,
  WorkflowRunHistory,
  workflowFailureResult,
  type WorkflowCommandDeps,
  type WorkflowOwnerBinding,
  type WorkflowRuntimeHandle
} from "./runtime-workflow-commands.js";
import { WorkflowCatalogCache } from "./workflow-catalog-cache.js";
import type { WorkflowStartInput } from "./workflow-runtime.js";
import { WorkflowRunStore } from "./workflow-run-store.js";
import { WorkflowStore } from "./workflow-store.js";

const WORKFLOW_ID = "wf-11111111-1111-4111-8111-111111111111";
const OWNER_ID = "owner-session-1";

let root: string;
let workspace: string;
let agentDir: string;
let store: WorkflowStore;
let catalog: WorkflowCatalogCache;
let runs: WorkflowRunStore;
let posted: RuntimeMessage[];
let activeRuns: WorkflowRun[];
let catalogs: string[];
let runPublishes: boolean[];

function draft(name = "起步模板"): WorkflowDefinition {
  return {
    version: 1,
    id: WORKFLOW_ID,
    name,
    nodes: [
      { id: "plan", title: "规划", kind: "task", prompt: "规划 {{input}}", position: { x: 0, y: 0 }, exec: { kind: "agent" } },
      { id: "work", title: "实施", kind: "task", prompt: "实施 {{plan}}", position: { x: 1, y: 0 }, exec: { kind: "agent" } },
      { id: "gate", title: "验收", kind: "gate", prompt: "验收 {{work}}", position: { x: 2, y: 0 }, exec: { kind: "agent" } },
      { id: "output", title: "整理", kind: "output", prompt: "整理", position: { x: 3, y: 0 }, exec: { kind: "agent" } }
    ],
    edges: [
      { id: "e1", from: "plan", to: "work" },
      { id: "e2", from: "work", to: "gate" },
      { id: "e3", from: "gate", to: "output" }
    ],
    rework: { entryNodeId: "work", gateNodeId: "gate", maxAttempts: 2 },
    revision: 0,
    createdAt: 1,
    updatedAt: 1
  };
}

function incompleteDraft(): WorkflowDefinition {
  return { ...draft("草稿"), nodes: [], edges: [], rework: undefined };
}

/** 真实定义存储里落一份可运行定义，返回它与 baseHash。 */
function saveDefinition(definition = draft()): { definition: WorkflowDefinition; baseHash: string } {
  // 第二次起必须带旧 hash（乐观并发契约），测试里自动读一次。
  let saved: { definition: WorkflowDefinition; baseHash: string };
  try {
    // 已存在（第二次起）：带旧 hash 更新。
    saved = store.save(workspace, definition, { workflowId: WORKFLOW_ID, baseHash: store.get(workspace, WORKFLOW_ID).baseHash });
  } catch {
    // 尚不存在：新建（id 由注入的 createId 给出，恰好是 WORKFLOW_ID）。
    saved = store.save(workspace, definition);
  }
  catalog.invalidate(workspace);
  return saved;
}

function runRecord(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "wr-run-1",
    workflowId: WORKFLOW_ID,
    workflowName: "起步模板",
    workspace,
    agentId: "default",
    ownerSessionId: OWNER_ID,
    definitionHash: "hash-1",
    runnerInstanceId: "instance-self",
    runnerPid: 111,
    status: "running",
    startedAt: 10,
    currentAttempt: 1,
    maxAttempts: 2,
    executions: [],
    resolvedNodes: [],
    ...overrides
  };
}

interface FakeRuntime {
  handle: WorkflowRuntimeHandle;
  started: WorkflowStartInput[];
  order: string[];
  stopped: string[];
  running: WorkflowRun | undefined;
}

function fakeRuntime(initial?: WorkflowRun): FakeRuntime {
  const fake: FakeRuntime = {
    started: [],
    order: [],
    stopped: [],
    running: initial,
    handle: {
      beginRun: () => fake.order.push("begin"),
      start: (input) => {
        fake.order.push("start");
        fake.started.push(input);
        fake.running = { ...runRecord({ status: "starting", definitionHash: input.definitionHash, workflowId: input.definition.id }), runId: "wr-new-1" };
        return fake.running;
      },
      stop: (runId) => {
        fake.stopped.push(runId ?? "");
        if (fake.running && (!runId || fake.running.runId === runId)) fake.running = { ...fake.running, status: "stopping" };
        return fake.running;
      },
      snapshot: () => fake.running,
      hasActiveRun: () => fake.running !== undefined && ACTIVE_WORKFLOW_STATUSES.has(fake.running.status)
    }
  };
  return fake;
}

const owner: WorkflowOwnerBinding = { ownerSessionId: OWNER_ID, workspace: "", agentId: "default", hasActiveRun: false };

function deps(overrides: Partial<WorkflowCommandDeps> = {}): WorkflowCommandDeps {
  const runtime = fakeRuntime();
  return {
    store,
    catalog,
    runs,
    instanceId: "instance-self",
    post: (message) => posted.push(message),
    resolveOwner: (ownerSessionId, target) => ownerSessionId === OWNER_ID
      ? { ok: true, owner: { ...owner, workspace: target } }
      : { ok: false, diagnostic: { code: "owner-missing", message: `owner 会话 ${ownerSessionId} 不在运行中` } },
    runtimeFor: () => runtime.handle,
    resolveConfigs: (_owner, definition) => definition.nodes.map((node) => ({
      nodeId: node.id,
      source: "agent" as const,
      model: { provider: "p", id: "m" },
      thinkingLevel: "off" as const,
      tools: ["read" as const],
      systemPrompt: `静态身份：${node.title}`
    })),
    resolveDisplayConfigs: (_workspace, definition) => definition.nodes.map((node) => ({
      nodeId: node.id,
      source: "agent" as const,
      model: { provider: "p", id: "m" },
      thinkingLevel: "off" as const,
      tools: ["read" as const]
    })),
    validationContext: () => ({
      subagents: [],
      availableModels: [{ provider: "p", id: "m" }],
      sourceTools: ["read", "edit", "write", "bash", "powershell", "grep", "find", "ls"],
      ownerAccessMode: "ask"
    }),
    pendingPermissionIds: (runId) => runId === "wr-run-1" ? ["permission-1"] : [],
    activeRuns: () => activeRuns,
    findRuntime: (runId) => runtime.handle.snapshot()?.runId === runId ? runtime.handle : undefined,
    publishCatalog: (target) => catalogs.push(target),
    publishRuns: (options) => runPublishes.push(options?.immediate === true),
    ...overrides
  };
}

/** 每条命令都回一条 workflow.result；测试统一从 posted 里取。 */
function results(): Array<Extract<RuntimeMessage, { type: "workflow.result" }>["result"]> {
  return posted.filter((message): message is Extract<RuntimeMessage, { type: "workflow.result" }> => message.type === "workflow.result").map((message) => message.result);
}

function runsFrames(): WorkflowRunsSnapshot[] {
  return posted.filter((message): message is Extract<RuntimeMessage, { type: "workflow.runs" }> => message.type === "workflow.runs").map((message) => message.snapshot);
}

async function dispatch(command: WorkflowCommand, overrides: Partial<WorkflowCommandDeps> = {}) {
  posted.length = 0;
  await createWorkflowCommandProcessor(deps(overrides))(command);
  const all = results();
  expect(all).toHaveLength(1);
  expect(all[0]!.requestId).toBe(command.requestId);
  expect(all[0]!.op).toBe(command.type);
  return all[0]!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-commands-"));
  workspace = join(root, "workspace");
  agentDir = join(root, "agent");
  mkdirSync(workspace, { recursive: true });
  store = new WorkflowStore(() => 5_000, () => WORKFLOW_ID);
  catalog = new WorkflowCatalogCache(store, () => 5_000);
  runs = new WorkflowRunStore({ agentDir, now: () => 9_000, liveness: () => "unknown" });
  posted = [];
  activeRuns = [];
  catalogs = [];
  runPublishes = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow 命令回执与诊断", () => {
  it("对每条命令都回一条带 requestId/op 的回执，失败带可读诊断", async () => {
    const missing = await dispatch({ type: "workflow.get", requestId: "r-get", workspace, workflowId: WORKFLOW_ID });
    expect(missing).toMatchObject({ ok: false, code: "not-found" });
    expect(missing.ok === false && missing.errors[0]!.message).toContain("工作流不存在");

    const badSave = await dispatch({ type: "workflow.save", requestId: "r-save", workspace, draft: { name: 1 } as unknown as WorkflowDefinition });
    expect(badSave).toMatchObject({ ok: false, code: "invalid-draft" });
    expect(badSave.ok === false && badSave.errors.length).toBeGreaterThan(0);

    const deleteMissing = await dispatch({ type: "workflow.delete", requestId: "r-del", workspace, workflowId: WORKFLOW_ID, baseHash: "h" });
    expect(deleteMissing).toMatchObject({ ok: false, code: "not-found" });

    const noOwner = await dispatch({ type: "workflow.run", requestId: "r-run", workspace, ownerSessionId: "ghost", workflowId: WORKFLOW_ID, input: "" });
    expect(noOwner).toMatchObject({ ok: false, code: "owner-missing" });
    expect(noOwner.ok === false && noOwner.errors[0]!.message).toContain("不在运行中");

    const noRun = await dispatch({ type: "workflow.stop", requestId: "r-stop", runId: "wr-ghost" });
    expect(noRun).toMatchObject({ ok: false, code: "not-found" });

    const badNode = await dispatch({ type: "workflow.node.get", requestId: "r-node", runId: "wr-ghost", executionId: "x", content: "artifact" });
    expect(badNode).toMatchObject({ ok: false, code: "not-found" });

    const syncEmpty = await dispatch({ type: "workflow.sync", requestId: "r-sync" });
    expect(syncEmpty.ok).toBe(true);
    expect(syncEmpty.ok === true && syncEmpty.op === "workflow.sync" && syncEmpty.result.diagnostics).toHaveLength(1);
  });

  it("未预期异常也经 workflow.result 兜底（不只发全局 error）", async () => {
    const result = workflowFailureResult({ type: "workflow.get", requestId: "r-1", workspace, workflowId: WORKFLOW_ID }, new Error("磁盘炸了"));
    expect(result).toMatchObject({ requestId: "r-1", op: "workflow.get", ok: false, code: "workflow-error" });
    expect(result.ok === false && result.errors[0]).toEqual({ code: "workflow-error", message: "磁盘炸了" });
    const wrapped = workflowFailureResult(
      { type: "workflow.get", requestId: "r-1", workspace, workflowId: WORKFLOW_ID },
      new WorkflowCommandFailure("busy", "已有运行", [{ code: "busy", message: "该会话已有工作流在运行" }])
    );
    expect(wrapped.ok === false && wrapped.errors[0]!.code).toBe("busy");
  });

  it("get 返回定义、baseHash、运行校验问题与实际模型", async () => {
    const saved = saveDefinition();
    const got = await dispatch({ type: "workflow.get", requestId: "r-get", workspace, workflowId: WORKFLOW_ID });
    expect(got.ok).toBe(true);
    if (!got.ok || got.op !== "workflow.get") throw new Error("回执类型不符");
    expect(got.result.baseHash).toBe(saved.baseHash);
    expect(got.result.definition.name).toBe("起步模板");
    expect(got.result.issues).toEqual([]);
    expect(got.result.resolvedNodes?.map((node) => node.model)).toEqual(Array.from({ length: 4 }, () => ({ provider: "p", id: "m" })));
  });

  it("不允许通过 resolvedNodes 泄漏 systemPrompt", () => {
    const projected = projectResolvedNodeConfigs([
      { nodeId: "n1", source: "agent", model: { provider: "p", id: "m" }, thinkingLevel: "off", tools: ["read"], systemPrompt: "秘密" }
    ]);
    expect(projected).toEqual([{ nodeId: "n1", source: "agent", model: { provider: "p", id: "m" }, thinkingLevel: "off", tools: ["read"] }]);
    expect(JSON.stringify(projected)).not.toContain("秘密");
  });

  it("save 草稿允许不完整，返回问题但不阻断保存，并失效/重发目录", async () => {
    const saved = await dispatch({ type: "workflow.save", requestId: "r-save", workspace, draft: incompleteDraft() });
    expect(saved.ok).toBe(true);
    if (!saved.ok || saved.op !== "workflow.save") throw new Error("回执类型不符");
    expect(saved.result.definition.revision).toBe(1);
    expect(saved.result.baseHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(saved.result.issues.some((issue) => issue.code === "entry-count")).toBe(true);
    expect(catalogs).toEqual([workspace]);
  });

  it("save 冲突返回 conflict，不覆盖别人的编辑", async () => {
    const first = saveDefinition();
    store.save(workspace, { ...draft("第二次改名") }, { workflowId: WORKFLOW_ID, baseHash: first.baseHash });
    const stale = await dispatch({ type: "workflow.save", requestId: "r-save", workspace, workflowId: WORKFLOW_ID, baseHash: first.baseHash, draft: draft("过期稿") });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    expect(store.get(workspace, WORKFLOW_ID).definition.name).toBe("第二次改名");
  });

  it("delete 只删定义，不动已有运行快照", async () => {
    const saved = saveDefinition();
    runs.create(runRecord({ status: "completed" }), saved.definition);
    const deleted = await dispatch({ type: "workflow.delete", requestId: "r-del", workspace, workflowId: WORKFLOW_ID, baseHash: saved.baseHash });
    expect(deleted.ok).toBe(true);
    expect(catalogs).toEqual([workspace]);
    expect(runs.get("wr-run-1").status).toBe("completed");
  });
});

describe("workflow.run 受理", () => {
  it("先冻结配置再受理，start 立即返回 starting 并立即推一帧", async () => {
    saveDefinition();
    const runtime = fakeRuntime();
    const result = await dispatch(
      { type: "workflow.run", requestId: "r-run", workspace, ownerSessionId: OWNER_ID, workflowId: WORKFLOW_ID, input: "做一件小事" },
      { runtimeFor: () => runtime.handle }
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.op !== "workflow.run") throw new Error("回执类型不符");
    expect(result.result).toEqual({ runId: "wr-new-1", status: "starting" });
    // beginRun（冻结模型覆盖）必须先于 start。
    expect(runtime.order).toEqual(["begin", "start"]);
    expect(runtime.started).toHaveLength(1);
    expect(runtime.started[0]!.configs).toHaveLength(4);
    expect(runtime.started[0]!.configs[0]!.systemPrompt).toBe("静态身份：规划");
    expect(runtime.started[0]!.definitionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(runPublishes).toEqual([true]);
  });

  it("owner 已有运行 / 定义不可运行 / 输入超限都拒绝且不启动", async () => {
    saveDefinition();
    const busyRuntime = fakeRuntime(runRecord({ runId: "wr-busy", status: "running" }));
    const busy = await dispatch(
      { type: "workflow.run", requestId: "r-run", workspace, ownerSessionId: OWNER_ID, workflowId: WORKFLOW_ID, input: "" },
      { runtimeFor: () => busyRuntime.handle }
    );
    expect(busy).toMatchObject({ ok: false, code: "busy" });

    catalog.save(workspace, incompleteDraft(), { workflowId: WORKFLOW_ID, baseHash: store.get(workspace, WORKFLOW_ID).baseHash });
    const invalid = await dispatch({ type: "workflow.run", requestId: "r-run2", workspace, ownerSessionId: OWNER_ID, workflowId: WORKFLOW_ID, input: "" });
    expect(invalid).toMatchObject({ ok: false, code: "invalid-workflow" });
    expect(invalid.ok === false && invalid.errors.length).toBeGreaterThan(0);

    const tooLong = await dispatch({ type: "workflow.run", requestId: "r-run3", workspace, ownerSessionId: OWNER_ID, workflowId: WORKFLOW_ID, input: "x".repeat(17 * 1024) });
    expect(tooLong).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("owner 工作区不一致时拒绝（realpath 判定由 pi-runtime 注入）", async () => {
    saveDefinition();
    const mismatch = await dispatch(
      { type: "workflow.run", requestId: "r-run", workspace, ownerSessionId: OWNER_ID, workflowId: WORKFLOW_ID, input: "" },
      { resolveOwner: () => ({ ok: false, diagnostic: { code: "workspace-mismatch", message: "工作流工作区与会话不一致" } }) }
    );
    expect(mismatch).toMatchObject({ ok: false, code: "workspace-mismatch" });
  });

  it("工作区锁冲突按 conflict 错误码回执（带现有运行摘要）", async () => {
    saveDefinition();
    const conflictRuntime: WorkflowRuntimeHandle = {
      start: () => { throw new WorkflowCommandFailure("conflict", "工作区已有本实例的工作流运行：run wr-running-1（实例 i-1，PID 42）"); },
      stop: () => undefined,
      snapshot: () => undefined,
      hasActiveRun: () => false
    };
    const conflicted = await dispatch(
      { type: "workflow.run", requestId: "r-run", workspace, ownerSessionId: OWNER_ID, workflowId: WORKFLOW_ID, input: "" },
      { runtimeFor: () => conflictRuntime }
    );
    expect(conflicted).toMatchObject({ ok: false, code: "conflict" });
    expect(conflicted.ok === false && conflicted.errors[0]!.message).toContain("wr-running-1");
  });

  it("节点配置解析失败按具体诊断拒绝受理", async () => {
    saveDefinition();
    const failed = await dispatch(
      { type: "workflow.run", requestId: "r-run", workspace, ownerSessionId: OWNER_ID, workflowId: WORKFLOW_ID, input: "" },
      { resolveConfigs: () => { throw new Error("节点「实施」（work）：找不到子智能体「x」"); } }
    );
    expect(failed).toMatchObject({ ok: false, code: "config-invalid" });
    expect(failed.ok === false && failed.errors[0]!.message).toContain("找不到子智能体");
  });
});

describe("workflow.stop 与运行查询", () => {
  it("本实例的运行先置 stopping 并立即推帧", async () => {
    const runtime = fakeRuntime(runRecord({ status: "running" }));
    const result = await dispatch({ type: "workflow.stop", requestId: "r-stop", runId: "wr-run-1" }, { findRuntime: () => runtime.handle });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.result).toEqual({ runId: "wr-run-1", status: "stopping" });
    expect(runtime.stopped).toEqual(["wr-run-1"]);
    expect(runPublishes).toEqual([true]);
  });

  it("其他实例的活跃运行不能跨实例停止，终态停止是幂等成功", async () => {
    const saved = saveDefinition();
    runs.create(runRecord({ status: "running", runnerInstanceId: "instance-other", runnerPid: 222 }), saved.definition);
    const external = await dispatch({ type: "workflow.stop", requestId: "r-stop", runId: "wr-run-1" });
    expect(external).toMatchObject({ ok: false, code: "external-run" });

    // 本实例的记录仍是活跃态但没有运行器（会话被删）：不假装成功，给出可诊断的 stale-run。
    runs.create(runRecord({ runId: "wr-stale", status: "running" }), saved.definition);
    const stale = await dispatch({ type: "workflow.stop", requestId: "r-stop-stale", runId: "wr-stale" });
    expect(stale).toMatchObject({ ok: false, code: "stale-run" });
    expect(stale.ok === false && stale.errors[0]!.message).toContain("启动对账");

    runs.save({ ...runs.get("wr-run-1"), status: "completed", endedAt: 20 });
    const done = await dispatch({ type: "workflow.stop", requestId: "r-stop2", runId: "wr-run-1" });
    expect(done.ok).toBe(true);
    expect(done.ok === true && done.result).toEqual({ runId: "wr-run-1", status: "completed" });
  });

  it("runs.list 标出外部实例与待决权限 id，run.get 优先实时快照", async () => {
    const saved = saveDefinition();
    runs.create(runRecord({ status: "running" }), saved.definition);
    runs.create(runRecord({ runId: "wr-run-2", status: "completed", runnerInstanceId: "instance-other" }), saved.definition);
    const listed = await dispatch({ type: "workflow.runs.list", requestId: "r-list", workspace });
    expect(listed.ok).toBe(true);
    if (!listed.ok || listed.op !== "workflow.runs.list") throw new Error("回执类型不符");
    const byId = new Map(listed.result.runs.map((run) => [run.runId, run]));
    expect(byId.get("wr-run-1")).toMatchObject({ status: "running", pendingPermissionIds: ["permission-1"] });
    expect(byId.get("wr-run-1")!.external).toBeUndefined();
    expect(byId.get("wr-run-2")).toMatchObject({ status: "completed", external: true });

    const liveRuntime = fakeRuntime(runRecord({ runId: "wr-run-1", status: "running", currentAttempt: 2 }));
    const got = await dispatch({ type: "workflow.run.get", requestId: "r-get", runId: "wr-run-1" }, { findRuntime: () => liveRuntime.handle });
    expect(got.ok).toBe(true);
    expect(got.ok === true && got.op === "workflow.run.get" && got.result.run.currentAttempt).toBe(2);
    expect(got.ok === true && got.op === "workflow.run.get" && got.result.definition.id).toBe(WORKFLOW_ID);
  });

  it("node.get 按文件读取产物并显式标记截断，游标非法直接拒绝", async () => {
    const saved = saveDefinition();
    runs.create(runRecord({
      status: "completed",
      executions: [{ executionId: "execution-1", nodeId: "plan", nodeTitle: "规划", attempt: 1, status: "completed" }]
    }), saved.definition);
    runs.writeArtifact("wr-run-1", "execution-1", "a\n".repeat(MAX_WORKFLOW_NODE_GET_ARTIFACT_BYTES));
    const clipped = await dispatch({ type: "workflow.node.get", requestId: "r-node", runId: "wr-run-1", executionId: "execution-1", content: "artifact" });
    expect(clipped.ok).toBe(true);
    if (!clipped.ok || clipped.op !== "workflow.node.get") throw new Error("回执类型不符");
    expect(clipped.result.truncated).toBe(true);
    expect(new TextEncoder().encode(clipped.result.artifact ?? "").byteLength).toBeLessThanOrEqual(MAX_WORKFLOW_NODE_GET_ARTIFACT_BYTES);
    expect(clipped.result.artifact!.startsWith("a\n")).toBe(true);

    const badCursor = await dispatch({ type: "workflow.node.get", requestId: "r-node2", runId: "wr-run-1", executionId: "execution-1", content: "transcript", cursor: "abc" });
    expect(badCursor).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("node.get 的 transcript 走真实 JSONL 且分页信息明确", async () => {
    const sessionFile = join(agentDir, "chatanytime-sessions", "default", "delegations", "workflows", OWNER_ID, "wr-run-1", "a1", "plan", "session.jsonl");
    mkdirSync(join(sessionFile, ".."), { recursive: true });
    writeFileSync(sessionFile, [
      JSON.stringify({ id: "e1", type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "第一行" }] } }),
      JSON.stringify({ id: "e2", type: "message", message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "第二行" }] } })
    ].join("\n"));
    const saved = saveDefinition();
    runs.create(runRecord({
      status: "completed",
      executions: [{ executionId: "execution-1", nodeId: "plan", nodeTitle: "规划", attempt: 1, status: "completed", sessionFile }]
    }), saved.definition);
    const page = await dispatch({ type: "workflow.node.get", requestId: "r-node", runId: "wr-run-1", executionId: "execution-1", content: "transcript", limit: 1 });
    expect(page.ok).toBe(true);
    if (!page.ok || page.op !== "workflow.node.get") throw new Error("回执类型不符");
    expect(page.result.messages).toHaveLength(1);
    expect(page.result.nextCursor).toBe("1");
    expect(page.result.truncated).toBe(true);
  });
});

describe("workflow.sync 与目录", () => {
  it("返回工作区轻目录并立即补一帧运行摘要", async () => {
    saveDefinition();
    const synced = await dispatch({ type: "workflow.sync", requestId: "r-sync", workspace });
    expect(synced.ok).toBe(true);
    if (!synced.ok || synced.op !== "workflow.sync") throw new Error("回执类型不符");
    expect(synced.result.workflows).toEqual([
      expect.objectContaining({ id: WORKFLOW_ID, name: "起步模板", nodeCount: 4, runnable: true, issueCount: 0 })
    ]);
    expect(runPublishes).toEqual([true]);
  });

  it("工作区不存在时给出 invalid-workspace 诊断而不是空目录", async () => {
    const failed = await dispatch({ type: "workflow.sync", requestId: "r-sync", workspace: join(root, "missing") });
    expect(failed).toMatchObject({ ok: false, code: "invalid-workspace" });
  });

  it("按 id 或精确名称解析工作流引用，不做模糊匹配", () => {
    const entries: WorkflowSummary[] = [
      { id: "wf-a", name: "发布流程", nodeCount: 1, updatedAt: 1, runnable: true, issueCount: 0 },
      { id: "wf-b", name: "发布流程 2", nodeCount: 1, updatedAt: 2, runnable: true, issueCount: 0 }
    ];
    expect(matchWorkflowReference(entries, "wf-b")?.name).toBe("发布流程 2");
    expect(matchWorkflowReference(entries, "发布流程")?.id).toBe("wf-a");
    expect(matchWorkflowReference(entries, "发布")).toBeUndefined();
    expect(matchWorkflowReference(entries, "  ")).toBeUndefined();
  });
});

describe("workflow.runs 发帧与轻量历史", () => {
  it("epoch 固定、revision 递增，合帧不重复推送", () => {
    const frames: WorkflowRunsSnapshot[] = [];
    const history = new WorkflowRunHistory({ selfInstanceId: "instance-self" });
    const timers: Array<() => void> = [];
    const publisher = createWorkflowRunsPublisher({
      post: (message) => { if (message.type === "workflow.runs") frames.push(message.snapshot); },
      history,
      activeRuns: () => activeRuns,
      pendingPermissionIds: () => ["permission-1"],
      epoch: "epoch-1",
      schedule: (callback) => { timers.push(callback); return timers.length; },
      cancel: () => { timers.length = 0; }
    });
    activeRuns = [runRecord({ status: "running" })];
    publisher.publish();
    publisher.publish();
    expect(timers).toHaveLength(1);
    expect(frames).toHaveLength(0);
    timers[0]!();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ epoch: "epoch-1", revision: 1 });
    expect(frames[0]!.runs[0]).toMatchObject({ runId: "wr-run-1", status: "running", pendingPermissionIds: ["permission-1"] });

    publisher.publishNow();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ epoch: "epoch-1", revision: 2 });
    expect(publisher.snapshot().revision).toBe(2);
    publisher.dispose();
  });

  it("终态进历史并裁剪到上限，外部活跃运行只在存活时展示", () => {
    const history = new WorkflowRunHistory({ selfInstanceId: "instance-self", terminalLimit: 2, liveness: (pid) => pid === 333 ? "alive" : "dead" });
    history.seed([
      runRecord({ runId: "wr-t1", status: "completed", startedAt: 1 }),
      runRecord({ runId: "wr-t2", status: "completed", startedAt: 2 }),
      runRecord({ runId: "wr-t3", status: "rejected", startedAt: 3 }),
      runRecord({ runId: "wr-ext", status: "running", runnerInstanceId: "instance-other", runnerPid: 333 }),
      runRecord({ runId: "wr-dead", status: "running", runnerInstanceId: "instance-other", runnerPid: 444 }),
      runRecord({ runId: "wr-self-active", status: "running", startedAt: 4 })
    ]);
    const summaries = history.summaries([runRecord({ runId: "wr-self-active", status: "running" })], () => []);
    expect(summaries.map((run) => run.runId)).toEqual(["wr-self-active", "wr-ext", "wr-t3", "wr-t2"]);
    expect(summaries.find((run) => run.runId === "wr-ext")?.external).toBe(true);
    expect(summaries.find((run) => run.runId === "wr-t3")?.external).toBeUndefined();

    history.record(runRecord({ runId: "wr-ext", status: "interrupted", runnerInstanceId: "instance-other", runnerPid: 333, startedAt: 10 }));
    const after = history.summaries([], () => []);
    expect(after.find((run) => run.runId === "wr-ext")).toMatchObject({ status: "interrupted", external: true });
    // 外部实例的终态保留在历史里（external），本实例的终态按上限裁剪。
    expect(after.filter((run) => run.external !== true).map((run) => run.runId)).toEqual(["wr-t3"]);
    history.remove("wr-ext");
    expect(history.summaries([], () => []).some((run) => run.runId === "wr-ext")).toBe(false);
  });

  it("摘要只带轻量字段（不含提示词/产物/聊天内容）", () => {
    const history = new WorkflowRunHistory({ selfInstanceId: "instance-self" });
    history.seed([runRecord({
      runId: "wr-lean",
      status: "failed",
      endedAt: 11,
      error: "x".repeat(1_000),
      executions: [{ executionId: "execution-1", nodeId: "plan", nodeTitle: "规划", attempt: 1, status: "completed", artifactPath: "/secret/artifact.txt", sessionFile: "/secret/session.jsonl" }]
    })]);
    const summary = history.summaries([], () => [])[0]!;
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("/secret/");
    expect(summary.error).toHaveLength(400);
    expect(Object.keys(summary).sort()).toEqual([
      "agentId", "currentAttempt", "endedAt", "error", "maxAttempts", "nodeStates", "ownerSessionId",
      "pendingPermissionIds", "runId", "startedAt", "status", "workflowId", "workflowName", "workspace"
    ].sort());
  });

  it("终态集合与活跃集合互不重叠", () => {
    for (const status of TERMINAL_WORKFLOW_STATUSES) expect(ACTIVE_WORKFLOW_STATUSES.has(status)).toBe(false);
    expect([...ACTIVE_WORKFLOW_STATUSES]).toEqual(["starting", "running", "stopping"]);
  });
});

describe("utility 接线契约（pi-runtime）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeSource = readFileSync(join(here, "pi-runtime.ts"), "utf8").replace(/\r\n?/gu, "\n");
  /** 源码片段存在性：用 includes 而不是正则，避免转义地狱，也让失败信息直接给出缺的片段。 */
  const has = (snippet: string): boolean => runtimeSource.includes(snippet);
  const require = (snippet: string): void => { expect(has(snippet), `pi-runtime.ts 缺少接线片段：\n${snippet}`).toBe(true); };

  it("全命令走 workflow.result，stop 走旁路，队列失败也回收执", () => {
    require("if (isWorkflowCommand(command)) {\n    await handleWorkflowCommand(command);");
    require('return command.type.startsWith("workflow.");');
    require('if (event.data.type === "workflow.stop") {');
    require('post({ type: "workflow.result", result: workflowFailureResult(event.data, error) });');
    require("await ensureWorkflowPlumbing().processor(command);");
    require("prepareWorkflowRunStorage();");
  });

  it("运行器持于 owner record，并有 workflowEnabled 开关投影", () => {
    require("workflowRuntime?: WorkflowRuntime;");
    require("workflowEnabled: boolean;");
    require("workflowEnabled: workflowToolEnabled(recordAgent),");
    // 开关归一化只有一处实现（runtime-workflow），pi-runtime 只转调——步骤七不再重复写 `=== true`。
    require("return runtimeWorkflow.workflowOverrideEnabled(agent);");
    require("record.workflowRuntime = runtime;");
    require("workflowHandles.set(owner.ownerSessionId, handle);");
    require("workflowHandles.delete(record.session.sessionId);");
  });

  it("活跃 owner 不被 LRU 驱逐、不允许同 id 重建、资源重载与角色保存不销毁", () => {
    require("&& !recordHasActiveWorkflow(record))");
    require("if (existing && recordHasActiveWorkflow(existing)) {");
    require('if (recordHasActiveWorkflow(record)) throw new Error("当前会话有工作流在运行，重载资源会重建会话');
    require("if (recordHasActiveWorkflow(activeRuntime)) {");
    require("配置已保存；当前会话有工作流在运行，重新加载会话后生效");
    require("if (runActive(record) || recordHasActiveWorkflow(record))");
    // 兜底：真正销毁 record 时请求停止并取消该 run 的待决权限。
    require("record.workflowRuntime.stop();");
    require("if (run) permissionBroker.cancelWorkflow(run.runId);");
  });

  it("删除会话先 stopAndWait 确认，再删文件并清历史（失败保留）", () => {
    require("async function releaseWorkflowOwnerForDeletion(");
    require("const confirmed = await runtime.stopAndWait();");
    require("if (workflowRelease.failures.length > 0) throw new Error(`会话删除已取消");
    require("const workflowFailures = await removeWorkflowHistoryForOwner(workflowRelease.ownerSessionId, ownerAgentId);");
    require("if (ACTIVE_WORKFLOW_STATUSES.has(run.status)) {");
    require("清理失败（已保留记录）");
    require('try { rmdirSync(join(getAgentDir(), "chatanytime-sessions", agentId, "delegations", "workflows", ownerSessionId)); }');
  });

  it("owner 必须是真实 live 记录且工作区 realpath 一致（不读 activeRuntime）", () => {
    require("function resolveWorkflowOwner(");
    require("const record = liveSessions.get(ownerSessionId);");
    require("const ownerKey = workflowWorkspaceKey(record.workspace);");
    require("return workspaceLockKey(realpathSync.native(resolve(path)));");
    require('code: "workspace-mismatch"');
    require("function workflowOwnerBinding(record: SessionRuntimeRecord): WorkflowOwnerBinding");
    require("async function startRecordWorkflow(record: SessionRuntimeRecord, workflowRef: string, input: string, options?: { signal?: AbortSignal }): Promise<WorkflowRunAccepted>");
    // owner 连接线函数里不得出现 activeRuntime（工具必须落在调用它的会话上）。
    const startRecordBlock = runtimeSource.slice(runtimeSource.indexOf("async function startRecordWorkflow("));
    expect(startRecordBlock.slice(0, startRecordBlock.indexOf("\n}\n")).includes("activeRuntime")).toBe(false);
  });

  it("节点权限带 owner 身份 + workflow scope + cap 取严 + 10 分钟超时", () => {
    require("{ accessModeCap: () => cap }");
    require("workflow: () => request.node,");
    require("permissionTimeoutMs: () => WORKFLOW_PERMISSION_TIMEOUT_MS");
    require('runtimePermissions.requestPermission(deps, request.toolName, request.args, request.toolCallId, "subagent");');
    require("pendingWorkflowPermissions.set(request.id, request.principal.workflow.runId);");
    require("if (pendingWorkflowPermissions.delete(id)) workflowPlumbing?.publisher.publish();");
    require("cancelPermissions: (runId) => permissionBroker.cancelWorkflow(runId),");
    // 节点 cap 取受理时冻结的投影，不重读定义/设置。
    require("run.resolvedNodes.find((entry) => entry.nodeId === request.node.nodeId)");
  });

  it("浏览器工具每次执行复核 owner 角色与总闸；模型覆盖在受理时冻结", () => {
    require("function buildWorkflowBrowserTools(record: SessionRuntimeRecord): ToolDefinition[]");
    require("if (settings?.browser?.enabled === false) return false;");
    require("return (live?.agent ?? record.agent).toolOverrides?.browser !== false;");
    require('if (message.includes("工作区已有")) throw new WorkflowCommandFailure("conflict", message);');
    require("transformModel: frozen.transform,");
    require("beginRun: frozen.reset,");
    require("function createFrozenModelOverride()");
    require("if (cached) return cached;");
  });

  it("运行前冻结配置，get 可带实际模型", () => {
    require("return resolveWorkflowNodeConfigs(");
    require("resolveDisplayConfigs: (targetWorkspace, definition) => workflowDisplayConfigs(targetWorkspace, definition),");
    require("return projectResolvedNodeConfigs(configs);");
    require("subagents: workspaceResources.load(record.workspace).subagents");
  });

  it("启动对账 + 有界保留 + 资源目录给 workflows + 运行摘要发帧", () => {
    require("diagnostics.push(...plumbing.runStore.reconcile());");
    require("diagnostics.push(...plumbing.runStore.prune());");
    require("workflows: workflowCatalogItems(catalogWorkspace)");
    require("createWorkflowRunsPublisher({");
    require("if (TERMINAL_WORKFLOW_STATUSES.has(run.status)) {");
    require("new WorkflowCatalogCache(store, Date.now, 15_000)");
    require("if (options?.immediate) publisher.publishNow(); else publisher.publish();");
  });

  it("给步骤七的工具接线面（不 import pi-runtime 即可对准契约）", () => {
    require("function workflowToolSurfaceFor(record: SessionRuntimeRecord): WorkflowToolSurface {");
    require("list: () => workflowCatalogForRecord(record),");
    require("start: (workflowRef, input, options) => startRecordWorkflow(record, workflowRef, input, options),");
    require("status: (runId) => workflowStatusForRecord(record, runId)");
    // 受理前取消的固定文案（工具回执直接透传）；受理后不跟随父 signal。
    require("if (options?.signal?.aborted) throw new Error(WORKFLOW_START_CANCELLED);");
  });
});
