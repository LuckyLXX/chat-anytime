import type { AccessMode } from "../../../shared/protocol";
import {
  DEFAULT_WORKFLOW_ATTEMPTS,
  MAX_WORKFLOW_ATTEMPTS,
  WORKFLOW_VERSION,
  type CompiledWorkflowPlan,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowEdge,
  type WorkflowExecution,
  type WorkflowExecutionStatus,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowNodePosition,
  type WorkflowRework,
  type WorkflowRunStatus
} from "../../../shared/workflow";

/**
 * 工作流画布的纯计算层（步骤六）。
 *
 * 这里只放「不碰 DOM、不碰 window」的函数：几何、id 分配、图编辑、脏比较、
 * 诊断分组、文案字典。组件负责渲染与事件，测试可以直接钉住这些语义。
 *
 * 三条与方案对齐的硬约束：
 * ① **位置只影响视觉**：所有图编辑都只改 `position`，运行顺序由 `nodes` 数组序
 *    + 依赖边决定，绝不把坐标写进顺序口径。
 * ② **画布不画 loop**：连线只能连普通依赖，会成环的连线当场拒绝；返工区间一律
 *    由检查器写进 `rework` 字段，画布只把它渲染成虚线与区间标识。
 * ③ **删节点连带清理**：删节点同时删掉相邻边，并在 rework 指向它时清掉 rework
 *    （半截返工区间永远是非法结构，留着只会让人以为还配着）。
 */

/** 节点卡尺寸（px）：画布坐标、命中矩形、拖拽全部以它为准。 */
export const WORKFLOW_NODE_WIDTH = 208;
export const WORKFLOW_NODE_HEIGHT = 88;
/** 画布四周留白与自动摆放步长。 */
export const WORKFLOW_STAGE_PADDING = 44;
export const WORKFLOW_COLUMN_STEP = 252;
export const WORKFLOW_ROW_STEP = 124;

export const WORKFLOW_NODE_KIND_LABELS: Record<WorkflowNodeKind, string> = {
  task: "任务",
  review: "审查",
  gate: "验收 gate",
  output: "结果"
};

export const WORKFLOW_EXECUTION_STATUS_LABELS: Record<WorkflowExecutionStatus, string> = {
  pending: "待执行",
  starting: "启动中",
  running: "执行中",
  waiting_permission: "待确认",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  skipped: "已跳过"
};

export const WORKFLOW_RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  completed: "已完成",
  rejected: "未通过",
  stopped: "已停止",
  failed: "失败",
  interrupted: "已中断"
};

export const WORKFLOW_ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  "read-only": "只读",
  ask: "每次询问",
  workspace: "工作区访问",
  full: "完全访问"
};

/** 访问上限下拉的顺序：从最严到最松，配「继承」空值用。 */
export const WORKFLOW_ACCESS_MODE_ORDER: AccessMode[] = ["read-only", "ask", "workspace", "full"];

export const WORKFLOW_SOURCE_LABELS = { agent: "当前角色", subagent: "自定义子智能体" } as const;

const TERMINAL_RUN_STATUS: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>(["completed", "rejected", "stopped", "failed", "interrupted"]);

/** 运行是否已经收场（终态）。运行条的「关闭」与「停止」按钮按它区分。 */
export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUS.has(status);
}

export interface WorkflowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function nodeRect(node: WorkflowNode): WorkflowRect {
  return { x: node.position.x, y: node.position.y, width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT };
}

function overlaps(a: WorkflowRect, b: WorkflowRect, gap: number): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/**
 * 新增节点的默认落点：放在最右侧一列，若与已有节点重叠就逐行下移。
 * 不是布局算法，只保证「新节点看得见、不压住别人」。
 */
