import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/protocol";
import { collectRecentCompletedSessions, RECENT_COMPLETED_LIMIT } from "./recent-completions";

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "path" | "workspace" | "title">): SessionSummary {
  return {
    agentId: "default",
    modifiedAt: 1,
    messageCount: 1,
    ...overrides
  };
}

describe("sidebar recent completed sessions", () => {
  it("只收有完成记录的会话，按完成时间倒序（跨工作区摊平）", () => {
    const recent = collectRecentCompletedSessions([
      session({ id: "idle", path: "idle.jsonl", workspace: "C:/Projects/A", title: "从没跑过", modifiedAt: 99 }),
      session({ id: "a-old", path: "a-old.jsonl", workspace: "C:/Projects/A", title: "A 里早跑完的", completedAt: 10, completedOutcome: "completed" }),
      session({ id: "b-new", path: "b-new.jsonl", workspace: "C:/Projects/B", title: "B 里刚跑完的", completedAt: 30, completedOutcome: "failed" }),
      session({ id: "c-mid", path: "c-mid.jsonl", workspace: "C:/Projects/C", title: "C 里中止的", completedAt: 20, completedOutcome: "aborted" })
    ]);

    expect(recent.map((item) => item.id)).toEqual(["b-new", "c-mid", "a-old"]);
  });

  it("成功 / 失败 / 中止都算已完成（它只是「运行中」的另一半）", () => {
    const recent = collectRecentCompletedSessions([
      session({ id: "ok", path: "ok.jsonl", workspace: "C:/A", title: "ok", completedAt: 1, completedOutcome: "completed" }),
      session({ id: "fail", path: "fail.jsonl", workspace: "C:/A", title: "fail", completedAt: 2, completedOutcome: "failed" }),
      session({ id: "abort", path: "abort.jsonl", workspace: "C:/A", title: "abort", completedAt: 3, completedOutcome: "aborted" })
    ]);
    expect(recent.map((item) => item.id)).toEqual(["abort", "fail", "ok"]);
  });

  it("上一轮完成、这一轮又在跑的会话归「运行中」，不在这里重复出现", () => {
    const recent = collectRecentCompletedSessions([
      session({ id: "again", path: "again.jsonl", workspace: "C:/A", title: "又跑起来了", completedAt: 5, completedOutcome: "completed", runStatus: "running" })
    ]);
    expect(recent).toEqual([]);
  });

  it("已在眼前的会话（激活会话与分屏格子）不占位，切走后自然回来", () => {
    const all = [
      session({ id: "active", path: "active.jsonl", workspace: "C:/A", title: "正在看", completedAt: 9, completedOutcome: "completed" }),
      session({ id: "pane", path: "pane.jsonl", workspace: "C:/B", title: "分屏里", completedAt: 8, completedOutcome: "completed" }),
      session({ id: "elsewhere", path: "elsewhere.jsonl", workspace: "C:/C", title: "别处", completedAt: 7, completedOutcome: "completed" })
    ];
    const excluded = new Set(["active", "pane"]);

    expect(collectRecentCompletedSessions(all, { excludeSessionIds: excluded }).map((item) => item.id)).toEqual(["elsewhere"]);
    // 切走之后（排除集不含它）它会回到列表。
    expect(collectRecentCompletedSessions(all, { excludeSessionIds: new Set(["active"]) }).map((item) => item.id)).toEqual(["pane", "elsewhere"]);
  });

  it("上限是最近 5 个", () => {
    const all = Array.from({ length: 7 }, (_, index) => session({
      id: `s-${index}`,
      path: `s-${index}.jsonl`,
      workspace: "C:/A",
      title: `第 ${index} 个`,
      completedAt: index
    }));
    const recent = collectRecentCompletedSessions(all);

    expect(RECENT_COMPLETED_LIMIT).toBe(5);
    expect(recent.map((item) => item.id)).toEqual(["s-6", "s-5", "s-4", "s-3", "s-2"]);
  });

  it("搜索结果在取前 5 之前生效：第 6 个命中的也能被搜出来", () => {
    const all = Array.from({ length: 7 }, (_, index) => session({
      id: `s-${index}`,
      path: `s-${index}.jsonl`,
      workspace: "C:/A",
      title: index === 0 ? "被挤出去的那条" : `第 ${index} 个`,
      completedAt: index
    }));

    expect(collectRecentCompletedSessions(all).some((item) => item.id === "s-0")).toBe(false);
    expect(collectRecentCompletedSessions(all, { query: "被挤出去" }).map((item) => item.id)).toEqual(["s-0"]);
  });

  it("搜索命中标题、工作区与助手名", () => {
    const all = [
      session({ id: "one", path: "one.jsonl", workspace: "C:/Projects/PiDesktop", title: "检查渲染", completedAt: 2 }),
      session({ id: "two", path: "two.jsonl", workspace: "C:/Projects/Other", title: "另一件事", completedAt: 3, agentId: "reviewer" })
    ];

    expect(collectRecentCompletedSessions(all, { query: "pidesktop" }).map((item) => item.id)).toEqual(["one"]);
    expect(collectRecentCompletedSessions(all, { query: "审查助手", agentNames: { reviewer: "审查助手" } }).map((item) => item.id)).toEqual(["two"]);
    expect(collectRecentCompletedSessions(all, { query: "不存在的词" })).toEqual([]);
  });

  it("不修改入参顺序（排序返回新数组），非法时间戳忽略", () => {
    const input = [
      session({ id: "old", path: "old.jsonl", workspace: "C:/A", title: "旧", completedAt: 1 }),
      session({ id: "new", path: "new.jsonl", workspace: "C:/B", title: "新", completedAt: 2 }),
      session({ id: "nan", path: "nan.jsonl", workspace: "C:/B", title: "坏时间", completedAt: Number.NaN })
    ];
    const recent = collectRecentCompletedSessions(input, { query: "  " });

    expect(recent.map((item) => item.id)).toEqual(["new", "old"]);
    expect(input.map((item) => item.id)).toEqual(["old", "new", "nan"]);
  });
});
