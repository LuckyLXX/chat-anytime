import { describe, expect, it } from "vitest";
import { lastCompletedChangedExecutionId, lastReviewExecutionId } from "./execution-select";
import type { ToolExecution } from "../../../shared/protocol";

/**
 * App 的 executions 派生选择器（2026-09-25 性能 P0）的回归网。
 *
 * 这两个选择器的**唯一目的**是让 zustand 的 `Object.is` 早退生效：工具 output
 * 逐帧增长时，如果选择器返回新对象/新数组，App 就会以 ~20 fps 重建整棵子树
 * （侧栏/顶栏/预览壳），等于没改。所以这里的断言分两类：
 * - 值语义：output 增长 / 无关 execution 变化时返回值**不变**；
 * - 形态：返回值是原始值（string | undefined），不是每次新建的容器。
 */

function execution(overrides: Partial<ToolExecution> & Pick<ToolExecution, "id">): ToolExecution {
  return { name: "bash", args: {}, status: "running", startedAt: 1, ...overrides };
}

describe("lastReviewExecutionId", () => {
  it("returns the newest execution carrying a patch", () => {
    const executions = [
      execution({ id: "e1", status: "completed", patch: "diff-1" }),
      execution({ id: "e2", status: "completed", output: "无 patch" }),
      execution({ id: "e3", status: "completed", patch: "diff-3" })
    ];
    expect(lastReviewExecutionId(executions)).toBe("e3");
    expect(lastReviewExecutionId([])).toBeUndefined();
    expect(lastReviewExecutionId([execution({ id: "e1", status: "completed" })])).toBeUndefined();
  });
});

describe("lastCompletedChangedExecutionId", () => {
  it("returns the newest completed execution that changed a file", () => {
    const executions = [
      execution({ id: "e1", status: "completed", changedFile: { relativePath: "a.md" } }),
      execution({ id: "e2", status: "running", changedFile: { relativePath: "b.md" } }),
      execution({ id: "e3", status: "error", changedFile: { relativePath: "c.md" } }),
      execution({ id: "e4", status: "completed", output: "只输出文本" })
    ];
    // running/error 不算：effect 只在改动落定后才同步编辑器。
    expect(lastCompletedChangedExecutionId(executions)).toBe("e1");
    expect(lastCompletedChangedExecutionId([])).toBeUndefined();
  });
});

describe("selector stability (the whole point of the extraction)", () => {
  it("returns the same primitive while only the output of a running execution grows", () => {
    const before = [
      execution({ id: "e1", status: "completed", patch: "diff-1", changedFile: { relativePath: "a.md" } }),
      execution({ id: "e2", status: "running", output: "第 1 帧" })
    ];
    const after = [
      before[0]!,
      { ...before[1]!, output: "第 2 帧（多了一些输出）" }
    ];
    expect(after).not.toBe(before);
    expect(lastReviewExecutionId(after)).toBe(lastReviewExecutionId(before));
    expect(lastCompletedChangedExecutionId(after)).toBe(lastCompletedChangedExecutionId(before));
    // 原始值（zustand 用 Object.is 比较的就是它）。
    expect(Object.is(lastReviewExecutionId(after), lastReviewExecutionId(before))).toBe(true);
    expect(typeof lastReviewExecutionId(before)).toBe("string");
  });

  it("changes only when a new reviewable/completed-change execution lands", () => {
    const before = [
      execution({ id: "e1", status: "completed", patch: "diff-1", changedFile: { relativePath: "a.md" } })
    ];
    const withRunning = [...before, execution({ id: "e2", status: "running", changedFile: { relativePath: "b.md" } })];
    expect(lastReviewExecutionId(withRunning)).toBe(lastReviewExecutionId(before));
    expect(lastCompletedChangedExecutionId(withRunning)).toBe(lastCompletedChangedExecutionId(before));

    const withCompleted = [...withRunning.slice(0, 1), { ...withRunning[1]!, status: "completed" as const, patch: "diff-2" }];
    expect(lastReviewExecutionId(withCompleted)).toBe("e2");
    expect(lastCompletedChangedExecutionId(withCompleted)).toBe("e2");
  });

  it("never returns a freshly allocated container", () => {
    const executions = [
      execution({ id: "e1", status: "completed", patch: "diff-1", changedFile: { relativePath: "a.md" } }),
      execution({ id: "e2", status: "completed" })
    ];
    // 同一数组连续取两次：Object.is 必须为 true（返回新对象会立刻击穿早退）。
    const first = lastReviewExecutionId(executions);
    expect(Object.is(first, lastReviewExecutionId(executions))).toBe(true);
    expect(first === "e1" || first === undefined || typeof first === "string").toBe(true);
    // 空数组也必须稳定（不返回新数组/对象）。
    expect(Object.is(lastCompletedChangedExecutionId([]), lastCompletedChangedExecutionId([]))).toBe(true);
  });
});
