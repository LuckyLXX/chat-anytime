import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkflowDraft, MAX_WORKFLOW_ATTEMPTS, type WorkflowExecution, type WorkflowRun } from "../shared/workflow.js";
import { MAX_TRANSCRIPT_MESSAGE_BYTES, MAX_TRANSCRIPT_PAGE_BYTES, WorkflowRunStore } from "./workflow-run-store.js";

let root: string;
let agentDir: string;
let workspaceDir: string;
let store: WorkflowRunStore;
const definition = createWorkflowDraft(10, "wf-test");

function run(id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: id,
    workflowId: definition.id,
    workflowName: definition.name,
    workspace: "workspace-a",
    agentId: "agent-a",
    ownerSessionId: "owner-a",
    definitionHash: "hash",
    runnerInstanceId: "instance-a",
    runnerPid: 100,
    status: "running",
    startedAt: 10,
    currentAttempt: 1,
    maxAttempts: 3,
    executions: [{ executionId: `execution-${id}`, nodeId: "n1", nodeTitle: "节点", attempt: 1, status: "running" }],
    resolvedNodes: [],
    ...overrides
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-runs-"));
  agentDir = join(root, "agent");
  workspaceDir = join(root, "workspace-a");
  mkdirSync(workspaceDir, { recursive: true });
  store = new WorkflowRunStore({ agentDir, now: () => 99, liveness: (pid) => pid === 100 ? "dead" : pid === 200 ? "alive" : "unknown" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 与 `workflowChildSessionDirectory` 同构：`<agent>/chatanytime-sessions/<agentId>/delegations/workflows/<owner>/<run>/a<attempt>/<node>/session.jsonl`。 */
function sessionFileFor(runId: string, nodeId: string, attempt = 1, owner = "owner-a"): string {
  return join(agentDir, "chatanytime-sessions", "agent-a", "delegations", "workflows", owner, runId, `a${attempt}`, nodeId, "session.jsonl");
}

function writeSession(
  file: string,
  options: {
    header?: { id: string; cwd?: string; parentSession?: string } | null;
    messages?: Array<{ role: "user" | "assistant"; text: string }>;
  }
): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines: string[] = [];
  if (options.header !== null) {
    lines.push(JSON.stringify({
      type: "session",
      version: 3,
      id: options.header?.id ?? "session-default",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: options.header?.cwd ?? workspaceDir,
      parentSession: options.header?.parentSession ?? "owner-a"
    }));
  }
  for (const [index, message] of (options.messages ?? []).entries()) {
    lines.push(JSON.stringify({
      id: `entry-${index}`,
      type: "message",
      message: { role: message.role, timestamp: 1, content: [{ type: "text", text: message.text }] }
    }));
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
}

function completedRun(id: string, executions: WorkflowRun["executions"], overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return run(id, { workspace: workspaceDir, status: "completed", executions, ...overrides });
}

describe("WorkflowRunStore", () => {
  it("freezes the definition independently of later edits", () => {
    const first = run("run-a");
    store.create(first, definition);
    const original = store.getDefinition(first.runId);
    definition.name = "later edit";
    try {
      expect(store.getDefinition(first.runId)).toEqual(original);
      expect(store.get(first.runId)).toEqual(first);
    } finally { definition.name = original.name; }
  });

  it("serializes state changes and prevents another instance changing ownership", () => {
    const first = run("run-a");
    store.create(first, definition);
    store.save({ ...first, status: "completed", endedAt: 20 });
    expect(store.get(first.runId)).toMatchObject({ status: "completed", endedAt: 20 });
    expect(() => store.save(first)).toThrow("终态运行不能被旧状态覆盖");
    expect(() => store.save({ ...first, runnerInstanceId: "other" })).toThrow("归属不匹配");
  });

  it("writes and reads the exact node artifact while preserving newlines", () => {
    const first = run("run-a");
    store.create(first, definition);
    const artifactPath = store.writeArtifact(first.runId, "execution-run-a", "a\n  b\n");
    store.save({ ...first, executions: [{ ...first.executions[0]!, artifactPath }] });
    expect(store.readArtifact(first.runId, "execution-run-a")).toBe("a\n  b\n");
    expect(() => store.readArtifact(first.runId, "unknown")).toThrow("不存在");
  });

  it("does not let an artifact symlink escape the run directory", () => {
    const first = run("run-a");
    store.create(first, definition);
    const dir = join(agentDir, "pidesktop-workflows", "runs", first.runId, "artifacts", "a1");
    mkdirSync(dir, { recursive: true });
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "secret");
    try { symlinkSync(outside, join(dir, "n1.txt"), "file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    expect(() => store.readArtifact(first.runId, "execution-run-a")).toThrow();
    expect(() => store.writeArtifact(first.runId, "execution-run-a", "bad")).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("secret");
  });

  it("reconciles only runs whose process is confirmed dead", () => {
    store.create(run("dead", { runnerPid: 100 }), definition);
    store.create(run("alive", { runnerPid: 200 }), definition);
    store.create(run("unknown", { runnerPid: 300 }), definition);
    expect(store.reconcile()).toEqual([]);
    expect(store.get("dead")).toMatchObject({ status: "interrupted", endedAt: 99 });
    expect(store.get("alive").status).toBe("running");
    expect(store.get("unknown").status).toBe("running");
  });

  it("keeps active runs and the newest terminal runs when pruning", () => {
    store.create(run("active", { startedAt: 1 }), definition);
    store.create(run("old", { status: "completed", startedAt: 2 }), definition);
    store.create(run("new", { status: "completed", startedAt: 3 }), definition);
    expect(store.prune(1)).toEqual([]);
    expect(store.list().runs.map((item) => item.runId)).toEqual(["new", "active"]);
  });

  it("deletes the real associated session file when pruning", () => {
    const file = join(agentDir, "chatanytime-sessions", "agent-a", "delegations", "workflows", "owner-a", "old", "a1", "n1", "session.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{}");
    const first = run("old", { status: "completed" });
    first.executions[0]!.sessionFile = file;
    store.create(first, definition);
    expect(store.prune(0)).toEqual([]);
    expect(() => readFileSync(file)).toThrow();
  });

  it("retains the index and reports an unsafe session-file path when cleaning", () => {
    const file = join(root, "outside.jsonl");
    writeFileSync(file, "untouched");
    const first = run("old", { status: "completed" });
    first.executions[0]!.sessionFile = file;
    store.create(first, definition);
    expect(store.prune(0).join(" ")).toContain("清理失败");
    expect(store.get("old").runId).toBe("old");
    expect(readFileSync(file, "utf8")).toBe("untouched");
  });

  it("游标不存在时返回空页和诊断，绝不静默回到第一页", () => {
    store.create(run("a", { status: "completed", startedAt: 3 }), definition);
    store.create(run("b", { status: "completed", startedAt: 2 }), definition);
    store.create(run("c", { status: "completed", startedAt: 1 }), definition);
    const first = store.list({ limit: 2 });
    expect(first.runs.map((item) => item.runId)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe("b");
    expect(store.list({ cursor: "b" }).runs.map((item) => item.runId)).toEqual(["c"]);

    const missing = store.list({ cursor: "deleted-run", limit: 2 });
    expect(missing.runs).toEqual([]);
    expect(missing.nextCursor).toBeUndefined();
    expect(missing.diagnostics.join(" ")).toContain("deleted-run");
    expect(missing.diagnostics.join(" ")).toContain("已失效");
  });

  it("prune 清 JSONL 后清理空的 owner/run 目录，其他 run 与 owner 原样保留", () => {
    const file = sessionFileFor("old", "n1");
    writeSession(file, { header: { id: "session-old" }, messages: [{ role: "user", text: "hi" }] });
    const first = completedRun("old", [{ executionId: "execution-old", nodeId: "n1", nodeTitle: "节点", attempt: 1, status: "completed", sessionId: "session-old", sessionFile: file }]);
    store.create(first, definition);

    // 邻居：同一 owner 下的另一个 run，另一个 owner 下的同 id run。
    const neighborRun = sessionFileFor("other-run", "n1");
    writeSession(neighborRun, { header: { id: "session-neighbor" } });
    const otherOwner = sessionFileFor("old", "n1", 1, "owner-b");
    writeSession(otherOwner, { header: { id: "session-owner-b", parentSession: "owner-b" } });

    // executions 为空的 run 只留下空目录：也应该被清掉（但只 rmdir 空目录）。
    const emptyRunDir = join(agentDir, "chatanytime-sessions", "agent-a", "delegations", "workflows", "owner-a", "empty-run", "a1");
    mkdirSync(emptyRunDir, { recursive: true });
    store.create(completedRun("empty-run", []), definition);

    expect(store.prune(0)).toEqual([]);
    expect(existsSync(emptyRunDir)).toBe(false);
    expect(existsSync(dirname(emptyRunDir))).toBe(false); // .../owner-a/empty-run
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dirname(file))).toBe(false); // .../a1/n1
    expect(existsSync(dirname(dirname(dirname(file))))).toBe(false); // .../old（本 run）
    const ownerDir = dirname(dirname(dirname(dirname(file))));
    expect(existsSync(ownerDir)).toBe(true); // owner-a 下还有 other-run
    expect(existsSync(neighborRun)).toBe(true);
    expect(existsSync(otherOwner)).toBe(true);
  });

  it("readTranscript 核验 sessionFile 头部：id/cwd/parent 不匹配一律拒绝", () => {
    const file = sessionFileFor("run-a", "n1");
    const execution: WorkflowExecution = { executionId: "execution-run-a", nodeId: "n1", nodeTitle: "节点", attempt: 1, status: "completed", sessionId: "session-1", sessionFile: file };
    store.create(completedRun("run-a", [execution]), definition);
    writeSession(file, { header: { id: "session-1" }, messages: [{ role: "user", text: "第一行" }] });
    expect(store.readTranscript("run-a", "execution-run-a").messages).toHaveLength(1);

    writeSession(file, { header: { id: "session-other" }, messages: [] });
    expect(() => store.readTranscript("run-a", "execution-run-a")).toThrowError(/header\.id/);

    writeSession(file, { header: { id: "session-1", cwd: join(root, "elsewhere") }, messages: [] });
    expect(() => store.readTranscript("run-a", "execution-run-a")).toThrowError(/header\.cwd/);

    writeSession(file, { header: { id: "session-1", parentSession: "owner-b" }, messages: [] });
    expect(() => store.readTranscript("run-a", "execution-run-a")).toThrowError(/parentSession/);

    // 记录里写了 sessionId，但文件没有可核验的头部：不靠路径猜归属。
    writeSession(file, { header: null, messages: [{ role: "user", text: "没有头部" }] });
    expect(() => store.readTranscript("run-a", "execution-run-a")).toThrowError(/缺少 session 头部/);
  });

  it("readTranscript 分页按字节有界，游标逐页前进且不重复", () => {
    const file = sessionFileFor("run-a", "n1");
    const chunk = "正文".repeat(2_500); // ~15 KB/条
    writeSession(file, {
      header: { id: "session-1" },
      messages: Array.from({ length: 60 }, (_unused, index) => ({ role: "user" as const, text: `第 ${index} 条：${chunk}` }))
    });
    store.create(completedRun("run-a", [{ executionId: "execution-run-a", nodeId: "n1", nodeTitle: "节点", attempt: 1, status: "completed", sessionId: "session-1", sessionFile: file }]), definition);

    const first = store.readTranscript("run-a", "execution-run-a", 0, 200);
    const firstBytes = first.messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8"), 0);
    expect(first.messages.length).toBeGreaterThan(0);
    expect(first.messages.length).toBeLessThan(60);
    expect(firstBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_PAGE_BYTES);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe(String(first.messages.length));

    const second = store.readTranscript("run-a", "execution-run-a", Number(first.nextCursor), 200);
    expect(second.messages.length).toBeGreaterThan(0);
    expect(second.messages[0]!.id).not.toBe(first.messages[0]!.id);
    // 第二页从第一页的下一条开始（内容按序、不重复）
    const textOf = (message: (typeof first.messages)[number]): string => message.blocks.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
    expect(textOf(second.messages[0]!)).toContain(`第 ${first.messages.length} 条`);
    expect(textOf(first.messages.at(-1)!)).toContain(`第 ${first.messages.length - 1} 条`);
    expect(second.nextCursor).toBe(String(first.messages.length + second.messages.length));
  });

  it("readTranscript 对超大单条显式截断（不改原文件）且游标能继续", () => {
    const file = sessionFileFor("run-a", "n1");
    writeSession(file, {
      header: { id: "session-1" },
      messages: [{ role: "user", text: "大".repeat(120_000) }, { role: "assistant", text: "第二条" }]
    });
    store.create(completedRun("run-a", [{ executionId: "execution-run-a", nodeId: "n1", nodeTitle: "节点", attempt: 1, status: "completed", sessionId: "session-1", sessionFile: file }]), definition);
    const before = readFileSync(file, "utf8");

    const first = store.readTranscript("run-a", "execution-run-a", 0, 1);
    expect(first.messages).toHaveLength(1);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe("1");
    const messageBytes = Buffer.byteLength(JSON.stringify(first.messages[0]), "utf8");
    expect(messageBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_MESSAGE_BYTES);
    const text = first.messages[0]!.blocks.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n");
    expect(text).toContain("已截断");
    expect(text).toContain("原");
    expect(readFileSync(file, "utf8")).toBe(before);

    const second = store.readTranscript("run-a", "execution-run-a", 1, 1);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]!.blocks).toMatchObject([{ type: "text", text: "第二条" }]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.truncated).toBe(false);
  });

  it("拒绝非法运行记录（execution.status / attempts / resolvedNodes）", () => {
    store.create(run("run-a"), definition);
    const path = join(agentDir, "pidesktop-workflows", "runs", "run-a", "run.json");
    const base = JSON.parse(readFileSync(path, "utf8")) as WorkflowRun & Record<string, unknown>;
    const write = (record: unknown): void => writeFileSync(path, JSON.stringify(record));

    write({ ...base, executions: [{ ...base.executions[0]!, status: "done" }] });
    expect(() => store.get("run-a")).toThrowError(/节点执行状态非法/);

    write({ ...base, maxAttempts: MAX_WORKFLOW_ATTEMPTS + 1 });
    expect(() => store.get("run-a")).toThrowError(/maxAttempts/);

    write({ ...base, currentAttempt: 4 });
    expect(() => store.get("run-a")).toThrowError(/currentAttempt/);

    write({ ...base, resolvedNodes: [{ nodeId: "n1" }] });
    expect(() => store.get("run-a")).toThrowError(/节点来源非法|节点模型配置/);

    write({ ...base, executions: [{ ...base.executions[0]!, attempt: 4 }], maxAttempts: 3, currentAttempt: 3 });
    expect(() => store.get("run-a")).toThrowError(/attempt/);

    expect(() => store.create(run("run-b", {
      executions: [{ executionId: "execution-run-b", nodeId: "n1", nodeTitle: "节点", attempt: 1, status: "done" as unknown as "running" }]
    }), definition)).toThrowError(/节点执行状态非法/);
  });

  it("readTranscript 拒绝非法游标而不是静默当成第一页", () => {
    const file = sessionFileFor("run-a", "n1");
    writeSession(file, { header: { id: "session-1" }, messages: [{ role: "user", text: "第一行" }] });
    store.create(completedRun("run-a", [{ executionId: "execution-run-a", nodeId: "n1", nodeTitle: "节点", attempt: 1, status: "completed", sessionId: "session-1", sessionFile: file }]), definition);
    expect(() => store.readTranscript("run-a", "execution-run-a", -1)).toThrowError(/游标/);
    expect(() => store.readTranscript("run-a", "execution-run-a", Number.NaN)).toThrowError(/游标/);
    expect(store.readTranscript("run-a", "execution-run-a", 0).messages).toHaveLength(1);
    expect(store.readTranscript("run-a", "execution-run-a", 5).messages).toEqual([]);
  });
});
