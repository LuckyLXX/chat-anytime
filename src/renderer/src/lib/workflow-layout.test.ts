import { describe, expect, it } from "vitest";
import { validateWorkflowForRun, type WorkflowDefinition } from "../../../shared/workflow";
import { WORKFLOW_NODE_HEIGHT, WORKFLOW_NODE_WIDTH, createStarterWorkflow, nodeRect } from "./workflow-canvas";
import { fitWorkflowScale, moveWorkflowCanvasNode, projectWorkflowCanvas, workflowLayoutMode, type WorkflowCanvasGraph } from "./workflow-layout";

const narrow = { width: 420, height: 840 };
const wide = { width: 1700, height: 440 };

function expectNoOverlap(graph: WorkflowCanvasGraph): void {
  const rectangles = graph.nodes.map(nodeRect);
  rectangles.forEach((a, index) => rectangles.slice(index + 1).forEach((b) => {
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  }));
}

function expectCompleteBounds(graph: WorkflowCanvasGraph): void {
  const { x, y, width, height } = graph.bounds;
  const points = [...graph.edges.values()].flatMap((edge) => edge.extent);
  points.push(...(graph.rework?.extent ?? []));
  if (graph.rework) {
    const label = graph.rework.label;
    points.push({ x: label.x - 66, y: label.y - 12 }, { x: label.x + 66, y: label.y + 12 });
  }
  for (const node of graph.nodes) {
    points.push(node.position, { x: node.position.x + WORKFLOW_NODE_WIDTH, y: node.position.y + WORKFLOW_NODE_HEIGHT });
  }
  for (const point of points) {
    expect(point.x).toBeGreaterThan(x);
    expect(point.x).toBeLessThan(x + width);
    expect(point.y).toBeGreaterThan(y);
    expect(point.y).toBeLessThan(y + height);
  }
}

