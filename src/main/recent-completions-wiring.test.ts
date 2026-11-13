import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 侧栏「已完成」分区的接线契约（2026-11-13 用户需求：顶部只有「运行中」时，
 * 刚在别的工作区跑完的会话得切回那个工作区翻分组才找得到）。
 *
 * 纯函数测试只能证明筛选/排序对，证明不了：
 * - 主进程真的在**回合终态出口**记了（记在 activate 的「清圆点」路径上 ⇒ 点开即消失）；
 * - 重启后首帧真的贴上了（hydrate 与全量刷新两条重建路径都要 overlay）；
 * - 渲染端真的渲染在所有工作区分组之前、点下去走的是同一条 openSession；
 * - store 的内容比较覆盖了新字段（漏比 ⇒ 帧被早退吞掉，侧栏不刷新）。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

describe("sidebar recent completed wiring contract", () => {
  const runtime = read("./pi-runtime.ts");
  const app = read("../renderer/src/App.tsx");
  const styles = read("../renderer/src/styles.css");
  const store = read("../renderer/src/store.ts");
  const lib = read("../renderer/src/lib/recent-completions.ts");

  it("主进程在唯一终态出口记录（与圆点解耦：可见会话也记）", () => {
    const start = runtime.indexOf("function setTerminalRunStatus(");
    expect(start).toBeGreaterThan(-1);
    const end = runtime.indexOf("\n}", start);
    const body = runtime.slice(start, end);
    // 终态出口：正常结束 / 中止 / 失败 / prompt 直接抛 / IM 与自动化兜底都汇到这里。
    expect(body).toContain("rememberSessionCompletion(record, outcome)");
    // 记录必须发生在「可见会话清成 undefined」之前或之后都行，但必须不是条件分支里
    // 只对不可见会话记录——否则用户点开看过的那一轮就永远不进「已完成」。
    expect(runtime).not.toContain("if (!visible) rememberSessionCompletion");
  });

  it("记录的写入路径：内存镜像 + 立即原子落盘 + 立刻贴到当前列表", () => {
    expect(runtime).toContain("import { applyRecentCompletions, loadRecentCompletions, recentCompletionsPath, recordRecentCompletion, saveRecentCompletions, type RecentCompletion } from \"./recent-completions.js\"");
    expect(runtime).toContain("recentCompletions = recordRecentCompletion(recentCompletions, { path, outcome })");
    expect(runtime).toContain("saveRecentCompletions(recentCompletionsFilePath(), recentCompletions)");
    expect(runtime).toContain("currentSessions = applyRecentCompletions(currentSessions, recentCompletions)");
    // 不做防抖：utility 进程退出是直接 kill，防抖窗口内退出会丢最后一条。
    expect(runtime).not.toMatch(/scheduleRecentCompletionsSave|recentCompletionsSaveTimer/u);
  });

  it("两条列表重建路径都 overlay，且启动先读记录再 hydrate", () => {
    const hydrateStart = runtime.indexOf("function hydrateSessionsFromIndex(");
    const refreshStart = runtime.indexOf("async function performSessionsRefresh(");
    expect(hydrateStart).toBeGreaterThan(-1);
    expect(refreshStart).toBeGreaterThan(hydrateStart);
    // 各取函数体（下一个顶层 function 之前）。
    const hydrateBody = runtime.slice(hydrateStart, refreshStart);
    const refreshBody = runtime.slice(refreshStart, runtime.indexOf("function sessionReadyStatus(", refreshStart));
    expect(hydrateBody).toContain("applyRecentCompletions(currentSessions, recentCompletions)");
    expect(refreshBody).toContain("applyRecentCompletions(currentSessions, recentCompletions)");
    // 首帧就要有：load 必须在 hydrateSessionsFromIndex() 之前。
    const loadAt = runtime.indexOf("recentCompletions = loadRecentCompletions(recentCompletionsFilePath())");
    const hydrateCallAt = runtime.indexOf("hydrateSessionsFromIndex();");
    expect(loadAt).toBeGreaterThan(-1);
    expect(hydrateCallAt).toBeGreaterThan(loadAt);
  });

  it("渲染端：分区在所有工作区分组之前、默认展开、只在「全部」视图出现", () => {
    const recentSection = app.indexOf('<section className="session-recent-group"');
    const groups = app.indexOf("sessionGroups.map((group) =>");
    expect(recentSection).toBeGreaterThan(-1);
    expect(groups).toBeGreaterThan(recentSection);
    // 紧跟「运行中」之后：实时状态优先，已完成紧随其后。
    expect(app.indexOf('<section className="session-running-group"')).toBeLessThan(recentSection);
    expect(app).toContain('sessionView === "active" && listedRecentCompletedSessions.length > 0');
    // 默认展开 = 没有折叠状态机（不引入 expanded 之类的受控开关）。
    expect(app).not.toContain("expandedRecentCompleted");
  });

  it("数据源两段式，且排除已经在眼前的会话", () => {
    expect(app).toContain('import { collectRecentCompletedSessions } from "./lib/recent-completions"');
    expect(app).toContain('collectRecentCompletedSessions(sessionsForView(sessionSummaries, "active", sessionViewOptions), { excludeSessionIds: onScreenSessionIds })');
    expect(app).toContain("collectRecentCompletedSessions(recentCompletedSessions, { query: sidebarQuery, agentNames, excludeSessionIds: onScreenSessionIds })");
    expect(app).toContain("...(activeSessionId ? [activeSessionId] : []), ...paneIds");
  });

  it("点一行走的是同一条 openSession 路径，右键菜单与分组行共用一份", () => {
    expect(app.match(/openSession\(item\.path, item\.workspace, item\.id, item\.agentId\)/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(app.match(/items: sessionContextItems\(item\)/gu)?.length).toBe(3);
  });

  it("分区样式存在（与「运行中」同构 + 结局色点复用 .session-status-dot.*）", () => {
    expect(styles).toContain(".session-recent-group {");
    expect(styles).toContain(".session-recent-items {");
    expect(styles).toContain(".session-recent-heading em {");
  });

  it("store 的身份保留比较覆盖新字段（漏比 ⇒ 只改完成记录的帧被早退吞掉）", () => {
    const start = store.indexOf("export function mergeSessionsPreservingIdentity(");
    expect(start).toBeGreaterThan(-1);
    const body = store.slice(start, store.indexOf("\n}", start));
    expect(body).toContain("item.completedAt === other.completedAt");
    expect(body).toContain("item.completedOutcome === other.completedOutcome");
  });

  it("渲染端投影只认完成记录、排除运行中，上限 5", () => {
    expect(lib).toContain("export const RECENT_COMPLETED_LIMIT = 5");
    expect(lib).toContain('session.runStatus !== "running"');
    expect(lib).toContain(".slice(0, limit)");
  });
});
