import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest, QuestionRequest, Todo } from "../../shared/protocol.js";
import { currentPermissionRequest, currentQuestionRequest, useDesktopStore } from "./store.js";

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
