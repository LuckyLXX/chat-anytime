import type { TurnTiming } from "../../../shared/protocol";

/**
 * 「本地乐观待回复」的判定（点发送之后、快照回来之前的那一段）。
 *
 * 为什么单独抽出来：`runtime:send` 是「发了就不回」的通道 —— main 侧
 * `ipcMain.handle("runtime:send", …)` 同步返回 void，渲染端
 * `await window.piDesktop.send(…)` 对命令级失败**永不 reject**，所以乐观状态
 * 只能靠三个信号收：
 *   ① 运行时带回的**会话级**命令失败（error 推送带 sessionId）→ 本格立刻收；
 *   ② 快照证据（busy / turnTiming）接管显示；
 *   ③ 兜底窗口（`localTurnDeadline`）——静默失败路径（例如 user_input 钩子吞掉
 *      输入、命令排在长任务后面）不会带回任何错误推送。
 * 缺①③会留下一条假的「正在努力输出中」+ 一直跳的耗时读数，且只有等到该格
 * busy 翻转（常常是被别的事件带着翻）才消失 —— 2026-10-09 用户报告的多会话
 * 多开现场就是这个形状。
 */
export interface LocalTurn {
  startedAt: number;
  sessionId?: string;
}

/**
 * 兜底窗口：直到这条 prompt 的回合真被接受为止。正常运行里快照在 ~百毫秒内就会
 * 带回 beginTurn（turnTiming + busy），所以这个窗口只兜静默失败；给得宽松一点，
 * 避免命令排在长任务（会话打开、压缩）后面时把待回复行闪掉。
 */
export const LOCAL_TURN_FALLBACK_MS = 15_000;

/**
 * 这条乐观待回复属于哪一格。sessionId 必须**真实相等** —— 任一侧缺省都不算命中，
 * 否则未水合的格子（data.sessionId 还是 undefined）会凭空长出一条待回复行。
 */
export function localTurnForPane(localTurn: LocalTurn | undefined, paneSessionId: string | undefined): TurnTiming | undefined {
  if (!localTurn || paneSessionId === undefined || localTurn.sessionId !== paneSessionId) return undefined;
  return { startedAt: localTurn.startedAt };
}

/** 兜底截止时刻（组件挂一次性定时器用它；到点仍无快照证据就收起本地乐观）。 */
export function localTurnDeadline(localTurn: LocalTurn): number {
  return localTurn.startedAt + LOCAL_TURN_FALLBACK_MS;
}

/** 命令级失败的最小形状（store 的 commandError 直接可传；只关心归属会话）。 */
export interface CommandErrorLike {
  sessionId?: string;
  message?: string;
}

/**
 * 服务端命令级失败是否落到这一格。只有真实相等的 sessionId 才算命中：缺省
 * （进程级失败）绝不命中任何一格，宁可只留全局 toast，也不误收别格的待回复。
 */
export function commandErrorTargetsPane(
  error: CommandErrorLike | undefined,
  paneSessionId: string | undefined
): boolean {
  if (!error || paneSessionId === undefined) return false;
  return error.sessionId !== undefined && error.sessionId === paneSessionId;
}
