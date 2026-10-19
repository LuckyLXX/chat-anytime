import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../shared/protocol.js";
import { buildSnippet, searchSessionText, searchTerms } from "./session-search.js";
import { createEmptySessionTextIndex, type SessionTextIndex } from "./session-text-index.js";
import { sessionPathKey } from "./session-scope.js";

function session(id: string, title: string, modifiedAt = Date.now()): SessionSummary {
  return { id, path: `C:/sessions/${id}.jsonl`, workspace: "C:/work", title, modifiedAt, messageCount: 2 };
}

function indexWith(entries: Record<string, { timestamp: number; role: "user" | "assistant"; text: string }[]>): SessionTextIndex {
  const index = createEmptySessionTextIndex();
  for (const [path, docs] of Object.entries(entries)) {
    index.files[sessionPathKey(path)] = { mtimeMs: 1, size: 1, parsedBytes: 1, docs };
  }
  return index;
}

describe("searchTerms", () => {
  it("normalizes NFKC, lowercases and de-duplicates whitespace-separated terms", () => {
    expect(searchTerms("  ＤＥＰＬＯＹ   deploy ")).toEqual(["deploy"]);
    expect(searchTerms("部署 失败 部署")).toEqual(["部署", "失败"]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("buildSnippet", () => {
  it("centers on the earliest term and marks truncation", () => {
    const text = `${"前".repeat(200)}关键错误在这里${"后".repeat(200)}`;
    const snippet = buildSnippet(text, ["关键错误"], 30);
    expect(snippet).toContain("关键错误");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("collapses whitespace and newlines", () => {
    expect(buildSnippet("第一行\n\n第二行 关键词", ["关键词"], 100)).toBe("第一行 第二行 关键词");
  });
});

describe("searchSessionText", () => {
  it("matches a single term and returns session metadata", () => {
    const target = session("a", "部署事故");
    const hits = searchSessionText(
      indexWith({ [target.path]: [{ timestamp: 1_000, role: "user", text: "上线部署失败了" }] }),
      [target],
      "部署"
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sessionId: "a", path: target.path, title: "部署事故", role: "user", timestamp: 1_000 });
    expect(hits[0]?.snippet).toContain("部署");
  });

  it("requires every whitespace-separated term (AND)", () => {
    const target = session("a", "混合");
    const index = indexWith({
      [target.path]: [
        { timestamp: 1, role: "user", text: "部署失败" },
        { timestamp: 2, role: "assistant", text: "部署成功" }
      ]
    });

    const hits = searchSessionText(index, [target], "部署 失败");
    expect(hits.map((hit) => hit.timestamp)).toEqual([1]);
  });

  it("is case-insensitive and NFKC-normalized", () => {
    const target = session("a", "Deploy notes");
    const hits = searchSessionText(
      indexWith({ [target.path]: [{ timestamp: 1, role: "assistant", text: "The ＤＥＰＬＯＹ failed" }] }),
      [target],
      "deploy"
    );
    expect(hits).toHaveLength(1);
  });

  it("ranks a title match above a body-only match", () => {
    const titleMatch = session("a", "部署清单");
    const bodyMatch = session("b", "其他话题");
    const index = indexWith({
      [titleMatch.path]: [{ timestamp: 1, role: "assistant", text: "部署这件事" }],
      [bodyMatch.path]: [{ timestamp: 1, role: "assistant", text: "部署这件事" }]
    });

    const hits = searchSessionText(index, [titleMatch, bodyMatch], "部署");
    expect(hits.map((hit) => hit.sessionId)).toEqual(["a", "b"]);
  });

  it("caps hits per session but keeps global ordering", () => {
    const target = session("a", "长会话");
    const docs = Array.from({ length: 6 }, (_, index) => ({ timestamp: index + 1, role: "user" as const, text: `第 ${String(index)} 次部署` }));
    const hits = searchSessionText(indexWith({ [target.path]: docs }), [target], "部署");
    expect(hits).toHaveLength(3);
  });

  it("returns nothing for empty or unmatched queries", () => {
    const target = session("a", "话题");
    const index = indexWith({ [target.path]: [{ timestamp: 1, role: "user", text: "一段话" }] });
    expect(searchSessionText(index, [target], "   ")).toEqual([]);
    expect(searchSessionText(index, [target], "不存在的词")).toEqual([]);
    expect(searchSessionText(index, [target], "话", { limit: 1 })).toHaveLength(1);
  });

  it("ignores sessions that have no index entry", () => {
    expect(searchSessionText(createEmptySessionTextIndex(), [session("a", "话题")], "部署")).toEqual([]);
  });

  it("preserves the archived flag from the summary", () => {
    const target = { ...session("a", "归档话题"), archived: true };
    const hits = searchSessionText(
      indexWith({ [target.path]: [{ timestamp: 1, role: "user", text: "部署" }] }),
      [target],
      "部署"
    );
    expect(hits[0]?.archived).toBe(true);
  });
});
