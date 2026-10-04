// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatOverlayEdges, useChatOverlayRegion } from "./chat-overlay-region";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 聊天区遮罩边界（2026-10-04）：会话级确认框只在聊天区内居中的几何基础。
 *
 * 纯函数部分钉住「并集 / 兜底」两条语义；hook 部分钉住「量出来写到根变量、卸载清干净」。
 * 「谁用这些变量」（.modal-backdrop.in-chat / .error-toast）在
 * `src/main/chat-overlay-wiring.test.ts` 里做源码断言。
 */
describe("chatOverlayEdges", () => {
  it("单块会话区：取它的左右边界", () => {
    expect(chatOverlayEdges([{ left: 260, right: 900 }], 1400)).toEqual({ left: 260, right: 900 });
  });

  it("分屏多块：取并集，不是第一块", () => {
    // 设计模式下会话区在右侧；分屏时几块并排 —— 只认第一个会把弹窗偏到左边。
    expect(chatOverlayEdges([{ left: 700, right: 1400 }, { left: 260, right: 700 }], 1400)).toEqual({ left: 260, right: 1400 });
  });

  it("零宽矩形（未布局）不计入，退化成整窗", () => {
    expect(chatOverlayEdges([{ left: 500, right: 500 }], 1200)).toEqual({ left: 0, right: 1200 });
    expect(chatOverlayEdges([], 1200)).toEqual({ left: 0, right: 1200 });
  });

  it("会话区被挤得比弹窗还窄时退回整窗（宁可全窗居中，也不要装不下的窄条）", () => {
    expect(chatOverlayEdges([{ left: 600, right: 700 }], 1200)).toEqual({ left: 0, right: 1200 });
  });

  it("越界值被夹回视口", () => {
    expect(chatOverlayEdges([{ left: -40, right: 2000 }], 1400)).toEqual({ left: 0, right: 1400 });
  });
});

describe("useChatOverlayRegion", () => {
  let container: HTMLDivElement;
  let pane: HTMLDivElement;
  let root: Root | undefined;
  let innerWidth: PropertyDescriptor | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    pane = document.createElement("div");
    pane.dataset.pane = "conversation";
    container.appendChild(pane);
    document.body.appendChild(container);
    // happy-dom 的布局恒为 0：直接给会话区矩形打桩，量测链路才有东西可量。
    pane.getBoundingClientRect = () => ({ left: 300, top: 58, right: 1000, bottom: 800, width: 700, height: 742, x: 300, y: 58, toJSON: () => ({}) }) as DOMRect;
    innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
  });

  afterEach(() => {
    if (root) { const mounted = root; root = undefined; act(() => mounted.unmount()); }
    container.remove();
    if (innerWidth) Object.defineProperty(window, "innerWidth", innerWidth);
    document.documentElement.style.removeProperty("--chat-overlay-left");
    document.documentElement.style.removeProperty("--chat-overlay-right");
    document.documentElement.style.removeProperty("--chat-overlay-width");
    vi.restoreAllMocks();
  });

  function Probe(): null {
    useChatOverlayRegion({ current: container });
    return null;
  }

  it("挂载即量测并写到根变量，卸载清干净", () => {
    const mounted = createRoot(document.createElement("div"));
    root = mounted;
    act(() => { mounted.render(<Probe />); });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--chat-overlay-left")).toBe("300px");
    // right 变量是「距视口右边」的内缩量，不是坐标：1400 - 1000。
    expect(style.getPropertyValue("--chat-overlay-right")).toBe("400px");
    expect(style.getPropertyValue("--chat-overlay-width")).toBe("700px");

    root = undefined;
    act(() => { mounted.unmount(); });
    expect(document.documentElement.style.getPropertyValue("--chat-overlay-left")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--chat-overlay-right")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--chat-overlay-width")).toBe("");
  });

  it("会话区尺寸变化（拖分隔条 / 侧栏折叠）后重新发布", () => {
    const mounted = createRoot(document.createElement("div"));
    root = mounted;
    act(() => { mounted.render(<Probe />); });
    // happy-dom 的 ResizeObserver 是空实现，直接驱动同一条量测路径。
    pane.getBoundingClientRect = () => ({ left: 300, top: 58, right: 700, bottom: 800, width: 400, height: 742, x: 300, y: 58, toJSON: () => ({}) }) as DOMRect;
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(document.documentElement.style.getPropertyValue("--chat-overlay-width")).toBe("400px");
  });
});
