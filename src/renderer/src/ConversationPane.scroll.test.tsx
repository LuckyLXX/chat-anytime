// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RuntimeSnapshot } from "../../shared/protocol";
import { ConversationPane } from "./ConversationPane";
import { useDesktopStore } from "./store";

/**
 * 切换会话时的滚动契约（2026-10-09 用户报「切会话后停在滚动条中间，还得手动滚到底」）。
 *
 * 根因分两段，缺任一条都会复发：
 * ① **切会话那一帧的瞬跳只覆盖当帧布局**。窗口化条目随后实体化（占位 `div` → 真实
 *    内容 = React 换节点），视口上方变高；而 Chromium 的滚动锚定对「节点被替换」的
 *    成长**不补偿**（真浏览器探针：40 条占位里实体化 16 条，gap 0 → 1600px），图片
 *    解码 / 产物测高同理。旧的「粘底时由粘底逻辑接管」只等下一次 messages/busy 变化，
 *    中间这段视口就停在滚动条中间。
 * ② 会话身份只比 `sessionId` prop 会漏判：数据晚一帧到（prop 已定、内容还是空的）时，
 *    那次「空 → 整个会话」的换入被当成普通新消息，走 idle 的 smooth 分支 —— 正是
 *    「从上往下滚一遍」的动画。
 *
 * 这里用可驱动的假 IntersectionObserver + 可写布局（scrollHeight/clientHeight/scrollTop）
 * 把两条路径都钉住：切换必须 auto 到底、切换后内容再变高仍钉住、后续帧不许 smooth、
 * 用户上滚后不再抢。
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

/** 可驱动布局的滚动容器模型：记录每次 scrollTo，并把 scrollTop 夹在合法区间。 */
interface Layout {
  calls: Array<{ top: number; behavior: string }>;
  setHeight(height: number): void;
  setViewportHeight(height: number): void;
  scrollTop(): number;
  userScrollTo(top: number): void;
}

const CLIENT_HEIGHT = 800;

function installLayout(element: HTMLElement): Layout {
  let height = 6000;
  let clientHeight = CLIENT_HEIGHT;
  let scrollTop = 0;
  const calls: Layout["calls"] = [];
  const maxTop = (): number => Math.max(0, height - clientHeight);
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, maxTop()));
    }
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: (options: { top?: number; behavior?: string }) => {
      const top = options?.top ?? 0;
      calls.push({ top, behavior: options?.behavior ?? "" });
      scrollTop = Math.max(0, Math.min(top, maxTop()));
    }
  });
  return {
    calls,
    setHeight: (next) => {
      height = next;
      scrollTop = Math.min(scrollTop, maxTop());
    },
    setViewportHeight: (next) => {
      clientHeight = next;
      scrollTop = Math.min(scrollTop, maxTop());
    },
    scrollTop: () => scrollTop,
    userScrollTo: (top) => {
      scrollTop = Math.max(0, Math.min(top, maxTop()));
    }
  };
}

/** 假 IntersectionObserver：可被测试驱动（happy-dom 不派发真实回调）。 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly elements = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.elements.add(target);
  }
  unobserve(target: Element): void {
    this.elements.delete(target);
  }
  disconnect(): void {
    this.elements.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** 模拟「这些元素进入 ±1 屏」——条目随之实体化。 */
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

/** 可驱动 ResizeObserver：模拟流式尾部 / 图片解码在父组件滚动之后才改变高度。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly elements = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void { this.elements.add(target); }
  unobserve(target: Element): void { this.elements.delete(target); }
  disconnect(): void { this.elements.clear(); }
  static fire(target: Element): void {
    for (const observer of FakeResizeObserver.instances) {
      if (observer.elements.has(target)) observer.callback([{ target } as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
  }
}

let container: HTMLDivElement;
const roots = new Set<ReturnType<typeof createRoot>>();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  FakeIntersectionObserver.instances = [];
  FakeResizeObserver.instances = [];
  const host = globalThis as unknown as { ResizeObserver?: unknown; IntersectionObserver?: unknown; window: unknown };
  host.ResizeObserver = FakeResizeObserver;
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

/** 与 App 一致：格子的 sessionId 就是主快照的会话（prop 与数据同帧变化）。 */
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

