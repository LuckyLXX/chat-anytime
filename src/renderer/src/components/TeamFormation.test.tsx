import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TeamSnapshot } from "../../../shared/protocol";
import { TeamFormation } from "./TeamFormation";
import { filterTasks, taskCounts } from "./TeamBoardParts";

const snapshot: TeamSnapshot = {
  running: 1,
  lead: { model: "deepseek/v4", status: "inactive", tokens: 1_040_000, cost: 1.1, steps: 171, contextPercent: 40 },
  members: [
    {
      name: "migration-dev",
      status: "running",
      model: "deepseek/v4",
      taskId: "task-1",
      taskSubject: "旧记录迁移到新表",
      lastReport: { text: "迁移脚本已跑通，正在补回滚脚本。", at: 1_700_000_000_000 },
      activity: { steps: 23, tokens: 252_900, cost: 0.91, contextPercent: 40, currentTool: "edit", recent: [] }
    },
    {
      name: "qa-browser",
      status: "inactive",
      model: "deepseek/v4",
      activity: { steps: 6, tokens: 15_300, cost: 0.05, contextPercent: 12, recent: [] }
    }
  ],
  tasks: [
    { id: "task-1", revision: 1, subject: "旧记录迁移到新表", status: "in_progress", ownerName: "migration-dev", blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] },
    { id: "task-2", revision: 1, subject: "浏览器冒烟回归", status: "completed", ownerName: "qa-browser", blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] },
    { id: "task-3", revision: 1, subject: "补齐回滚脚本", status: "pending", blockedBy: ["task-1"], writeScopes: [], ready: false, writeScopeWarnings: [] }
  ],
  messages: [
    { id: "m-1", sender: "qa-browser", target: "lead", text: "回归用例 12/12 通过。", at: 1_700_000_100_000, kind: "report" },
    { id: "m-2", sender: "lead", target: "migration-dev", text: "先补 schema 对比。", at: 1_700_000_200_000, kind: "assign" }
  ]
};

function markup(): string {
  return renderToStaticMarkup(
    <TeamFormation
      snapshot={snapshot}
      selectedName="migration-dev"
      now={1_700_000_300_000}
      draft=""
      onDraftChange={() => undefined}
      sending={false}
      onSubmitSend={() => undefined}
      onSelect={() => undefined}
      onStop={() => undefined}
      onOpenTranscript={() => undefined}
      onOpenArtifact={() => undefined}
    />
  );
}

describe("TeamFormation", () => {
  it("renders the summary with task progress, tokens and dollar cost", () => {
    const html = markup();
    expect(html).toContain("任务进度");
    expect(html).toContain("<b>1/3</b>");
    expect(html).toContain("1.3M");
    expect(html).toContain("$2.06");
  });

  it("renders the lead row, member rows with latest report and the graph", () => {
    const html = markup();
    expect(html).toContain("team-rail-item lead");
    expect(html).toContain("migration-dev");
    expect(html).toContain("迁移脚本已跑通，正在补回滚脚本。");
    expect(html).toContain('class="team-graph"');
    expect(html).toContain("task-1");
  });

  it("renders communication rows newest first with kind tags", () => {
    const html = markup();
    expect(html).toContain("通讯记录");
    expect(html).toContain("回归用例 12/12 通过。");
    expect(html).toContain("先补 schema 对比。");
    expect(html.indexOf("先补 schema 对比。")).toBeLessThan(html.indexOf("回归用例 12/12 通过。"));
    expect(html).toContain("回报");
    expect(html).toContain("指派");
  });

  it("renders an empty communication state when there are no messages", () => {
    const bare = renderToStaticMarkup(
      <TeamFormation
        snapshot={{ ...snapshot, messages: [] }}
        selectedName="migration-dev"
        now={1}
        draft=""
        onDraftChange={() => undefined}
        sending={false}
        onSubmitSend={() => undefined}
        onSelect={() => undefined}
        onStop={() => undefined}
        onOpenTranscript={() => undefined}
        onOpenArtifact={() => undefined}
      />
    );
    expect(bare).toContain("本次运行还没有团队消息");
  });
});

describe("team task filters", () => {
  it("counts and filters by status and free text", () => {
    expect(taskCounts(snapshot.tasks ?? [])).toEqual({ all: 3, in_progress: 1, pending: 1, completed: 1 });
    expect(filterTasks(snapshot.tasks ?? [], "pending").map((task) => task.id)).toEqual(["task-3"]);
    expect(filterTasks(snapshot.tasks ?? [], "all", "冒烟").map((task) => task.id)).toEqual(["task-2"]);
    expect(filterTasks(snapshot.tasks ?? [], "pending", "migration-dev")).toHaveLength(0);
  });
});
