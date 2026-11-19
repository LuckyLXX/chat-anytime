import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type AgentSession
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, PermissionDecision, PermissionRequest, ThinkingLevel } from "../shared/protocol.js";
import {
  WORKFLOW_PERMISSION_TIMEOUT_MS,
  parseGateDecision,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRun
} from "../shared/workflow.js";
import { PermissionBroker } from "./permission-broker.js";
import {
  createWorkflowChildExecutor,
  createWorkflowChildSession,
  workflowChildSessionDirectory,
  type WorkflowChildAdapterOptions,
  type WorkflowChildExecutionRequest,
  type WorkflowChildNodeConfig,
  type WorkflowChildPermissionRequest,
  type WorkflowChildSessionCreated
} from "./workflow-child.js";
import { createWorkflowCoordinator } from "./workflow-coordinator.js";
import { WorkflowRunStore } from "./workflow-run-store.js";
import { WorkflowRuntime } from "./workflow-runtime.js";

/**
 * 工作流节点执行适配器在**真实 AgentSession** 上的零网络冒烟（faux provider）：
 * 默认创建配方（withCacheWarmingOff + DefaultResourceLoader + createAgentSession +
 * bindExtensions + setActiveToolsByName）、agent_settled 收口、JSONL 落盘、会话
 * 释放、每次执行独立 sessionId / sessionFile，以及权限拒绝与「权限等待中停止」。
 * fake child 的单测只能证明编排逻辑；Pi 的字段名与事件时序漂移只有这条能发现。
 *
 * 说明：本适配器不负责调度。文件前半部分用同一 gate 节点连续两次执行（attempt 1/2）
 * 证明「每次执行独立会话」并把两段真实文本交给 `parseGateDecision` 走通 retry → pass
 * 的连接段；文件末尾的端到端用例把**真实运行器**（`WorkflowRuntime`）接到同一个真实
 * 适配器上：一次受理自动跑完 P/R/S，区间 retry → pass，前缀与后缀各一次。
 */

const temporaryDirectories: string[] = [];
const leadSessions: AgentSession[] = [];

