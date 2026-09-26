import { describe, expect, it } from "vitest";
import type { PanelSessionLive, RuntimeMessage, SessionSummary } from "../shared/protocol.js";
import { MAX_PANEL_SESSIONS, createPanelStateCache } from "./panel-state.js";

function summary(id: string, runStatus?: SessionSummary["runStatus"]): SessionSummary {
  return { id, path: `${id}.jsonl`, workspace: "D:/ws", title: `话题 ${id}`, modifiedAt: 1, messageCount: 3, ...(runStatus ? { runStatus } : {}) };
}

function live(sessionId: string, busy: boolean): PanelSessionLive {
  return {
    sessionId,
    title: `话题 ${sessionId}`,
    workspace: "D:/ws",
    busy,
    status: busy ? "正在读取文件" : "就绪",
    currentTools: [],
    todos: [],
    todoSummary: { total: 0, completed: 0, inProgress: 0 },
    updatedAt: 1
  };
}

/** 只带用到的字段：面板缓存是纯投影，不消费快照的其余部分。 */
function stateMessage(sessions: SessionSummary[], sessionId?: string): RuntimeMessage {
  return { type: "state", snapshot: { sessions, ...(sessionId ? { sessionId } : {}) } } as unknown as RuntimeMessage;
}

const scope = { version: "1.3.4", agentName: "助手", workspace: "D:/ws" };

describe("createPanelStateCache", () => {
  it("没收到任何推送时给空载荷（面板必须能显示「暂无运行中会话」而不是报错）", () => {
    const cache = createPanelStateCache(() => scope);
    const payload = cache.snapshot();
    expect(payload.sessions).toEqual([]);
    expect(payload.live).toEqual([]);
    expect(payload.activeSessionId).toBeUndefined();
    expect(payload.app).toEqual(scope);
    expect(typeof payload.generatedAt).toBe("number");
  });

  it("state 提供会话列表与激活会话，sessions.live 提供执行明细（两者互不覆盖）", () => {
    const cache = createPanelStateCache(() => scope);
    cache.ingest(stateMessage([summary("s1", "running"), summary("s2")], "s1"));
    cache.ingest({ type: "sessions.live", sessions: [live("s1", true)] });
    const payload = cache.snapshot();
    expect(payload.activeSessionId).toBe("s1");
    expect(payload.sessions.map((item) => item.id)).toEqual(["s1", "s2"]);
    expect(payload.live.map((item) => item.sessionId)).toEqual(["s1"]);
    // 后续的 state 不应清掉 live（两条推送的节奏不同：列表可能先到、也可能后到）
    cache.ingest(stateMessage([summary("s1")], "s1"));
    expect(cache.snapshot().live).toHaveLength(1);
  });

  it("sessions.live 全量替换（会话被驱逐后不能留下幽灵条目）", () => {
    const cache = createPanelStateCache(() => scope);
    cache.ingest({ type: "sessions.live", sessions: [live("s1", true), live("s2", false)] });
    expect(cache.snapshot().live).toHaveLength(2);
    cache.ingest({ type: "sessions.live", sessions: [live("s2", true)] });
    expect(cache.snapshot().live.map((item) => item.sessionId)).toEqual(["s2"]);
  });

  it("只认 state / sessions.live，其余推送一律忽略（面板不消费别的通道）", () => {
    const cache = createPanelStateCache(() => scope);
    cache.ingest({ type: "todos", todos: [] });
    cache.ingest({ type: "log", level: "info", message: "hi" });
    const payload = cache.snapshot();
    expect(payload.sessions).toEqual([]);
    expect(payload.live).toEqual([]);
  });

  it("会话列表截到上限（每秒轮询的端点不该下发整库历史）", () => {
    const cache = createPanelStateCache(() => scope);
    const many = Array.from({ length: MAX_PANEL_SESSIONS + 12 }, (_value, index) => summary(`s${index}`));
    cache.ingest(stateMessage(many, "s0"));
    const payload = cache.snapshot();
    expect(payload.sessions).toHaveLength(MAX_PANEL_SESSIONS);
    // 保留的是开头那一段（侧边栏顺序：pinned 与最近活动的在前）
    expect(payload.sessions[0]!.id).toBe("s0");
  });

  it("scope 每次快照重新求值（切助手/切工作区立刻反映，不需要失效逻辑）", () => {
    let current = { ...scope };
    const cache = createPanelStateCache(() => current);
    expect(cache.snapshot().app.workspace).toBe("D:/ws");
    current = { ...scope, workspace: "D:/other" };
    expect(cache.snapshot().app.workspace).toBe("D:/other");
  });
});
