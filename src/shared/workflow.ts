import type { AccessMode, BuiltinToolName, SubagentDefinition, ThinkingLevel } from "./protocol.js";

export const WORKFLOW_VERSION = 1 as const;
export const MAX_WORKFLOW_NODES = 32;
export const MAX_WORKFLOW_EDGES = 64;
export const MAX_WORKFLOWS_PER_WORKSPACE = 100;
export const MAX_WORKFLOW_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_WORKFLOW_NAME_LENGTH = 64;
export const MAX_WORKFLOW_NODE_TITLE_LENGTH = 40;
export const MAX_WORKFLOW_PROMPT_LENGTH = 8_000;
export const MAX_WORKFLOW_INPUT_BYTES = 16 * 1024;
export const MAX_WORKFLOW_ATTEMPTS = 5;
export const DEFAULT_WORKFLOW_ATTEMPTS = 3;
export const MAX_WORKFLOW_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_WORKFLOW_INLINE_ARTIFACT_BYTES = 8 * 1024;
export const MAX_WORKFLOW_INLINE_CONTEXT_BYTES = 24 * 1024;
export const MAX_WORKFLOW_NODE_MESSAGE_BYTES = 64 * 1024;
export const WORKFLOW_NODE_TIMEOUT_MS = 30 * 60 * 1000;
export const WORKFLOW_RUN_TIMEOUT_MS = 120 * 60 * 1000;
export const WORKFLOW_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

export type WorkflowNodeKind = "task" | "review" | "gate" | "output";
export type WorkflowExecutionKind = "agent" | "subagent";
export type WorkflowLayoutMode = "auto" | "manual";

export interface WorkflowModelRef {
  provider: string;
  id: string;
}

export interface WorkflowNodeExecution {
  kind: WorkflowExecutionKind;
  subagent?: string;
  model?: WorkflowModelRef;
  thinkingLevel?: ThinkingLevel;
  tools?: BuiltinToolName[];
  accessModeCap?: AccessMode;
}

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  title: string;
  role?: string;
  kind: WorkflowNodeKind;
  prompt: string;
  position: WorkflowNodePosition;
  exec: WorkflowNodeExecution;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface WorkflowRework {
  entryNodeId: string;
  gateNodeId: string;
  /** 总执行轮数，而不是额外返工次数。 */
  maxAttempts: number;
}