afterEach(async () => {
  for (const lead of leadSessions.splice(0)) {
    try {
      lead.dispose();
    } catch {
      // best-effort
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Workspace {
  root: string;
  agentDir: string;
  faux: ReturnType<typeof fauxProvider>;
  modelRuntime: AgentSession["modelRuntime"];
  model: { provider: string; id: string };
}

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-workflow-child-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  const { session: lead } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    customTools: [],
    model: faux.getModel(),
    sessionManager: SessionManager.create(root, join(root, "sessions"))
  });
  await lead.bindExtensions({ onError: () => {} });
  lead.modelRuntime.registerNativeProvider(faux.provider);
  await lead.modelRuntime.refresh({ allowNetwork: false });
  leadSessions.push(lead);
  const model = faux.getModel();
  return { root, agentDir, faux, modelRuntime: lead.modelRuntime, model: { provider: model.provider, id: model.id } };
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

function nodeConfig(model: { provider: string; id: string }, overrides: Partial<WorkflowChildNodeConfig> = {}): WorkflowChildNodeConfig {
  return {
    nodeId: "n1",
    source: "agent",
    model,
    thinkingLevel: "medium" as ThinkingLevel,
    tools: ["read"],
    browserTools: false,
    systemPrompt: "你是工作流节点执行者，只完成当前节点的任务。",
    ...overrides
  };
}

function nodeRequest(ws: Workspace, overrides: Partial<WorkflowChildExecutionRequest> = {}): WorkflowChildExecutionRequest {
  return {
    runId: "run-1",
    executionId: "exec-1",
    nodeId: "n1",
    nodeTitle: "实施",
    attempt: 1,
    ownerSessionId: "owner-1",
    config: nodeConfig(ws.model),
    prompt: "请完成这一步",
    ...overrides
  };
}

function adapterOptions(ws: Workspace, overrides: Partial<WorkflowChildAdapterOptions> = {}): WorkflowChildAdapterOptions {
  return {
    workspace: ws.root,
    agentDir: ws.agentDir,
    agent: agentProfile(),
    modelRuntime: ws.modelRuntime,
    requestPermission: async () => "allow-once",
    ...overrides
  };
}

/** 把适配器的权限入口接到真实 PermissionBroker（带 workflow scope 的 principal）。 */
function brokerHandler(broker: PermissionBroker): (request: WorkflowChildPermissionRequest) => Promise<PermissionDecision> {
  return async (request) => await broker.request({
    accessMode: "ask",
    toolName: request.toolName,
    summary: `工作流节点「${request.node.nodeTitle}」：${request.toolName}`,
    args: request.args,
    risk: request.toolName === "bash" ? "command" : "write",
    principal: {
      kind: "subagent",
      sessionId: "owner-1",
      parentSessionId: "owner-1",
      workflow: {
        runId: request.node.runId,
        nodeId: request.node.nodeId,
        attempt: request.node.attempt,
        nodeTitle: request.node.nodeTitle
      }
    },
    timeoutMs: WORKFLOW_PERMISSION_TIMEOUT_MS
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function jsonlFiles(ws: Workspace, request: WorkflowChildExecutionRequest, options: WorkflowChildAdapterOptions): string[] {
  const directory = workflowChildSessionDirectory(options, request);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".jsonl"));
}

describe("workflow child adapter over a real AgentSession", () => {
  it("真实创建 → agent_settled 结算 → JSONL 落盘 → 会话释放", async () => {
    const ws = await makeWorkspace();
    const text = "第一行\n\n- 列表项\n```ts\nconst a = 1;\n```\n";
    ws.faux.setResponses([fauxAssistantMessage(text)]);
    const options = adapterOptions(ws);
    const created: { record: WorkflowChildSessionCreated; disposed: number }[] = [];
    const executor = createWorkflowChildExecutor({
      ...options,
      createChildSession: async (context) => {
        const record = await createWorkflowChildSession(options, context);
        const entry = { record, disposed: 0 };
        const dispose = record.dispose;
        record.dispose = () => {
          entry.disposed += 1;
          dispose();
        };
        created.push(entry);
        return record;
      }
    });
    const request = nodeRequest(ws, { prompt: "请写一段带换行的说明" });
    const outcome = await executor(request);

    expect(outcome.status).toBe("completed");
    // 保留换行：Markdown/代码块逐字交接，未经折叠空白。
    expect(outcome.text).toBe(text);
    expect(outcome.stopReason).toBe("stop");
    expect(outcome.sessionId).toBeTruthy();
    expect(outcome.sessionFile).toBeTruthy();

    // 独立目录 + SDK 返回的真实文件名（<timestamp>_<sessionId>.jsonl）。
    const files = jsonlFiles(ws, request, options);
    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith(`_${outcome.sessionId}.jsonl`)).toBe(true);
    expect(existsSync(outcome.sessionFile!)).toBe(true);
    const transcript = readFileSync(outcome.sessionFile!, "utf8");
    expect(transcript).toContain("请写一段带换行的说明");
    expect(transcript).toContain("const a = 1;");
    expect(transcript).toContain('"role":"user"');
    // session header：parentSession 只作关联信息（owner），cwd 是用户工作区。
    expect(transcript).toContain('"parentSession":"owner-1"');
    expect(transcript).toContain(`"cwd":${JSON.stringify(ws.root)}`);

    // 会话已释放，且清理报告确认（运行器据此才敢把 run 标成 stopped/completed）。
    expect(created).toHaveLength(1);
    expect(created[0]?.disposed).toBe(1);
    expect(outcome.cleanup).toMatchObject({
      confirmed: true,
      listenersReleased: true,
      timersCleared: true,
      sessionDisposed: true,
      abortAcknowledged: true,
      errors: []
    });
    // 确认过的清理不需要迟到确认入口（新接口只在未确认时提供）。
    expect(outcome.retryCleanup).toBeUndefined();
    expect(outcome.cleanupSettled).toBeUndefined();
  }, 20_000);

  it("真实创建配方：cacheWarming 关闭、只激活白名单工具、没有递归编排工具", async () => {
    const ws = await makeWorkspace();
    const browserTool: ToolDefinition = defineTool({
      name: "browser_navigate",
      label: "打开页面",
      description: "打开一个页面（测试替身）",
      parameters: Type.Object({ url: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} })
    });
    const options = adapterOptions(ws, { buildBrowserTools: () => [browserTool] });
    const request = nodeRequest(ws, { config: nodeConfig(ws.model, { tools: ["read"], browserTools: true }) });
    const record = await createWorkflowChildSession(options, {
      request,
      requestPermission: async () => "allow-once"
    });
    try {
      const session = record.handle as unknown as AgentSession;
      // 无人值守节点不能替用户烧 token 保温前缀缓存。
      expect(session.settingsManager.getCacheWarmingMode()).toBe("off");
      // 激活集 = 冻结的原生工具 + 显式注入的浏览器工具，没有别的。
      expect(session.getActiveToolNames().sort()).toEqual(["browser_navigate", "read"]);
      const names = session.getAllTools().map((tool) => tool.name);
      expect(names).not.toContain("delegate_agent");
      expect(names.some((name) => name.startsWith("team_"))).toBe(false);
      expect(names.some((name) => name.startsWith("workflow_"))).toBe(false);
      // 冻结系统提示进入会话。
      expect(session.systemPrompt).toContain("你是工作流节点执行者");
      // 会话 id / 文件来自 SDK，不是猜的。
      expect(record.sessionId).toBe(session.sessionId);
      expect(record.sessionFile.endsWith(`_${session.sessionId}.jsonl`)).toBe(true);
    } finally {
      record.dispose();
    }

    // 没声明浏览器能力时不挂（同一来源工具集，注入是显式的）。
    const plain = await createWorkflowChildSession(options, {
      request: nodeRequest(ws, { config: nodeConfig(ws.model, { tools: ["read"], browserTools: false }) }),
      requestPermission: async () => "allow-once"
    });
    try {
      const session = plain.handle as unknown as AgentSession;
      expect(session.getActiveToolNames()).toEqual(["read"]);
      expect(session.getAllTools().map((tool) => tool.name)).not.toContain("browser_navigate");
    } finally {
      plain.dispose();
    }
  }, 20_000);

  it("每次执行一个新会话：attempt 1/2 各自落盘，gate 文本能走通 retry → pass", async () => {
    const ws = await makeWorkspace();
    ws.faux.setResponses([
      fauxAssistantMessage('{"verdict":"retry","reason":"测试仍有两个失败用例，需要修复后重新验证"}'),
      fauxAssistantMessage('```json\n{"verdict":"pass","reason":"全部通过"}\n```')
    ]);
    const options = adapterOptions(ws);
    const executor = createWorkflowChildExecutor(options);
    const gateConfig = nodeConfig(ws.model, { tools: [] });
    const first = await executor(nodeRequest(ws, { nodeId: "gate", nodeTitle: "验收", config: gateConfig, prompt: "判定第 1 轮" }));
    const second = await executor(nodeRequest(ws, {
      nodeId: "gate",
      nodeTitle: "验收",
      attempt: 2,
      executionId: "exec-2",
      config: gateConfig,
      prompt: "判定第 2 轮"
    }));

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.sessionFile).not.toBe(second.sessionFile);
    expect(existsSync(first.sessionFile!)).toBe(true);
    expect(existsSync(second.sessionFile!)).toBe(true);

    const firstDecision = parseGateDecision(first.text!);
    const secondDecision = parseGateDecision(second.text!);
    expect(firstDecision.ok && firstDecision.decision.verdict).toBe("retry");
    expect(secondDecision.ok && secondDecision.decision.verdict).toBe("pass");
  }, 20_000);

  it("权限拒绝：工具被拦下、命令没执行，节点记技术失败", async () => {
    const ws = await makeWorkspace();
    const marker = `pwned-${process.pid}.txt`;
    ws.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: `node -e "require('fs').writeFileSync('${marker}','x')"` })]),
      fauxAssistantMessage("已经用别的方式完成")
    ]);
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => requests.push(request));
    const executor = createWorkflowChildExecutor(adapterOptions(ws, { requestPermission: brokerHandler(broker) }));
    const running = executor(nodeRequest(ws, { prompt: "跑一下测试", config: nodeConfig(ws.model, { tools: ["bash"] }) }));
    await waitFor(() => requests.length === 1);
    expect(requests[0]?.principal.workflow).toMatchObject({ runId: "run-1", nodeId: "n1", attempt: 1 });
    broker.resolve(requests[0]!.id, "deny");

    const outcome = await running;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("权限被拒绝");
    // 权限门在工具执行前拦截：命令没有真的跑。
    expect(existsSync(join(ws.root, marker))).toBe(false);
    expect(outcome.cleanup.confirmed).toBe(true);
  }, 20_000);

  it("权限等待中停止：取消本 run 权限后 abort 收场，清理已确认", async () => {
    const ws = await makeWorkspace();
    ws.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo should-not-run" })]),
      fauxAssistantMessage("完成")
    ]);
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => requests.push(request));
    const executor = createWorkflowChildExecutor(adapterOptions(ws, { requestPermission: brokerHandler(broker) }));
    const statuses: string[] = [];
    const controller = new AbortController();
    // §7.3 顺序：先取消本 run 的权限等待，再 abort 当前 child。
    controller.signal.addEventListener("abort", () => broker.cancelWorkflow("run-1"));
    const running = executor({
      ...nodeRequest(ws, { prompt: "跑一下测试", config: nodeConfig(ws.model, { tools: ["bash"] }) }),
      signal: controller.signal,
      onStatus: (status) => statuses.push(status)
    });
    await waitFor(() => requests.length === 1 && statuses.includes("waiting_permission"));
    controller.abort();

    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(outcome.error).toBeUndefined();
    expect(statuses).toContain("waiting_permission");
    expect(outcome.cleanup).toMatchObject({
      confirmed: true,
      listenersReleased: true,
      timersCleared: true,
      sessionDisposed: true,
      abortAcknowledged: true,
      errors: []
    });
    expect(outcome.retryCleanup).toBeUndefined();
  }, 20_000);

  it("工具卡住时 abort 宽限内无法确认：迟到收场后 cleanupSettled 推送确认（真实链路）", async () => {
    const ws = await makeWorkspace();
    ws.faux.setResponses([fauxAssistantMessage([fauxToolCall("workflow_block", {})])]);
    let blockStarted = false;
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const blockingTool: ToolDefinition = defineTool({
      name: "workflow_block",
      label: "阻塞工具",
      description: "阻塞到测试放行为止（模拟不退出的工具）",
      parameters: Type.Object({}),
      execute: async () => {
        blockStarted = true;
        await gate;
        return { content: [{ type: "text", text: "unblocked" }], details: {} };
      }
    });
    const executor = createWorkflowChildExecutor(adapterOptions(ws, {
      abortGraceMs: 1_500,
      buildBrowserTools: () => [blockingTool]
    }));
    const controller = new AbortController();
    const running = executor({
      ...nodeRequest(ws, { prompt: "调用阻塞工具", config: nodeConfig(ws.model, { tools: [], browserTools: true }) }),
      signal: controller.signal
    });
    await waitFor(() => blockStarted, 10_000);
    controller.abort();

    // 工具不退出：abort 在宽限内无法确认，清理如实报告未确认（不假报停止完成）。
    const outcome = await running;
    expect(outcome.status).toBe("stopped");
    expect(outcome.cleanup.confirmed).toBe(false);
    expect(outcome.cleanup.abortAcknowledged).toBe(false);
    expect(outcome.cleanup.errors.join("\n")).toContain("确认停止");
    expect(typeof outcome.retryCleanup).toBe("function");
    expect(outcome.cleanupSettled).toBeInstanceOf(Promise);

    // 工具退出、agent 收场：迟到确认经推送通道送达，会话已回收。
    unblock();
    const settled = await outcome.cleanupSettled!;
    expect(settled.confirmed).toBe(true);
    expect(settled.abortAcknowledged).toBe(true);
    expect(settled.sessionDisposed).toBe(true);
    expect(settled.errors).toEqual([]);
  }, 20_000);
});

