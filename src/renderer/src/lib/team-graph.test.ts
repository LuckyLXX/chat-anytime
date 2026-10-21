import { describe, expect, it } from "vitest";
import type { TeamMemberSummary, TeamTaskSummary } from "../../../shared/protocol";
import { layoutTeamGraph } from "./team-graph";

function member(name: string, status: TeamMemberSummary["status"] = "running"): TeamMemberSummary {
  return { name, status, model: "p/m" };
}

function task(overrides: Partial<TeamTaskSummary> & Pick<TeamTaskSummary, "id">): TeamTaskSummary {
  return {
    revision: 1,
    subject: `任务 ${overrides.id}`,
    status: "pending",
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...overrides
  };
}

describe("layoutTeamGraph", () => {
  it("把 lead 放在顶部，成员横向排开，并画出派生边", () => {
    const layout = layoutTeamGraph([member("a"), member("b"), member("c")], [], 900);
    const lead = layout.nodes.find((node) => node.id === "lead")!;
    const members = layout.nodes.filter((node) => node.kind === "member");
    expect(members).toHaveLength(3);
    expect(new Set(members.map((node) => node.y)).size).toBe(1);
    expect(members[0]!.y).toBeGreaterThan(lead.y);
    expect(members.map((node) => node.x)).toEqual([...members.map((node) => node.x)].sort((left, right) => left - right));
    expect(layout.edges.filter((edge) => edge.kind === "spawn")).toHaveLength(3);
    expect(layout.width).toBeGreaterThanOrEqual(900);
  });

  it("成员超过一行的容量时换行并增高", () => {
    const members = Array.from({ length: 8 }, (_, index) => member(`m-${index}`));
    const narrow = layoutTeamGraph(members, [], 700);
    const rows = new Set(narrow.nodes.filter((node) => node.kind === "member").map((node) => node.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(narrow.width).toBeGreaterThanOrEqual(700);

    const wide = layoutTeamGraph(members, [], 1400);
    expect(wide.height).toBeLessThan(narrow.height);
  });

  it("每个成员只挂一个当前任务：进行中优先于待处理，已完成不上图", () => {
    const layout = layoutTeamGraph(
      [member("a"), member("b")],
      [
        task({ id: "task-1", ownerName: "a", status: "pending" }),
        task({ id: "task-2", ownerName: "a", status: "in_progress" }),
        task({ id: "task-3", ownerName: "b", status: "completed" })
      ],
      900
    );
    const taskNodes = layout.nodes.filter((node) => node.kind === "task");
    expect(taskNodes.map((node) => node.taskId)).toEqual(["task-2"]);
    expect(layout.edges.filter((edge) => edge.kind === "owns")).toHaveLength(1);
  });

  it("两个任务都可见时画依赖虚线边", () => {
    const layout = layoutTeamGraph(
      [member("a"), member("b")],
      [
        task({ id: "task-1", ownerName: "a", status: "in_progress" }),
        task({ id: "task-2", ownerName: "b", status: "pending", blockedBy: ["task-1"], ready: false })
      ],
      900
    );
    const depends = layout.edges.find((edge) => edge.kind === "depends");
    expect(depends).toMatchObject({ from: "task:task-1", to: "task:task-2" });
  });

  it("没有成员时也保留 lead 根节点", () => {
    const layout = layoutTeamGraph([], [], 600);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.id).toBe("lead");
    expect(layout.height).toBeGreaterThan(0);
  });
});
