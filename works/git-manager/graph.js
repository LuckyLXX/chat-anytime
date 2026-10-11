/**
 * 提交图（泳道）布局 —— 纯函数，不碰 DOM、不认识主题，只把提交拓扑算成可绘制的线段。
 *
 * 输入是 `bridge.mjs /api/log` 的提交数组（**新 → 旧**，父提交在数组更靠后的位置），
 * 输出每行的泳道位置与线段。UI 把它画成 SVG。
 *
 * 算法是 git log --graph 的那套「车道」模型：
 * - `lanes[i]` 表示第 i 条泳道**正等待**出现的提交 sha（null = 这条道空着）；
 * - 自上而下扫：提交若被某条泳道等待，就落在最小的那条泳道上（多条等待 = 分支汇入，
 *   其余那条记 merge 线）；否则占用最左侧的空泳道（新分支头）；
 * - 本提交的第一个父接住本泳道（主线继续），其余父各自认领一条泳道（新分支线）；
 * - 尾部空泳道立刻回收，避免图越画越宽。
 *
 * 画线口径（UI 按此渲染，行高固定、泳道宽固定）：
 * - `pass`：某泳道从上到下贯穿本行（不参与本提交）
 * - `merge`：另一条泳道斜着汇入本行的提交点
 * - `branch`：从本行的提交点斜着分叉到另一条泳道
 * - `spine`：提交点向下接住第一个父的竖线
 * 线段满足：从本行顶边到本行底边（pass），或从顶边到行中点 / 从中点到行底边（斜线）。
 */

/** 颜色按泳道索引取模；具体色值由 UI 决定（色板写在 styles.css 的 --lane-N 变量里）。 */
export const LANE_COLOR_COUNT = 8;

/** 一行的最大泳道数上限：极端拓扑（几十条并发分支）不该把图撑到画不下。 */
export const MAX_LANES = 24;

function dedupe(edges) {
  const seen = new Set();
  const out = [];
  for (const edge of edges) {
    const key = `${edge.from}:${edge.to}:${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out.sort((left, right) => left.from - right.from || left.to - right.to);
}

function computeEdges(before, after, lane, sha, parents) {
  const edges = [];
  const width = Math.max(before.length, after.length);
  for (let index = 0; index < width; index += 1) {
    const was = before[index] ?? null;
    const now = after[index] ?? null;
    if (was === sha) {
      // 这条泳道等的就是本提交：落在本泳道上是终点，别的泳道斜着汇进来
      if (index !== lane) edges.push({ from: index, to: lane, kind: "merge" });
    } else if (was !== null) {
      edges.push({ from: index, to: index, kind: "pass" });
    } else if (now !== null && index !== lane) {
      // 上一行还空着、本行被占用的泳道：从提交点分叉出去
      edges.push({ from: lane, to: index, kind: "branch" });
    }
  }
  if (parents.length > 0 && (after[lane] ?? null) !== null) edges.push({ from: lane, to: lane, kind: "spine" });
  for (let index = 0; index < width; index += 1) {
    const now = after[index] ?? null;
    if (now === null || index === lane) continue;
    // 只画「本行新开的分叉」：该泳道在上一行就已经等着同一个提交时，pass 已经画过了
    if (parents.includes(now) && (before[index] ?? null) !== now) edges.push({ from: lane, to: index, kind: "branch" });
  }
  return dedupe(edges);
}

/**
 * 布局一批提交。
 * @param {{ sha: string, parents?: string[] }[]} commits 新 → 旧的提交数组
 * @returns {{ sha: string, lane: number, color: number, laneCount: number, edges: { from: number, to: number, kind: string }[] }[]}
 */
export function layoutGraph(commits) {
  const lanes = [];
  const rows = [];
  for (const commit of commits ?? []) {
    if (!commit || typeof commit.sha !== "string" || commit.sha.length === 0) continue;
    const parents = Array.isArray(commit.parents) ? commit.parents.filter((parent) => typeof parent === "string" && parent.length > 0) : [];
    const before = lanes.slice();
    let lane = lanes.indexOf(commit.sha);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) {
        if (lanes.length >= MAX_LANES) {
          // 超过上限就复用最后一条道：图会略微失真，但绝不无限变宽
          lane = MAX_LANES - 1;
        } else {
          lanes.push(null);
          lane = lanes.length - 1;
        }
      }
    } else {
      // 多条泳道等同一个提交（分支汇入）：只保留最左那条，其余置空由 merge 线表达
      for (let index = lane + 1; index < lanes.length; index += 1) {
        if (lanes[index] === commit.sha) lanes[index] = null;
      }
    }

    if (parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = parents[0];
      for (let index = 1; index < parents.length; index += 1) {
        const parent = parents[index];
        if (lanes.includes(parent)) continue;
        const free = lanes.indexOf(null);
        if (free < 0) {
          if (lanes.length >= MAX_LANES) continue;
          lanes.push(parent);
        } else {
          lanes[free] = parent;
        }
      }
    }

    const after = lanes.slice();
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({
      sha: commit.sha,
      lane,
      color: lane % LANE_COLOR_COUNT,
      laneCount: Math.max(before.length, after.length),
      edges: computeEdges(before, after, lane, commit.sha, parents)
    });
  }
  return rows;
}
