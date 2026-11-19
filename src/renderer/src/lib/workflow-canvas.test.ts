// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { validateWorkflowForRun } from "../../../shared/workflow";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
  WORKFLOW_STAGE_PADDING,
  addWorkflowNode,
  attemptText,
  clampAttempts,
  clampText,
  cloneWorkflowDefinition,
  connectWorkflowNodes,
  createStarterWorkflow,
  edgeGeometry,
  estimateWorkflowExecutions,
  executionsForNode,
  groupWorkflowIssues,
  isEditableTarget,
  isTerminalRunStatus,
  isWorkflowDraftDirty,
  latestExecutionForNode,
  moveWorkflowNode,
  nextNodePosition,
  nextWorkflowEdgeId,
  nextWorkflowNodeId,
  nodeRect,
  removeWorkflowEdge,
  removeWorkflowNode,
  reworkGeometry,
  reworkRegionNodeIds,
  setWorkflowRework,
  stageSize,
  updateWorkflowNode,
  workflowDraftFingerprint,
  workflowNodeSourceLabel,
  wouldCreateCycle,
  type WorkflowRect
} from "./workflow-canvas";

function overlaps(a: WorkflowRect, b: WorkflowRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("起步模板", () => {
  it("六节点 + 五条依赖 + 返工区间（实施 → 验收），能通过运行校验", () => {
    const starter = createStarterWorkflow(1_000);
    expect(starter.nodes.map((node) => node.title)).toEqual(["规划", "实施", "审查", "测试", "验收", "结果整理"]);
    expect(starter.nodes.map((node) => node.kind)).toEqual(["task", "task", "review", "review", "gate", "output"]);
    expect(starter.rework).toEqual({ entryNodeId: "n2", gateNodeId: "n5", maxAttempts: 3 });
    expect(starter.edges).toHaveLength(5);
    // 模板必须是「真能跑」的：不留断图、不引用不存在的祖先、不编造子智能体。
    const validation = validateWorkflowForRun(starter);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.plan?.prefixNodeIds).toEqual(["n1"]);
    expect(validation.plan?.regionNodeIds).toEqual(["n2", "n3", "n4", "n5"]);
    expect(validation.plan?.suffixNodeIds).toEqual(["n6"]);
    expect(starter.nodes.every((node) => node.exec.kind === "agent")).toBe(true);
  });

  it("最多执行次数按 P + S + R × maxAttempts 估算", () => {
    const validation = validateWorkflowForRun(createStarterWorkflow(1_000));
    expect(estimateWorkflowExecutions(validation.plan)).toBe(1 + 1 + 4 * 3);
    expect(estimateWorkflowExecutions(undefined)).toBeUndefined();
  });

  it("返工区间只含 entry 可达 ∩ 能到 gate 的节点", () => {
    expect([...reworkRegionNodeIds(createStarterWorkflow(1_000))].sort()).toEqual(["n2", "n3", "n4", "n5"]);
    const withoutRework = setWorkflowRework(createStarterWorkflow(1_000), undefined);
    expect(withoutRework.rework).toBeUndefined();
    expect(reworkRegionNodeIds(withoutRework).size).toBe(0);
  });
});

