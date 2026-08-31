import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PI_DESKTOP_CONTROL_ENTRY_TYPE, restoreControlMessages, restoreToolExecutions, transcriptMessagesFromEntries, type PersistedSessionMessage } from "./session-history.js";

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

  it("restores a workspace-relative file summary for write and edit calls", () => {
    const messages: PersistedSessionMessage[] = [
      { role: "assistant", timestamp: 100, content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/new.ts" } }] },
      { role: "toolResult", timestamp: 140, toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "written" }], isError: false }
    ];

    expect(restoreToolExecutions(messages, "C:/work/demo")[0]?.changedFile).toEqual({ relativePath: "src/new.ts" });
  });

  it("restores delegation progress from toolResult details (flattened DelegationProgress shape)", () => {
    const delegation = {
      goal: "审查本次改动",
      childSessionId: "child-1",
      childSessionFile: "C:/agent/chatanytime-sessions/default/delegations/child-1.jsonl",
      subagentName: "Code Reviewer",
      subagentColor: "amber",
      role: "review",
      model: { provider: "p", id: "m" },
      steps: [
        { toolCallId: "t1", tool: "read", label: "读取文件：src/a.ts", status: "completed", startedAt: 100, completedAt: 120 },
        { toolCallId: "t2", tool: "bash", label: "执行命令 npm test", status: "running", startedAt: 130 }
      ]
    };
    const messages: PersistedSessionMessage[] = [
      { role: "assistant", timestamp: 100, content: [{ type: "toolCall", id: "call-1", name: "delegate_agent", arguments: { goal: "审查本次改动" } }] },
      { role: "toolResult", timestamp: 200, toolCallId: "call-1", toolName: "delegate_agent", content: [{ type: "text", text: "审查完成" }], details: delegation, isError: false }
    ];

    expect(restoreToolExecutions(messages)).toMatchObject([{
      id: "call-1",
      name: "delegate_agent",
      delegation: expect.objectContaining({ childSessionId: "child-1", subagentName: "Code Reviewer", steps: delegation.steps })
    }]);
  });

  it("falls back to the generic view when a persisted result carries no delegation details", () => {
    const messages: PersistedSessionMessage[] = [
      { role: "assistant", timestamp: 100, content: [{ type: "toolCall", id: "call-1", name: "delegate_agent", arguments: { goal: "x" } }] },
      { role: "toolResult", timestamp: 200, toolCallId: "call-1", toolName: "delegate_agent", content: [{ type: "text", text: "ok" }], details: { goal: "x" }, isError: false }
    ];

    expect(restoreToolExecutions(messages)[0]).not.toHaveProperty("delegation");
  });

  it("parses delegation transcripts into normalized chat messages", () => {
    const messages = transcriptMessagesFromEntries([
      { id: "e1", type: "message", message: { role: "user", timestamp: 100, content: "审阅 src/a.ts" } },
      { id: "e2", type: "message", message: { role: "assistant", timestamp: 200, content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } }] } },
      { id: "e3", type: "message", message: { role: "toolResult", timestamp: 250, toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "content" }], isError: false } },
      { id: "e4", type: "message", message: { role: "assistant", timestamp: 300, content: [{ type: "text", text: "结论" }] } },
      { id: "e5", type: "message", message: { role: "custom", customType: "other", content: "x", display: false } },
      { id: "garbage", type: "message" }
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[0]?.blocks).toEqual([{ type: "text", text: "审阅 src/a.ts" }]);
    expect(messages[1]?.blocks).toEqual([{ type: "tool-call", id: "t1", name: "read", arguments: { path: "src/a.ts" } }]);
    expect(messages[2]?.blocks).toEqual([{ type: "text", text: "结论" }]);
  });
});

describe("persisted desktop control messages", () => {
  it("stores compact controls outside the model context", () => {
    const manager = SessionManager.inMemory("C:/work/demo");
    manager.appendCustomEntry(PI_DESKTOP_CONTROL_ENTRY_TYPE, { kind: "compact-command", text: "/compact" });

    expect(manager.buildSessionContext().messages).toEqual([]);
    expect(restoreControlMessages(manager.getBranch())).toMatchObject([
      { role: "user", control: "compact", blocks: [{ type: "text", text: "/compact" }] }
    ]);
  });

  it("restores compact commands and results without treating unrelated custom entries as chat", () => {
    const messages = restoreControlMessages([
      { id: "entry-command", type: "custom", customType: PI_DESKTOP_CONTROL_ENTRY_TYPE, timestamp: "2026-08-10T07:29:00.000Z", data: { kind: "compact-command", text: "/compact 保留当前修改" } },
      { id: "entry-other", type: "custom", customType: "another-extension", timestamp: "2026-08-10T07:29:10.000Z", data: { kind: "compact-command", text: "/compact" } },
      { id: "entry-result", type: "custom", customType: PI_DESKTOP_CONTROL_ENTRY_TYPE, timestamp: "2026-08-10T07:29:20.000Z", data: { kind: "compact-result", text: "已压缩上下文。" } }
    ]);

    expect(messages).toMatchObject([
      { id: "pidesktop-control-entry-command", role: "user", control: "compact", blocks: [{ type: "text", text: "/compact 保留当前修改" }] },
      { id: "pidesktop-control-entry-result", role: "assistant", control: "compact", blocks: [{ type: "text", text: "已压缩上下文。" }] }
    ]);
  });
});