/* ── 真实自动返工链路（运行器 + 真实子会话） ───────────────────────────────── */

const WORKFLOW_TERMINAL_STATUSES = new Set<string>(["completed", "rejected", "stopped", "failed", "interrupted"]);

/** P → R → gate → S，返工区间是 R + gate（workflow-runtime 的 prefix/region/suffix 口径）。 */
function reworkWorkflow(): WorkflowDefinition {
  const node = (id: string, title: string, kind: WorkflowNode["kind"], prompt: string): WorkflowNode => ({
    id, title, kind, prompt, position: { x: 0, y: 0 }, exec: { kind: "agent" }
  });
  return {
    version: 1,
    id: "wf-rework-e2e",
    name: "返工链路",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      node("plan", "规划", "task", "【规划】拆出三步计划：{{input}}"),
      node("work", "实施", "task", "【实施】第 {{attempt}} 轮完成改动。上一轮验收反馈：{{retry_feedback}}"),
      node("gate", "验收", "gate", "【验收】判定第 {{attempt}} 轮实施：{{work}}"),
      node("output", "交付", "output", "【交付】汇总最终实现：{{work}}")
    ],
    edges: [
      { id: "e1", from: "plan", to: "work" },
      { id: "e2", from: "work", to: "gate" },
      { id: "e3", from: "gate", to: "output" }
    ],
    rework: { entryNodeId: "work", gateNodeId: "gate", maxAttempts: 3 }
  };
}

