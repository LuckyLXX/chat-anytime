// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/protocol";
import { TimelineEntry } from "./ConversationPane";

/**
 * 时间线窗口化（T10）的条目契约。
 *
 * 折叠条目必须：① 保留实测/估算高度（否则展开会滚动跳动）；② 保留 `.message` 类与
 * data-turn-key（主题选择器与缩略导航锚点语义不变）；③ 不渲染消息内容（这才是省下来的
 * 那部分开销）。第三条由纯逻辑测试（timeline-window.test.ts）决定「谁折叠」，
 * 这里钉住「折叠成什么样」。
 */

const noop = (): void => undefined;

function message(text: string): ChatMessage {
  return { id: "m1", uuid: "u1", role: "assistant", timestamp: 0, blocks: [{ type: "text", text }] };
}

function baseProps(text: string) {
  return {
    message: message(text),
    executions: [],
    onOpenArtifact: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
    onHtmlAction: noop,
    onCopy: noop,
    onEdit: noop,
    onRegenerate: noop,
    onShare: async () => undefined
  };
}

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => container.remove());

describe("TimelineEntry：折叠成等高占位", () => {
  it("只留高度与锚点，不渲染内容", () => {
    const registered: Array<[string, HTMLElement | null]> = [];
    const root = createRoot(container);
    act(() => {
      root.render(
        <TimelineEntry
          {...baseProps("这段内容不该出现在折叠条目里")}
          entryKey="u1"
          entryTurnKey="turn-u1"
          live={false}
          placeholderHeight={321}
          register={(key, element) => registered.push([key, element])}
          onEntryRendered={noop}
        />
      );
    });
    const placeholder = container.querySelector<HTMLElement>('[data-tombstone="true"]')!;
    expect(placeholder).toBeTruthy();
    expect(placeholder.style.height).toBe("321px");
    expect(placeholder.className).toContain("message");
    expect(placeholder.dataset.turnKey).toBe("turn-u1");
    expect(container.textContent).not.toContain("这段内容不该出现在折叠条目里");
    // 占位元素也要注册给观察器（否则它永远无法变成可见）
    expect(registered.some(([key, element]) => key === "u1" && element === placeholder)).toBe(true);
    act(() => root.unmount());
    expect(registered.some(([, element]) => element === null)).toBe(true);
  });

  it("live=true 时渲染真实内容并上报实测", () => {
    const rendered: string[] = [];
    const root = createRoot(container);
    act(() => {
      root.render(
        <TimelineEntry
          {...baseProps("真实内容在这里")}
          entryKey="u1"
          live
          placeholderHeight={100}
          register={noop}
          onEntryRendered={(key) => rendered.push(key)}
        />
      );
    });
    expect(container.textContent).toContain("真实内容在这里");
    expect(container.querySelector('[data-tombstone="true"]')).toBeNull();
    expect(rendered).toEqual(["u1"]);
    act(() => root.unmount());
  });
});