export function nextNodePosition(nodes: readonly WorkflowNode[]): WorkflowNodePosition {
  if (nodes.length === 0) return { x: WORKFLOW_STAGE_PADDING, y: WORKFLOW_STAGE_PADDING };
  const right = Math.max(...nodes.map((node) => node.position.x + WORKFLOW_NODE_WIDTH));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const rects = nodes.map(nodeRect);
  let candidate: WorkflowNodePosition = { x: right + (WORKFLOW_COLUMN_STEP - WORKFLOW_NODE_WIDTH), y: top };
  for (let guard = 0; guard < 200; guard += 1) {
    const rect: WorkflowRect = { x: candidate.x, y: candidate.y, width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT };
    if (!rects.some((other) => overlaps(rect, other, 12))) break;
    candidate = { x: candidate.x, y: candidate.y + WORKFLOW_ROW_STEP };
  }
  return candidate;
}

// —— id 分配：定义内稳定、可读（n3 / e7），与运行期 UUID 无关 ——

export function nextWorkflowNodeId(nodes: readonly WorkflowNode[]): string {
  let max = 0;
  for (const node of nodes) {
    const match = /^n(\d+)$/u.exec(node.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `n${max + 1}`;
}

export function nextWorkflowEdgeId(edges: readonly WorkflowEdge[]): string {
  let max = 0;
  for (const edge of edges) {
    const match = /^e(\d+)$/u.exec(edge.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `e${max + 1}`;
}

export function createWorkflowNode(nodes: readonly WorkflowNode[], options: { kind?: WorkflowNodeKind; title?: string } = {}): WorkflowNode {
  const kind = options.kind ?? "task";
  return {
    id: nextWorkflowNodeId(nodes),
    title: options.title ?? WORKFLOW_NODE_KIND_LABELS[kind],
    kind,
    prompt: "",
    position: nextNodePosition(nodes),
    exec: { kind: "agent" }
  };
}

export function addWorkflowNode(definition: WorkflowDefinition, options: { kind?: WorkflowNodeKind; title?: string } = {}): { definition: WorkflowDefinition; node: WorkflowNode } {
  const node = createWorkflowNode(definition.nodes, options);
  return { definition: { ...definition, nodes: [...definition.nodes, node] }, node };
}

export function updateWorkflowNode(definition: WorkflowDefinition, nodeId: string, patch: Partial<Omit<WorkflowNode, "id">>): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch, id: node.id } : node)) };
}

/** 拖拽落位：只改坐标，保留其余字段（位置永远不参与执行语义）。 */
export function moveWorkflowNode(definition: WorkflowDefinition, nodeId: string, position: WorkflowNodePosition): WorkflowDefinition {
  return updateWorkflowNode(definition, nodeId, { position: { x: Math.round(position.x), y: Math.round(position.y) } });
}

export function removeWorkflowNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  const nodes = definition.nodes.filter((node) => node.id !== nodeId);
  const edges = definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  const next: WorkflowDefinition = { ...definition, nodes, edges };
  if (definition.rework && (definition.rework.entryNodeId === nodeId || definition.rework.gateNodeId === nodeId)) delete next.rework;
  return next;
}

export type WorkflowConnectResult = { ok: true; definition: WorkflowDefinition; edge: WorkflowEdge } | { ok: false; reason: string };

function outgoingMap(definition: WorkflowDefinition): Map<string, string[]> {
  const map = new Map<string, string[]>(definition.nodes.map((node) => [node.id, []]));
  for (const edge of definition.edges) map.get(edge.from)?.push(edge.to);
  return map;
}

/** 从 `start` 出发能到达的节点集合（含自身）。返回值是节点 id。 */
export function reachableFrom(definition: WorkflowDefinition, start: string): Set<string> {
  const outgoing = outgoingMap(definition);
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }
  return seen;
}

/** 新增 from→to 是否会让普通依赖成环（含反向边已存在的情形）。 */
export function wouldCreateCycle(definition: WorkflowDefinition, from: string, to: string): boolean {
  if (from === to) return true;
  return reachableFrom(definition, to).has(from);
}

/**
 * 两击连线的落子逻辑：拒绝自环、重复边、以及任何会成环的依赖。
 * 返工区间不在这里画——它由检查器的 entry/gate/maxAttempts 结构化表达。
 */