export interface WorkflowDefinition {
  version: typeof WORKFLOW_VERSION;
  id: string;
  name: string;
  description?: string;
  whenToUse?: string;
  inputHint?: string;
  /** 编辑器排版偏好。缺省保留旧定义，由画布识别旧编辑器的初始位置。 */
  layout?: WorkflowLayoutMode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  rework?: WorkflowRework;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowRunStatus = "starting" | "running" | "stopping" | "completed" | "rejected" | "stopped" | "failed" | "interrupted";
export type WorkflowExecutionStatus = "pending" | "starting" | "running" | "waiting_permission" | "completed" | "failed" | "stopped" | "skipped";

/** 运行启动时冻结的非敏感配置；凭据与 SDK 对象不能入盘。 */
export interface WorkflowResolvedNodeConfig {
  nodeId: string;
  source: WorkflowExecutionKind;
  subagent?: string;
  model: WorkflowModelRef;
  thinkingLevel: ThinkingLevel;
  tools: BuiltinToolName[];
  accessModeCap?: AccessMode;
  browserTools?: boolean;
  injectAgentsMd?: boolean;
}

export interface WorkflowExecution {
  executionId: string;
  nodeId: string;
  nodeTitle: string;
  attempt: number;
  status: WorkflowExecutionStatus;
  startedAt?: number;
  endedAt?: number;
  sessionId?: string;
  /** SDK 返回的真实文件路径，仅后端可据记录读取。 */
  sessionFile?: string;
  artifactPath?: string;
  decision?: GateDecision;
  error?: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  workflowName: string;
  workspace: string;
  agentId: string;
  ownerSessionId: string;
  ownerSessionFile?: string;
  definitionHash: string;
  runnerInstanceId: string;
  runnerPid: number;
  status: WorkflowRunStatus;
  startedAt: number;
  endedAt?: number;
  currentAttempt: number;
  maxAttempts: number;
  currentExecutionId?: string;
  executions: WorkflowExecution[];
  resolvedNodes: WorkflowResolvedNodeConfig[];
  error?: string;
}

export interface WorkflowDiagnostic {
  code: string;
  message: string;
  path?: string;
  nodeId?: string;
  edgeId?: string;
  severity?: "error" | "warning";
}

export interface WorkflowNormalizationResult {
  ok: boolean;
  definition?: WorkflowDefinition;
  errors: WorkflowDiagnostic[];
  warnings: WorkflowDiagnostic[];
}

export interface WorkflowNormalizeOptions {
  /** 由存储层传入实际 JSON UTF-8 体积；未传时按 input 序列化估算。 */
  serializedBytes?: number;
  /** 草稿创建时允许缺省的存储元数据，由调用方之后补齐。 */
  allowMissingMetadata?: boolean;
}

export interface WorkflowRunValidationContext {
  subagents?: readonly SubagentDefinition[];
  availableModels?: readonly WorkflowModelRef[];
  sourceTools?: readonly BuiltinToolName[];
  ownerAccessMode?: AccessMode;
}

export interface WorkflowRunValidationResult {
  ok: boolean;
  errors: WorkflowDiagnostic[];
  warnings: WorkflowDiagnostic[];
  plan?: CompiledWorkflowPlan;
  topologicalOrder?: string[];
}

export interface CompiledWorkflowPlan {
  entryNodeId: string;
  exitNodeId: string;
  topologicalOrder: string[];
  prefixNodeIds: string[];
  regionNodeIds: string[];
  suffixNodeIds: string[];
  rework?: WorkflowRework;
}

export interface WorkflowTemplateReference {
  raw: string;
  kind: "input" | "attempt" | "retry_feedback" | "node";
  nodeId?: string;
  start: number;
  end: number;
}

export interface WorkflowTemplateValues {
  input?: string;
  attempt?: number;
  retryFeedback?: string;
  nodes?: Record<string, string>;
}

export interface GateDecision {
  verdict: "pass" | "retry";
  reason: string;
}

export type GateDecisionParseResult = { ok: true; decision: GateDecision } | { ok: false; error: string };

const NODE_KINDS = new Set<WorkflowNodeKind>(["task", "review", "gate", "output"]);
const EXECUTION_KINDS = new Set<WorkflowExecutionKind>(["agent", "subagent"]);
const ACCESS_RANK: Record<AccessMode, number> = {
  "read-only": 0,
  ask: 1,
  workspace: 2,
  full: 3
};
const BUILTIN_TOOLS = new Set<BuiltinToolName>(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/gu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function diagnostic(code: string, message: string, path?: string, extra?: Partial<WorkflowDiagnostic>): WorkflowDiagnostic {
  return { code, message, ...(path ? { path } : {}), ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, path: string, max: number, errors: WorkflowDiagnostic[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    errors.push(diagnostic("invalid-text", `${path} 必须是字符串`, path));
    return undefined;
  }
  if (value.length > max) errors.push(diagnostic("text-too-long", `${path} 超过 ${max} 字符`, path));
  return value;
}

function requiredText(value: unknown, path: string, max: number, errors: WorkflowDiagnostic[]): string {
  if (typeof value !== "string") {
    errors.push(diagnostic("invalid-text", `${path} 必须是字符串`, path));
    return "";
  }
  if (value.length > max) errors.push(diagnostic("text-too-long", `${path} 超过 ${max} 字符`, path));
  return value;
}

function requiredId(value: unknown, path: string, errors: WorkflowDiagnostic[]): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    errors.push(diagnostic("invalid-id", `${path} 必须是字母、数字、下划线或连字符组成的稳定 id`, path));
    return typeof value === "string" ? value : "";
  }
  return value;
}

function numberValue(value: unknown, path: string, errors: WorkflowDiagnostic[]): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(diagnostic("invalid-number", `${path} 必须是有限数字`, path));
    return 0;
  }
  return value;
}

