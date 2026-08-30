import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest, QuestionRequest, RuntimeSnapshot, SessionPaneSnapshot, ToolExecution, Todo, UsageStats } from "../../shared/protocol.js";
import { currentPermissionRequest, currentQuestionRequest, dropPaneStates, pruneParkedPanels, useDesktopStore } from "./store.js";

function permission(id: string, sessionId: string): PermissionRequest {
  return {
    id,
    toolName: "bash",
    summary: "运行命令",
    args: { command: "npm test" },
    risk: "command",
    principal: { kind: "root-agent", sessionId, toolCallId: `tool-${id}` }
  };
}

const emptySnapshot: RuntimeSnapshot = {
  agentId: "default",
  agentName: "默认助手",
  thinkingLevel: "medium",
  busy: false,
  status: "",
  queuedMessages: [],
  messages: [],
  executions: [],
  backgroundProcesses: [],
  sessions: [],
  recentWorkspaces: []
};

function snap(sessionId: string, workspace = `/w/${sessionId}`): RuntimeSnapshot {
  return { ...emptySnapshot, sessionId, sessionFile: `/p/${sessionId}.jsonl`, workspace };
}

describe("desktop permission queue", () => {
  beforeEach(() => {
    useDesktopStore.setState({ permissions: [], todos: [] });
  });

  it("keeps concurrent permission requests in arrival order", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "permission", request: permission("permission-1", "session-a") });
    state.handleRuntimeMessage({ type: "permission", request: permission("permission-2", "session-b") });

    expect(useDesktopStore.getState().permissions.map((request) => request.id)).toEqual([
      "permission-1",
      "permission-2"
    ]);
  });

  it("ignores duplicate permission frames", () => {
    const state = useDesktopStore.getState();
    const request = permission("permission-1", "session-a");
    state.handleRuntimeMessage({ type: "permission", request });
    state.handleRuntimeMessage({ type: "permission", request });

    expect(useDesktopStore.getState().permissions).toHaveLength(1);
  });

  it("dismisses permissions invalidated by a runtime reset", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "permission", request: permission("permission-1", "session-a") });
    state.handleRuntimeMessage({ type: "permission.dismiss", id: "permission-1" });

    expect(useDesktopStore.getState().permissions).toEqual([]);
  });

  it("publishes the native todo list over the todos channel", () => {
    const state = useDesktopStore.getState();
    const todos: Todo[] = [
      { content: "审阅变更", status: "in_progress" },
      { content: "提交", status: "pending" }
    ];
    state.handleRuntimeMessage({ type: "todos", todos });

    expect(useDesktopStore.getState().todos).toEqual(todos);

    state.handleRuntimeMessage({ type: "todos", todos: [{ ...todos[0]!, status: "completed" }] });
    expect(useDesktopStore.getState().todos).toHaveLength(1);
    expect(useDesktopStore.getState().todos[0]?.status).toBe("completed");
  });

  it("tracks built-in provider model refresh results", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "models-refresh-error", providerId: "deepseek", message: "拉取失败" });

    expect(useDesktopStore.getState().modelRefreshStatus).toBe("error");
    expect(useDesktopStore.getState().modelRefreshError).toBe("拉取失败");
    expect(useDesktopStore.getState().modelRefreshProvider).toBe("deepseek");

    state.handleRuntimeMessage({ type: "models-refreshed", providerId: "deepseek" });
    expect(useDesktopStore.getState().modelRefreshStatus).toBe("success");
    expect(useDesktopStore.getState().modelRefreshError).toBeUndefined();
    expect(useDesktopStore.getState().modelRefreshProvider).toBe("deepseek");
  });
});

