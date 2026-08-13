import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest, Todo } from "../../shared/protocol.js";
import { useDesktopStore } from "./store.js";

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
      { id: "todo-1", title: "审阅变更", status: "in_progress", createdAt: 1, updatedAt: 2 },
      { id: "todo-2", title: "提交", status: "pending", createdAt: 3, updatedAt: 3 }
    ];
    state.handleRuntimeMessage({ type: "todos", todos });

    expect(useDesktopStore.getState().todos).toEqual(todos);

    state.handleRuntimeMessage({ type: "todos", todos: [{ ...todos[0]!, status: "completed", completedAt: 5 }] });
    expect(useDesktopStore.getState().todos).toHaveLength(1);
    expect(useDesktopStore.getState().todos[0]?.status).toBe("completed");
  });
});
