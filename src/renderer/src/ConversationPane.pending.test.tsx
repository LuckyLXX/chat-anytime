// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RuntimeSnapshot } from "../../shared/protocol";
import { ConversationPane } from "./ConversationPane";
import { LOCAL_TURN_FALLBACK_MS } from "./lib/local-turn";
import { useDesktopStore } from "./store";

/**
 * 「点发送 → 运行时拒绝」后的界面契约（2026-10-09 用户报告的多会话多开现场）。
 *
 * 现场形状：聊天区底部留着一条 `PendingResponse`（头像 + 「Pi 正在努力输出中……」气泡
 * + 「回答耗时 等待输出 总耗时 6.2s」）—— 那是**本地乐观待回复**，而真正发起它的
 * 那次发送被运行时拒了（所属会话的 jsonl 在点击前后零写入）。过去的清除路径只有
 * `data.busy` 翻转，于是这条假气泡要等到别的事件把 busy 带着翻过来才消失。
 *
 * 这里钉住三件事：① 命令级失败（带本格 sessionId）一到，乐观待回复立刻收起，
 * 并在气泡位置给一条内联失败提示；② 别的会话的失败**不**影响本格；③ 遇到静默失败
 * （不推送任何错误）时，兜底窗口到点也会收起。
 */

const noop = (): void => undefined;

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, uuid: id, role, timestamp: 0, blocks: [{ type: "text", text }] };
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
    messages: [message("u1", "user", "帮我看看这个仓库")],
    executions: [],
    queuedMessages: [],
    backgroundProcesses: [],
    sessions: [],
    recentWorkspaces: [],
    ...overrides
  };
}

let container: HTMLDivElement;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // happy-dom 不实现滚动/观察器；组件挂载时会碰它们（尺寸量测、粘底、窗口化）。
  scrollTo = vi.fn();
  (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  const host = globalThis as unknown as { ResizeObserver?: unknown; IntersectionObserver?: unknown; window: unknown };
  host.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  host.IntersectionObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
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

function render(sessionId: string | undefined): { root: ReturnType<typeof createRoot> } {
  const root = createRoot(container);
  act(() => {
    root.render(
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
  });
  return { root };
}

/** 受控 textarea：走原生 setter + input 事件，再提交表单（与用户回车等价）。 */
async function sendPrompt(text: string): Promise<void> {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("找不到输入框");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function pendingRow(): Element | null {
  return container.querySelector(".pending-response, .response-progress-inline");
}

function notice(): Element | null {
  return container.querySelector(".timeline-notice");
}

describe("发送被运行时拒绝后的乐观待回复", () => {
  it("命令级失败一到：假气泡立刻收起，并在气泡位置给内联提示", async () => {
    const { root } = render("session-a");

    await sendPrompt("拉取这个仓库");
    expect(pendingRow()).not.toBeNull();
    expect(container.textContent).toContain("正在努力输出中");
    expect(notice()).toBeNull();

    act(() => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "error", message: "该会话不在运行中（可能已被回收），请重新打开", sessionId: "session-a" });
    });

    expect(pendingRow()).toBeNull();
    expect(container.textContent).not.toContain("正在努力输出中");
    expect(notice()?.textContent).toContain("该会话不在运行中（可能已被回收），请重新打开");

    act(() => {
      root.unmount();
    });
  });

  it("别的会话的失败不影响本格（乐观待回复仍然在等自己的回合）", async () => {
    const { root } = render("session-a");

    await sendPrompt("拉取这个仓库");
    act(() => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "error", message: "别格被拒", sessionId: "session-b" });
    });

    expect(pendingRow()).not.toBeNull();
    expect(notice()).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("静默失败（不推送任何错误）时，兜底窗口到点也会收起", async () => {
    vi.useFakeTimers();
    const { root } = render("session-a");

    await sendPrompt("拉取这个仓库");
    expect(pendingRow()).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(LOCAL_TURN_FALLBACK_MS);
    });
    expect(pendingRow()).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("提示出现在时间线尾部时要重新粘底（否则它落在可视区外，用户看不到自己刚失败的那条）", async () => {
    const { root } = render("session-a");
    await sendPrompt("拉取这个仓库");
    const before = scrollTo.mock.calls.length;

    act(() => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "error", message: "该会话不在运行中", sessionId: "session-a" });
    });

    expect(notice()).not.toBeNull();
    expect(scrollTo.mock.calls.length).toBeGreaterThan(before);

    act(() => {
      root.unmount();
    });
  });

  it("内联提示可关闭，且不会跨会话残留", async () => {
    const { root } = render("session-a");
    await sendPrompt("拉取这个仓库");
    act(() => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "error", message: "发送失败原因", sessionId: "session-a" });
    });
    expect(notice()).not.toBeNull();

    const dismiss = notice()?.querySelector("button");
    act(() => {
      dismiss?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(notice()).toBeNull();

    // 切到另一格/另一会话：即便失败记录还在 store 里，本格也不再显示
    act(() => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "error", message: "又一次失败", sessionId: "session-a" });
    });
    act(() => {
      useDesktopStore.setState({ snapshot: snapshot({ sessionId: "session-c" }) });
    });
    expect(notice()).toBeNull();

    act(() => {
      root.unmount();
    });
  });
});