function normalizeNode(value: unknown, index: number, errors: WorkflowDiagnostic[]): WorkflowNode {
  const path = `nodes[${index}]`;
  if (!isRecord(value)) {
    errors.push(diagnostic("invalid-node", `${path} 必须是对象`, path));
    return {
      id: `invalid-${index}`,
      title: "",
      kind: "task",
      prompt: "",
      position: { x: 0, y: 0 },
      exec: { kind: "agent" }
    };
  }
  const id = requiredId(value.id, `${path}.id`, errors);
  const title = requiredText(value.title, `${path}.title`, MAX_WORKFLOW_NODE_TITLE_LENGTH, errors);
  const kind = value.kind as WorkflowNodeKind;
  if (!NODE_KINDS.has(kind)) errors.push(diagnostic("invalid-node-kind", `${path}.kind 不是支持的节点类型`, `${path}.kind`));
  const prompt = requiredText(value.prompt, `${path}.prompt`, MAX_WORKFLOW_PROMPT_LENGTH, errors);
  const positionValue = isRecord(value.position) ? value.position : {};
  if (!isRecord(value.position)) errors.push(diagnostic("invalid-position", `${path}.position 必须是对象`, `${path}.position`));
  const position = {
    x: numberValue(positionValue.x, `${path}.position.x`, errors),
    y: numberValue(positionValue.y, `${path}.position.y`, errors)
  };
  const execValue = isRecord(value.exec) ? value.exec : {};
  if (!isRecord(value.exec)) errors.push(diagnostic("invalid-exec", `${path}.exec 必须是对象`, `${path}.exec`));
  const execKind = execValue.kind as WorkflowExecutionKind;
  if (!EXECUTION_KINDS.has(execKind)) errors.push(diagnostic("invalid-exec-kind", `${path}.exec.kind 不是 agent 或 subagent`, `${path}.exec.kind`));
  const exec: WorkflowNodeExecution = { kind: execKind === "subagent" ? "subagent" : "agent" };
  if (execValue.subagent !== undefined) exec.subagent = requiredText(execValue.subagent, `${path}.exec.subagent`, 128, errors);
  if (execValue.model !== undefined) {
    const model = isRecord(execValue.model) ? execValue.model : {};
    if (!isRecord(execValue.model)) errors.push(diagnostic("invalid-model", `${path}.exec.model 必须是对象`, `${path}.exec.model`));
    exec.model = {
      provider: requiredText(model.provider, `${path}.exec.model.provider`, 128, errors),
      id: requiredText(model.id, `${path}.exec.model.id`, 256, errors)
    };
  }
  if (execValue.thinkingLevel !== undefined) {
    const level = execValue.thinkingLevel as ThinkingLevel;
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
      errors.push(diagnostic("invalid-thinking-level", `${path}.exec.thinkingLevel 不是支持的思考档位`, `${path}.exec.thinkingLevel`));
    } else exec.thinkingLevel = level;
  }
  if (execValue.tools !== undefined) {
    if (!Array.isArray(execValue.tools)) {
      errors.push(diagnostic("invalid-tools", `${path}.exec.tools 必须是数组`, `${path}.exec.tools`));
    } else {
      const tools: BuiltinToolName[] = [];
      for (const [toolIndex, tool] of execValue.tools.entries()) {
        if (typeof tool !== "string" || !BUILTIN_TOOLS.has(tool as BuiltinToolName)) {
          errors.push(diagnostic("invalid-tool", `${path}.exec.tools[${toolIndex}] 不是内置工具名`, `${path}.exec.tools[${toolIndex}]`));
        } else if (!tools.includes(tool as BuiltinToolName)) tools.push(tool as BuiltinToolName);
      }
      exec.tools = tools;
    }
  }
  if (execValue.accessModeCap !== undefined) {
    const cap = execValue.accessModeCap as AccessMode;
    if (typeof cap !== "string" || !Object.hasOwn(ACCESS_RANK, cap)) errors.push(diagnostic("invalid-access-cap", `${path}.exec.accessModeCap 不是支持的访问模式`, `${path}.exec.accessModeCap`));
    else exec.accessModeCap = cap;
  }
  const role = optionalText(value.role, `${path}.role`, 128, errors);
  return {
    id,
    title,
    ...(role !== undefined ? { role } : {}),
    kind: NODE_KINDS.has(kind) ? kind : "task",
    prompt,
    position,
    exec
  };
}