export function connectWorkflowNodes(definition: WorkflowDefinition, fromId: string, toId: string, edgeId?: string): WorkflowConnectResult {
  if (!definition.nodes.some((node) => node.id === fromId) || !definition.nodes.some((node) => node.id === toId)) {
    return { ok: false, reason: "连线端点不存在" };
  }
  if (fromId === toId) return { ok: false, reason: "节点不能连到自己" };
  if (definition.edges.some((edge) => edge.from === fromId && edge.to === toId)) return { ok: false, reason: "这两个节点之间已有依赖边" };
  if (wouldCreateCycle(definition, fromId, toId)) return { ok: false, reason: "会产生环：返工区间请在检查器里配置，画布只画普通依赖" };
  const edge: WorkflowEdge = { id: edgeId ?? nextWorkflowEdgeId(definition.edges), from: fromId, to: toId };
  return { ok: true, definition: { ...definition, edges: [...definition.edges, edge] }, edge };
}

export function removeWorkflowEdge(definition: WorkflowDefinition, edgeId: string): WorkflowDefinition {
  return { ...definition, edges: definition.edges.filter((edge) => edge.id !== edgeId) };
}

/** 写返工结构（检查器的 entry/gate/maxAttempts）；传 undefined 表示清掉返工区间。 */
export function setWorkflowRework(definition: WorkflowDefinition, rework: WorkflowRework | undefined): WorkflowDefinition {
  const next: WorkflowDefinition = { ...definition };
  if (rework) next.rework = { ...rework, maxAttempts: clampAttempts(rework.maxAttempts) };
  else delete next.rework;
  return next;
}

export function clampAttempts(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WORKFLOW_ATTEMPTS;
  return Math.min(MAX_WORKFLOW_ATTEMPTS, Math.max(1, Math.round(value)));
}

/**
 * 画布上的返工区间标识：entry 可达 ∩ 能到 gate（与运行校验同一口径，但宽容——
 * 结构没配全时返回空集，画布不瞎标）。
 */
export function reworkRegionNodeIds(definition: WorkflowDefinition): Set<string> {
  const rework = definition.rework;
  if (!rework?.entryNodeId || !rework.gateNodeId) return new Set<string>();
  if (!definition.nodes.some((node) => node.id === rework.entryNodeId) || !definition.nodes.some((node) => node.id === rework.gateNodeId)) return new Set<string>();
  const incoming = new Map<string, string[]>(definition.nodes.map((node) => [node.id, []]));
  for (const edge of definition.edges) incoming.get(edge.to)?.push(edge.from);
  const down = reachableFrom(definition, rework.entryNodeId);
  const up = new Set<string>();
  const queue = [rework.gateNodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (up.has(id)) continue;
    up.add(id);
    for (const previous of incoming.get(id) ?? []) queue.push(previous);
  }
  return new Set([...down].filter((id) => up.has(id)));
}

/** 最多节点执行次数 = P + S + R × maxAttempts（不是模型调用数，也不是 token 预算）。 */
export function estimateWorkflowExecutions(plan: CompiledWorkflowPlan | undefined): number | undefined {
  if (!plan) return undefined;
  return plan.prefixNodeIds.length + plan.suffixNodeIds.length + plan.regionNodeIds.length * (plan.rework?.maxAttempts ?? 1);
}

// —— 定义级操作 ——

/**
 * 六节点起步模板：规划 → 实施 → 审查 → 测试 → 验收 gate → 结果整理，
 * 返工区间为「实施 … 验收」。全部节点走 agent 来源（owner 的角色与模型），
 * **不编造子智能体**——要用子智能体请用户在检查器里自己选。
 */
