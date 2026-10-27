// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RuntimeSnapshot } from "../../shared/protocol";
import { ConversationPane } from "./ConversationPane";
import { useDesktopStore } from "./store";

/**
 * 时间线窗口化的**接线**契约（2026-10-26 用户报「长会话历史轮次内容丢失，看不到了，
 * 像被删除了一样」）。
 *
 * 根因不是数据丢失，而是占位条目没有注册进 IntersectionObserver：观察器在面板的
 * `useLayoutEffect` 里创建，而条目的 ref 回调在**同一提交里更早**执行（父 effect 晚于
 * 子 ref），那时 `windowObserverRef.current` 仍是 undefined，注册被静默丢弃；条目的
 * ref 又是稳定引用，不会重新挂载——于是除了尾部 `TIMELINE_LIVE_TAIL` 条，整段历史
 * 永远是空白占位，滚动也唤不回来。
 *
 * 为什么必须放在这里而不是纯逻辑用例里：`lib/timeline-window.ts` 的用例只能证明
 * 「谁该折叠」，证明不了「折叠后还能被唤回」。之前的回归网只有源码字符串断言与折叠
 * 外观断言，删掉整条注册路径也会全绿——正是这个 bug 溜过去的原因。这里用真实组件 +
 * 可驱动的假 IntersectionObserver 钉住「注册真的发生了、条目真的能实体化」。
 */

const noop = (): void => undefined;

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, uuid: id, role, timestamp: 0, blocks: [{ type: "text", text }] };
}

/** 够长以启用时间线窗口化（TIMELINE_WINDOW_MIN_MESSAGES = 40）。 */
function conversation(prefix: string, count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`, index % 2 === 0 ? "user" : "assistant", `第 ${index} 条消息`));
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agentId: "default",
    agentName: "默认助手",
    thinkingLevel: "medium",
    busy: false,
    status: "",
    sessionId: "session-a",
    workspace: "D:/w",
    messages: conversation("a", 60),
    executions: [],
    queuedMessages: [],
    backgroundProcesses: [],
    sessions: [],
    recentWorkspaces: [],
    ...overrides
  };
}

/** 假 IntersectionObserver：happy-dom 不派发真实回调，由测试驱动「进入 ±1 屏」。 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly elements = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void { this.elements.add(target); }
  unobserve(target: Element): void { this.elements.delete(target); }
  disconnect(): void { this.elements.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  fireVisible(isIntersecting: boolean): void {
    const entries = [...this.elements].map((target) => ({ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 })) as unknown as IntersectionObserverEntry[];
    this.callback(entries, this as unknown as IntersectionObserver);
  }
  static latest(): FakeIntersectionObserver {
    const instance = FakeIntersectionObserver.instances.at(-1);
    if (!instance) throw new Error("没有注册的时间线观察器");
    return instance;
  }
}

let container: HTMLDivElement;
const roots = new Set<ReturnType<typeof createRoot>>();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  FakeIntersectionObserver.instances = [];
  const host = globalThis as unknown as { IntersectionObserver?: unknown; ResizeObserver?: unknown; window: unknown };
  host.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  host.IntersectionObserver = FakeIntersectionObserver;
  host.window ??= host;
  (host as { piDesktop?: unknown }).piDesktop = {
    send: async () => undefined,
    searchWorkspaceFiles: async () => ({ entries: [] }),
    onRuntimeMessage: () => () => undefined
  };
  useDesktopStore.setState({
    ready: true,
    snapshot: snapshot(),
    paneStates: {},
    parkedPanels: {},
    error: undefined,
    commandError: undefined
  });
});

afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots.clear();
  container.remove();
  vi.useRealTimers();
});

function Pane(): ReactNode {
  const sessionId = useDesktopStore((state) => state.snapshot.sessionId);
  return (
    <ConversationPane
      sessionId={sessionId}
      focused
      onNewSession={noop}
      onOpenArtifact={noop}
      onOpenFile={noop}
      onOpenDiff={noop}
      onOpenPlanDetail={noop}
      onOpenMemoryTopic={noop}
      onActionError={noop}
    />
  );
}

function render(): HTMLElement {
  const root = createRoot(container);
  roots.add(root);
  act(() => { root.render(<Pane />); });
  const timeline = container.querySelector<HTMLElement>(".timeline");
  if (!timeline) throw new Error("找不到时间线容器");
  return timeline;
}

function counts(timeline: HTMLElement): { live: number; tombstones: number } {
  return {
    live: timeline.querySelectorAll(".message:not([data-tombstone])").length,
    tombstones: timeline.querySelectorAll('[data-tombstone="true"]').length
  };
}

function observed(): number {
  return FakeIntersectionObserver.instances.at(-1)?.elements.size ?? -1;
}

describe("时间线窗口化接线：占位条目必须被观察", () => {
  it("首次进入长会话：所有条目（含占位）都注册进观察器", () => {
    const timeline = render();
    expect(counts(timeline)).toEqual({ live: 8, tombstones: 52 });
    // 注册发生在观察器创建之前的那个提交里 → 靠补注册兜住。少一条都会让该条历史
    // 永久停在空白占位。
    expect(observed()).toBe(60);
  });

  it("占位滚入视口后实体化（历史内容能看回来）", () => {
    const timeline = render();
    act(() => { FakeIntersectionObserver.latest().fireVisible(true); });
    expect(counts(timeline)).toEqual({ live: 60, tombstones: 0 });
    expect(timeline.textContent).toContain("第 0 条消息");
    expect(timeline.textContent).toContain("第 51 条消息");
  });

  it("水合路径（面板先挂载、消息后到）同样全部注册", () => {
    useDesktopStore.setState({ snapshot: snapshot({ messages: [] }) });
    const timeline = render();
    act(() => { useDesktopStore.setState({ snapshot: snapshot({ messages: conversation("a", 60) }) }); });
    expect(counts(timeline)).toEqual({ live: 8, tombstones: 52 });
    expect(observed()).toBe(60);
  });

  it("`ready` 翻转重建观察器后，已挂载条目重新注册（不是只剩新挂载的）", () => {
    useDesktopStore.setState({ ready: false, snapshot: snapshot({ messages: [] }) });
    const timeline = render();
    act(() => { useDesktopStore.setState({ ready: true, snapshot: snapshot({ messages: conversation("a", 60) }) }); });
    expect(observed()).toBe(60);
    // 重建出的新观察器也能把它们唤回来。
    act(() => { FakeIntersectionObserver.latest().fireVisible(true); });
    expect(counts(timeline)).toEqual({ live: 60, tombstones: 0 });
  });

  it("短→长会话切换：观察器是随这次提交建的，也要全部注册", () => {
    useDesktopStore.setState({ snapshot: snapshot({ messages: conversation("s", 5) }) });
    const timeline = render();
    act(() => { useDesktopStore.setState({ snapshot: snapshot({ sessionId: "session-b", messages: conversation("b", 60) }) }); });
    expect(counts(timeline)).toEqual({ live: 8, tombstones: 52 });
    expect(observed()).toBe(60);
    act(() => { FakeIntersectionObserver.latest().fireVisible(true); });
    expect(counts(timeline)).toEqual({ live: 60, tombstones: 0 });
  });
});
