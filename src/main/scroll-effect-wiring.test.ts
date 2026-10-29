import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 时间线「当前轮次」滚动监听的接线契约。
 *
 * 为什么放在 src/main：渲染端 tsconfig 没有 node 类型，源码断言只能写在这里。
 * 为什么需要源码断言：`turn-summary` / `timeline-window` 的纯逻辑用例证明不了
 * effect 的依赖是什么——旧实现把每帧换引用的 `turnStartKeys` 放进 deps，于是流式
 * 期间每 50ms 拆挂一次 scroll 监听并全量扫 400 个 `offsetTop`（每帧一次强制布局）。
 * 删掉整条签名路径，纯逻辑测试仍会全绿，所以这里钉住源码形态。
 */
const pane = readFileSync(join(__dirname, "../renderer/src/ConversationPane.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("active-turn scroll wiring", () => {
  it("keys the effect on the turn-key signature instead of the per-frame turns array", () => {
    expect(pane).toContain("turnKeySignature(turns)");
    expect(pane).toContain("}, [turnKeyId]);");
    expect(pane).not.toContain("}, [turnStartKeys, data.messages.length]);");
  });

  it("coalesces scroll events into one rAF scan per frame", () => {
    expect(pane).toContain("requestAnimationFrame(updateActiveTurn)");
    expect(pane).toContain("cancelAnimationFrame(frame)");
    expect(pane).toContain('timeline.addEventListener("scroll", scheduleUpdate, { passive: true })');
  });
});