export function createStarterWorkflow(now = Date.now(), id = "wf-draft"): WorkflowDefinition {
  const step = (index: number): WorkflowNodePosition => ({ x: WORKFLOW_STAGE_PADDING + index * WORKFLOW_COLUMN_STEP, y: WORKFLOW_STAGE_PADDING });
  const nodes: WorkflowNode[] = [
    {
      id: "n1",
      title: "规划",
      role: "规划",
      kind: "task",
      prompt: "先读懂用户需求，给出可执行的实施步骤、涉及文件与风险点。不要修改任何文件。\n\n用户输入：\n{{input}}",
      position: step(0),
      exec: { kind: "agent" }
    },
    {
      id: "n2",
      title: "实施",
      role: "开发",
      kind: "task",
      prompt: "按规划实施改动，保持最小改动面。\n\n用户输入：\n{{input}}\n\n规划：\n{{n1}}\n\n上一轮验收反馈（首轮为空）：\n{{retry_feedback}}",
      position: step(1),
      exec: { kind: "agent" }
    },
    {
      id: "n3",
      title: "审查",
      role: "审查",
      kind: "review",
      prompt: "审查实施结果：正确性、边界情况、与现有约定的一致性。逐条列出问题与位置。\n\n实施结果：\n{{n2}}",
      position: step(2),
      exec: { kind: "agent" }
    },
    {
      id: "n4",
      title: "测试",
      role: "验证",
      kind: "review",
      prompt: "真实执行可验证的检查（测试、构建、脚本），把命令与实际输出记录下来。不要只凭阅读下结论。\n\n实施结果：\n{{n2}}",
      position: step(3),
      exec: { kind: "agent" }
    },
    {
      id: "n5",
      title: "验收",
      role: "验收",
      kind: "gate",
      prompt: "根据审查与测试结论判定本轮是否通过。只输出一个 JSON 对象，不要输出其他内容：\n{\"verdict\":\"pass 或 retry\",\"reason\":\"非空原因\"}\n\n审查：\n{{n3}}\n\n测试：\n{{n4}}",
      position: step(4),
      exec: { kind: "agent" }
    },
    {
      id: "n6",
      title: "结果整理",
      role: "交付",
      kind: "output",
      prompt: "汇总本次运行的结果：改了什么、验证了什么、还有什么遗留。保留必要换行与代码块。\n\n规划：\n{{n1}}\n\n实施：\n{{n2}}\n\n验收裁决：\n{{n5}}\n\n用户输入：\n{{input}}",
      position: step(5),
      exec: { kind: "agent" }
    }
  ];
  const edges: WorkflowEdge[] = [
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n2", to: "n3" },
    { id: "e3", from: "n3", to: "n4" },
    { id: "e4", from: "n4", to: "n5" },
    { id: "e5", from: "n5", to: "n6" }
  ];
  return {
    version: WORKFLOW_VERSION,
    id,
    name: "实施—验收工作流",
    description: "规划一次，实施/审查/测试按轮返工，验收通过后整理结果。",
    inputHint: "这次要完成的需求、目标文件与验收标准；会作为 {{input}} 注入每个节点。",
    layout: "auto",
    nodes,
    edges,
    rework: { entryNodeId: "n2", gateNodeId: "n5", maxAttempts: DEFAULT_WORKFLOW_ATTEMPTS },
    revision: 0,
    createdAt: now,
    updatedAt: now
  };
}

/** 复制定义：新 id 由存储层分配，这里只换名字并清掉磁盘元数据。 */
export function cloneWorkflowDefinition(definition: WorkflowDefinition, now = Date.now()): WorkflowDefinition {
  return {
    ...definition,
    name: `${definition.name}（副本）`.slice(0, 64),
    revision: 0,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * 脏比较的规范化指纹：**不含** revision/createdAt/updatedAt（存储层每次保存都会
 * 重写它们），并且把可选字段补齐成固定顺序——服务端回读的对象与本地草稿的
 * 键序可能不同，不归一化就会一读出来就「脏」。
 */
export function workflowDraftFingerprint(definition: WorkflowDefinition): string {
  const nodes = definition.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    role: node.role ?? "",
    kind: node.kind,
    prompt: node.prompt,
    x: node.position.x,
    y: node.position.y,
    execKind: node.exec.kind,
    subagent: node.exec.subagent ?? "",
    model: node.exec.model ? `${node.exec.model.provider}/${node.exec.model.id}` : "",
    thinkingLevel: node.exec.thinkingLevel ?? "",
    tools: [...(node.exec.tools ?? [])].sort().join(","),
    accessModeCap: node.exec.accessModeCap ?? ""
  }));
  const edges = definition.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, label: edge.label ?? "" }));
  const rework = definition.rework
    ? { entry: definition.rework.entryNodeId, gate: definition.rework.gateNodeId, maxAttempts: definition.rework.maxAttempts }
    : null;
  return JSON.stringify({
    name: definition.name,
    description: definition.description ?? "",
    whenToUse: definition.whenToUse ?? "",
    inputHint: definition.inputHint ?? "",
    layout: definition.layout ?? null,
    nodes,
    edges,
    rework
  });
}

