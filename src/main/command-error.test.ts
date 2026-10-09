import { describe, expect, it } from "vitest";
import type { RuntimeCommand } from "../shared/protocol.js";
import { commandSessionId } from "./command-error.js";

/**
 * 命令级失败归属会话的判定（2026-10-09 用户报告的「假的正在努力输出中」根因链一环）。
 *
 * `runtime:send` 是发了就不回的通道，命令级失败只能靠推送告知；这条推送必须带上
 * 「是谁的命令」渲染端才能收起对应格子的乐观待回复。缺省值绝不允许误命中。
 */
describe("commandSessionId", () => {
  it("带回命令自带的 sessionId", () => {
    const prompt: RuntimeCommand = { type: "session.prompt", text: "hi", sessionId: "session-a" };
    expect(commandSessionId(prompt)).toBe("session-a");
  });

  it("带 sessionId 的分屏/资源类命令同样带得回来", () => {
    expect(commandSessionId({ type: "session.compact", sessionId: "session-b" })).toBe("session-b");
    expect(commandSessionId({ type: "session.regenerate", text: "x", sessionId: "session-c" })).toBe("session-c");
    expect(commandSessionId({ type: "session.queue.add", text: "x", sessionId: "session-d" })).toBe("session-d");
  });

  it("不带会话的命令一律缺省（渲染端不误收任何一格）", () => {
    expect(commandSessionId({ type: "agent.select", agentId: "default" })).toBeUndefined();
    expect(commandSessionId({ type: "session.new" })).toBeUndefined();
    expect(commandSessionId({ type: "workspace.open", path: "D:/w" })).toBeUndefined();
  });

  it("sessionId 为空串时原样带回（形状异常但不编造）", () => {
    expect(commandSessionId({ type: "session.prompt", text: "hi", sessionId: "" })).toBe("");
  });
});
