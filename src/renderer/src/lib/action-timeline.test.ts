import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../shared/protocol";
import { actionTimelineSegments, actionTimelineStats, formatProcessDuration } from "./action-timeline";

function assistant(blocks: ChatMessage["blocks"], streaming = false): ChatMessage {
  return { id: "a1", role: "assistant", timestamp: 1, blocks, streaming };
}

describe("assistant action timeline", () => {
  it("preserves prose and action order while combining adjacent text", () => {
    const segments = actionTimelineSegments(assistant([
      { type: "text", text: "先" },
      { type: "thinking", text: "分析" },
      { type: "tool-call", id: "t1", name: "read", arguments: {} },
      { type: "text", text: "后" },
      { type: "text", text: "续" }
    ]));
    expect(segments.map((segment) => segment.type)).toEqual(["text", "thinking", "tool-call", "text"]);
    expect(segments.at(-1)).toMatchObject({ type: "text", text: "后续" });
  });

  it("stays active until the whole turn and its tools are complete", () => {
    const segments = actionTimelineSegments(assistant([
      { type: "thinking", text: "分析" },
      { type: "tool-call", id: "t1", name: "read", arguments: {} },
      { type: "text", text: "完成" }
    ], true));
    const executions = [{ id: "t1", name: "read", args: {}, status: "completed" as const, startedAt: 100, completedAt: 250 }];
    expect(actionTimelineStats(segments, executions, true).active).toBe(true);
    expect(actionTimelineStats(segments, executions, false).active).toBe(false);
    const thoughtSegments = actionTimelineSegments(assistant([{ type: "thinking", text: "分析" }], true));
    expect(actionTimelineStats(thoughtSegments, [], true).active).toBe(true);
    const newToolSegments = actionTimelineSegments(assistant([{ type: "tool-call", id: "new", name: "read", arguments: {} }], true));
    expect(actionTimelineStats(newToolSegments, [], true).active).toBe(true);
  });

  it("formats a compact Chinese elapsed duration", () => {
    expect(formatProcessDuration(0, 450)).toBe("450 毫秒");
    expect(formatProcessDuration(0, 62_000)).toBe("1 分 2 秒");
    expect(formatProcessDuration(0, 3_000)).toBe("3 秒");
  });
});
