import { describe, expect, it } from "vitest";
import type { ChatMessage, RuntimeMessage, RuntimeSnapshot } from "../shared/protocol.js";
import { createMainSnapshotCache } from "./snapshot-baselines.js";

function message(id: string): ChatMessage {
  return { id, uuid: id, role: "assistant", timestamp: 1, blocks: [{ type: "text", text: id }] };
}

function snapshot(sessionId: string, revision: number, overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    revision,
    sessionId,
    agentId: "default",
    agentName: "默认助手",
    thinkingLevel: "medium",
    busy: false,
    status: "就绪",
    queuedMessages: [],
    messages: [],
    executions: [],
    backgroundProcesses: [],
    sessions: [],
    recentWorkspaces: [],
    ...overrides
  };
}

function state(session: RuntimeSnapshot): RuntimeMessage {
  return { type: "state", snapshot: session };
}

function cache() {
  let seq = 0;
  return createMainSnapshotCache({ nextRequestId: () => `req-${++seq}` });
}

describe("createMainSnapshotCache", () => {
  it("state 建立基线，state.patch 合并进同一会话的基线（bootstrap 拿到最新内容）", () => {
    const main = cache();
    main.ingest(state(snapshot("a", 1, { messages: [message("m1")] })));
    const result = main.ingest({
      type: "state.patch",
      snapshot: { sessionId: "a", revision: 2, busy: true },
      messages: { append: [message("m2")] }
    });
    expect(result.latest?.busy).toBe(true);
    expect(result.latest?.messages.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(main.latest()).toBe(result.latest);
  });

  it("重复帧（revision ≤ 基线）丢弃，不重复 append", () => {
    const main = cache();
    main.ingest(state(snapshot("a", 1)));
    const patch: RuntimeMessage = { type: "state.patch", snapshot: { sessionId: "a", revision: 2 }, messages: { append: [message("m2")] } };
    main.ingest(patch);
    main.ingest(patch);
    expect(main.latest()?.messages.map((item) => item.id)).toEqual(["m2"]);
  });

  it("A→B→A 的 resume 帧合并进**目标会话**的基线，而不是当前 latestSnapshot", () => {
    const main = cache();
    main.ingest(state(snapshot("a", 1, { messages: [message("a1")], status: "A 就绪" })));
    main.ingest(state(snapshot("b", 2, { messages: [message("b1")], status: "B 就绪" })));
    const result = main.ingest({
      type: "state.resume.patch",
      sessionId: "a",
      baseRevision: 1,
      snapshot: { sessionId: "a", revision: 3, status: "A 正在工作" },
      messages: { append: [message("a2")] }
    });
    expect(result.recover).toBeUndefined();
    expect(result.latest?.sessionId).toBe("a");
    expect(result.latest?.status).toBe("A 正在工作");
    // 关键：拿的是 A 的历史（a1 + a2），绝不是 B 的消息。
    expect(result.latest?.messages.map((item) => item.id)).toEqual(["a1", "a2"]);
  });

  it("resume 令牌不匹配 → 只发定向恢复（不复用坏基线、也不整体清空）", () => {
    const main = cache();
    main.ingest(state(snapshot("a", 1, { messages: [message("a1")] })));
    main.ingest(state(snapshot("b", 2)));
    const result = main.ingest({
      type: "state.resume.patch",
      sessionId: "a",
      baseRevision: 99,
      snapshot: { sessionId: "a", revision: 3 },
      messages: { append: [message("a2")] }
    });
    expect(result.latest).toBeUndefined();
    expect(result.recover).toEqual({ type: "state.recover", sessionId: "a", requestId: "req-1" });
    // 当前 active 快照保持原样（B）：坏帧绝不能污染 bootstrap。
    expect(main.latest()?.sessionId).toBe("b");
  });

  it("跨会话的普通补丁（基线不存在）只请求该会话的定向恢复", () => {
    const main = cache();
    main.ingest(state(snapshot("b", 1)));
    const result = main.ingest({ type: "state.patch", snapshot: { sessionId: "a", revision: 2 }, messages: { append: [message("a1")] } });
    expect(result.recover).toEqual({ type: "state.recover", sessionId: "a", requestId: "req-1" });
    expect(main.latest()?.sessionId).toBe("b");
    expect(main.latest()?.messages).toEqual([]);
  });

  it("同一目标已有在途恢复请求时不重复发（帧速率可达 20fps）", () => {
    const main = cache();
    main.ingest(state(snapshot("b", 1)));
    const first = main.ingest({ type: "state.patch", snapshot: { sessionId: "a", revision: 2 } });
    const second = main.ingest({ type: "state.patch", snapshot: { sessionId: "a", revision: 3 } });
    expect(first.recover?.requestId).toBe("req-1");
    expect(second.recover).toBeUndefined();
  });

  it("state.recovery 按 requestId+sessionId 认领，并成为新的当前快照", () => {
    const main = cache();
    main.ingest(state(snapshot("b", 1)));
    const request = main.ingest({ type: "state.patch", snapshot: { sessionId: "a", revision: 2 } });
    const requestId = request.recover?.requestId ?? "";
    const applied = main.ingest({ type: "state.recovery", requestId, sessionId: "a", snapshot: snapshot("a", 5, { messages: [message("a1")] }) });
    expect(applied.latest?.sessionId).toBe("a");
    expect(applied.latest?.revision).toBe(5);
    expect(main.latest()?.messages.map((item) => item.id)).toEqual(["a1"]);
    // 恢复之后同一会话继续按补丁走（序号从恢复帧接上）。
    const next = main.ingest({ type: "state.patch", snapshot: { sessionId: "a", revision: 6, busy: true } });
    expect(next.latest?.busy).toBe(true);
  });

  it("过期的恢复响应（requestId/sessionId 不匹配）一律丢弃，不覆盖当前 active", () => {
    const main = cache();
    main.ingest(state(snapshot("b", 1)));
    main.ingest(state(snapshot("c", 2)));
    const stale = main.ingest({ type: "state.recovery", requestId: "req-unknown", sessionId: "a", snapshot: snapshot("a", 9) });
    expect(stale.latest).toBeUndefined();
    expect(main.latest()?.sessionId).toBe("c");
  });


  it("渲染端自己发起的恢复也要被认领（否则 main 的基线落后，后续差量算错）", () => {
    const main = cache();
    main.ingest(state(snapshot("a", 1, { messages: [message("m1")] })));
    // 模拟 utility 回应**渲染端**的 state.recover：requestId 是渲染端生成的。
    const rendererRecovery = main.ingest({
      type: "state.recovery",
      requestId: "renderer-own-request",
      sessionId: "a",
      snapshot: snapshot("a", 7, { messages: [message("m1"), message("m2")], status: "A 恢复" })
    });
    expect(rendererRecovery.latest?.status).toBe("A 恢复");
    expect(main.latest()?.messages.map((item) => item.id)).toEqual(["m1", "m2"]);
    // 基线也换成恢复帧：下一帧补丁可从 rev 7 接上。
    const next = main.ingest({ type: "state.patch", snapshot: { sessionId: "a", revision: 8, busy: true } });
    expect(next.latest?.busy).toBe(true);
  });

  it("恢复帧的目标不是当前 active 时只刷新该会话基线，绝不覆盖当前快照", () => {
    const main = cache();
    main.ingest(state(snapshot("b", 1)));
    const stale = main.ingest({
      type: "state.recovery",
      requestId: "renderer-own-request",
      sessionId: "a",
      snapshot: snapshot("a", 9)
    });
    expect(stale.latest).toBeUndefined();
    expect(main.latest()?.sessionId).toBe("b");
  });

  it("补丁序号断档（main 基线落后）只请求定向恢复，不套用旧差量", () => {
    const main = cache();
    main.ingest(state(snapshot("a", 1, { messages: [message("m1")] })));
    const gap = main.ingest({
      type: "state.patch",
      snapshot: { sessionId: "a", revision: 6, status: "跳号了" },
      messages: { append: [message("m2")] }
    });
    expect(gap.recover).toEqual({ type: "state.recover", sessionId: "a", requestId: "req-1" });
    // 旧基线保持自洽（宁可不变，也不留下一份真假混合的快照）。
    expect(main.latest()?.messages.map((item) => item.id)).toEqual(["m1"]);
    expect(main.latest()?.status).not.toBe("跳号了");
  });

  it("非 active 通道的消息一律忽略（面板/资源等推送不影响快照缓存）", () => {
    const main = cache();
    main.ingest(state(snapshot("a", 1)));
    const result = main.ingest({ type: "sessions.live", sessions: [] });
    expect(result).toEqual({});
    expect(main.latest()?.sessionId).toBe("a");
  });
});