describe("节点与依赖编辑", () => {
  it("新增节点 id 递增，落点不与已有节点重叠", () => {
    const starter = createStarterWorkflow(1_000);
    expect(nextWorkflowNodeId(starter.nodes)).toBe("n7");
    expect(nextWorkflowEdgeId(starter.edges)).toBe("e6");
    const { definition, node } = addWorkflowNode(starter);
    expect(node.id).toBe("n7");
    expect(node.position.x).toBeGreaterThan(0);
    const rects = definition.nodes.map(nodeRect);
    for (const [index, rect] of rects.entries()) {
      for (const other of rects.slice(index + 1)) expect(overlaps(rect, other)).toBe(false);
    }
  });

  it("空图的新节点落在画布留白内", () => {
    expect(nextNodePosition([])).toEqual({ x: WORKFLOW_STAGE_PADDING, y: WORKFLOW_STAGE_PADDING });
  });

  it("移动节点只改坐标，不改顺序与依赖（可运行性不变）", () => {
    const starter = createStarterWorkflow(1_000);
    const moved = moveWorkflowNode(starter, "n2", { x: 12.4, y: 480.6 });
    expect(moved.nodes.find((node) => node.id === "n2")?.position).toEqual({ x: 12, y: 481 });
    expect(moved.nodes.map((node) => node.id)).toEqual(starter.nodes.map((node) => node.id));
    expect(moved.edges).toEqual(starter.edges);
    expect(validateWorkflowForRun(moved).ok).toBe(true);
    expect(validateWorkflowForRun(moved).plan).toEqual(validateWorkflowForRun(starter).plan);
  });

  it("两击连线：正常连接成功，自环/重复/成环被拒", () => {
    const starter = createStarterWorkflow(1_000);
    const linked = connectWorkflowNodes(starter, "n1", "n4");
    expect(linked.ok).toBe(true);
    if (!linked.ok) throw new Error("unreachable");
    expect(linked.edge.id).toBe("e6");
    expect(linked.definition.edges.at(-1)).toEqual({ id: "e6", from: "n1", to: "n4" });

    expect(connectWorkflowNodes(starter, "n2", "n2")).toMatchObject({ ok: false, reason: "节点不能连到自己" });
    expect(connectWorkflowNodes(starter, "n1", "n2")).toMatchObject({ ok: false, reason: "这两个节点之间已有依赖边" });
    expect(connectWorkflowNodes(starter, "n5", "n2")).toMatchObject({ ok: false });
    expect(connectWorkflowNodes(starter, "n2", "n1")).toMatchObject({ ok: false });
    expect(connectWorkflowNodes(starter, "n1", "n9")).toMatchObject({ ok: false, reason: "连线端点不存在" });
    expect(wouldCreateCycle(starter, "n5", "n2")).toBe(true);
    expect(wouldCreateCycle(starter, "n1", "n6")).toBe(false);
  });

  it("删边只删那条依赖", () => {
    const starter = createStarterWorkflow(1_000);
    const pruned = removeWorkflowEdge(starter, "e3");
    expect(pruned.edges.map((edge) => edge.id)).toEqual(["e1", "e2", "e4", "e5"]);
    expect(pruned.nodes).toHaveLength(6);
  });

  it("删节点连带删相邻边，并在 rework 指向它时清掉返工配置", () => {
    const starter = createStarterWorkflow(1_000);
    const removedMiddle = removeWorkflowNode(starter, "n3");
    expect(removedMiddle.nodes.map((node) => node.id)).toEqual(["n1", "n2", "n4", "n5", "n6"]);
    expect(removedMiddle.edges.map((edge) => edge.id)).toEqual(["e1", "e4", "e5"]);
    expect(removedMiddle.rework).toEqual(starter.rework);

    const removedEntry = removeWorkflowNode(starter, "n2");
    expect(removedEntry.rework).toBeUndefined();
    expect(removedEntry.edges.some((edge) => edge.from === "n2" || edge.to === "n2")).toBe(false);

    const removedGate = removeWorkflowNode(starter, "n5");
    expect(removedGate.rework).toBeUndefined();
  });

  it("更新节点字段时 id 不会被补丁覆盖", () => {
    const starter = createStarterWorkflow(1_000);
    const updated = updateWorkflowNode(starter, "n2", { title: "写代码", id: "hacked" } as never);
    expect(updated.nodes.find((node) => node.id === "n2")?.title).toBe("写代码");
    expect(updated.nodes.some((node) => node.id === "hacked")).toBe(false);
  });

  it("maxAttempts 被钳制在 1..5", () => {
    expect(clampAttempts(0)).toBe(1);
    expect(clampAttempts(99)).toBe(5);
    expect(clampAttempts(Number.NaN)).toBe(3);
    const starter = createStarterWorkflow(1_000);
    expect(setWorkflowRework(starter, { entryNodeId: "n2", gateNodeId: "n5", maxAttempts: 0 }).rework?.maxAttempts).toBe(1);
  });
});

describe("几何", () => {
  it("依赖边从源右中点连到目标左中点，中点用于放置边操作", () => {
    const starter = createStarterWorkflow(1_000);
    const from = starter.nodes[0]!;
    const to = starter.nodes[1]!;
    const geometry = edgeGeometry(from, to);
    expect(geometry.d.startsWith(`M ${from.position.x + WORKFLOW_NODE_WIDTH} ${from.position.y + WORKFLOW_NODE_HEIGHT / 2}`)).toBe(true);
    expect(geometry.d.endsWith(`${to.position.x} ${to.position.y + WORKFLOW_NODE_HEIGHT / 2}`)).toBe(true);
    expect(geometry.midX).toBeGreaterThan(from.position.x);
    expect(geometry.midX).toBeLessThan(to.position.x + WORKFLOW_NODE_WIDTH);
  });

  it("返工回边向下绕行，中点落在两节点下方", () => {
    const starter = createStarterWorkflow(1_000);
    const entry = starter.nodes.find((node) => node.id === "n2")!;
    const gate = starter.nodes.find((node) => node.id === "n5")!;
    const geometry = reworkGeometry(entry, gate);
    expect(geometry.midY).toBeGreaterThan(entry.position.y + WORKFLOW_NODE_HEIGHT);
    expect(geometry.d.startsWith("M ")).toBe(true);
  });

  it("舞台尺寸覆盖所有节点并留出回边空间", () => {
    const starter = createStarterWorkflow(1_000);
    const size = stageSize(starter.nodes);
    const right = Math.max(...starter.nodes.map((node) => node.position.x + WORKFLOW_NODE_WIDTH));
    expect(size.width).toBeGreaterThan(right);
    expect(size.height).toBeGreaterThan(WORKFLOW_NODE_HEIGHT + 40);
    expect(stageSize([])).toEqual({ width: 720, height: 360 });
  });
});