export function normalizeWorkflowDraft(input: unknown, options: WorkflowNormalizeOptions = {}): WorkflowNormalizationResult {
  const errors: WorkflowDiagnostic[] = [];
  const warnings: WorkflowDiagnostic[] = [];
  if (!isRecord(input)) return { ok: false, errors: [diagnostic("invalid-definition", "工作流定义必须是对象")], warnings };
  const version = input.version;
  if (version !== WORKFLOW_VERSION) errors.push(diagnostic("unsupported-version", `只支持工作流版本 ${WORKFLOW_VERSION}`, "version"));
  const id = requiredId(input.id, "id", errors);
  const name = requiredText(input.name, "name", MAX_WORKFLOW_NAME_LENGTH, errors);
  const description = optionalText(input.description, "description", 2_000, errors);
  const whenToUse = optionalText(input.whenToUse, "whenToUse", 2_000, errors);
  const inputHint = optionalText(input.inputHint, "inputHint", 2_000, errors);
  const layout = input.layout === "auto" || input.layout === "manual" ? input.layout : undefined;
  if (input.layout !== undefined && layout === undefined) {
    errors.push(diagnostic("invalid-layout", "layout 必须是 auto 或 manual", "layout"));
  }
  const rawNodes = input.nodes;
  const nodes: WorkflowNode[] = [];
  if (!Array.isArray(rawNodes)) errors.push(diagnostic("invalid-nodes", "nodes 必须是数组", "nodes"));
  else {
    if (rawNodes.length > MAX_WORKFLOW_NODES) errors.push(diagnostic("too-many-nodes", `节点数不能超过 ${MAX_WORKFLOW_NODES}`, "nodes"));
    rawNodes.forEach((node, index) => nodes.push(normalizeNode(node, index, errors)));
  }
  const nodeIds = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (nodeIds.has(node.id)) errors.push(diagnostic("duplicate-node-id", `节点 id 重复：${node.id}`, `nodes[${index}].id`, { nodeId: node.id }));
    nodeIds.add(node.id);
  }
  const rawEdges = input.edges;
  const edges: WorkflowEdge[] = [];
  if (!Array.isArray(rawEdges)) errors.push(diagnostic("invalid-edges", "edges 必须是数组", "edges"));
  else {
    if (rawEdges.length > MAX_WORKFLOW_EDGES) errors.push(diagnostic("too-many-edges", `普通边不能超过 ${MAX_WORKFLOW_EDGES}`, "edges"));
    const edgeIds = new Set<string>();
    for (const [index, value] of rawEdges.entries()) {
      const path = `edges[${index}]`;
      if (!isRecord(value)) {
        errors.push(diagnostic("invalid-edge", `${path} 必须是对象`, path));
        continue;
      }
      if (value.kind !== undefined && value.kind !== "flow") {
        errors.push(diagnostic("unsupported-edge-kind", `不支持旧版或未知的边类型：${String(value.kind)}`, `${path}.kind`));
      }
      const edge: WorkflowEdge = {
        id: requiredId(value.id, `${path}.id`, errors),
        from: requiredId(value.from, `${path}.from`, errors),
        to: requiredId(value.to, `${path}.to`, errors)
      };
      const label = optionalText(value.label, `${path}.label`, 200, errors);
      if (label !== undefined) edge.label = label;
      if (edgeIds.has(edge.id)) errors.push(diagnostic("duplicate-edge-id", `边 id 重复：${edge.id}`, `${path}.id`, { edgeId: edge.id }));
      edgeIds.add(edge.id);
      if (edge.from && !nodeIds.has(edge.from)) errors.push(diagnostic("missing-edge-source", `边 ${edge.id} 的起点不存在：${edge.from}`, `${path}.from`, { edgeId: edge.id }));
      if (edge.to && !nodeIds.has(edge.to)) errors.push(diagnostic("missing-edge-target", `边 ${edge.id} 的终点不存在：${edge.to}`, `${path}.to`, { edgeId: edge.id }));
      edges.push(edge);
    }
  }
  let rework: WorkflowRework | undefined;
  if (input.rework !== undefined) {
    if (!isRecord(input.rework)) errors.push(diagnostic("invalid-rework", "rework 必须是对象", "rework"));
    else {
      const maxAttempts = input.rework.maxAttempts ?? DEFAULT_WORKFLOW_ATTEMPTS;
      if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_WORKFLOW_ATTEMPTS) {
        errors.push(diagnostic("invalid-max-attempts", `rework.maxAttempts 必须是 1-${MAX_WORKFLOW_ATTEMPTS} 的整数`, "rework.maxAttempts"));
      }
      rework = {
        entryNodeId: input.rework.entryNodeId === "" ? "" : requiredId(input.rework.entryNodeId, "rework.entryNodeId", errors),
        gateNodeId: input.rework.gateNodeId === "" ? "" : requiredId(input.rework.gateNodeId, "rework.gateNodeId", errors),
        maxAttempts: typeof maxAttempts === "number" && Number.isInteger(maxAttempts) ? maxAttempts : DEFAULT_WORKFLOW_ATTEMPTS
      };
    }
  }
  const revision = input.revision;
  const createdAt = input.createdAt;
  const updatedAt = input.updatedAt;
  if (!options.allowMissingMetadata) {
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) errors.push(diagnostic("invalid-revision", "revision 必须是非负整数", "revision"));
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) errors.push(diagnostic("invalid-created-at", "createdAt 必须是有限数字", "createdAt"));
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) errors.push(diagnostic("invalid-updated-at", "updatedAt 必须是有限数字", "updatedAt"));
  }
  const normalized: WorkflowDefinition = {
    version: WORKFLOW_VERSION,
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(inputHint !== undefined ? { inputHint } : {}),
    ...(layout !== undefined ? { layout } : {}),
    nodes,
    edges,
    ...(rework ? { rework } : {}),
    revision: typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : 0,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0
  };
  const serializedBytes = options.serializedBytes ?? utf8ByteLength(JSON.stringify(input));
  if (serializedBytes > MAX_WORKFLOW_FILE_BYTES) errors.push(diagnostic("file-too-large", `工作流文件不能超过 ${MAX_WORKFLOW_FILE_BYTES} 字节`, undefined));
  return { ok: errors.length === 0, ...(errors.length === 0 ? { definition: normalized } : {}), errors, warnings };
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function graphFor(definition: WorkflowDefinition): { outgoing: Map<string, WorkflowEdge[]>; incoming: Map<string, WorkflowEdge[]> } {
  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const node of definition.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of definition.edges) {
    outgoing.get(edge.from)?.push(edge);
    incoming.get(edge.to)?.push(edge);
  }
  return { outgoing, incoming };
}

