import type { TeamMemberSummary, TeamTaskSummary } from "../../../shared/protocol";

/**
 * 编队页「Agent 网络」的布局纯函数：lead 在最上，成员按行排布，每个成员下方挂
 * 一个当前任务节点，任务依赖用虚线连到被依赖的任务。组件只负责把坐标画出来，
 * 布局本身在这里可测试（换行、任务挑选、依赖边、宽度不足时横向滚动）。
 */

export const GRAPH_PAD = 18;
export const GRAPH_NODE_W = 210;
export const GRAPH_NODE_H = 72;
export const GRAPH_TASK_W = 190;
export const GRAPH_TASK_H = 58;
export const GRAPH_LEAD_W = 220;
export const GRAPH_LEAD_H = 72;
export const GRAPH_COL_GAP = 22;
export const GRAPH_ROW_GAP = 58;
export const GRAPH_TASK_GAP = 26;
export const GRAPH_LEAD_GAP = 30;
export const GRAPH_MAX_COLS = 6;

export interface TeamGraphNode {
  /** `lead` / `member:<name>` / `task:<taskId>`。 */
  id: string;
  kind: "lead" | "member" | "task";
  x: number;
  y: number;
  w: number;
  h: number;
  /** 成员节点与任务节点的归属成员名（点击任务时选中 owner）。 */
  memberName?: string;
  taskId?: string;
  /** 成员节点对应的成员下标（决定连线颜色），lead 为 -1。 */
  colorIndex: number;
}

export interface TeamGraphEdge {
  from: string;
  to: string;
  kind: "spawn" | "owns" | "depends";
  /** 成员下标（决定颜色）；依赖边为 -1。 */
  colorIndex: number;
}

export interface TeamGraphLayout {
  nodes: TeamGraphNode[];
  edges: TeamGraphEdge[];
  /** 实际画布宽度（可能大于传入宽度，交给外层横向滚动）。 */
  width: number;
  height: number;
}

/** 每个成员只看一个「当前任务」：进行中 > 就绪待处理 > 阻塞待处理；已完成不上图。 */
function currentTaskFor(tasks: TeamTaskSummary[], memberName: string): TeamTaskSummary | undefined {
  const owned = tasks.filter((task) => task.ownerName === memberName && task.status !== "completed");
  return owned.find((task) => task.status === "in_progress")
    ?? owned.find((task) => task.status === "pending" && task.ready)
    ?? owned.find((task) => task.status === "pending");
}

export function layoutTeamGraph(
  members: TeamMemberSummary[],
  tasks: TeamTaskSummary[],
  width: number
): TeamGraphLayout {
  const available = Math.max(GRAPH_NODE_W + 2 * GRAPH_PAD, Math.floor(width));
  const cols = Math.max(1, Math.min(
    GRAPH_MAX_COLS,
    Math.max(1, members.length),
    Math.floor((available - 2 * GRAPH_PAD + GRAPH_COL_GAP) / (GRAPH_NODE_W + GRAPH_COL_GAP))
  ));
  const contentWidth = 2 * GRAPH_PAD + cols * GRAPH_NODE_W + (cols - 1) * GRAPH_COL_GAP;
  const canvasWidth = Math.max(available, contentWidth);
  // 窄容器或成员较多时收紧纵向间距，让两行成员 + 任务仍尽量落在一屏内。
  const compact = available < 760 || members.length > 3;
  const taskGap = compact ? 12 : GRAPH_TASK_GAP;
  const rowGap = compact ? 16 : GRAPH_ROW_GAP;
  const leadGap = compact ? 16 : GRAPH_LEAD_GAP;

  const nodes: TeamGraphNode[] = [];
  const edges: TeamGraphEdge[] = [];

  // lead 永远在顶部居中（即使没有成员也画，避免空图没有根）。
  nodes.push({
    id: "lead",
    kind: "lead",
    x: Math.round((canvasWidth - GRAPH_LEAD_W) / 2),
    y: GRAPH_PAD,
    w: GRAPH_LEAD_W,
    h: GRAPH_LEAD_H,
    colorIndex: -1
  });

  let rowY = GRAPH_PAD + GRAPH_LEAD_H + leadGap;
  let height = rowY;
  for (let start = 0; start < members.length; start += cols) {
    const row = members.slice(start, start + cols);
    const rowWidth = row.length * GRAPH_NODE_W + (row.length - 1) * GRAPH_COL_GAP;
    const rowStartX = GRAPH_PAD + Math.max(0, (canvasWidth - 2 * GRAPH_PAD - rowWidth) / 2);
    let taskBottom = rowY + GRAPH_NODE_H;
    row.forEach((member, index) => {
      const colorIndex = start + index;
      const x = Math.round(rowStartX + index * (GRAPH_NODE_W + GRAPH_COL_GAP));
      const memberId = `member:${member.name}`;
      nodes.push({
        id: memberId,
        kind: "member",
        x,
        y: rowY,
        w: GRAPH_NODE_W,
        h: GRAPH_NODE_H,
        memberName: member.name,
        colorIndex
      });
      edges.push({ from: "lead", to: memberId, kind: "spawn", colorIndex });

      const task = currentTaskFor(tasks, member.name);
      if (!task) return;
      const taskId = `task:${task.id}`;
      const taskY = rowY + GRAPH_NODE_H + taskGap;
      nodes.push({
        id: taskId,
        kind: "task",
        x: Math.round(x + (GRAPH_NODE_W - GRAPH_TASK_W) / 2),
        y: taskY,
        w: GRAPH_TASK_W,
        h: GRAPH_TASK_H,
        memberName: member.name,
        taskId: task.id,
        colorIndex
      });
      edges.push({ from: memberId, to: taskId, kind: "owns", colorIndex });
      taskBottom = Math.max(taskBottom, taskY + GRAPH_TASK_H);
    });
    height = Math.max(height, taskBottom);
    rowY = taskBottom + rowGap;
  }

  // 任务依赖：两端都可见才画（被依赖任务可能属于另一个成员）。
  const taskNodeIds = new Map(nodes.filter((node) => node.kind === "task").map((node) => [node.taskId!, node.id]));
  for (const task of tasks) {
    const to = taskNodeIds.get(task.id);
    if (!to) continue;
    for (const blockerId of task.blockedBy) {
      const from = taskNodeIds.get(blockerId);
      if (from) edges.push({ from, to, kind: "depends", colorIndex: -1 });
    }
  }

  return {
    nodes,
    edges,
    width: canvasWidth,
    height: Math.max(height + GRAPH_PAD, GRAPH_PAD * 2 + GRAPH_LEAD_H + leadGap)
  };
}
