// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitWrap, useExitPresence } from "./Presence";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 把 hook 返回值镜像到外部变量的探针组件（无 testing-library 环境下的最小 harness）。 */
let latest: { rendered: boolean; exiting: boolean } | undefined;
function Probe({ open, exitMs }: { open: boolean; exitMs: number }) {
  latest = useExitPresence(open, exitMs);
  return null;
}

function mount(open: boolean, exitMs: number): { rerender: (nextOpen: boolean, ms?: number) => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const paint = (nextOpen: boolean, ms: number) => act(() => { root.render(<Probe open={nextOpen} exitMs={ms} />); });
  paint(open, exitMs);
  return { rerender: (nextOpen: boolean, ms?: number) => paint(nextOpen, ms ?? exitMs) };
}

/** 在 act 内推进 fake timers，让定时器回调里的 setState 同步 flush 渲染。 */
function tick(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms); });
}

describe("useExitPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete document.documentElement.dataset.uiMotion;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders immediately while open", () => {
    const view = mount(true, 160);
    expect(latest).toEqual({ rendered: true, exiting: false });
    view.rerender(true);
    expect(latest?.rendered).toBe(true);
  });

  it("keeps rendering through the exit window, then unmounts", () => {
    const view = mount(true, 160);
    view.rerender(false);
    expect(latest).toEqual({ rendered: true, exiting: true });
    tick(159);
    expect(latest?.rendered).toBe(true);
    tick(1);
    expect(latest).toEqual({ rendered: false, exiting: false });
  });

  it("cancels the pending unmount when reopened during the exit window", () => {
    const view = mount(true, 160);
    view.rerender(false);
    tick(80);
    view.rerender(true);
    tick(1000);
    expect(latest).toEqual({ rendered: true, exiting: false });
  });

  it("unmounts instantly when the motion toggle is off (data-ui-motion=off)", () => {
    document.documentElement.dataset.uiMotion = "off";
    const view = mount(true, 160);
    view.rerender(false);
    tick(0);
    expect(latest).toEqual({ rendered: false, exiting: false });
  });

  it("unmounts instantly when the OS requests reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const view = mount(true, 160);
    view.rerender(false);
    tick(0);
    expect(latest).toEqual({ rendered: false, exiting: false });
    vi.unstubAllGlobals();
  });

  it("unmounts instantly with exitMs 0", () => {
    const view = mount(true, 0);
    view.rerender(false);
    tick(0);
    expect(latest).toEqual({ rendered: false, exiting: false });
  });
});

describe("ExitWrap", () => {
  it("adds the exiting class and inert attribute only while exiting", () => {
    const staticMarkup = renderToStaticMarkup(<ExitWrap exiting={false}><span>子内容</span></ExitWrap>);
    expect(staticMarkup).toContain("ui-presence");
    expect(staticMarkup).not.toContain("is-exiting");
    expect(staticMarkup).not.toContain("inert");

    const exitingMarkup = renderToStaticMarkup(<ExitWrap exiting><span>子内容</span></ExitWrap>);
    expect(exitingMarkup).toContain("ui-presence is-exiting");
    expect(exitingMarkup).toContain("inert");
  });
});