export function stableTopologicalOrder(definition: WorkflowDefinition): string[] | undefined {
  const { outgoing, incoming } = graphFor(definition);
  const orderIndex = new Map(definition.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map<string, number>(definition.nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const ready = definition.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const result: string[] = [];
  const sortReady = (): void => { ready.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0) || a.localeCompare(b)); };
  sortReady();
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      const next = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, next);
      if (next === 0) ready.push(edge.to);
    }
    sortReady();
  }
  return result.length === definition.nodes.length ? result : undefined;
}

function traverse(start: string, edges: Map<string, WorkflowEdge[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges.get(id) ?? []) queue.push(edge.to);
  }
  return seen;
}

function reverseTraverse(start: string, incoming: Map<string, WorkflowEdge[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of incoming.get(id) ?? []) queue.push(edge.from);
  }
  return seen;
}

export function collectTemplateReferences(template: string): WorkflowTemplateReference[] {
  const references: WorkflowTemplateReference[] = [];
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const raw = match[1]?.trim() ?? "";
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (raw === "input" || raw === "attempt" || raw === "retry_feedback") {
      references.push({ raw, kind: raw === "retry_feedback" ? "retry_feedback" : raw, start, end });
    } else {
      references.push({ raw, kind: "node", nodeId: raw, start, end });
    }
  }
  return references;
}

