import { stableTopologicalOrder, type WorkflowDefinition, type WorkflowLayoutMode, type WorkflowNode, type WorkflowNodePosition } from "../../../shared/workflow";
import { WORKFLOW_COLUMN_STEP, WORKFLOW_NODE_HEIGHT, WORKFLOW_NODE_WIDTH, WORKFLOW_STAGE_PADDING, moveWorkflowNode, nodeRect, type WorkflowRect } from "./workflow-canvas";

export interface WorkflowSize { width: number; height: number }

type Axis = "horizontal" | "vertical";
type Direction = Axis | "wrapped";
type Point = WorkflowNodePosition;

interface WorkflowPath {
  d: string;
  /** Bézier control points or orthogonal vertices enclose the entire path. */
  extent: Point[];
}

interface ReworkPath extends WorkflowPath { label: Point }

export interface WorkflowCanvasGraph {
  nodes: WorkflowNode[];
  edges: Map<string, WorkflowPath>;
  rework?: ReworkPath;
  bounds: WorkflowRect;
  direction?: Direction;
}

const PADDING = 26;
const LAYER_GAP = 44;
const TRACK_GAP = 38;
const WRAP_ROW_GAP = 62;
const RETURN_LABEL_WIDTH = 132;

/** The old editor's only automatic layout used n1, n2, … in fixed slots. Unknown coordinates are authored. */
export function workflowLayoutMode(definition: WorkflowDefinition): WorkflowLayoutMode {
  return definition.layout ?? (definition.nodes.every((node) => {
    const slot = /^n([1-9]\d*)$/u.exec(node.id);
    return slot && node.position.x === WORKFLOW_STAGE_PADDING + (Number(slot[1]) - 1) * WORKFLOW_COLUMN_STEP
      && node.position.y === WORKFLOW_STAGE_PADDING;
  }) ? "auto" : "manual");
}

/** Freeze the projected positions on the first drag, without copying stale node content into the draft. */
export function moveWorkflowCanvasNode(definition: WorkflowDefinition, nodeId: string, position: Point, displayed?: readonly WorkflowNode[]): WorkflowDefinition {
  const positions = workflowLayoutMode(definition) === "auto" && displayed
    ? new Map(displayed.map((node) => [node.id, node.position]))
    : undefined;
  const nodes = positions ? definition.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })) : definition.nodes;
  return moveWorkflowNode({ ...definition, layout: "manual", nodes }, nodeId, position);
}

