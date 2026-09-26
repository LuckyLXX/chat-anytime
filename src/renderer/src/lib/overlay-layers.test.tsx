// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { overlayLayersOpen, pushOverlayLayer, subscribeOverlayLayers, useOverlayLayer } from "./overlay-layers";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 全屏弹层计数：右侧预览面板里的内置浏览器是原生 `WebContentsView`，永远浮在
 * 所有 DOM 之上，所以「有弹层打开」必须能让 App 挂起它（`browserSuspended`）。
 * 这里钉住计数语义；「谁登记、谁接进 browserSuspended」的接线在
 * `src/main/overlay-layer-wiring.test.ts`（源码断言，同仓库既有惯例）。
 */
describe("overlayLayers", () => {
  it("计数：开一个为真、关掉归零，release 幂等且不会减成负数", () => {
    expect(overlayLayersOpen()).toBe(false);
    const release = pushOverlayLayer();
    expect(overlayLayersOpen()).toBe(true);
    release();
    release(); // React effect cleanup / 多条关闭路径都可能重复释放
    release();
    expect(overlayLayersOpen()).toBe(false);
  });

  it("嵌套：还留着一层时不能报成「没有弹层」", () => {
    const outer = pushOverlayLayer();
    const inner = pushOverlayLayer();
    expect(overlayLayersOpen()).toBe(true);
    inner();
    expect(overlayLayersOpen()).toBe(true);
    outer();
    expect(overlayLayersOpen()).toBe(false);
  });

  it("订阅只在「有没有弹层」真的翻转时通知（每层进出都通知会让 App 白重渲）", () => {
    let calls = 0;
    const unsubscribe = subscribeOverlayLayers(() => { calls += 1; });
    const first = pushOverlayLayer();
    expect(calls).toBe(1);
    const second = pushOverlayLayer();
    expect(calls).toBe(1); // 仍然「有」，不必通知
    second();
    expect(calls).toBe(1);
    first();
    expect(calls).toBe(2);
    unsubscribe();
    const third = pushOverlayLayer();
    expect(calls).toBe(2); // 退订后不再回调
    third();
  });

  it("useOverlayLayer 随 active 登记与释放，卸载时兜底释放", () => {
    let root: Root | undefined;
    const container = document.createElement("div");
    document.body.appendChild(container);
    function Probe({ active }: { active: boolean }): null {
      useOverlayLayer(active);
      return null;
    }
    act(() => { root = createRoot(container); });
    act(() => { root!.render(<Probe active={false} />); });
    expect(overlayLayersOpen()).toBe(false);
    act(() => { root!.render(<Probe active />); });
    expect(overlayLayersOpen()).toBe(true);
    act(() => { root!.render(<Probe active={false} />); });
    expect(overlayLayersOpen()).toBe(false);
    act(() => { root!.render(<Probe active />); });
    act(() => { root!.unmount(); });
    expect(overlayLayersOpen()).toBe(false);
    container.remove();
  });
});
