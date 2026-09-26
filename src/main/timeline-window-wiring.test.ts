import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 时间线窗口化（T10）的接线契约。
 *
 * 为什么放在 main 侧：渲染端 tsconfig 没有 node 类型（不能 import node:fs），
 * 而 `lib/timeline-window.ts` 自己的用例只能证明纯逻辑正确，证明不了 Pane 真的挂了
 * 窗口化——把 `shouldRenderLive` 或观察器删掉，纯逻辑用例会全绿而长会话照样首帧全渲染
 * 400 条 markdown（实测 1,747 ms）。
 */
describe("timeline window wiring contract", () => {
  const pane = readFileSync(join(__dirname, "../renderer/src/ConversationPane.tsx"), "utf8");
  const styles = readFileSync(join(__dirname, "../renderer/src/styles.css"), "utf8");

  it("时间线列表走 TimelineEntry（而不是直接渲染 MessageView）", () => {
    expect(pane).toContain("<TimelineEntry");
    expect(pane).not.toContain("return <MessageView key={message.uuid ?? message.id}");
  });

  it("折叠决策、占位高度、观察器三处接线都在", () => {
    expect(pane).toContain("shouldRenderLive({");
    expect(pane).toContain("placeholderHeightFor(windowHeightsRef.current.get(entryKey)");
    expect(pane).toContain("createTimelineObserver({");
    expect(pane).toContain("margin: TIMELINE_LIVE_MARGIN");
  });

  it("折叠前会量真实高度（唯一能拿到真值的机会）", () => {
    expect(pane).toContain("windowHeightsRef.current.set(key, height)");
  });

  it("Ctrl/Cmd+F 临时全部展开（页内查找不受折叠影响）且不 preventDefault", () => {
    const block = pane.slice(pane.indexOf('event.key.toLowerCase() === "f"'));
    expect(pane).toContain("setWindowExpandAll(true)");
    expect(block.slice(0, 400)).not.toContain("preventDefault");
  });

  it("会话切换复位可见集合与实测高度", () => {
    expect(pane).toContain("windowHeightsRef.current.clear()");
  });

  it("占位保留 .message 类与 data-turn-key，并有对应 CSS", () => {
    expect(pane).toContain('className="message message-tombstone"');
    expect(pane).toContain("data-turn-key={entryTurnKey}");
    expect(styles).toContain('.timeline > .message[data-tombstone="true"]');
  });
});