describe("自适应排版", () => {
  it("旧横排模板自动适配，单个手动坐标或显式 manual 均保留", () => {
    const { layout: _layout, ...legacy } = createStarterWorkflow(1);
    expect(workflowLayoutMode(legacy)).toBe("auto");
    expect(projectWorkflowCanvas(legacy, narrow).nodes.map((node) => node.position.x)).toEqual(Array(6).fill(26));
    const moved = { ...legacy, nodes: legacy.nodes.map((node) => node.id === "n1" ? { ...node, position: { x: -70, y: -45 } } : node) };
    expect(workflowLayoutMode(moved)).toBe("manual");
    expect(projectWorkflowCanvas(moved, narrow).nodes).toEqual(moved.nodes);
    expectCompleteBounds(projectWorkflowCanvas(moved, narrow));
    expect(workflowLayoutMode({ ...legacy, layout: "manual" })).toBe("manual");
  });

  it("同一张图在窄视口纵排，在宽视口横排，分别走对应方向的端口", () => {
    const definition = createStarterWorkflow(1);
    const original = structuredClone(definition);
    const vertical = projectWorkflowCanvas(definition, narrow);
    const horizontal = projectWorkflowCanvas(definition, wide);
    expect(vertical.direction).toBe("vertical");
    expect(horizontal.direction).toBe("horizontal");
    for (const graph of [vertical, horizontal]) {
      const start = graph.nodes[0]!.position;
      const first = graph.edges.get("e1")!.extent[0];
      expect(first).toEqual(graph.direction === "vertical"
        ? { x: start.x + WORKFLOW_NODE_WIDTH / 2, y: start.y + WORKFLOW_NODE_HEIGHT }
        : { x: start.x + WORKFLOW_NODE_WIDTH, y: start.y + WORKFLOW_NODE_HEIGHT / 2 });
      expectNoOverlap(graph);
      expectCompleteBounds(graph);
    }
    expect(definition).toEqual(original);
    expect(validateWorkflowForRun({ ...definition, nodes: vertical.nodes }).plan).toEqual(validateWorkflowForRun(original).plan);
  });

  it("短窗口折叠长链，每行尾部转向下一行而不是缩成一条长线", () => {
    const definition = createStarterWorkflow(1);
    const viewport = { width: 625, height: 394 };
    const graph = projectWorkflowCanvas(definition, viewport);
    expect(graph.direction).toBe("wrapped");
    expect(fitWorkflowScale(graph.bounds, viewport)).toBeGreaterThan(0.75);
    const nextRow = graph.nodes.findIndex((node) => node.position.y !== graph.nodes[0]!.position.y);
    expect(nextRow).toBeGreaterThan(1);
    expect(graph.nodes[nextRow]?.position.x).toBe(graph.nodes[nextRow - 1]?.position.x);
    expectNoOverlap(graph);
    expectCompleteBounds(graph);
  });

  it("分支同层并列、合并位于其后，跨层依赖和返工各走卡片外侧", () => {
    const source = createStarterWorkflow(1);
    const definition = { ...source, edges: [
      ...source.edges.filter(({ id }) => id !== "e3"),
      { id: "branch", from: "n2", to: "n4" },
      { id: "merge", from: "n3", to: "n5" },
      { id: "skip", from: "n2", to: "n5" }
    ] };
    const graph = projectWorkflowCanvas(definition, narrow);
    const [, , a, b, join] = graph.nodes;
    expect(a!.position.y).toEqual(b!.position.y);
    expect(a!.position.x).toBeLessThan(b!.position.x);
    expect(join!.position.y).toBeGreaterThan(a!.position.y);
    expect(graph.edges.get("skip")!.extent[2]!.x).toBeGreaterThan(b!.position.x + WORKFLOW_NODE_WIDTH);
    expect(graph.rework!.label.x).toBeGreaterThan(graph.edges.get("skip")!.extent[2]!.x);
    expect(graph).toEqual(projectWorkflowCanvas(definition, narrow));
    expectNoOverlap(graph);
    expectCompleteBounds(graph);
  });

  it("散点、成环和空白草稿可以显示，长图仍能适应全图", () => {
    const source = createStarterWorkflow(1);
    const cycle = { ...source, edges: [...source.edges, { id: "cycle", from: "n6", to: "n2" }] };
    const disconnected = { ...source, edges: source.edges.slice(0, 1) };
    for (const draft of [cycle, disconnected]) expectNoOverlap(projectWorkflowCanvas(draft, narrow));
    expect(projectWorkflowCanvas({ ...source, nodes: [] }, narrow).nodes).toEqual([]);
    const chain: WorkflowDefinition = { ...source, nodes: Array.from({ length: 32 }, (_, i) => ({ ...source.nodes[0]!, id: `n${i + 1}` })),
      edges: Array.from({ length: 31 }, (_, i) => ({ id: `e${i + 1}`, from: `n${i + 1}`, to: `n${i + 2}` })) };
    const viewport = { width: 420, height: 420 };
    const graph = projectWorkflowCanvas(chain, viewport);
    const zoom = fitWorkflowScale(graph.bounds, viewport);
    expect(zoom).toBeLessThan(0.5);
    expect(graph.bounds.height * zoom).toBeLessThan(viewport.height);
    expect(graph.bounds.width * zoom).toBeLessThan(viewport.width);
    expectNoOverlap(graph);
  });

  it("第一次拖动固定当前排版坐标，再次拖动只更新目标节点", () => {
    const source = createStarterWorkflow(1);
    const displayed = projectWorkflowCanvas(source, narrow).nodes;
    const moved = moveWorkflowCanvasNode(source, "n2", { x: 73, y: 99 }, displayed);
    expect(moved.layout).toBe("manual");
    expect(moved.nodes[0]?.position).toEqual(displayed[0]?.position);
    expect(projectWorkflowCanvas(moved, wide).nodes[1]?.position).toEqual({ x: 73, y: 99 });
    expect(moveWorkflowCanvasNode(moved, "n2", { x: 12, y: 34 }, source.nodes).nodes[0]?.position).toEqual(displayed[0]?.position);
    expect(validateWorkflowForRun(moved).plan).toEqual(validateWorkflowForRun(source).plan);
  });
});