describe("split-pane parked data cache", () => {
  beforeEach(() => {
    useDesktopStore.setState({ snapshot: emptySnapshot, paneStates: {}, parkedPanels: {} });
  });

  it("焦点切换到 B 时，把旧激活格 A 的数据写入 parkedPanels[A]", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "state", snapshot: snap("a", "/w/a") });
    state.handleRuntimeMessage({ type: "state", snapshot: snap("b", "/w/b") });
    const parked = useDesktopStore.getState().parkedPanels;
    expect(parked["a"]?.workspace).toBe("/w/a");
    expect(parked["b"]).toBeUndefined(); // 当前激活格不应留档
  });

  it("三分屏焦点依次 A→B→C 后，同时保留 A 与 B（旧单槽会丢 A）", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "state", snapshot: snap("a") });
    state.handleRuntimeMessage({ type: "state", snapshot: snap("b") });
    state.handleRuntimeMessage({ type: "state", snapshot: snap("c") });
    const parked = useDesktopStore.getState().parkedPanels;
    expect(parked["a"]?.sessionId).toBe("a");
    expect(parked["b"]?.sessionId).toBe("b");
    expect(parked["c"]).toBeUndefined();
  });

  it("dropPaneStates 清理对应格的 parkedPanels，不影响其余格", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "state", snapshot: snap("a") });
    state.handleRuntimeMessage({ type: "state", snapshot: snap("b") });
    state.handleRuntimeMessage({ type: "state", snapshot: snap("c") });
    dropPaneStates(["a"]);
    const parked = useDesktopStore.getState().parkedPanels;
    expect(parked["a"]).toBeUndefined();
    expect(parked["b"]?.sessionId).toBe("b");
  });

  it("pruneParkedPanels 清掉不在格子集合里的留档（单窗口切话题不积累），保留仍在格子里的", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "state", snapshot: snap("a") });
    state.handleRuntimeMessage({ type: "state", snapshot: snap("b") });
    state.handleRuntimeMessage({ type: "state", snapshot: snap("c") });
    pruneParkedPanels(new Set(["b"]));
    let parked = useDesktopStore.getState().parkedPanels;
    expect(parked["a"]).toBeUndefined();
    expect(parked["b"]?.sessionId).toBe("b");
    expect(parked["c"]).toBeUndefined();
    // 空集合（单窗口）全部清空。
    pruneParkedPanels(new Set());
    parked = useDesktopStore.getState().parkedPanels;
    expect(Object.keys(parked)).toEqual([]);
  });
});

describe("snapshot merge execution identity", () => {
  function execution(id: string, output: string): ToolExecution {
    return { id, name: "bash", args: { command: "ls" }, status: "completed", startedAt: 1, completedAt: 2, output };
  }

  function paneState(sessionId: string, executions: ToolExecution[]): SessionPaneSnapshot {
    return { sessionId, thinkingLevel: "medium", busy: false, status: "", queuedMessages: [], messages: [], executions };
  }

  beforeEach(() => {
    useDesktopStore.setState({ snapshot: { ...emptySnapshot, sessionId: "active" }, paneStates: {}, parkedPanels: {} });
  });

  it("session.state 内容未变（含全新 args 引用）时复用旧 executions 数组引用", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "session.state", snapshot: paneState("pane-1", [execution("t1", "out")]) });
    const first = useDesktopStore.getState().paneStates["pane-1"]!;
    // 主进程每帧 spread 新数组 + IPC 克隆出新 args 对象，内容相同。
    state.handleRuntimeMessage({ type: "session.state", snapshot: paneState("pane-1", [{ ...execution("t1", "out"), args: { command: "ls" } }]) });
    const second = useDesktopStore.getState().paneStates["pane-1"]!;
    expect(second.executions).toBe(first.executions);
  });

  it("executions 完全相同的一帧不触发 store 更新（paneStates 引用不变）", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "session.state", snapshot: paneState("pane-1", [execution("t1", "out")]) });
    const panesBefore = useDesktopStore.getState().paneStates;
    state.handleRuntimeMessage({ type: "session.state", snapshot: paneState("pane-1", [{ ...execution("t1", "out"), args: { command: "ls" } }]) });
    expect(useDesktopStore.getState().paneStates).toBe(panesBefore);
  });

  it("output 或状态变化时换新引用", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "session.state", snapshot: paneState("pane-1", [execution("t1", "out-1")]) });
    const first = useDesktopStore.getState().paneStates["pane-1"]!;
    state.handleRuntimeMessage({ type: "session.state", snapshot: paneState("pane-1", [execution("t1", "out-2")]) });
    const second = useDesktopStore.getState().paneStates["pane-1"]!;
    expect(second.executions).not.toBe(first.executions);
    expect(second.executions[0]?.output).toBe("out-2");
    state.handleRuntimeMessage({ type: "session.state", snapshot: paneState("pane-1", [execution("t1", "out-2"), execution("t2", "")]) });
    const third = useDesktopStore.getState().paneStates["pane-1"]!;
    expect(third.executions).not.toBe(second.executions);
    expect(third.executions).toHaveLength(2);
  });

  it("state 通道（激活会话）同样复用未变 executions 的数组引用", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({ type: "state", snapshot: { ...snap("active"), executions: [execution("t1", "out")] } });
    const first = useDesktopStore.getState().snapshot;
    state.handleRuntimeMessage({ type: "state", snapshot: { ...snap("active"), executions: [{ ...execution("t1", "out"), args: { command: "ls" } }] } });
    const second = useDesktopStore.getState().snapshot;
    expect(second.executions).toBe(first.executions);
  });
});

