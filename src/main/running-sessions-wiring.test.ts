import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 侧栏「运行中」分区的接线契约（2026-10-29 用户需求：不同工作区同时有会话在执行时
 * 不好切换）。
 *
 * `collectRunningSessions` 的单测只能证明筛选/排序对，证明不了侧栏真的把它渲染在
 * 所有工作区分组**之上**、只在「全部」视图出现、并且点下去走的是同一条 openSession
 * 路径（否则点一行什么也不发生）。这几处断一处，功能就静默失效。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

describe("sidebar running sessions wiring contract", () => {
  const app = read("../renderer/src/App.tsx");
  const styles = read("../renderer/src/styles.css");
  const lib = read("../renderer/src/lib/running-sessions.ts");

  it("分区渲染在所有工作区分组之前", () => {
    const section = app.indexOf('<section className="session-running-group"');
    const groups = app.indexOf("sessionGroups.map((group) =>");
    expect(section).toBeGreaterThan(-1);
    expect(groups).toBeGreaterThan(-1);
    expect(section).toBeLessThan(groups);
  });

  it("数据来自 sessionsForView(active) + 搜索词过滤，归档视图不出现", () => {
    expect(app).toContain('import { collectRunningSessions, hasRunningSession } from "./lib/running-sessions"');
    // 归档会话即使带着 running 也不进这个分区（归档视图里不显示分区）。
    expect(app).toContain('collectRunningSessions(sessionsForView(sessionSummaries, "active"))');
    expect(app).toContain('collectRunningSessions(runningSessions, sidebarQuery, agentNames)');
    expect(app).toContain('sessionView === "active" && listedRunningSessions.length > 0');
  });

  it("点一行走的是同一条 openSession 路径，右键菜单与分组行共用一份", () => {
    // 分组行 + 运行中分区行 + 归档右键「打开（自动恢复）」都经 openSession。
    expect(app.match(/openSession\(item\.path, item\.workspace, item\.id, item\.agentId\)/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(app.match(/items: sessionContextItems\(item\)/gu)?.length).toBe(2);
    expect(app).toContain("function sessionContextItems(item: SessionSummary): ContextMenuItem[]");
  });

  it("折叠工作区的标题带运行点，折叠侧栏的话题按钮带运行计数", () => {
    expect(app).toContain("hasRunningSession(group.sessions)");
    expect(app).toContain("rail-running-badge");
    expect(styles).toContain(".session-running-group {");
    expect(styles).toContain(".rail-running-badge {");
  });

  it("分区只认 running，跳过早已结束的状态", () => {
    expect(lib).toContain('session.runStatus === "running"');
    expect(lib).not.toContain('"completed"');
  });
});