export function isWorkflowDraftDirty(saved: WorkflowDefinition | undefined, draft: WorkflowDefinition): boolean {
  return !saved || workflowDraftFingerprint(saved) !== workflowDraftFingerprint(draft);
}

// —— 诊断与展示 ——

export interface WorkflowIssueGroups {
  nodes: Map<string, WorkflowDiagnostic[]>;
  edges: Map<string, WorkflowDiagnostic[]>;
  general: WorkflowDiagnostic[];
}

/** 运行校验问题按节点/边归位，画布就地高亮；无定位的进 general 区。 */
export function groupWorkflowIssues(issues: readonly WorkflowDiagnostic[]): WorkflowIssueGroups {
  const nodes = new Map<string, WorkflowDiagnostic[]>();
  const edges = new Map<string, WorkflowDiagnostic[]>();
  const general: WorkflowDiagnostic[] = [];
  for (const issue of issues) {
    const bucket = issue.nodeId ? nodes : issue.edgeId ? edges : undefined;
    const key = issue.nodeId ?? issue.edgeId;
    if (!bucket || !key) {
      general.push(issue);
      continue;
    }
    const list = bucket.get(key);
    if (list) list.push(issue);
    else bucket.set(key, [issue]);
  }
  return { nodes, edges, general };
}

export function workflowIssueText(issue: WorkflowDiagnostic): string {
  return issue.message.trim() || issue.code;
}

/** 节点卡的来源文案：当前角色 / 具体子智能体（不猜、不回落）。 */
export function workflowNodeSourceLabel(node: WorkflowNode): string {
  if (node.exec.kind === "subagent") return node.exec.subagent ? `子智能体 ${node.exec.subagent}` : "子智能体（未选择）";
  return WORKFLOW_SOURCE_LABELS.agent;
}

/** 节点设置的模型；未设置时由运行前预检解析成 owner 的模型并按实际值展示。 */
export function workflowNodeModelLabel(node: WorkflowNode): string | undefined {
  return node.exec.model ? `${node.exec.model.provider}/${node.exec.model.id}` : undefined;
}

/** 键盘删除保护：输入框/文本域/可编辑区域内的 Delete 不能当成删节点。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null };
  const tag = element.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (element.isContentEditable) return true;
  return element.getAttribute?.("contenteditable") === "true" || element.getAttribute?.("contenteditable") === "";
}

/** 输入长度按字符裁剪（不静默截断执行语义字段：只在输入事件里用）。 */
export function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function executionsForNode(executions: readonly WorkflowExecution[], nodeId: string): WorkflowExecution[] {
  return executions.filter((execution) => execution.nodeId === nodeId).sort((a, b) => a.attempt - b.attempt || (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

export function latestExecutionForNode(executions: readonly WorkflowExecution[], nodeId: string): WorkflowExecution | undefined {
  return executionsForNode(executions, nodeId).at(-1);
}

/** 「第 k/m 轮」文案；未配置返工时只显示轮号。 */
export function attemptText(attempt: number, maxAttempts: number): string {
  return maxAttempts > 1 ? `第 ${attempt}/${maxAttempts} 轮` : "单轮";
}
