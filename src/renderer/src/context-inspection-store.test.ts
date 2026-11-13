import { beforeEach, describe, expect, it } from "vitest";
import type { ContextInspection } from "../../shared/protocol.js";
import { useDesktopStore } from "./store.js";

/**
 * 上下文中心结果按 requestId 认领：切会话/连点刷新时，晚到的旧帧不能覆盖新帧。
 * 与 session.search 同一套纪律（见 store.test.ts 的检索结果用例）。
 */

function inspection(sessionId = "s1"): ContextInspection {
  return {
    at: 1_760_000_000_000,
    sessionId,
    agentId: "agent-1",
    agentName: "黑鱼河",
    thinkingLevel: "max",
    prompt: { text: "prompt", blocks: [], sections: [], extraSystemMessages: [], turnInjections: [] },
    tools: { declared: [], undeclared: [] },
    messages: { total: 0, byRole: [], top: [], images: 0 },
    runtime: []
  };
}

describe("context inspection result routing", () => {
  beforeEach(() => {
    useDesktopStore.setState({ contextInspection: { requestId: "r1", sessionId: "s1", loading: true } });
  });

  it("匹配 requestId 的结果落库并结束 loading", () => {
    useDesktopStore.getState().handleRuntimeMessage({ type: "session.inspect-result", requestId: "r1", sessionId: "s1", inspection: inspection() });
    const state = useDesktopStore.getState().contextInspection!;
    expect(state.loading).toBe(false);
    expect(state.data?.sessionId).toBe("s1");
    expect(state.at).toBe(1_760_000_000_000);
    expect(state.error).toBeUndefined();
  });

  it("过期 requestId 整帧丢弃（连点刷新/切会话）", () => {
    const before = useDesktopStore.getState().contextInspection;
    useDesktopStore.getState().handleRuntimeMessage({ type: "session.inspect-result", requestId: "stale", sessionId: "s1", inspection: inspection() });
    expect(useDesktopStore.getState().contextInspection).toBe(before);
  });

  it("失败结果保留旧数据、写入错误（页面可显示旧快照 + 错误提示）", () => {
    useDesktopStore.setState({ contextInspection: { requestId: "r2", sessionId: "s1", loading: true, data: inspection(), at: 5 } });
    useDesktopStore.getState().handleRuntimeMessage({ type: "session.inspect-result", requestId: "r2", sessionId: "s1", error: "该会话不在运行中" });
    const state = useDesktopStore.getState().contextInspection!;
    expect(state.loading).toBe(false);
    expect(state.error).toBe("该会话不在运行中");
    expect(state.data?.sessionId).toBe("s1");
    expect(state.at).toBe(5);
  });

  it("没有在途请求时结果被丢弃", () => {
    useDesktopStore.setState({ contextInspection: undefined });
    useDesktopStore.getState().handleRuntimeMessage({ type: "session.inspect-result", requestId: "r9", inspection: inspection() });
    expect(useDesktopStore.getState().contextInspection).toBeUndefined();
  });
});
