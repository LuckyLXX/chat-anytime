import { describe, expect, it } from "vitest";
import { runActive } from "./run-state.js";

/**
 * 「会话还在跑吗」的唯一口径（2026-11-13 内网用户报：绘画没完成、输入框已显示
 * 完成，回车却报 `Agent is already processing…`）。
 *
 * 关键点不是"两个布尔取或"这种琐碎，而是**谁算数**：`record.busy` 是我们自己的
 * 意向标记（旧实现在 `agent_end` 就清掉），`session.isStreaming` 是 Pi 的权威
 * 状态（`agent_settled` 之前一直为真：自动重试 / 压缩恢复 / 排队 followUp 都还在
 * 跑）。收尾窗口里只有后者说真话，所以它必须是"忙"的充分条件。
 */
describe("runActive", () => {
  it("两个都不忙才算空闲", () => {
    expect(runActive({ busy: false, session: { isStreaming: false } })).toBe(false);
  });

  it("只看 record.busy 就够（我们自己的意向标记仍然算忙）", () => {
    expect(runActive({ busy: true, session: { isStreaming: false } })).toBe(true);
  });

  it("agent_end 收了 busy 但 Pi 还在收尾 → 仍算忙（本 bug 的现场）", () => {
    expect(runActive({ busy: false, session: { isStreaming: true } })).toBe(true);
  });

  it("两个都忙也是忙（正常回合中）", () => {
    expect(runActive({ busy: true, session: { isStreaming: true } })).toBe(true);
  });
});