export function renderWorkflowTemplate(template: string, values: WorkflowTemplateValues): string {
  return template.replace(TEMPLATE_PATTERN, (_whole, raw: string) => {
    const key = raw.trim();
    if (key === "input") return values.input ?? "";
    if (key === "attempt") return values.attempt === undefined ? "" : String(values.attempt);
    if (key === "retry_feedback") return values.retryFeedback ?? "";
    return values.nodes?.[key] ?? "";
  });
}

function duplicateEdges(definition: WorkflowDefinition): WorkflowDiagnostic[] {
  const errors: WorkflowDiagnostic[] = [];
  const seen = new Set<string>();
  for (const edge of definition.edges) {
    if (edge.from === edge.to) errors.push(diagnostic("self-edge", `边 ${edge.id} 不能连接节点自身`, undefined, { edgeId: edge.id }));
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) errors.push(diagnostic("duplicate-edge", `节点之间不能有重复依赖边：${edge.from} → ${edge.to}`, undefined, { edgeId: edge.id }));
    seen.add(key);
  }
  return errors;
}

function validateRework(definition: WorkflowDefinition, order: string[], errors: WorkflowDiagnostic[]): CompiledWorkflowPlan | undefined {
  const { outgoing, incoming } = graphFor(definition);
  const sources = definition.nodes.filter((node) => (incoming.get(node.id)?.length ?? 0) === 0);
  const sinks = definition.nodes.filter((node) => (outgoing.get(node.id)?.length ?? 0) === 0);
  if (sources.length !== 1) errors.push(diagnostic("entry-count", `工作流必须恰好有一个入口，当前有 ${sources.length} 个`));
  if (sinks.length !== 1) errors.push(diagnostic("exit-count", `工作流必须恰好有一个最终出口，当前有 ${sinks.length} 个`));
  const entry = sources[0]?.id;
  const exit = sinks[0]?.id;
  if (exit && definition.nodes.find((node) => node.id === exit)?.kind !== "output") errors.push(diagnostic("exit-kind", "最终出口必须是 output 节点", undefined, { nodeId: exit }));
  const reachable = entry ? traverse(entry, outgoing) : new Set<string>();
  if (reachable.size !== definition.nodes.length) {
    for (const node of definition.nodes) if (!reachable.has(node.id)) errors.push(diagnostic("unreachable-node", `节点不可从入口到达：${node.id}`, undefined, { nodeId: node.id }));
  }
  const canReachExit = exit ? reverseTraverse(exit, incoming) : new Set<string>();
  for (const node of definition.nodes) if (entry && reachable.has(node.id) && exit && !canReachExit.has(node.id)) errors.push(diagnostic("dead-end-node", `节点无法到达最终出口：${node.id}`, undefined, { nodeId: node.id }));
  const rework = definition.rework;
  if (!rework) {
    for (const node of definition.nodes) if (node.kind === "gate") errors.push(diagnostic("gate-without-rework", "没有返工配置时不允许可执行 gate 节点", undefined, { nodeId: node.id }));
    if (!entry || !exit) return undefined;
    return { entryNodeId: entry, exitNodeId: exit, topologicalOrder: order, prefixNodeIds: order, regionNodeIds: [], suffixNodeIds: [] };
  }
  if (!definition.nodes.some((node) => node.id === rework.entryNodeId)) errors.push(diagnostic("missing-rework-entry", `返工入口不存在：${rework.entryNodeId}`, undefined, { nodeId: rework.entryNodeId }));
  if (!definition.nodes.some((node) => node.id === rework.gateNodeId)) errors.push(diagnostic("missing-rework-gate", `返工 gate 不存在：${rework.gateNodeId}`, undefined, { nodeId: rework.gateNodeId }));
  const gates = definition.nodes.filter((node) => node.kind === "gate");
  if (gates.length !== 1) errors.push(diagnostic("gate-count", `返工工作流必须恰好有一个 gate，当前有 ${gates.length} 个`));
  if (definition.nodes.find((node) => node.id === rework.gateNodeId)?.kind !== "gate") errors.push(diagnostic("rework-gate-kind", "rework.gateNodeId 必须指向 gate 节点", undefined, { nodeId: rework.gateNodeId }));
  if (!entry || !exit || !definition.nodes.some((node) => node.id === rework.entryNodeId) || !definition.nodes.some((node) => node.id === rework.gateNodeId)) return undefined;
  const fromEntry = traverse(rework.entryNodeId, outgoing);
  const toGate = reverseTraverse(rework.gateNodeId, incoming);
  const region = new Set([...fromEntry].filter((id) => toGate.has(id)));
  if (!region.has(rework.entryNodeId) || !region.has(rework.gateNodeId)) {
    errors.push(diagnostic("rework-disconnected", "返工入口必须通过普通依赖边到达 gate", undefined, { nodeId: rework.entryNodeId }));
    return undefined;
  }
  const prefixSet = reverseTraverse(rework.entryNodeId, incoming);
  const suffixSet = traverse(rework.gateNodeId, outgoing);
  for (const id of prefixSet) if (region.has(id)) prefixSet.delete(id);
  for (const id of suffixSet) if (region.has(id)) suffixSet.delete(id);
  const allPartitioned = new Set([...prefixSet, ...region, ...suffixSet]);
  for (const node of definition.nodes) if (!allPartitioned.has(node.id)) errors.push(diagnostic("rework-bypass-node", `节点不属于返工前缀、区间或后缀：${node.id}`, undefined, { nodeId: node.id }));
  for (const edge of definition.edges) {
    const fromIn = region.has(edge.from);
    const toIn = region.has(edge.to);
    if (!fromIn && toIn && edge.to !== rework.entryNodeId) errors.push(diagnostic("rework-entry-bypass", `外部边只能进入返工入口，实际进入 ${edge.to}`, undefined, { edgeId: edge.id, nodeId: edge.to }));
    if (fromIn && !toIn && edge.from !== rework.gateNodeId) errors.push(diagnostic("rework-exit-bypass", `返工区间只能从 gate 离开，实际从 ${edge.from} 离开`, undefined, { edgeId: edge.id, nodeId: edge.from }));
    if (!fromIn && !toIn && prefixSet.has(edge.from) && suffixSet.has(edge.to)) errors.push(diagnostic("rework-bypass", `边 ${edge.id} 绕过了返工区间`, undefined, { edgeId: edge.id }));
  }
  for (const edge of outgoing.get(rework.gateNodeId) ?? []) if (region.has(edge.to)) errors.push(diagnostic("gate-internal-edge", "gate 不能再指向返工区间内部节点", undefined, { edgeId: edge.id }));
  const regionOrder = order.filter((id) => region.has(id));
  if (regionOrder[regionOrder.length - 1] !== rework.gateNodeId) errors.push(diagnostic("gate-not-last", "gate 必须是返工区间的最后一个节点", undefined, { nodeId: rework.gateNodeId }));
  const prefixOrder = order.filter((id) => prefixSet.has(id));
  const suffixOrder = order.filter((id) => suffixSet.has(id));
  return {
    entryNodeId: entry,
    exitNodeId: exit,
    topologicalOrder: order,
    prefixNodeIds: prefixOrder,
    regionNodeIds: regionOrder,
    suffixNodeIds: suffixOrder,
    rework
  };
}