function workflowLayers(definition: WorkflowDefinition): WorkflowNode[][] {
  const order = stableTopologicalOrder(definition);
  const layers: WorkflowNode[][] = [];
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  const linked = new Set<string>();
  for (const edge of definition.edges) {
    if (!outgoing.has(edge.from) || !outgoing.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
    linked.add(edge.from);
    linked.add(edge.to);
  }
  if (order) {
    const rank = new Map<string, number>();
    for (const id of order) {
      const next = (rank.get(id) ?? 0) + 1;
      for (const to of outgoing.get(id) ?? []) rank.set(to, Math.max(next, rank.get(to) ?? 0));
    }
    for (const node of definition.nodes) {
      if (linked.has(node.id)) (layers[rank.get(node.id) ?? 0] ??= []).push(node);
    }
  }

  // Leave room to edit standalone nodes, including saved drafts with a cycle or missing edges.
  const standalone = order ? definition.nodes.filter((node) => !linked.has(node.id)) : definition.nodes;
  const perLayer = Math.ceil(Math.sqrt(standalone.length));
  for (let i = 0; i < standalone.length; i += perLayer) layers.push(standalone.slice(i, i + perLayer));
  return layers;
}

function arrangeNodes(definition: WorkflowDefinition, layers: WorkflowNode[][], direction: Axis): WorkflowNode[] {
  const vertical = direction === "vertical";
  const advance = (vertical ? WORKFLOW_NODE_HEIGHT : WORKFLOW_NODE_WIDTH) + LAYER_GAP;
  const track = (vertical ? WORKFLOW_NODE_WIDTH : WORKFLOW_NODE_HEIGHT) + TRACK_GAP;
  const tracks = Math.max(0, ...layers.map((layer) => layer.length));
  const positions = new Map<string, Point>();
  for (const [rank, layer] of layers.entries()) {
    for (const [index, node] of layer.entries()) {
      const cross = PADDING + track * (index + (tracks - layer.length) / 2);
      const along = PADDING + advance * rank;
      positions.set(node.id, vertical ? { x: cross, y: along } : { x: along, y: cross });
    }
  }
  return definition.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
}

function wrapChain(definition: WorkflowDefinition, chain: WorkflowNode[], columns: number): WorkflowNode[] {
  const positions = new Map(chain.map((node, i) => {
    const row = Math.floor(i / columns);
    const offset = i % columns;
    const col = row % 2 === 0 ? offset : columns - offset - 1;
    return [node.id, { x: PADDING + col * WORKFLOW_COLUMN_STEP, y: PADDING + row * (WORKFLOW_NODE_HEIGHT + WRAP_ROW_GAP) }];
  }));
  return definition.nodes.map((node) => ({ ...node, position: positions.get(node.id)! }));
}

function cubic(start: Point, leave: Point, approach: Point, end: Point): WorkflowPath {
  return { d: `M ${start.x} ${start.y} C ${leave.x} ${leave.y}, ${approach.x} ${approach.y}, ${end.x} ${end.y}`, extent: [start, leave, approach, end] };
}

function polyline(points: Point[]): WorkflowPath {
  const [start, ...rest] = points;
  return { d: `M ${start!.x} ${start!.y}${rest.map((point) => ` L ${point.x} ${point.y}`).join("")}`, extent: points };
}

function dependencyPath(from: WorkflowNode, to: WorkflowNode, direction: Direction | undefined, rail: number): WorkflowPath {
  const dx = to.position.x - from.position.x;
  const dy = to.position.y - from.position.y;
  const axis = direction === "wrapped" ? (dy === 0 ? "horizontal" : "vertical") : direction;
  const vertical = axis ? axis === "vertical" : Math.abs(dy / WORKFLOW_NODE_HEIGHT) > Math.abs(dx / WORKFLOW_NODE_WIDTH);
  const sign = (vertical ? dy : dx) < 0 ? -1 : 1;
  const length = vertical ? WORKFLOW_NODE_HEIGHT : WORKFLOW_NODE_WIDTH;
  const primary = (p: Point) => vertical ? p.y : p.x;
  const cross = (p: Point) => vertical ? p.x : p.y;
  const point = (along: number, across: number) => vertical ? { x: across, y: along } : { x: along, y: across };
  const middle = (vertical ? WORKFLOW_NODE_WIDTH : WORKFLOW_NODE_HEIGHT) / 2;
  const start = point(primary(from.position) + (sign > 0 ? length : 0), cross(from.position) + middle);
  const end = point(primary(to.position) + (sign > 0 ? 0 : length), cross(to.position) + middle);
  const gap = primary(end) - primary(start);
  // An edge that skips a layer can otherwise run through the intervening cards.
  if (direction && direction !== "wrapped" && gap > LAYER_GAP && sign > 0) {
    const leave = primary(start) + LAYER_GAP / 2;
    const approach = primary(end) - LAYER_GAP / 2;
    return polyline([start, point(leave, cross(start)), point(leave, rail), point(approach, rail), point(approach, cross(end)), end]);
  }
  const handle = Math.max(16, Math.abs(gap) / 2);
  return cubic(start, point(primary(start) + sign * handle, cross(start)), point(primary(end) - sign * handle, cross(end)), end);
}

function reworkPath(entry: WorkflowNode, gate: WorkflowNode, direction: Direction | undefined, left: number, right: number, bottom: number): ReworkPath {
  const vertical = direction === "vertical";
  const width = WORKFLOW_NODE_WIDTH;
  const height = WORKFLOW_NODE_HEIGHT;
  const side = vertical || direction === "wrapped" ? width * 0.73 : direction === "horizontal" ? width : width / 2;
  const drop = direction === "horizontal" ? height * 0.73 : height;
  const start = { x: gate.position.x + side, y: gate.position.y + drop };
  const end = { x: entry.position.x + side, y: entry.position.y + drop };
  if (direction === "wrapped") {
    const startY = start.y + WRAP_ROW_GAP / 2;
    const endY = end.y + WRAP_ROW_GAP / 2;
    const rail = left - 18;
    if (startY === endY) {
      return {
        ...polyline([start, { x: start.x, y: startY }, { x: end.x, y: endY }, end]),
        label: { x: (start.x + end.x) / 2, y: endY }
      };
    }
    return {
      ...polyline([start, { x: start.x, y: startY }, { x: rail, y: startY }, { x: rail, y: endY }, { x: end.x, y: endY }, end]),
      label: { x: Math.max(left + RETURN_LABEL_WIDTH / 2, (rail + end.x) / 2), y: endY }
    };
  }
  if (vertical) {
    const startY = start.y + LAYER_GAP * 0.72;
    const endY = end.y + LAYER_GAP * 0.72;
    const rail = right + RETURN_LABEL_WIDTH / 2 + 12;
    return {
      ...polyline([start, { x: start.x, y: startY }, { x: rail, y: startY }, { x: rail, y: endY }, { x: end.x, y: endY }, end]),
      label: { x: rail, y: (startY + endY) / 2 }
    };
  }
  const rail = bottom + 49;
  if (direction === "horizontal") {
    const startX = start.x + LAYER_GAP * 0.72;
    const endX = end.x + LAYER_GAP * 0.72;
    return {
      ...polyline([start, { x: startX, y: start.y }, { x: startX, y: rail }, { x: endX, y: rail }, { x: endX, y: end.y }, end]),
      label: { x: (startX + endX) / 2, y: rail }
    };
  }
  return {
    ...polyline([start, { x: start.x, y: rail }, { x: end.x, y: rail }, end]),
    label: { x: (start.x + end.x) / 2, y: rail }
  };
}

function canvasGraph(definition: WorkflowDefinition, nodes: WorkflowNode[], direction?: Direction): WorkflowCanvasGraph {
  if (nodes.length === 0) return { nodes, edges: new Map(), bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const rects = nodes.map(nodeRect);
  const points = rects.flatMap((rect) => [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }]);
  const right = Math.max(...points.map((p) => p.x));
  const bottom = Math.max(...points.map((p) => p.y));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = new Map<string, WorkflowPath>();
  for (const edge of definition.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const path = dependencyPath(from, to, direction, (direction === "vertical" ? right : bottom) + 21);
    edges.set(edge.id, path);
    points.push(...path.extent);
  }
  const entry = definition.rework && byId.get(definition.rework.entryNodeId);
  const gate = definition.rework && byId.get(definition.rework.gateNodeId);
  const rework = entry && gate ? reworkPath(entry, gate, direction, Math.min(...points.map((point) => point.x)), right, bottom) : undefined;
  if (rework) {
    points.push(...rework.extent, { x: rework.label.x - RETURN_LABEL_WIDTH / 2, y: rework.label.y - 12 }, { x: rework.label.x + RETURN_LABEL_WIDTH / 2, y: rework.label.y + 12 });
  }
  const x = Math.min(...points.map((p) => p.x)) - PADDING;
  const y = Math.min(...points.map((p) => p.y)) - PADDING;
  const bounds = { x, y, width: Math.max(...points.map((p) => p.x)) + PADDING - x, height: Math.max(...points.map((p) => p.y)) + PADDING - y };
  return { nodes, edges, ...(rework ? { rework } : {}), bounds, ...(direction ? { direction } : {}) };
}

/** Fit the entire graph at up to 100%, including large graphs whose overview needs a small scale. */
export function fitWorkflowScale(bounds: WorkflowSize, viewport: WorkflowSize): number {
  if (viewport.width <= 2 || viewport.height <= 2) return 1;
  return Math.min(1, (viewport.width - 2) / bounds.width, (viewport.height - 2) / bounds.height);
}

/** The projection is view state. Nothing here changes a definition, its fingerprint, or its execution plan. */
export function projectWorkflowCanvas(definition: WorkflowDefinition, viewport: WorkflowSize): WorkflowCanvasGraph {
  if (workflowLayoutMode(definition) === "manual") return canvasGraph(definition, definition.nodes);
  const layers = workflowLayers(definition);
  let best = canvasGraph(definition, arrangeNodes(definition, layers, "vertical"), "vertical");
  if (!best.direction) return best;
  if (viewport.width >= 760) {
    const horizontal = canvasGraph(definition, arrangeNodes(definition, layers, "horizontal"), "horizontal");
    if (fitWorkflowScale(horizontal.bounds, viewport) >= fitWorkflowScale(best.bounds, viewport)) best = horizontal;
  }
  const chain = layers.flat();
  // Consecutive steps can be folded at row ends. Keep true branches in shared rank lanes.
  if (viewport.width > 0 && layers.length === chain.length && chain.length >= 4) {
    const consecutiveLinks = new Set(chain.slice(1).map((node, i) => `${chain[i]!.id}\0${node.id}`));
    if (definition.edges.every(({ from, to }) => consecutiveLinks.has(`${from}\0${to}`))) {
      for (let columns = 2; columns <= Math.min(6, chain.length - 1); columns += 1) {
        const wrapped = canvasGraph(definition, wrapChain(definition, chain, columns), "wrapped");
        if (fitWorkflowScale(wrapped.bounds, viewport) > fitWorkflowScale(best.bounds, viewport) * 1.05) best = wrapped;
      }
    }
  }
  return best;
}
