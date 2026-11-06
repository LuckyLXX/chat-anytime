// 记忆面板卡片布局的回归网：面板列表是「定高 flex 列」，卡片又带 overflow:hidden，
// 一旦丢掉 flex: 0 0 auto，28 张卡会被 flex-shrink 压成一条条 1px 横线（实机踩到）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "renderer", "src", "styles.css"), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}

describe("memory panel card layout", () => {
  it("never lets cards shrink inside the fixed-height flex list", () => {
    const card = ruleBody(".memory-card");
    expect(card).toContain("flex: 0 0 auto");
    expect(ruleBody(".memory-panel-list")).toContain("overflow-y: auto");
  });

  it("keeps the memory center detail column non-shrinking and scrollable", () => {
    expect(css).toContain(".memory-center-meta > * { flex: 0 0 auto; }");
    expect(ruleBody(".memory-center-meta")).toContain("overflow-y: auto");
  });

  it("lays the graph out as a single scrolling column (connector positions are CSS, not measured)", () => {
    const graph = ruleBody(".mg");
    expect(graph).toContain("overflow-y: auto");
    expect(graph).toContain("flex-direction: column");
    expect(ruleBody(".mg-lane-nodes")).toContain("flex-direction: column");
    expect(ruleBody(".mg-node-body")).toContain("grid-template-columns");
  });
});
