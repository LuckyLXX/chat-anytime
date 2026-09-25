// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThinkingBlock, TimingMeta } from "./ConversationPane";

/**
 * 计时下沉 + 思考块测量节流的行为契约（2026-09-25 P1）。
 *
 * 背景：时钟原先挂在整格 ConversationPane 上（`useElapsedNow(isGenerating)`），
 * 生成期间整格每 100ms 重渲染一次，与 50ms 的流式帧叠成 ~30 次/秒；ThinkingBlock
 * 的 useLayoutEffect 又对每个流式帧做一次同步 scrollHeight 读取（强制 reflow）。
 * 修法：时钟下沉到真正需要它的叶子组件；思考块测量改「前缘节流 + 尾部补测」。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
});

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("TimingMeta 自持时钟", () => {
  it("还在计时（无 completedAt）时自己推进读数，不依赖父组件重渲染", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<TimingMeta timing={{ startedAt: 0, answerStartedAt: 0 }} />);
    });
    expect(container.textContent).toContain("1.0s");

    tick(100);
    expect(container.textContent).toContain("1.1s");
    tick(100);
    expect(container.textContent).toContain("1.2s");

    act(() => {
      root.unmount();
    });
  });

  it("已定稿（completedAt 存在）时不挂时钟：读数冻结，且不留定时器", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<TimingMeta timing={{ startedAt: 0, completedAt: 500 }} />);
    });
    const before = container.textContent;
    expect(before).toContain("500ms");
    expect(vi.getTimerCount()).toBe(0);

    tick(5000);
    expect(container.textContent).toBe(before);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      root.unmount();
    });
  });
});

describe("ThinkingBlock 测量节流", () => {
  let reads = 0;
  let restore: (() => void)[] = [];

  beforeEach(() => {
    reads = 0;
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { reads += 1; return 100; } });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 10; } });
    restore = [
      () => { if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight); },
      () => { if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight); }
    ];
  });

  afterEach(() => {
    restore.forEach((fn) => fn());
  });

  it("节流窗口内的连续变化只测一次，且尾部补测保证最终状态正确", () => {
    const root = createRoot(container);
    const paint = (text: string) => act(() => { root.render(<ThinkingBlock text={text} label="思考" />); });

    paint("一");
    expect(reads).toBe(1); // 挂载即测（前缘）

    // 流式的 3 帧：都在 200ms 窗口内 → 不该每帧都量
    paint("一二");
    paint("一二三");
    paint("一二三四");
    expect(reads).toBe(1);

    // 尾部补测：窗口一到必须补一次，且结果正确（100 > 10 + 1 → 出展开按钮）
    tick(200);
    expect(reads).toBe(2);
    expect(container.textContent).toContain("展开全文");

    act(() => {
      root.unmount();
    });
  });
});
