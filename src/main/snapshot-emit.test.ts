import { describe, expect, it } from "vitest";
import type { ChatMessage, RuntimeSnapshot, ToolExecution } from "../shared/protocol";
import { createActiveEmitter } from "./snapshot-emit";

/**
 * 消息按「id+正文」缓存同一对象：生产链路里消息对象是不可变的，normalize 层按 Pi 消息
 * 身份缓存，未变化的历史消息跨帧保持同一引用——差分全靠这个引用比较。测试里也必须
 * 复用对象，否则每次都看起来「整段重写」。
 */
const messageCache = new Map<string, ChatMessage>();
function message(id: string, text = id): ChatMessage {
  const key = `${id}::${text}`;
  const cached = messageCache.get(key);
  if (cached) return cached;
  const created: ChatMessage = { id, uuid: id, role: "assistant", timestamp: 1, blocks: [{ type: "text", text }] };
  messageCache.set(key, created);
  return created;
}

function execution(id: string, output = ""): ToolExecution {
  return { id, name: "bash", args: {}, status: "running", startedAt: 1, output };
}

/**
 * 空数组也共用同一引用：生产链路的 `snapshot()` 在列表未变化时复用同一个引用，
 * 字段差量正是靠引用相等早退（测试里每次新建空数组会伪造成「列表变化了」）。
 */
const stable = {
  messages: [] as ChatMessage[],
  executions: [] as ToolExecution[],
  queuedMessages: [] as RuntimeSnapshot["queuedMessages"],
  backgroundProcesses: [] as RuntimeSnapshot["backgroundProcesses"],
  sessions: [] as RuntimeSnapshot["sessions"],
  recentWorkspaces: [] as RuntimeSnapshot["recentWorkspaces"]
};

/** 只带发帧决策用得到的字段（其余字段走缺省，比较逻辑按引用/值相等）。 */
function snapshot(sessionId: string | undefined, overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agentId: "default",
    agentName: "默认助手",
    thinkingLevel: "medium",
    busy: false,
    status: "就绪",
    ...stable,
    ...(sessionId ? { sessionId } : {}),
    ...overrides
  };
}