function render(pane: ReactNode = <Pane />): { root: ReturnType<typeof createRoot>; timeline: HTMLElement; layout: Layout } {
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(pane);
  });
  const timeline = container.querySelector<HTMLElement>(".timeline");
  if (!timeline) throw new Error("找不到时间线容器");
  const layout = installLayout(timeline);
  layout.calls.length = 0;
  return { root, timeline, layout };
}

function switchTo(sessionId: string, messages: ChatMessage[]): void {
  act(() => {
    useDesktopStore.setState({ snapshot: snapshot({ sessionId, messages }) });
  });
}

/** 推进若干帧（钉底窗口是 rAF 循环）。 */
async function frames(count = 6): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(count * 20);
  });
}

describe("切换会话的滚动契约", () => {
  it("切会话：瞬跳到底部，不出现平滑滚动", () => {
    const { root, layout } = render();

    switchTo("session-b", conversation("b", 60));

    expect(layout.calls.length).toBeGreaterThan(0);
    expect(layout.calls.every((call) => call.behavior === "auto")).toBe(true);
    expect(layout.calls.at(-1)?.top).toBe(6000);
    expect(layout.scrollTop()).toBe(5200);

    act(() => root.unmount());
  });

  it("会话身份来自数据：prop 没变、内容换入也要瞬跳（不是平滑）", async () => {
    // 分屏 / 水合场景：格子拿到的 sessionId 先定，数据（paneStates）后到，
    // 「空 → 整个会话」的换入发生在 prop 没变的后续帧。
    vi.useFakeTimers();
    useDesktopStore.setState({ snapshot: snapshot({ sessionId: "session-unrelated", workspace: undefined, messages: [] }) });
    const { root, layout } = render(
      <ConversationPane
        sessionId="session-a"
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
    expect(container.textContent).toContain("正在载入会话");
    // 挂载时数据还没到（空态），先让挂载那次钉底窗口自然收工：
    await frames(8);
    layout.calls.length = 0;

    switchTo("session-a", conversation("a", 60));

    expect(layout.calls.some((call) => call.behavior === "smooth")).toBe(false);
    expect(layout.calls.at(-1)).toEqual({ top: 6000, behavior: "auto" });
    expect(layout.scrollTop()).toBe(5200);

    act(() => root.unmount());
  });

  it("切会话后内容再变高（图片解码 / 产物测高）：仍钉在底部", async () => {
    vi.useFakeTimers();
    const { root, layout } = render();
    switchTo("session-b", conversation("b", 60));
    expect(layout.scrollTop()).toBe(5200);

    layout.setHeight(7000); // 视口上方变高，浏览器不补偿 scrollTop
    await frames();

    expect(layout.scrollTop()).toBe(6200);
    expect(layout.calls.at(-1)?.behavior).toBe("auto");

    act(() => root.unmount());
  });

  it("切会话后窗口化条目实体化（节点被替换）：靠条目实测钩子重新钉底", async () => {
    vi.useFakeTimers();
    const { root, layout } = render();
    switchTo("session-b", conversation("b", 60));
    // 先让钉底窗口收工（高度不变 → 提前退出），隔离出「实体化钩子」这一条路径。
    await frames(8);
    const before = layout.calls.length;

    layout.setHeight(7000);
    act(() => {
      FakeIntersectionObserver.latest().fireVisible(true);
    });

    expect(layout.calls.length).toBeGreaterThan(before);
    expect(layout.calls.at(-1)).toEqual({ top: 7000, behavior: "auto" });
    expect(layout.scrollTop()).toBe(6200);

    act(() => root.unmount());
  });

  it("钉底窗口期内后续帧也不做平滑滚动", () => {
    const { root, layout } = render();
    switchTo("session-b", conversation("b", 60));

    switchTo("session-b", [...conversation("b", 60), message("b-extra", "assistant", "新回复")]);

    expect(layout.calls.at(-1)?.behavior).toBe("auto");

    act(() => root.unmount());
  });

  it("用户上滚（粘底解除）后，钉底窗口不再抢", async () => {
    vi.useFakeTimers();
    const { root, timeline, layout } = render();
    switchTo("session-b", conversation("b", 60));

    act(() => {
      timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      layout.userScrollTo(0);
      timeline.dispatchEvent(new Event("scroll"));
    });
    const before = layout.calls.length;

    layout.setHeight(9000);
    await frames(12);

    expect(layout.calls.length).toBe(before);

    act(() => root.unmount());
  });
});

describe("持续输出的滚动契约", () => {
  async function streamingPane() {
    vi.useFakeTimers();
    const pane = render();
    act(() => {
      useDesktopStore.setState({ snapshot: snapshot({ busy: true }) });
    });
    await frames(10); // 首次切换的短暂钉底窗口已经退出
    return pane;
  }

  it("布局增长产生的 scroll 不能被当成用户上翻，后续输出仍跟随", async () => {
    const { root, timeline, layout } = await streamingPane();
    expect(layout.scrollTop()).toBe(5200);
    layout.setHeight(7200);
    act(() => timeline.dispatchEvent(new Event("scroll")));
    act(() => useDesktopStore.setState({ snapshot: snapshot({ busy: true, messages: [...conversation("a", 60), message("tail", "assistant", "继续输出")] }) }));
    await frames(2);
    expect(layout.scrollTop()).toBe(6400);
    act(() => root.unmount());
  });

  it("父组件滚动结束后尾部延迟增高，无新快照也要补滚到底", async () => {
    const { root, timeline, layout } = await streamingPane();
    layout.setHeight(7600);
    const tail = timeline.querySelector<HTMLElement>(".message:last-of-type")!;
    act(() => FakeResizeObserver.fire(tail));
    await frames(2);
    expect(layout.scrollTop()).toBe(6800);
    act(() => root.unmount());
  });

  it("用户上翻后尺寸变化不抢位置，手动到底后恢复异步跟随", async () => {
    const { root, timeline, layout } = await streamingPane();
    act(() => {
      timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
      layout.userScrollTo(4000);
      timeline.dispatchEvent(new Event("scroll"));
    });
    const tail = timeline.querySelector<HTMLElement>(".message:last-of-type")!;
    layout.setHeight(8000);
    act(() => FakeResizeObserver.fire(tail));
    await frames(2);
    expect(layout.scrollTop()).toBe(4000);
    act(() => {
      layout.userScrollTo(7200);
      timeline.dispatchEvent(new Event("scroll"));
    });
    layout.setHeight(9000);
    act(() => FakeResizeObserver.fire(tail));
    await frames(2);
    expect(layout.scrollTop()).toBe(8200);
    act(() => root.unmount());
  });

  it("浏览器在总高度不变时向上修正位置，也不能解除跟随", async () => {
    const { root, timeline, layout } = await streamingPane();
    act(() => timeline.dispatchEvent(new Event("scroll")));
    layout.userScrollTo(5000); // 模拟滚动锚定的修正，没有用户输入
    act(() => timeline.dispatchEvent(new Event("scroll")));
    await frames(2);
    expect(layout.scrollTop()).toBe(5200);
    act(() => root.unmount());
  });

  it("滚轮只上翻 20px 也不被吸回底部，未移动前的待执行补滚会取消", async () => {
    const { root, timeline, layout } = await streamingPane();
    act(() => {
      timeline.dispatchEvent(new Event("scroll"));
      FakeResizeObserver.fire(timeline); // 先排入一帧补滚
      timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
      layout.userScrollTo(5180);
      timeline.dispatchEvent(new Event("scroll"));
    });
    await frames(2);
    expect(layout.scrollTop()).toBe(5180);
    layout.setHeight(8000);
    act(() => FakeResizeObserver.fire(timeline));
    await frames(2);
    expect(layout.scrollTop()).toBe(5180);
    act(() => root.unmount());
  });

  it.each([false, true])("工具卡片内部上翻不解除时间线跟随（边缘阻止滚动串联：%s）", async (contain) => {
    const { root, timeline, layout } = await streamingPane();
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    if (contain) inner.style.overscrollBehaviorY = "contain";
    Object.defineProperties(inner, { scrollHeight: { value: 300 }, clientHeight: { value: 100 }, scrollTop: { value: contain ? 0 : 50 } });
    timeline.querySelector(".message:last-of-type")!.appendChild(inner);
    act(() => inner.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true })));
    layout.setHeight(8000);
    act(() => FakeResizeObserver.fire(timeline));
    await frames(2);
    expect(layout.scrollTop()).toBe(7200);
    act(() => root.unmount());
  });

  it.each(["scrollbar", "keyboard", "touch"])("%s 上翻期间异步增高不抢回底部", async (input) => {
    const { root, timeline, layout } = await streamingPane();
    act(() => {
      if (input === "scrollbar") {
        timeline.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: timeline.getBoundingClientRect().right, bubbles: true }));
      } else if (input === "keyboard") {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
      } else {
        for (const [type, y] of [["touchstart", 100], ["touchmove", 200]] as const) {
          const event = new Event(type, { bubbles: true });
          Object.defineProperty(event, "touches", { value: [{ clientY: y }] });
          timeline.dispatchEvent(event);
        }
      }
      layout.userScrollTo(4000);
      timeline.dispatchEvent(new Event("scroll"));
    });
    layout.setHeight(8000);
    act(() => FakeResizeObserver.fire(timeline));
    await frames(2);
    expect(layout.scrollTop()).toBe(4000);
    act(() => root.unmount());
  });

  it("输入框和其他面板的方向键不解除时间线跟随", async () => {
    const { root, timeline, layout } = await streamingPane();
    const textarea = container.querySelector("textarea")!;
    const otherPanel = document.createElement("div");
    document.body.appendChild(otherPanel);
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      otherPanel.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    });
    otherPanel.remove();
    layout.setHeight(8000);
    act(() => FakeResizeObserver.fire(timeline));
    await frames(2);
    expect(layout.scrollTop()).toBe(7200);
    act(() => root.unmount());
  });

  it("直接子节点新增后被观测、移除后停止观测", async () => {
    const { root, timeline } = await streamingPane();
    const child = document.createElement("div");
    timeline.appendChild(child);
    await frames(2);
    expect(FakeResizeObserver.instances.some((observer) => observer.elements.has(child))).toBe(true);
    child.remove();
    await frames(2);
    expect(FakeResizeObserver.instances.every((observer) => !observer.elements.has(child))).toBe(true);
    act(() => root.unmount());
  });

  it("视口尺寸变化同样补滚，多次变化只滚一帧，卸载清理观察器与待执行帧", async () => {
    const { root, timeline, layout } = await streamingPane();
    layout.setViewportHeight(500);
    layout.calls.length = 0;
    act(() => {
      FakeResizeObserver.fire(timeline);
      FakeResizeObserver.fire(timeline);
      FakeResizeObserver.fire(timeline);
    });
    await frames(2);
    expect(layout.calls).toEqual([{ top: 6000, behavior: "auto" }]);
    expect(layout.scrollTop()).toBe(5500);
    act(() => FakeResizeObserver.fire(timeline));
    act(() => root.unmount());
    const count = layout.calls.length;
    await frames(2);
    expect(layout.calls).toHaveLength(count);
    expect(FakeResizeObserver.instances.every((observer) => observer.elements.size === 0)).toBe(true);
  });

});
