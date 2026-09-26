/**
 * 面板作品的状态缓存（main 进程）。
 *
 * 面板 HTML 轮询的是 main 里的这一份内存缓存，**不读盘、不碰 utility**——
 * 执行状态只存在于 utility 的内存里（`liveSessions`），main 能拿到它全靠
 * `runtimeProcess.on("message")` 的转发：`state` 给出会话列表（带 runStatus）
 * 与激活会话 id，`sessions.live` 给出所有 live 会话的执行明细。
 *
 * 之所以缓存而不实时问 utility：面板是**独立窗口**，主窗口关闭（隐藏）时
 * 渲染端那条链路已经断了，但 main 与 utility 仍在通信；缓存把「谁在跑」这件事
 * 从「有没有人看着」里解耦出来。
 *
 * 本模块是纯内存逻辑（可单测）：喂消息 → 读载荷。IO/HTTP 在调用方。
 */

import type { PanelStatePayload, RuntimeMessage } from "../shared/protocol.js";

export interface PanelStateCache {
  /** 喂一条运行时推送；只认 `state` 与 `sessions.live`，其余忽略。 */
  ingest(message: RuntimeMessage): void;
  /** 当前载荷（没有数据时返回空列表，绝不抛错——面板必须能显示「暂无运行中会话」）。 */
  snapshot(): PanelStatePayload;
}

/**
 * 载荷里保留的会话条数上限。
 *
 * 面板是每秒轮询的 HTTP 端点，而会话库可能有上百条（实测 160+ 条历史话题）；
 * 全量下发等于每秒把几万个字符序列化一遍，而面板顶多展示最近几条
 * （列表本身已按侧边栏顺序排好：pinned 在前、其余按最近活动倒序）。
 */
export const MAX_PANEL_SESSIONS = 40;

/**
 * `scope` 每次快照时求值，因此助手切换、工作区切换会立刻反映到面板上，
 * 不需要任何失效逻辑。
 */
export function createPanelStateCache(scope: () => PanelStatePayload["app"]): PanelStateCache {
  let sessions: PanelStatePayload["sessions"] = [];
  let live: PanelStatePayload["live"] = [];
  let activeSessionId: string | undefined;

  return {
    ingest(message: RuntimeMessage): void {
      if (message.type === "state") {
        sessions = message.snapshot.sessions.slice(0, MAX_PANEL_SESSIONS);
        activeSessionId = message.snapshot.sessionId;
        return;
      }
      if (message.type === "sessions.live") live = message.sessions;
    },
    snapshot(): PanelStatePayload {
      return {
        generatedAt: Date.now(),
        ...(activeSessionId ? { activeSessionId } : {}),
        app: scope(),
        sessions,
        live
      };
    }
  };
}
