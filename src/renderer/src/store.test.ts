import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "../../shared/protocol.js";
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
    useDesktopStore.setState({ permissions: [], extensionUiDialogs: [], extensionNotice: undefined });
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

  it("queues and dismisses extension UI dialogs", () => {
    const state = useDesktopStore.getState();
    const request = { id: "dialog-1", method: "confirm" as const, title: "确认", message: "继续吗？" };
    state.handleRuntimeMessage({ type: "extension-ui.request", request });
    expect(useDesktopStore.getState().extensionUiDialogs).toEqual([request]);

    state.handleRuntimeMessage({ type: "extension-ui.dismiss", id: request.id });
    expect(useDesktopStore.getState().extensionUiDialogs).toEqual([]);
  });
});
