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
  scrollTop(): number;
  userScrollTo(top: number): void;
}

const CLIENT_HEIGHT = 800;

function installLayout(element: HTMLElement): Layout {
  let height = 6000;
  let scrollTop = 0;
  const calls: Layout["calls"] = [];
  const maxTop = (): number => Math.max(0, height - CLIENT_HEIGHT);
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => CLIENT_HEIGHT });
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

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  FakeIntersectionObserver.instances = [];
  const host = globalThis as unknown as { ResizeObserver?: unknown; IntersectionObserver?: unknown; window: unknown };
  host.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
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

    layout.userScrollTo(0);
    act(() => {
      timeline.dispatchEvent(new Event("scroll"));
    });
    const before = layout.calls.length;

    layout.setHeight(9000);
    await frames(12);

    expect(layout.calls.length).toBe(before);

    act(() => root.unmount());
  });
});
