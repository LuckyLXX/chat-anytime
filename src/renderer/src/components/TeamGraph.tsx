import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TeamLeadSummary, TeamMemberSummary, TeamTaskSummary } from "../../../shared/protocol";
import { formatElapsed, formatTokens, statusLabel, taskStatusLabel } from "./TeamBoardParts";
import { layoutTeamGraph, type TeamGraphEdge, type TeamGraphNode } from "../lib/team-graph";

/**
 * 编队页的「Agent 网络」：SVG 画边 + 绝对定位 HTML 节点（文字可换行、可聚焦）。
 * 只负责展示与选中，布局在 lib/team-graph.ts 的纯函数里。
 */

const COLOR_NAMES: Record<string, string> = {
  amber: "#d97706",
  rose: "#e11d48",
  orange: "#ea580c",
  emerald: "#059669",
  teal: "#0d9488",
  blue: "#2563eb",
  violet: "#7c3aed",
  slate: "#64748b"
};
const FALLBACK_COLORS = ["#818cf8", "#34d399", "#fbbf24", "#fb7185", "#38bdf8", "#c084fc"];

function memberColor(member: TeamMemberSummary | undefined, index: number): string {
  const named = member?.color ? COLOR_NAMES[member.color] : undefined;
  return named ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!;
}

function edgePath(edge: TeamGraphEdge, nodes: Map<string, TeamGraphNode>): string {
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);
  if (!from || !to) return "";
  const fromX = from.x + from.w / 2;
  const toX = to.x + to.w / 2;
  if (edge.kind === "depends") {
    const bottom = Math.max(from.y + from.h, to.y + to.h) + 14;
    return `M ${fromX} ${from.y + from.h} C ${fromX} ${bottom} ${toX} ${bottom} ${toX} ${to.y + to.h}`;
  }
  if (edge.kind === "spawn") {
    const midY = from.y + from.h + (to.y - (from.y + from.h)) * 0.55;
    return `M ${fromX} ${from.y + from.h} C ${fromX} ${midY} ${toX} ${midY} ${toX} ${to.y}`;
  }
  return `M ${fromX} ${from.y + from.h} L ${toX} ${to.y}`;
}

export function TeamGraph({ members, tasks, lead, selectedName, leadSelected, now, width: fixedWidth, onSelect, onSelectLead }: {
  members: TeamMemberSummary[];
  tasks: TeamTaskSummary[];
  lead?: TeamLeadSummary;
  selectedName?: string;
  leadSelected: boolean;
  now: number;
  /** 测试/静态预览用的固定宽度；正常渲染由 ResizeObserver 测容器。 */
  width?: number;
  onSelect(name: string): void;
  onSelectLead(): void;
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(880);

  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const next = host.clientWidth;
    if (next > 0 && next !== measured) setMeasured(next);
  }, [measured]);

  useEffect(() => {
    if (fixedWidth !== undefined) return;
    measure();
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [measure, fixedWidth]);

  const width = fixedWidth ?? measured;
  const layout = useMemo(() => layoutTeamGraph(members, tasks, width), [members, tasks, width]);
  const nodeIndex = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes]);
  const memberByName = useMemo(() => new Map(members.map((member) => [member.name, member])), [members]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const isActive = (node: TeamGraphNode): boolean => {
    if (node.kind === "lead") return leadSelected;
    if (node.kind === "task") return node.memberName === selectedName && !leadSelected;
    return node.memberName === selectedName && !leadSelected;
  };

  const connected = (edge: TeamGraphEdge): boolean => {
    if (leadSelected) return edge.from === "lead";
    if (!selectedName) return false;
    const from = nodeIndex.get(edge.from);
    const to = nodeIndex.get(edge.to);
    return from?.memberName === selectedName || to?.memberName === selectedName;
  };

  return (
    <div className="team-graph" ref={hostRef}>
      <div className="team-graph-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="team-graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map((edge) => {
            const active = connected(edge);
            const node = nodeIndex.get(edge.to);
            const color = edge.kind === "depends"
              ? "var(--warning)"
              : memberColor(node ? memberByName.get(node.memberName ?? "") : undefined, Math.max(0, edge.colorIndex));
            return (
              <path
                key={`${edge.kind}-${edge.from}-${edge.to}`}
                d={edgePath(edge, nodeIndex)}
                className={`team-graph-edge ${edge.kind}${active ? " active" : ""}`}
                style={{ stroke: color }}
              />
            );
          })}
        </svg>
        {layout.nodes.map((node) => {
          if (node.kind === "lead") {
            return (
              <button
                key={node.id}
                type="button"
                className={`team-graph-node lead${leadSelected ? " selected" : ""}`}
                style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
                onClick={onSelectLead}
                aria-label="Lead（当前会话）"
              >
                <span className="tg-title"><span className="tg-dot lead" />lead<span className="tg-role">主导</span></span>
                <span className="tg-meta">{lead?.model ?? "当前会话"}</span>
                <span className="tg-metrics">
                  <b>{formatTokens(lead?.tokens)}</b> tok
                  <span>·</span><b>{lead?.steps ?? "—"}</b> 步
                  {lead?.cost !== undefined && <><span>·</span><b>${lead.cost.toFixed(2)}</b></>}
                </span>
                <span className="tg-bar"><i style={{ width: `${Math.max(0, Math.min(100, lead?.contextPercent ?? 0))}%` }} /></span>
              </button>
            );
          }
          if (node.kind === "member") {
            const member = memberByName.get(node.memberName ?? "");
            if (!member) return null;
            const color = memberColor(member, node.colorIndex);
            const activity = member.activity;
            const current = activity?.currentTool
              ? `${activity.currentTool}${activity.currentDetail ? ` ${activity.currentDetail}` : ""}`
              : member.taskSubject ?? "等待任务";
            return (
              <button
                key={node.id}
                type="button"
                className={`team-graph-node member${isActive(node) ? " selected" : ""}`}
                style={{ left: node.x, top: node.y, width: node.w, height: node.h, borderColor: isActive(node) ? color : undefined }}
                onClick={() => member && onSelect(member.name)}
                aria-label={`成员 ${member.name}`}
              >
                <span className="tg-title">
                  <span className="tg-dot" style={{ background: color }} />
                  <span className="tg-name">{member.name}</span>
                  <span className={`st ${member.status}`}>{statusLabel(member.status)}</span>
                </span>
                <span className="tg-metrics">
                  <b>{formatTokens(activity?.tokens)}</b> tok
                  <span>·</span><b>{activity?.steps ?? 0}</b> 步
                  {member.status === "running" && <><span>·</span>{formatElapsed(activity?.startedAt, now)}</>}
                </span>
                <span className="tg-tool" title={current}>{current}</span>
              </button>
            );
          }
          const task = taskById.get(node.taskId ?? "");
          if (!task) return null;
          return (
            <button
              key={node.id}
              type="button"
              className={`team-graph-node task${isActive(node) ? " selected" : ""}`}
              style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
              onClick={() => node.memberName && onSelect(node.memberName)}
              aria-label={`任务 ${task.id} ${task.subject}`}
            >
              <span className="tg-title">
                <span className="tg-task-id">{task.id}</span>
                <span className={`st ${task.status === "pending" ? (task.ready ? "ready" : "blocked") : task.status}`}>{taskStatusLabel(task)}</span>
              </span>
              <span className="tg-task-subject" title={task.subject}>{task.subject}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