const PROMPT_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["【规划】", "plan"],
  ["【实施】", "work"],
  ["【验收】", "gate"],
  ["【交付】", "output"]
];

const NODE_MARKERS: ReadonlyMap<string, string> = new Map(PROMPT_MARKERS.map(([marker, node]) => [node, marker]));

/** 运行器把节点提示词与「执行轮号：N」写在同一条用户消息里；这里认回节点与轮号。 */
function classifyPrompt(text: string): { node: string; attempt: number } {
  const node = PROMPT_MARKERS.find(([marker]) => text.includes(marker))?.[1] ?? "unknown";
  const attempt = Number(/执行轮号：(\d+)/u.exec(text)?.[1] ?? Number.NaN);
  return { node, attempt };
}

function lastUserText(context: TranscriptContext): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  }
  return "";
}

/** 按「节点 + 轮号」应答的固定剧本：第一轮验收 retry，第二轮 pass。 */
function fauxReply(node: string, attempt: number): string {
  if (node === "plan") return "规划产物：读代码 / 改实现 / 跑测试";
  if (node === "work") return attempt === 1 ? "实施产物（第 1 轮）：初版实现" : "实施产物（第 2 轮）：修复后实现";
  if (node === "gate") return attempt === 1
    ? '{"verdict":"retry","reason":"仍有两个失败用例"}'
    : '```json\n{"verdict":"pass","reason":"全部通过"}\n```';
  if (node === "output") return "交付产物：实现已通过验收";
  throw new Error(`未预期的节点调用：${node}:${attempt}`);
}

