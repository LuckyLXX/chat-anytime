import { describe, expect, it } from "vitest";
import { LANE_COLOR_COUNT, layoutGraph, MAX_LANES } from "./graph.js";

/** 造一个提交（parents 按新→旧的顺序给出）。 */
function commit(sha, parents = []) {
  return { sha, parents };
}

describe("layoutGraph：线性历史", () => {
  const rows = layoutGraph([commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1")]);

  it("全部落在第 0 条泳道，同色", () => {
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.color)).toEqual([0, 0, 0]);
  });

  it("每个提交点向下接住第一个父（spine），中间行还有贯穿线（pass）", () => {
    expect(rows[0].edges).toEqual([{ from: 0, to: 0, kind: "spine" }]);
    expect(rows[1].edges).toEqual([{ from: 0, to: 0, kind: "spine" }]);
    // 最后一个提交没有父：不画向下的线
    expect(rows[2].edges).toEqual([]);
  });
});

describe("layoutGraph：分叉与合并", () => {
  // main: c3 ← c2 ← c1；feature 从 c2 分出 c4
  const rows = layoutGraph([
    commit("c3", ["c2"]),
    commit("c4", ["c2"]),
    commit("c2", ["c1"]),
    commit("c1")
  ]);
  const byId = new Map(rows.map((row) => [row.sha, row]));

  it("分出的提交占用新泳道，父提交回落到第 0 条泳道并画出汇入线", () => {
    expect(byId.get("c3").lane).toBe(0);
    expect(byId.get("c4").lane).toBe(1);
    expect(byId.get("c2").lane).toBe(0);
    expect(byId.get("c1").lane).toBe(0);
  });

  it("分支头与主线并排：新泳道向下接住父提交，主线贯穿；父提交那一行才出现汇入线", () => {
    // c4 是分支头（新道）：它向下接住 c2（spine 在第 1 道），主线在第 0 道贯穿；
    // 两条道的汇合发生在处理 c2 的那一行（merge 1→0）——与 git log --graph 的观感一致。
    expect(byId.get("c4").edges).toContainEqual({ from: 1, to: 1, kind: "spine" });
    expect(byId.get("c4").edges).toContainEqual({ from: 0, to: 0, kind: "pass" });
    expect(byId.get("c2").edges).toContainEqual({ from: 1, to: 0, kind: "merge" });
  });

  it("泳道颜色按索引取模且跨行稳定（同一条道永远同色）", () => {
    expect(byId.get("c4").color).toBe(1);
    expect(byId.get("c3").color).toBe(byId.get("c2").color);
    expect(LANE_COLOR_COUNT).toBeGreaterThan(1);
  });

  it("合并提交（两个父）让两条泳道同时存在，主线接住第一个父", () => {
    const merged = layoutGraph([
      commit("m1", ["c3", "c4"]),
      commit("c3", ["base"]),
      commit("c4", ["base"]),
      commit("base")
    ]);
    const mergeRow = merged[0];
    expect(mergeRow.lane).toBe(0);
    // 第二个父分叉到第 1 条道
    expect(mergeRow.edges).toContainEqual({ from: 0, to: 1, kind: "branch" });
    expect(mergeRow.edges).toContainEqual({ from: 0, to: 0, kind: "spine" });
    // base 被两条道同时等待：落在最左，另一条汇入
    const baseRow = merged.find((row) => row.sha === "base");
    expect(baseRow.lane).toBe(0);
    expect(baseRow.edges).toContainEqual({ from: 1, to: 0, kind: "merge" });
  });
});

describe("layoutGraph：边界", () => {
  it("空数组与非法项安全返回", () => {
    expect(layoutGraph([])).toEqual([]);
    expect(layoutGraph(undefined)).toEqual([]);
    expect(layoutGraph([null, { sha: "" }, commit("ok")])).toHaveLength(1);
  });

  it("去重后同一行不出现重复线段", () => {
    const rows = layoutGraph([commit("a", ["b"]), commit("b")]);
    for (const row of rows) {
      const keys = row.edges.map((edge) => `${edge.from}:${edge.to}:${edge.kind}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("泳道数有上限（极端拓扑不把图撑到画不下）", () => {
    // 造 40 条各自独立的根提交（每个都开新泳道）
    const commits = Array.from({ length: 40 }, (_, index) => commit(`r${index}`));
    const rows = layoutGraph(commits);
    expect(rows).toHaveLength(40);
    expect(Math.max(...rows.map((row) => row.lane))).toBeLessThan(MAX_LANES);
  });
});
