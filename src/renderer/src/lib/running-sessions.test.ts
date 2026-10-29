import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/protocol";
import { collectRunningSessions, hasRunningSession } from "./running-sessions";

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "path" | "workspace" | "title">): SessionSummary {
  return {
    agentId: "default",
    modifiedAt: 1,
    messageCount: 1,
    ...overrides
  };
}

describe("sidebar running sessions", () => {
  it("只收集正在执行的会话，跨工作区摊平并按最近活动排序", () => {
    const running = collectRunningSessions([
      session({ id: "idle", path: "idle.jsonl", workspace: "C:/Projects/A", title: "空闲话题", modifiedAt: 99 }),
      session({ id: "a-old", path: "a-old.jsonl", workspace: "C:/Projects/A", title: "工作区 A 的老任务", modifiedAt: 10, runStatus: "running" }),
      session({ id: "b-new", path: "b-new.jsonl", workspace: "C:/Projects/B", title: "工作区 B 的新任务", modifiedAt: 30, runStatus: "running" }),
      session({ id: "done", path: "done.jsonl", workspace: "C:/Projects/B", title: "刚跑完", modifiedAt: 40, runStatus: "completed" })
    ]);

    expect(running.map((item) => item.id)).toEqual(["b-new", "a-old"]);
  });

  it("执行中的旧会话也算：不受 pinned / 归档标记影响（归档范围由调用方收口）", () => {
    const running = collectRunningSessions([
      session({ id: "running", path: "running.jsonl", workspace: "C:/Projects/A", title: "跑着的", modifiedAt: 1, runStatus: "running" }),
      session({ id: "pinned", path: "pinned.jsonl", workspace: "C:/Projects/A", title: "置顶但空闲", modifiedAt: 50, pinned: true })
    ]);

    expect(running.map((item) => item.id)).toEqual(["running"]);
  });

  it("搜索命中标题、工作区与助手名，未命中即整条消失", () => {
    const all = [
      session({ id: "one", path: "one.jsonl", workspace: "C:/Projects/PiDesktop", title: "检查渲染", modifiedAt: 2, runStatus: "running" }),
      session({ id: "two", path: "two.jsonl", workspace: "C:/Projects/Other", title: "另一件事", modifiedAt: 3, runStatus: "running", agentId: "reviewer" })
    ];

    expect(collectRunningSessions(all, "pidesktop").map((item) => item.id)).toEqual(["one"]);
    expect(collectRunningSessions(all, "审查助手", { reviewer: "审查助手" }).map((item) => item.id)).toEqual(["two"]);
    expect(collectRunningSessions(all, "不存在的词")).toEqual([]);
  });

  it("空查询不过滤，且不修改入参顺序（排序返回新数组）", () => {
    const input = [
      session({ id: "old", path: "old.jsonl", workspace: "C:/A", title: "旧", modifiedAt: 1, runStatus: "running" }),
      session({ id: "new", path: "new.jsonl", workspace: "C:/B", title: "新", modifiedAt: 2, runStatus: "running" })
    ];
    const running = collectRunningSessions(input, "  ");

    expect(running.map((item) => item.id)).toEqual(["new", "old"]);
    expect(input.map((item) => item.id)).toEqual(["old", "new"]);
  });

  it("分组标题的运行点只看组内是否有 running", () => {
    expect(hasRunningSession([session({ id: "a", path: "a.jsonl", workspace: "C:/A", title: "a", runStatus: "running" })])).toBe(true);
    expect(hasRunningSession([
      session({ id: "b", path: "b.jsonl", workspace: "C:/A", title: "b", runStatus: "completed" }),
      session({ id: "c", path: "c.jsonl", workspace: "C:/A", title: "c", runStatus: "aborted" })
    ])).toBe(false);
    expect(hasRunningSession([])).toBe(false);
  });
});
