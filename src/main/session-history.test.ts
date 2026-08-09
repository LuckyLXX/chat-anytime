import { describe, expect, it } from "vitest";
import { restoreToolExecutions, type PersistedSessionMessage } from "./session-history.js";

describe("persisted activity history", () => {
  it("restores completed tool calls with their output and patch", () => {
    const messages: PersistedSessionMessage[] = [
      { role: "assistant", timestamp: 100, content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/app.ts" } }] },
      { role: "toolResult", timestamp: 140, toolCallId: "call-1", toolName: "edit", content: [{ type: "text", text: "updated" }], details: { patch: "@@ -1 +1 @@" }, isError: false }
    ];

    expect(restoreToolExecutions(messages)).toEqual([{
      id: "call-1",
      name: "edit",
      args: { path: "src/app.ts" },
      status: "completed",
      startedAt: 100,
      completedAt: 140,
      output: "updated",
      patch: "@@ -1 +1 @@"
    }]);
  });

  it("marks a persisted call without a result as interrupted", () => {
    expect(restoreToolExecutions([
      { role: "assistant", timestamp: 100, content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }] }
    ])).toMatchObject([{ id: "call-1", status: "error", output: "工具执行在应用关闭或会话切换前未返回结果。" }]);
  });
});
