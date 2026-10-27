import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 侧栏会话圆点的接线契约（2026-10-27）。
 *
 * `session-scope.ts` 的用例只能证明 `overlayLiveRunStatus` 这个模块正确，证明不了
 * `performSessionsRefresh` 真的调用它——删掉那一行，模块用例全绿而**已落盘**会话
 * 的圆点在每次全量刷新后照样消失（运行中的会话回合开始半秒后就没有「执行中」点，
 * parked 会话的绿/红结果点也活不过一次刷新）。回填（backfillUnpersistedSessions）
 * 压不住这条路：它只管文件还没落盘的会话。
 *
 * 两份磁盘摘要（`summarizeAllSessions`）都不带 runStatus（纯运行时状态），所以
 * 「刷新后必须用 live 记录覆盖」是这里唯一的前置条件；顺序也钉死：覆盖在回填
 * 之后，否则未落盘行的 runStatus 会被再算一遍。
 */
describe("sidebar run-status wiring contract", () => {
  const source = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8");
  const start = source.indexOf("async function performSessionsRefresh(");
  const end = source.indexOf("function sessionReadyStatus(");
  const refreshBody = start >= 0 && end > start ? source.slice(start, end) : "";

  it("slices the refresh body out of pi-runtime (guards the assertions below)", () => {
    expect(refreshBody).toContain("backfillUnpersistedSessions(");
    expect(refreshBody).toContain("sortSessionSummaries(");
  });

  it("overlays live run status after the disk rebuild", () => {
    expect(refreshBody).toContain("overlayLiveRunStatus(currentSessions, liveSeeds)");
    expect(refreshBody.indexOf("overlayLiveRunStatus(")).toBeGreaterThan(refreshBody.indexOf("backfillUnpersistedSessions("));
  });

  it("feeds the overlay the same live projections the backfill uses", () => {
    expect(refreshBody).toContain("const liveSeeds: LiveSessionSeed[] = [...liveSessions.values()].map(");
    expect(refreshBody).toContain("backfillUnpersistedSessions(currentSessions, previousSessions, liveSeeds)");
    // 仍必须是「以 live 记录为准」：runStatus 空（已读/未跑）就必须不带状态，否则
    // 刷新会把用户已经看过的绿点复活。
    expect(refreshBody).toContain("runStatus: record.runStatus");
  });
});
