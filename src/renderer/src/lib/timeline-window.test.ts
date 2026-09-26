// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../shared/protocol";
import { TIMELINE_LIVE_TAIL, createTimelineObserver, estimateMessageHeight, messageTextLength, placeholderHeightFor, shouldRenderLive, type TimelineObserverEntryLike } from "./timeline-window";

/**
 * 时间线窗口化（T10）的纯逻辑契约。
 *
 * 实测背景：400 条真实长度分布的消息 = 16,612 DOM 节点 / 挂载 1,747 ms；只留最近 12 条
 * 真实内容 + 等高占位 = 3,472 节点 / 404 ms。这里钉住「哪些条目必须保持真实渲染」——
 * 折叠错了会直接表现为滚动跳动或内容丢失。
 */

function message(text: string, role: "user" | "assistant" = "assistant"): ChatMessage {
  return { id: "m", uuid: "u", role, timestamp: 0, blocks: [{ type: "text", text }] };
}

describe("timeline window: 估算高度", () => {
  it("单调、有界（估算只用于从未渲染过的条目）", () => {
    const short = estimateMessageHeight(message("很短"));
    const medium = estimateMessageHeight(message("x".repeat(500)));
    const long = estimateMessageHeight(message("x".repeat(50_000)));
    expect(short).toBeGreaterThanOrEqual(64);
    expect(medium).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(medium);
    expect(long).toBeLessThanOrEqual(4000);
  });

  it("文本长度统计覆盖 text 与 image 块", () => {
    expect(messageTextLength(message("12345"))).toBe(5);
    const withImage: ChatMessage = { id: "i", role: "user", timestamp: 0, blocks: [{ type: "image", mimeType: "image/png", data: "x" }] as ChatMessage["blocks"] };
    expect(messageTextLength(withImage)).toBe(240);
  });
});

describe("timeline window: 谁必须保持真实渲染", () => {
  const base = { total: 400, expandAll: false, pinned: false };

  it("尾部若干条永不折叠（最新内容与流式消息）", () => {
    expect(shouldRenderLive({ ...base, index: 399, visible: false })).toBe(true);
    expect(shouldRenderLive({ ...base, index: 400 - TIMELINE_LIVE_TAIL, visible: false })).toBe(true);
    expect(shouldRenderLive({ ...base, index: 400 - TIMELINE_LIVE_TAIL - 1, visible: false })).toBe(false);
  });

  it("±1 屏内的条目保持真实渲染", () => {
    expect(shouldRenderLive({ ...base, index: 10, visible: true })).toBe(true);
  });

  it("缩略导航的目标先展开（否则会滚到估算位置）", () => {
    expect(shouldRenderLive({ ...base, index: 10, visible: false, pinned: true })).toBe(true);
  });

  it("Ctrl/Cmd+F 时全部展开（页内查找要能找到旧消息）", () => {
    expect(shouldRenderLive({ ...base, index: 10, visible: false, expandAll: true })).toBe(true);
  });

  it("首帧只有尾部若干条是真实渲染（这才是省下 1.7s 的那部分）", () => {
    // 挂载瞬间观察器还没回报任何可见项 → 400 条里只有尾部 8 条要解析 markdown。
    const live = Array.from({ length: 400 }, (_, index) => shouldRenderLive({ ...base, index, visible: false })).filter(Boolean);
    expect(live).toHaveLength(TIMELINE_LIVE_TAIL);
  });

  it("占位高度优先用实测缓存，其次估算", () => {
    expect(placeholderHeightFor(321, 96)).toBe(321);
    expect(placeholderHeightFor(undefined, 96)).toBe(96);
    expect(placeholderHeightFor(0, 96)).toBe(96);
  });
});

describe("timeline window: observer 映射", () => {
  interface Recorder { observe(target: Element): void; unobserve(target: Element): void; disconnect(): void }

  function fakeObserverFactory(): {
    create: (callback: (entries: readonly TimelineObserverEntryLike[]) => void, options: { root: HTMLElement; rootMargin: string }) => Recorder;
    fire: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
    observed: Element[];
    unobserved: Element[];
    settings: { rootMargin?: string };
  } {
    let callback: ((entries: readonly TimelineObserverEntryLike[]) => void) | undefined;
    const state = { observed: [] as Element[], unobserved: [] as Element[], settings: {} as { rootMargin?: string } };
    return {
      create: (cb, options) => {
        callback = cb;
        state.settings = options;
        return {
          observe: (target) => { state.observed.push(target); },
          unobserve: (target) => { state.unobserved.push(target); },
          disconnect: () => undefined
        };
      },
      fire: (entries) => callback?.(entries),
      get observed() { return state.observed; },
      get unobserved() { return state.unobserved; },
      get settings() { return state.settings; }
    };
  }

  it("元素 → key 映射与变更回调", () => {
    const factory = fakeObserverFactory();
    const events: Array<[string, boolean]> = [];
    const observer = createTimelineObserver({ root: document.createElement("div"), margin: "100% 0px", onChange: (key, visible) => events.push([key, visible]), createObserver: factory.create });

    const elementA = document.createElement("article");
    const elementB = document.createElement("article");
    observer.register("a", elementA);
    observer.register("b", elementB);
    factory.fire([{ target: elementA, isIntersecting: true }, { target: elementB, isIntersecting: false }]);
    expect(events).toEqual([["a", true], ["b", false]]);
    expect(factory.settings.rootMargin).toBe("100% 0px");
  });

  it("同一 key 换元素时先 unobserve 旧的（React key 复用）", () => {
    const factory = fakeObserverFactory();
    const events: Array<[string, boolean]> = [];
    const observer = createTimelineObserver({ root: document.createElement("div"), margin: "0px", onChange: (key, visible) => events.push([key, visible]), createObserver: factory.create });
    const first = document.createElement("article");
    const second = document.createElement("article");
    observer.register("a", first);
    observer.register("a", second);
    expect(factory.unobserved).toEqual([first]);
    factory.fire([{ target: first, isIntersecting: true }]); // 旧元素不该再产生事件
    factory.fire([{ target: second, isIntersecting: true }]);
    expect(events).toEqual([["a", true]]);
  });

  it("注销（null）后事件不再上抛", () => {
    const factory = fakeObserverFactory();
    const events: Array<[string, boolean]> = [];
    const observer = createTimelineObserver({ root: document.createElement("div"), margin: "0px", onChange: (key, visible) => events.push([key, visible]), createObserver: factory.create });
    const element = document.createElement("article");
    observer.register("a", element);
    observer.register("a", null);
    factory.fire([{ target: element, isIntersecting: true }]);
    expect(events).toEqual([]);
    observer.disconnect();
  });
});
