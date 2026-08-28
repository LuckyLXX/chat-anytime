import { describe, expect, it } from "vitest";
import type { ChatMessage, MessageBlock } from "../../../shared/protocol";
import { buildTurnSummaries, truncatePreview } from "./turn-summary";

function message(id: string, role: ChatMessage["role"], text: string, extra: ChatMessage["blocks"] = [], uuid?: string): ChatMessage {
  const blocks: MessageBlock[] = text ? [{ type: "text", text }, ...extra] : extra;
  return { id, uuid, role, timestamp: 1, blocks };
}

describe("truncatePreview", () => {
  it("collapses whitespace but keeps line structure", () => {
    expect(truncatePreview("  多行\n换行\ntext  ", 100)).toBe("多行\n换行\ntext");
  });

  it("collapses runs of spaces/tabs on each line", () => {
    expect(truncatePreview("a \t\t b  c", 100)).toBe("a b c");
  });

  it("collapses consecutive blank lines into a single newline", () => {
    expect(truncatePreview("头\n\n\n尾", 100)).toBe("头\n尾");
  });

  it("appends an ellipsis when over maxChars, preserving the boundary", () => {
    expect(truncatePreview("一二三四五", 3)).toBe("一二三…");
  });

  it("returns empty for blank / whitespace-only text", () => {
    expect(truncatePreview("", 100)).toBe("");
    expect(truncatePreview("   \n  ", 100)).toBe("");
  });

  it("does not pad with ellipsis when exactly at the limit", () => {
    expect(truncatePreview("abc", 3)).toBe("abc");
  });
});

describe("buildTurnSummaries", () => {
  it("splits into turns anchored at each user message", () => {
    const turns = buildTurnSummaries([
      message("u1", "user", "第一问"),
      message("a1", "assistant", "第一答"),
      message("u2", "user", "第二问"),
      message("a2", "assistant", "第二答")
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ key: "u1", index: 0, userText: "第一问", aiText: "第一答", messageCount: 2 });
    expect(turns[1]).toMatchObject({ key: "u2", index: 1, userText: "第二问", aiText: "第二答", messageCount: 2 });
  });

  it("collects multiple assistant text blocks within one turn", () => {
    const turns = buildTurnSummaries([
      message("u1", "user", "提问"),
      message("a1", "assistant", "先读"),
      message("a2", "assistant", "再总结")
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.aiText).toBe("先读\n再总结");
    expect(turns[0]?.messageCount).toBe(3);
  });

  it("ignores thinking / tool-call / image blocks in the summary", () => {
    const turns = buildTurnSummaries([
      message("u1", "user", "改一下"),
      message("a1", "assistant", "", [
        { type: "thinking", text: "先读文件" },
        { type: "tool-call", id: "t1", name: "read", arguments: {} },
        { type: "text", text: "实际答案" }
      ])
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.aiText).toBe("实际答案");
    expect(turns[0]?.messageCount).toBe(2);
  });

  it("ignores user image-only blocks (no text)", () => {
    const turns = buildTurnSummaries([
      { id: "u1", role: "user", timestamp: 1, blocks: [{ type: "image", mimeType: "image/png", data: "x" }] },
      message("a1", "assistant", "看到了")
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.userText).toBe("");
    expect(turns[0]?.aiText).toBe("看到了");
  });

  it("returns empty list for an empty conversation", () => {
    expect(buildTurnSummaries([])).toEqual([]);
  });

  it("keeps a trailing user message with no assistant reply", () => {
    const turns = buildTurnSummaries([
      message("u1", "user", "问一下"),
      message("a1", "assistant", "答"),
      message("u2", "user", "还没答就问第二个")
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ userText: "还没答就问第二个", aiText: "", messageCount: 1 });
  });

  it("skips a leading assistant with no user anchor", () => {
    const turns = buildTurnSummaries([
      message("a0", "assistant", "开头的孤立回答"),
      message("u1", "user", "提问"),
      message("a1", "assistant", "答")
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.key).toBe("u1");
    expect(turns[0]?.aiText).toBe("答");
  });

  it("truncates long text to maxPreviewChars", () => {
    const turns = buildTurnSummaries([
      message("u1", "user", "一二三四五六七八九十"),
      message("a1", "assistant", "甲乙丙丁戊己庚辛壬癸")
    ], 4);

    expect(turns[0]?.userText).toBe("一二三四…");
    expect(turns[0]?.aiText).toBe("甲乙丙丁…");
  });

  it("prefers uuid for the turn key when present", () => {
    const turns = buildTurnSummaries([
      message("u1", "user", "提问", [], "uuid-123"),
      message("a1", "assistant", "答")
    ]);

    expect(turns[0]?.key).toBe("uuid-123");
  });
});