describe("session-scoped pending panels", () => {
  function question(id: string, sessionId: string): QuestionRequest {
    return { id, sessionId, toolCallId: `tool-${id}`, questions: [{ text: "请选择", type: "single", options: ["A", "B"] }] };
  }

  it("returns only the request belonging to the active session", () => {
    const permissions = [permission("permission-a", "session-a"), permission("permission-b", "session-b")];
    const questions = [question("question-a", "session-a"), question("question-b", "session-b")];

    expect(currentPermissionRequest(permissions, "session-a")?.id).toBe("permission-a");
    expect(currentQuestionRequest(questions, "session-a")?.id).toBe("question-a");
  });

  it("hides a parked/background session's request from the current view", () => {
    const permissions = [permission("permission-a", "session-a")];
    const questions = [question("question-a", "session-a")];

    expect(currentPermissionRequest(permissions, "session-b")).toBeUndefined();
    expect(currentQuestionRequest(questions, "session-b")).toBeUndefined();
  });

  it("keeps the non-active request in the store until that session is viewed again", () => {
    const questions = [question("question-a", "session-a")];
    // 切到 session-b 时不展示，切回 session-a 时再次浮出。
    expect(currentQuestionRequest(questions, "session-b")).toBeUndefined();
    expect(currentQuestionRequest(questions, "session-a")?.id).toBe("question-a");
  });

  it("returns nothing when there is no active session", () => {
    expect(currentPermissionRequest([permission("permission-a", "session-a")], undefined)).toBeUndefined();
    expect(currentQuestionRequest([question("question-a", "session-a")], undefined)).toBeUndefined();
  });
});

describe("checkpoint rollback markers", () => {
  beforeEach(() => {
    useDesktopStore.setState({ rollbacks: {}, checkpointResult: undefined });
  });

  it("records per-call rollback markers from checkpoint-result and skips skipped files", () => {
    const state = useDesktopStore.getState();
    state.handleRuntimeMessage({
      type: "checkpoint-result",
      sessionId: "session-a",
      results: [
        { relativePath: "a.txt", action: "restored", toolCallIds: ["call-1", "call-2"] },
        { relativePath: "created.txt", action: "deleted", toolCallIds: ["call-3"] },
        { relativePath: "huge.txt", action: "skipped" }
      ],
      message: "已回滚"
    });
    const rollbacks = useDesktopStore.getState().rollbacks;
    // 每个调用 id 独立标记（产物行内任一命中即显示徽标）。
    expect(rollbacks).toEqual({
      "session-a:call-1": "restored",
      "session-a:call-2": "restored",
      "session-a:call-3": "deleted"
    });
    // skipped 不标记（按钮保持可点）。
    expect(Object.keys(rollbacks).some((key) => key.includes("huge"))).toBe(false);
    expect(useDesktopStore.getState().checkpointResult?.sessionId).toBe("session-a");
  });

  it("scopes markers by session so a new turn's fresh call ids are unaffected", () => {
    useDesktopStore.setState({ rollbacks: { "session-a:call-1": "restored" } });
    useDesktopStore.getState().handleRuntimeMessage({
      type: "checkpoint-result",
      sessionId: "session-b",
      results: [{ relativePath: "a.txt", action: "restored", toolCallIds: ["call-9"] }],
      message: "已回滚"
    });
    const rollbacks = useDesktopStore.getState().rollbacks;
    expect(rollbacks["session-a:call-1"]).toBe("restored");
    expect(rollbacks["session-b:call-9"]).toBe("restored");
    // 同会话同文件的新回复（新 call id）不会命中旧标记。
    expect(rollbacks["session-a:call-2"]).toBeUndefined();
  });
});

describe("usage stats", () => {
  it("usage-stats-result stores the payload and clears the loading flag", () => {
    useDesktopStore.setState({ usageStats: undefined, usageStatsLoading: true });
    const stats: UsageStats = {
      generatedAt: 1,
      scannedFiles: 2,
      scanMs: 5,
      total: { requests: 3, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitRate: null },
      byDay: [],
      byModel: [],
      byAgent: [],
      bySession: []
    };
    useDesktopStore.getState().handleRuntimeMessage({ type: "usage-stats-result", stats });
    const state = useDesktopStore.getState();
    expect(state.usageStats).toEqual(stats);
    expect(state.usageStatsLoading).toBe(false);
  });
});