export function validateWorkflowForRun(definition: WorkflowDefinition, context: WorkflowRunValidationContext = {}): WorkflowRunValidationResult {
  const normalized = normalizeWorkflowDraft(definition);
  if (!normalized.ok) return { ok: false, errors: normalized.errors, warnings: normalized.warnings };
  const errors: WorkflowDiagnostic[] = [];
  const warnings: WorkflowDiagnostic[] = [];
  errors.push(...duplicateEdges(definition));
  const order = stableTopologicalOrder(definition);
  if (!order) errors.push(diagnostic("cycle", "普通依赖边不能形成环"));
  for (const node of definition.nodes) {
    if (!node.prompt.trim()) errors.push(diagnostic("empty-prompt", `节点 prompt 不能为空：${node.title}`, undefined, { nodeId: node.id }));
    if (node.exec.kind === "subagent") {
      if (!node.exec.subagent) errors.push(diagnostic("missing-subagent", `节点未配置子智能体：${node.title}`, undefined, { nodeId: node.id }));
      else if (context.subagents && !context.subagents.some((subagent) => subagent.id === node.exec.subagent || subagent.name === node.exec.subagent)) {
        errors.push(diagnostic("unknown-subagent", `找不到子智能体：${node.exec.subagent}`, undefined, { nodeId: node.id }));
      }
    }
    if (node.exec.tools && context.sourceTools) {
      for (const tool of node.exec.tools) if (!context.sourceTools.includes(tool)) errors.push(diagnostic("tool-not-inherited", `节点工具 ${tool} 不在来源工具集内`, undefined, { nodeId: node.id }));
    }
    // accessModeCap 与 owner 模式逐次按工具风险取更严格的权限动作；它们不是
    // 可比较的单一等级（例如 read-only 对工作区外路径仍会询问）。
    if (node.exec.model && context.availableModels && !context.availableModels.some((model) => model.provider === node.exec.model?.provider && model.id === node.exec.model?.id)) {
      errors.push(diagnostic("unknown-model", `找不到节点模型：${node.exec.model.provider}/${node.exec.model.id}`, undefined, { nodeId: node.id }));
    }
    for (const reference of collectTemplateReferences(node.prompt)) {
      if (reference.kind !== "node") continue;
      if (!reference.nodeId || !definition.nodes.some((candidate) => candidate.id === reference.nodeId)) {
        errors.push(diagnostic("unknown-template-node", `模板引用了不存在的节点：${reference.nodeId ?? reference.raw}`, undefined, { nodeId: node.id }));
      }
    }
  }
  const plan = order ? validateRework(definition, order, errors) : undefined;
  if (order) {
    const { incoming } = graphFor(definition);
    const ancestors = new Map<string, Set<string>>();
    for (const node of definition.nodes) ancestors.set(node.id, reverseTraverse(node.id, incoming));
    for (const node of definition.nodes) {
      for (const reference of collectTemplateReferences(node.prompt)) {
        if (reference.kind !== "node" || !reference.nodeId || !definition.nodes.some((candidate) => candidate.id === reference.nodeId)) continue;
        if (reference.nodeId === node.id) errors.push(diagnostic("self-template-reference", `节点不能引用自身产物：${reference.raw}`, undefined, { nodeId: node.id }));
        else if (!ancestors.get(node.id)?.has(reference.nodeId)) errors.push(diagnostic("non-ancestor-template-reference", `模板只能引用真正祖先节点：${reference.raw}`, undefined, { nodeId: node.id }));
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, ...(plan && errors.length === 0 ? { plan } : {}), ...(order ? { topologicalOrder: order } : {}) };
}

export function parseGateDecision(text: string): GateDecisionParseResult {
  const trimmed = text.replace(/^\uFEFF/u, "").trim();
  if (!trimmed) return { ok: false, error: "gate 输出为空" };
  let payload = trimmed;
  if (payload.startsWith("```")) {
    const match = payload.match(/^```json\s*\n([\s\S]*?)\n```$/u);
    if (!match) return { ok: false, error: "gate 输出只能是完整 JSON 或一层 json 围栏" };
    payload = match[1]!.trim();
  }
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return { ok: false, error: "gate 输出不是合法 JSON" };
  }
  if (!isRecord(value) || (value.verdict !== "pass" && value.verdict !== "retry") || typeof value.reason !== "string" || !value.reason.trim()) {
    return { ok: false, error: "gate JSON 必须包含 verdict=pass/retry 与非空 reason" };
  }
  if (value.reason.length > 2_000) return { ok: false, error: "gate reason 不能超过 2000 字符" };
  return { ok: true, decision: { verdict: value.verdict, reason: value.reason } };
}

export function createWorkflowDraft(now = Date.now(), id = "wf-draft"): WorkflowDefinition {
  return {
    version: WORKFLOW_VERSION,
    id,
    name: "未命名工作流",
    nodes: [],
    edges: [],
    revision: 0,
    createdAt: now,
    updatedAt: now
  };
}
