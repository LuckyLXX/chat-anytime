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
    { name: "portrait-data", status: "inactive", description: "数据适配", activity: { steps: 1, recent: [] } }
  ],
  tasks: [
    { id: "task-1", revision: 2, subject: "渲染器骨架", status: "in_progress", ownerName: "portrait-render", blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] },
    { id: "task-2", revision: 1, subject: "回归测试", status: "pending", blockedBy: ["task-1"], writeScopes: [], ready: false, writeScopeWarnings: [] }
  ]
};

function markup(mode: "dock" | "full" = "dock"): string {
  return renderToStaticMarkup(
    <TeamBoard
      snapshot={snapshot}
      mode={mode}
      width={420}
      selectedName="portrait-render"
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

  it("renders the full workbench with the task board and return action", () => {
    const html = markup("full");
    expect(html).toContain("团队工作台");
    expect(html).toContain("任务板");
    expect(html).toContain("渲染器骨架");
    expect(html).toContain("回归测试");
    expect(html).toContain("返回对话");
  });
});