/** 等到运行器落下终态（不假定耗时，只给一个宽上限）。 */
async function waitForTerminal(runtime: WorkflowRuntime, timeoutMs = 30_000): Promise<WorkflowRun> {
  const started = Date.now();
  for (;;) {
    const snapshot = runtime.snapshot();
    if (snapshot && WORKFLOW_TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`工作流未在 ${timeoutMs}ms 内结束（当前 ${snapshot?.status ?? "无快照"}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("workflow runtime end-to-end over real AgentSessions", () => {
  it("自动跑完 P/R/S：区间 retry → pass，前缀与后缀各一次，每次执行独立真实会话", async () => {
    const ws = await makeWorkspace();
    const agent = agentProfile();
    const definition = reworkWorkflow();
    const calls: { node: string; attempt: number; prompt: string }[] = [];
    // 同一份无状态 responder 排队 6 份：每次模型调用按「节点 + 轮号」应答，不依赖调用顺序；
    // 队列耗尽会变成「No more faux responses queued」，多出的调用不会静默通过。
    const respond = (context: TranscriptContext) => {
      const prompt = lastUserText(context);
      const { node, attempt } = classifyPrompt(prompt);
      calls.push({ node, attempt, prompt });
      return fauxAssistantMessage(fauxReply(node, attempt));
    };
    ws.faux.setResponses(Array.from({ length: 6 }, () => respond));

    const options = adapterOptions(ws, { agent });
    const store = new WorkflowRunStore({ agentDir: ws.agentDir });
    const runtime = new WorkflowRuntime({
      workspace: ws.root,
      agentId: agent.id,
      ownerSessionId: "owner-1",
      coordinator: createWorkflowCoordinator({ agentDir: ws.agentDir }),
      store,
      executeChild: createWorkflowChildExecutor(options),
      cancelPermissions: () => {}
    });
    const configs = definition.nodes.map((node) => {
      const tools: WorkflowChildNodeConfig["tools"] = node.kind === "gate" ? [] : ["read"];
      return nodeConfig(ws.model, { nodeId: node.id, tools, systemPrompt: `你是工作流节点「${node.title}」的执行者。` });
    });
    const accepted = runtime.start({ definition, definitionHash: "hash-e2e", input: "把会话列表改成分页加载", configs });
    // 受理即可返回；节点只由运行器推进（没有任何手动重跑 gate）。
    expect(accepted.status).toBe("starting");
    expect(calls).toHaveLength(0);

    const run = await waitForTerminal(runtime);

    // ① 自动链路：P 一次 → 区间两轮（work + gate）→ S 一次。
    expect(calls.map((call) => `${call.node}:${call.attempt}`)).toEqual([
      "plan:1", "work:1", "gate:1", "work:2", "gate:2", "output:2"
    ]);
    expect(ws.faux.state.callCount).toBe(6);

    // ② 状态 completed（真实清理确认后才落终态）。
    expect(run.status).toBe("completed");
    expect(run.error).toBeUndefined();
    expect(run.endedAt).toBeGreaterThan(0);
    expect(run.currentAttempt).toBe(2);
    expect(run.maxAttempts).toBe(3);
    expect(runtime.hasActiveRun()).toBe(false);

    // ③ 执行记录：prefix/output 仅一次，区间两轮，没有 skipped。
    const attemptsOf = (nodeId: string): string[] => run.executions
      .filter((execution) => execution.nodeId === nodeId)
      .map((execution) => `${execution.attempt}:${execution.status}`);
    expect(attemptsOf("plan")).toEqual(["1:completed"]);
    expect(attemptsOf("work")).toEqual(["1:completed", "2:completed"]);
    expect(attemptsOf("gate")).toEqual(["1:completed", "2:completed"]);
    expect(attemptsOf("output")).toEqual(["2:completed"]);
    expect(run.executions).toHaveLength(6);

    // ④ gate 决策落记录：第一轮 retry、第二轮 pass（内存 + run.json）。
    const gates = run.executions.filter((execution) => execution.nodeId === "gate");
    expect(gates.map((execution) => execution.decision)).toEqual([
      { verdict: "retry", reason: "仍有两个失败用例" },
      { verdict: "pass", reason: "全部通过" }
    ]);
    const persisted = store.get(run.runId);
    expect(persisted.status).toBe("completed");
    expect(persisted.executions.filter((execution) => execution.nodeId === "gate")
      .map((execution) => execution.decision?.verdict)).toEqual(["retry", "pass"]);
    const runFile = readFileSync(join(store.runsRoot, run.runId, "run.json"), "utf8");
    expect(runFile).toContain('"verdict": "retry"');
    expect(runFile).toContain('"verdict": "pass"');

    // ⑤ 每次执行一个真实独立会话：不同 sessionId / 文件 / 目录，JSONL 头部可核验。
    expect(new Set(run.executions.map((execution) => execution.sessionId)).size).toBe(6);
    expect(new Set(run.executions.map((execution) => execution.sessionFile)).size).toBe(6);
    for (const execution of run.executions) {
      expect(execution.sessionId).toBeTruthy();
      expect(execution.sessionFile?.endsWith(`_${execution.sessionId}.jsonl`)).toBe(true);
      const sessionFile = execution.sessionFile!;
      expect(existsSync(sessionFile)).toBe(true);
      const directory = workflowChildSessionDirectory(options, {
        ownerSessionId: "owner-1", runId: run.runId, attempt: execution.attempt, nodeId: execution.nodeId
      });
      expect(dirname(sessionFile)).toBe(directory);
      expect(readdirSync(directory).filter((file) => file.endsWith(".jsonl"))).toEqual([basename(sessionFile)]);
      // 运行记录里的会话文件能按 header（id / cwd / parentSession）归属核验并读出真实消息。
      const transcript = store.readTranscript(run.runId, execution.executionId, 0, 20);
      const userText = transcript.messages
        .filter((message) => message.role === "user")
        .map((message) => message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"))
        .join("\n");
      // 独立性不只看 id/路径：这份 JSONL 里只有本节点的提示词痕迹，没有其他节点的会话消息。
      expect(userText).toContain(NODE_MARKERS.get(execution.nodeId)!);
      for (const [nodeId, marker] of NODE_MARKERS) {
        if (nodeId !== execution.nodeId) expect(userText).not.toContain(marker);
      }
    }

    // ⑥ 返工反馈进入第二轮消息；gate / output 读到的是本轮产物，不是上一轮。
    const promptOf = (node: string, attempt: number): string =>
      calls.find((call) => call.node === node && call.attempt === attempt)!.prompt;
    expect(promptOf("work", 1)).not.toContain("仍有两个失败用例");
    expect(promptOf("work", 2)).toContain("上一轮验收反馈");
    expect(promptOf("work", 2)).toContain("仍有两个失败用例");
    expect(promptOf("work", 2)).toContain(join("a1", "work.txt"));
    expect(promptOf("gate", 1)).toContain("实施产物（第 1 轮）");
    expect(promptOf("gate", 2)).toContain("实施产物（第 2 轮）");
    expect(promptOf("gate", 2)).not.toContain("实施产物（第 1 轮）");
    expect(promptOf("output", 2)).toContain("实施产物（第 2 轮）");

    // ⑦ 产物落盘可回读：suffix 写最后一轮，gate 决策文本原样保存。
    const secondWork = run.executions.find((execution) => execution.nodeId === "work" && execution.attempt === 2)!;
    const passGate = run.executions.find((execution) => execution.nodeId === "gate" && execution.attempt === 2)!;
    const outputExecution = run.executions.find((execution) => execution.nodeId === "output")!;
    expect(store.readArtifact(run.runId, secondWork.executionId)).toBe("实施产物（第 2 轮）：修复后实现");
    expect(store.readArtifact(run.runId, passGate.executionId)).toContain('"verdict":"pass"');
    expect(store.readArtifact(run.runId, outputExecution.executionId)).toBe("交付产物：实现已通过验收");
    for (const execution of run.executions) expect(existsSync(execution.artifactPath!)).toBe(true);

    // ⑧ 收尾放锁：同工作区可以被下一个 run 立即抢到。
    const contender = createWorkflowCoordinator({ agentDir: ws.agentDir });
    const reacquired = contender.acquire({ workspace: ws.root, runId: "wr-after-e2e" });
    expect(reacquired.ok).toBe(true);
    if (reacquired.ok) expect(reacquired.lease.release().ok).toBe(true);
  }, 60_000);
});
