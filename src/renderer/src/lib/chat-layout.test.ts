import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../shared/protocol";
import { groupAssistantMessages, splitAssistantToolLayout } from "./chat-layout";

function message(id: string, role: ChatMessage["role"], text: string, extra: ChatMessage["blocks"] = []): ChatMessage {
  return { id, role, timestamp: 1, blocks: [{ type: "text", text }, ...extra] };
}

describe("chat message layout", () => {
  it("groups continuous assistant segments, including tool calls", () => {
    const result = groupAssistantMessages([
      message("u1", "user", "检查项目"),
      message("a1", "assistant", "先读取文件", [{ type: "tool-call", id: "t1", name: "read", arguments: {} }]),
      message("a2", "assistant", "再总结"),
      message("u2", "user", "继续")
    ]);

    expect(result).toHaveLength(3);
    expect(result[1]?.role).toBe("assistant");
    expect(result[1]?.blocks).toHaveLength(3);
    expect(result[1]?.id).toBe("a1");
  });

  it("does not merge assistant replies across a user message", () => {
    const result = groupAssistantMessages([
      message("u1", "user", "第一问"),
      message("a1", "assistant", "第一答"),
      message("u2", "user", "第二问"),
      message("a2", "assistant", "第二答")
    ]);

    expect(result.map((item) => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("keeps extension callouts as boundaries between assistant segments", () => {
    const extension = { ...message("ext", "extension", "notice"), extension: { customType: "sample" } };
    const result = groupAssistantMessages([
      message("a1", "assistant", "before"),
      extension,
      message("a2", "assistant", "after")
    ]);

    expect(result.map((item) => item.role)).toEqual(["assistant", "extension", "assistant"]);
  });

  it("keeps prose before and after the folded tool process", () => {
    const layout = splitAssistantToolLayout(message("a1", "assistant", "开始", [
      { type: "tool-call", id: "t1", name: "read", arguments: {} },
      { type: "text", text: "继续处理" },
      { type: "tool-call", id: "t2", name: "edit", arguments: {} },
      { type: "text", text: "处理完成" }
    ]));
    expect(layout?.leading).toEqual([{ type: "text", text: "开始" }]);
    expect(layout?.process.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(layout?.trailing).toEqual([{ type: "text", text: "继续处理" }, { type: "text", text: "处理完成" }]);
  });
});