describe("createActiveEmitter", () => {
  it("首帧发全量 state，并分配全局 revision（基线记住这一帧）", () => {
    const emitter = createActiveEmitter();
    const frame = emitter.plan(snapshot("a"));
    expect(frame?.type).toBe("state");
    expect(frame && "snapshot" in frame ? frame.snapshot.revision : undefined).toBe(1);
    expect(emitter.hasBaseline("a")).toBe(true);
  });

  it("同一会话的高频更新继续走 state.patch，revision 连号；毫无变化时不占序号", () => {
    const emitter = createActiveEmitter();
    emitter.plan(snapshot("a", { messages: [message("m1")] }));
    const patch = emitter.plan(snapshot("a", { messages: [message("m1")], status: "正在工作" }));
    expect(patch).toMatchObject({ type: "state.patch", snapshot: { sessionId: "a", revision: 2, status: "正在工作" } });
    // 一帧完全没变：不发帧，也不消耗 revision（否则接收端会看到序号断档）。
    expect(emitter.plan(snapshot("a", { messages: [message("m1")], status: "正在工作" }))).toBeUndefined();
    expect(emitter.revision()).toBe(2);
    const next = emitter.plan(snapshot("a", { messages: [message("m1")], status: "就绪" }));
    expect(next).toMatchObject({ type: "state.patch", snapshot: { revision: 3 } });
  });

  it("A→B→A 切回时发带 baseRevision 的 resume patch，而不是 A 的全量 state", () => {
    const emitter = createActiveEmitter();
    const first = emitter.plan(snapshot("a", { messages: [message("m1"), message("m2")] }));
    expect(first?.type).toBe("state");
    emitter.plan(snapshot("b", { messages: [message("b1")] }));
    const resumed = emitter.plan(snapshot("a", { messages: [message("m1"), message("m2")], status: "正在工作" }));
    expect(resumed?.type).toBe("state.resume.patch");
    if (resumed?.type !== "state.resume.patch") throw new Error("expected resume frame");
    expect(resumed.sessionId).toBe("a");
    // 基线是 A 自己的首帧 revision；新 revision 是全局序号（跨过了 B 的那一帧）。
    expect(resumed.baseRevision).toBe(1);
    expect(resumed.snapshot.revision).toBe(3);
    expect(resumed.snapshot.status).toBe("正在工作");
    // 只带字段差量：没有消息变化就不带 messages（绝不重传历史）。
    expect(resumed.messages).toBeUndefined();
    expect(resumed.executions).toBeUndefined();
  });

  it("切回时只带自目标基线以来的消息差量（后台增长的部分）", () => {
    const emitter = createActiveEmitter();
    const m1 = message("m1");
    emitter.plan(snapshot("a", { messages: [m1] }));
    emitter.plan(snapshot("b", { messages: [message("b1")] }));
    const resumed = emitter.plan(snapshot("a", { messages: [m1, message("m2")] }));
    if (resumed?.type !== "state.resume.patch") throw new Error("expected resume frame");
    expect(resumed.messages?.append?.map((item) => item.id)).toEqual(["m2"]);
    expect(resumed.messages?.reset).toBeUndefined();
  });

  it("切回后继续走 state.patch，且 revision 从 resume 帧的新序号接上", () => {
    const emitter = createActiveEmitter();
    emitter.plan(snapshot("a", { messages: [message("m1")] }));
    emitter.plan(snapshot("b"));
    const resumed = emitter.plan(snapshot("a", { messages: [message("m1")] }));
    if (resumed?.type !== "state.resume.patch") throw new Error("expected resume frame");
    const resumedRevision = resumed.snapshot.revision ?? 0;
    const patch = emitter.plan(snapshot("a", { messages: [message("m1")], busy: true }));
    expect(patch).toMatchObject({ type: "state.patch", snapshot: { sessionId: "a", revision: resumedRevision + 1, busy: true } });
  });

  it("全局 revision 始终单调递增（跨会话不重置、不回头）", () => {
    const emitter = createActiveEmitter();
    const seen: number[] = [];
    for (const sessionId of ["a", "b", "a", "c", "b", "a"]) {
      const frame = emitter.plan(snapshot(sessionId, { status: `s-${sessionId}-${seen.length}` }));
      const revision = frame && "snapshot" in frame ? frame.snapshot.revision : undefined;
      if (revision !== undefined) seen.push(revision);
    }
    expect(seen.length).toBeGreaterThan(3);
    expect([...seen].sort((left, right) => left - right)).toEqual(seen);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("基线不存在（首次/被淘汰/已释放）时退化为全量 state，绝不给 resume", () => {
    const emitter = createActiveEmitter();
    emitter.plan(snapshot("a", { messages: [message("m1")] }));
    emitter.plan(snapshot("b"));
    // 会话被销毁：基线释放，之后切回只能全量。
    emitter.drop("a");
    const frame = emitter.plan(snapshot("a", { messages: [message("m1")] }));
    expect(frame?.type).toBe("state");
    expect(emitter.hasBaseline("a")).toBe(true);
  });

  it("drop 之后的下一帧不得基于已删基线发 resume（含 lastSessionId 复位）", () => {
    const emitter = createActiveEmitter();
    emitter.plan(snapshot("a", { messages: [message("m1")] }));
    emitter.plan(snapshot("a", { messages: [message("m1")], status: "正在工作" }));
    emitter.drop("a");
    const frame = emitter.plan(snapshot("a", { messages: [message("m1")], status: "正在工作" }));
    expect(frame?.type).toBe("state");
    // 全量重建后的基线已经接管：内容与它相同时不再发帧（绝不发基于旧基线的 resume）。
    expect(emitter.plan(snapshot("a", { messages: [message("m1")], status: "正在工作" }))).toBeUndefined();
  });

  it("LRU 上限之外的老会话被淘汰后切回走全量", () => {
    const emitter = createActiveEmitter(2);
    emitter.plan(snapshot("a", { messages: [message("m1")] }));
    emitter.plan(snapshot("b", { messages: [message("m1")] }));
    emitter.plan(snapshot("c", { messages: [message("m1")] }));
    expect(emitter.hasBaseline("a")).toBe(false);
    expect(emitter.hasBaseline("c")).toBe(true);
    expect(emitter.plan(snapshot("a", { messages: [message("m1")] }))?.type).toBe("state");
  });

  it("forceFull（state.sync / 定向恢复）总是发全量并重置该会话基线", () => {
    const emitter = createActiveEmitter();
    emitter.plan(snapshot("a", { messages: [message("m1")] }));
    const forced = emitter.plan(snapshot("a", { messages: [message("m1")] }), { forceFull: true });
    expect(forced?.type).toBe("state");
    const forcedRevision = forced && "snapshot" in forced ? forced.snapshot.revision ?? 0 : 0;
    expect(forcedRevision).toBe(2);
    // 重置后同一会话继续走 patch，序号从强制全量那一帧接上。
    expect(emitter.plan(snapshot("a", { messages: [message("m1")], status: "正在工作" })))
      .toMatchObject({ type: "state.patch", snapshot: { revision: forcedRevision + 1 } });
  });

  it("reset 清空所有基线，但 revision 继续单调递增（不回绕）", () => {
    const emitter = createActiveEmitter();
    emitter.plan(snapshot("a", { messages: [message("m1")] }));
    emitter.plan(snapshot("b", { messages: [message("m1")] }));
    expect(emitter.revision()).toBe(2);
    emitter.reset();
    expect(emitter.hasBaseline("a")).toBe(false);
    const frame = emitter.plan(snapshot("a", { messages: [message("m1")] }));
    expect(frame?.type).toBe("state");
    expect(frame && "snapshot" in frame ? frame.snapshot.revision : undefined).toBe(3);
  });

  it("未激活会话（sessionId 缺省）的帧一率全量（这种帧本身极小，键控基线无意义）", () => {
    const emitter = createActiveEmitter();
    expect(emitter.plan(snapshot(undefined))?.type).toBe("state");
    expect(emitter.plan(snapshot(undefined, { status: "正在启动" }))?.type).toBe("state");
    expect(emitter.hasBaseline(undefined)).toBe(false);
  });

  it("执行记录的基线存浅拷贝：原地改 output 也能被下一帧差出来", () => {
    const emitter = createActiveEmitter();
    const running = execution("e1", "partial");
    emitter.plan(snapshot("a", { executions: [running] }));
    // utility 侧 tool_execution_update 是原地改对象：基线必须是副本，否则差量丢失。
    running.output = "partial more";
    const patch = emitter.plan(snapshot("a", { executions: [running] }));
    expect(patch).toMatchObject({ type: "state.patch", executions: { upsert: [expect.objectContaining({ id: "e1", output: "partial more" })] } });
  });
});