describe("脏比较与复制", () => {
  it("只有可编辑字段影响脏判定，磁盘元数据被忽略", () => {
    const starter = createStarterWorkflow(1_000);
    expect(isWorkflowDraftDirty(starter, { ...starter, revision: 7, updatedAt: 9_999 })).toBe(false);
    expect(isWorkflowDraftDirty(starter, updateWorkflowNode(starter, "n1", { title: "计划" }))).toBe(true);
    expect(isWorkflowDraftDirty(starter, moveWorkflowNode(starter, "n1", { x: 1, y: 2 }))).toBe(true);
    expect(isWorkflowDraftDirty(undefined, starter)).toBe(true);
    expect(workflowDraftFingerprint(starter)).toBe(workflowDraftFingerprint({ ...starter, revision: 3 }));
  });

  it("可选字段缺省与空串不同键序仍判为同一定义", () => {
    const starter = createStarterWorkflow(1_000);
    const reordered = {
      ...starter,
      nodes: starter.nodes.map((node) => ({ ...node, role: node.role ?? "" }))
    };
    expect(isWorkflowDraftDirty(starter, reordered)).toBe(false);
  });

  it("复制改名字、清元数据，节点 id 与模板引用保持不变", () => {
    const starter = createStarterWorkflow(1_000);
    const copy = cloneWorkflowDefinition(starter, 5_000);
    expect(copy.name).toBe("实施—验收工作流（副本）");
    expect(copy.revision).toBe(0);
    expect(copy.createdAt).toBe(5_000);
    expect(copy.nodes.map((node) => node.id)).toEqual(starter.nodes.map((node) => node.id));
    expect(validateWorkflowForRun(copy).ok).toBe(true);
  });
});

describe("诊断与展示", () => {
  it("诊断按节点/边归位，未定位的进 general", () => {
    const groups = groupWorkflowIssues([
      { code: "a", message: "节点问题", nodeId: "n2" },
      { code: "b", message: "边问题", edgeId: "e1" },
      { code: "c", message: "全局问题" },
      { code: "d", message: "节点问题二", nodeId: "n2" }
    ]);
    expect(groups.nodes.get("n2")?.map((issue) => issue.code)).toEqual(["a", "d"]);
    expect(groups.edges.get("e1")).toHaveLength(1);
    expect(groups.general.map((issue) => issue.code)).toEqual(["c"]);
  });

  it("来源/模型文案不编造：agent 显示当前角色，未选子智能体如实提示", () => {
    const starter = createStarterWorkflow(1_000);
    expect(workflowNodeSourceLabel(starter.nodes[0]!)).toBe("当前角色");
    const withSubagent = updateWorkflowNode(starter, "n2", { exec: { kind: "subagent", subagent: "reviewer" } });
    expect(workflowNodeSourceLabel(withSubagent.nodes.find((node) => node.id === "n2")!)).toBe("子智能体 reviewer");
    const missingSubagent = updateWorkflowNode(starter, "n2", { exec: { kind: "subagent" } });
    expect(workflowNodeSourceLabel(missingSubagent.nodes.find((node) => node.id === "n2")!)).toBe("子智能体（未选择）");
  });

  it("执行记录按轮号取用，latest 取最后一轮", () => {
    const executions = [
      { executionId: "x3", nodeId: "n2", nodeTitle: "实施", attempt: 2, status: "completed" as const },
      { executionId: "x1", nodeId: "n2", nodeTitle: "实施", attempt: 1, status: "completed" as const },
      { executionId: "x2", nodeId: "n3", nodeTitle: "审查", attempt: 1, status: "failed" as const }
    ];
    expect(executionsForNode(executions, "n2").map((execution) => execution.executionId)).toEqual(["x1", "x3"]);
    expect(latestExecutionForNode(executions, "n2")?.executionId).toBe("x3");
    expect(latestExecutionForNode(executions, "n9")).toBeUndefined();
    expect(attemptText(2, 3)).toBe("第 2/3 轮");
    expect(attemptText(1, 1)).toBe("单轮");
  });

  it("终态判定与删除保护", () => {
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("stopping")).toBe(false);
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("rejected")).toBe(true);
    expect(isTerminalRunStatus("interrupted")).toBe(true);

    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const canvas = document.createElement("div");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(canvas)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);

    expect(clampText("abcdef", 3)).toBe("abc");
    expect(clampText("ab", 3)).toBe("ab");
  });
});
