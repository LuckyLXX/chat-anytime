import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TeamSnapshot } from "../../../shared/protocol";
import { TeamBoard } from "./TeamBoard";

const snapshot: TeamSnapshot = {
  running: 1,
  members: [
    {
      name: "portrait-render",
      status: "running",
      description: "渲染器",
      sessionId: "child-1",
      sessionFile: "/tmp/child-1.jsonl",
      model: "deepseek/v4",
      thinkingLevel: "medium",
      taskId: "task-1",
      taskSubject: "渲染器骨架",
      activity: {
        steps: 2,
        startedAt: Date.now() - 65_000,
        currentTool: "edit",
        currentDetail: "src/portrait/render.ts",
        tokens: 18_200,
        contextPercent: 42,
        recent: [
          { tool: "read", detail: "src/portrait/layout.ts", status: "done", startedAt: 1, endedAt: 2, durationMs: 400 },
          { tool: "edit", detail: "src/portrait/render.ts", status: "running", startedAt: 3 }
        ]
      }
    },
    { name: "portrait-data", status: "inactive", description: "数据适配", activity: { steps: 1, recent: [] } },
    {
      name: "portrait-review",
      status: "stopping",
      description: "审查",
      settlement: {
        id: "child-3:2",
        memberName: "portrait-review",
        outcome: "completed",
        summary: "审查完成：见 src/portrait/report.md",
        taskIds: ["task-1"],
        artifacts: ["src/portrait/report.md"],
        reported: false,
        at: 1_700_000_000_000
      }
    },
    {
      name: "portrait-bash",
      status: "running",
      description: "命令验证",
      settlement: {
        id: "child-4:1",
        memberName: "portrait-bash",
        outcome: "failed",
        taskIds: [],
        artifacts: [],
        blocker: { kind: "permission-denied", toolName: "bash", summary: "执行命令：npm test" },
        reported: true,
        error: "被权限拦截",
        at: 1_700_000_000_500
      }
    }
  ],
  tasks: [
    { id: "task-1", revision: 2, subject: "渲染器骨架", status: "in_progress", ownerName: "portrait-render", blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] },
    { id: "task-2", revision: 1, subject: "回归测试", status: "pending", blockedBy: ["task-1"], writeScopes: [], ready: false, writeScopeWarnings: [] }
  ]
};

function markup(mode: "dock" | "full" = "dock", selectedName = "portrait-render"): string {
  return renderToStaticMarkup(
    <TeamBoard
      snapshot={snapshot}
      mode={mode}
      width={420}
      selectedName={selectedName}
      onSelect={() => undefined}
      onResize={() => undefined}
      onToggleMode={() => undefined}
      onClose={() => undefined}
      onStopAll={() => undefined}
      onStopMember={() => undefined}
      onSend={() => Promise.resolve()}
      onOpenArtifact={() => undefined}
    />
  );
}

describe("TeamBoard", () => {
  it("renders the dock with members, live activity and send controls", () => {
    const html = markup("dock");
    expect(html).toContain('data-control="team-board"');
    expect(html).toContain("portrait-render");
    expect(html).toContain("18.2k tokens");
    expect(html).toContain("src/portrait/render.ts");
    expect(html).toContain('data-control="team-board-send"');
    expect(html).toContain('data-control="team-board-stop-all"');
    expect(html).toContain("停止成员");
  });

  it("shows the last settlement, its blocker and the stopping state", () => {
    const completed = markup("dock", "portrait-review");
    // 结算行：结局 + 短结论 + 产物数都能看见，不靠颜色区分。
    expect(completed).toContain('class="team-settlement completed"');
    expect(completed).toContain("上回合已完成");
    expect(completed).toContain("审查完成：见 src/portrait/report.md");
    expect(completed).toContain("产物 1");
    // 正在停止的成员：状态标签写「正在停止」，不谎报已停止。
    expect(completed).toContain("正在停止");

    const blocked = markup("dock", "portrait-bash");
    // 卡点直接写进结算行（成员名 + 工具 + 原因），列表行也带徽标。
    expect(blocked).toContain("权限被拒");
    expect(blocked).toContain("执行命令：npm test");
    expect(blocked).toContain("team-member-blocker");
    expect(blocked).toContain("上回合失败");
  });

  it("renders the full formation with summary, graph, task board, comms and return action", () => {
    const html = markup("full");
    expect(html).toContain("团队编队");
    expect(html).toContain("任务板");
    expect(html).toContain("渲染器骨架");
    expect(html).toContain("回归测试");
    expect(html).toContain("返回对话");
    // 编队页四块：汇总条 / Agent 网络 / 成员栏 / 通讯记录。
    expect(html).toContain("任务进度");
    expect(html).toContain("Agent 网络");
    expect(html).toContain('class="team-graph"');
    expect(html).toContain("team-rail-item");
    expect(html).toContain("通讯记录");
    expect(html).toContain("本次运行还没有团队消息");
  });
});
