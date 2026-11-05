import { describe, expect, it } from "vitest";
import { analyzeMemoryHealth } from "./memory-health.js";
import type { MemoryTopicSummary } from "./protocol.js";

function topic(overrides: Partial<MemoryTopicSummary> & { title: string }): MemoryTopicSummary {
  const { title, ...rest } = overrides;
  return {
    id: rest.id ?? title,
    description: rest.description ?? "一句话描述",
    contentChars: rest.contentChars ?? 1_000,
    contentRevision: 1,
    createdAt: rest.createdAt ?? "2026-01-01",
    updatedAt: rest.updatedAt ?? "2026-10-01",
    ...rest,
    title
  };
}

const now = Date.parse("2026-11-05T00:00:00Z");

describe("memory health", () => {
  it("flags oversize topics, core without summary and index pressure", () => {
    const health = analyzeMemoryHealth([
      topic({ title: "巨无霸", contentChars: 13_000, layer: "standard" }),
      topic({ title: "用户偏好", layer: "core", summaryChars: 0 }),
      topic({ title: "有要点", layer: "core", summaryChars: 120 })
    ], { indexChars: 1_900, now });
    const kinds = health.issues.map((issue) => issue.kind);
    expect(kinds).toContain("index-pressure");
    expect(kinds).toContain("large");
    expect(kinds).toContain("index-degraded");
    expect(kinds).toContain("core-no-summary");
    expect(kinds.filter((kind) => kind === "core-no-summary")).toHaveLength(1);
    expect(health.layers).toEqual({ core: 2, standard: 1, archive: 0 });
  });

  it("flags stale standard topics but not core or archive", () => {
    const health = analyzeMemoryHealth([
      topic({ title: "旧知识", updatedAt: "2026-06-01" }),
      topic({ title: "旧偏好", layer: "core", updatedAt: "2026-06-01", summaryChars: 50 }),
      topic({ title: "旧归档", layer: "archive", updatedAt: "2026-06-01" })
    ], { indexChars: 100, now });
    expect(health.issues.filter((issue) => issue.kind === "stale").map((issue) => issue.title)).toEqual(["旧知识"]);
  });

  it("finds near-duplicate titles and tiny topics", () => {
    const health = analyzeMemoryHealth([
      topic({ title: "PiDesktop 发布流程", description: "发版 CI 打包与升级" }),
      topic({ title: "PiDesktop 发版流程", description: "发版 CI 打包与升级步骤" }),
      topic({ title: "空壳", description: "只有一句", contentChars: 10 })
    ], { indexChars: 100, now });
    expect(health.duplicates).toHaveLength(1);
    expect(health.duplicates[0]!.score).toBeGreaterThan(0.55);
    expect(health.issues.some((issue) => issue.kind === "duplicate")).toBe(true);
    expect(health.issues.some((issue) => issue.kind === "tiny")).toBe(true);
  });

  it("stays quiet for a healthy library", () => {
    const health = analyzeMemoryHealth([
      topic({ title: "用户偏好", layer: "core", summaryChars: 80, updatedAt: "2026-11-01" }),
      topic({ title: "发布流程", updatedAt: "2026-10-20" })
    ], { indexChars: 500, now });
    expect(health.issues).toHaveLength(0);
  });
});
