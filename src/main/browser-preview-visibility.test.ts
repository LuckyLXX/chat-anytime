import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 内置浏览器预览标签页的**可见性契约**（2026-09-28 原生视图残留事故的回归网）。
 *
 * 事故：dev 下 Vite 热更新的整页刷新不会跑 React 的 cleanup，主进程那条
 * `visible=true` 就永久留着；而渲染端重建后**不认识**这些标签（bootstrap 不带标签
 * 清单），于是原生 `WebContentsView` 永远浮在窗口最上层遮住界面，只能重启应用
 * （用户实测：点预览按钮只开出空面板）。
 *
 * `browser-preview.ts` 直接持有 `WebContentsView`，原本没有单测（见
 * `tab-hibernation-wiring.test.ts` 的说明）。这里用假 `electron` 注入一个记录
 * `setVisible/setBounds` 的假视图，驱动**真**控制器，把「谁能把视图点亮」这件事
 * 钉成行为断言——比读源码断言更接近真机。
 */

const hoisted = vi.hoisted(() => {
  const views: FakeView[] = [];
  const addChildView = vi.fn();
  const removeChildView = vi.fn();

  class FakeWebContents {
    destroyed = false;
    url = "";
    session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), on: vi.fn() };
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    setWindowOpenHandler = vi.fn();
    setZoomFactor = vi.fn();
    executeJavaScript = vi.fn(async () => [0, 0]);
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    on = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const list = this.listeners.get(channel) ?? [];
      list.push(listener);
      this.listeners.set(channel, list);
    });
    loadURL = vi.fn(async () => undefined);
    isLoading = (): boolean => false;
    isDestroyed = (): boolean => this.destroyed;
    getURL = (): string => this.url;
    getTitle = (): string => "";
    close = (): void => { this.destroyed = true; };
    /** 测试里手动派发一个页面事件（模拟真实导航）。 */
    emit(channel: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(channel) ?? []) listener(...args);
    }
  }

  class FakeView {
    webContents = new FakeWebContents();
    visible = true;
    bounds: { x: number; y: number; width: number; height: number } | undefined;
    setVisibleLog: boolean[] = [];
    constructor() { views.push(this); }
    setBackgroundColor(): void { /* no-op */ }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void { this.bounds = bounds; }
    setVisible(next: boolean): void { this.visible = next; this.setVisibleLog.push(next); }
  }

  return { views, addChildView, removeChildView, FakeView, FakeWebContents };
});

type FakeWebContents = InstanceType<typeof hoisted.FakeWebContents>;
type FakeView = { webContents: FakeWebContents } & {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number } | undefined;
  setVisibleLog: boolean[];
  setBackgroundColor(): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setVisible(next: boolean): void;
};

vi.mock("electron", () => ({
  WebContentsView: hoisted.FakeView,
  shell: { openExternal: vi.fn(async () => undefined) }
}));

const { BrowserPreviewController } = await import("./browser-preview.js");

const RECT = { x: 100, y: 60, width: 480, height: 720 };

function makeController(): InstanceType<typeof BrowserPreviewController> {
  const window = {
    isDestroyed: () => false,
    contentView: { addChildView: hoisted.addChildView, removeChildView: hoisted.removeChildView }
  };
  return new BrowserPreviewController(window as never, vi.fn());
}

/** 模拟一次真实导航（休眠要求标签有可恢复地址）。 */
function landOnPage(view: FakeView, url = "https://example.com/page"): void {
  view.webContents.url = url;
  view.webContents.emit("did-navigate", { preventDefault: vi.fn() }, url);
}

beforeEach(() => {
  hoisted.views.length = 0;
  hoisted.addChildView.mockClear();
  hoisted.removeChildView.mockClear();
});

describe("preview tab visibility contract", () => {
  it("未知标签的 bounds 不建视图、不上屏（首帧 bounds 先于 visible 到达）", async () => {
    const controller = makeController();
    await controller.handle({ type: "bounds", tabId: "t1", bounds: RECT });
    expect(controller.tabIds()).toEqual([]);
    expect(hoisted.views).toHaveLength(0);
    controller.dispose();
  });

  it("bounds → visible:true 的顺序下，视图用暂存的矩形上屏", async () => {
    const controller = makeController();
    await controller.handle({ type: "bounds", tabId: "t1", bounds: RECT });
    await controller.handle({ type: "visible", tabId: "t1", visible: true });
    const view = hoisted.views[0]!;
    expect(controller.tabIds()).toEqual(["t1"]);
    expect(view.bounds).toEqual(RECT);
    expect(view.visible).toBe(true);
    expect(controller.isTabRendered("t1")).toBe(true);
    controller.dispose();
  });

  it("未知标签的 visible:false 不建视图（关标签后渲染端的收尾命令不复活空 webContents）", async () => {
    const controller = makeController();
    await controller.handle({ type: "visible", tabId: "closed-tab", visible: false });
    expect(controller.tabIds()).toEqual([]);
    expect(hoisted.views).toHaveLength(0);
    controller.dispose();
  });

  it("主进程自建的标签默认不可见：单靠 bounds 点不亮它", async () => {
    const controller = makeController();
    controller.ensureTab("ai-tab");
    const view = hoisted.views[0]!;
    expect(view.visible).toBe(false);
    await controller.handle({ type: "bounds", tabId: "ai-tab", bounds: RECT });
    expect(view.visible).toBe(false);
    expect(controller.isTabRendered("ai-tab")).toBe(false);
    await controller.handle({ type: "visible", tabId: "ai-tab", visible: true });
    expect(view.visible).toBe(true);
    controller.dispose();
  });

  it("休眠复位可见性：复活后必须等渲染端重新声明才上屏", async () => {
    const controller = makeController();
    await controller.handle({ type: "bounds", tabId: "t1", bounds: RECT });
    await controller.handle({ type: "visible", tabId: "t1", visible: true });
    landOnPage(hoisted.views[0]!);
    await controller.handle({ type: "visible", tabId: "t1", visible: false });
    expect(controller.hibernateTab("t1")).toBe(true);
    expect(controller.isHibernated("t1")).toBe(true);

    controller.ensureTab("t1"); // AI 显式要这个标签 → 复活
    const revived = hoisted.views[1]!;
    expect(revived.visible).toBe(false);
    await controller.handle({ type: "bounds", tabId: "t1", bounds: RECT });
    expect(revived.visible).toBe(false); // 渲染端还没说「我在看它」
    await controller.handle({ type: "visible", tabId: "t1", visible: true });
    expect(revived.visible).toBe(true);
    controller.dispose();
  });

  it("hideAllViews 摘掉所有视图，且之后的 bounds 不会把它点亮", async () => {
    const controller = makeController();
    for (const tabId of ["a", "b"]) {
      await controller.handle({ type: "bounds", tabId, bounds: RECT });
      await controller.handle({ type: "visible", tabId, visible: true });
    }
    expect(hoisted.views.every((view) => view.visible)).toBe(true);

    controller.hideAllViews();
    expect(hoisted.views.every((view) => !view.visible)).toBe(true);
    expect(controller.isTabRendered("a")).toBe(false);

    await controller.handle({ type: "bounds", tabId: "a", bounds: RECT });
    expect(hoisted.views[0]!.visible).toBe(false);

    await controller.handle({ type: "visible", tabId: "a", visible: true });
    expect(hoisted.views[0]!.visible).toBe(true);
    controller.dispose();
  });

  it("close 真正销毁视图（与「只是隐藏」区分开）", async () => {
    const controller = makeController();
    await controller.handle({ type: "bounds", tabId: "t1", bounds: RECT });
    await controller.handle({ type: "visible", tabId: "t1", visible: true });
    const view = hoisted.views[0]!;
    await controller.handle({ type: "close", tabId: "t1" });
    expect(controller.tabIds()).toEqual([]);
    expect(view.visible).toBe(false);
    expect(view.webContents.destroyed).toBe(true);
    expect(hoisted.removeChildView).toHaveBeenCalledWith(view);
    controller.dispose();
  });
});
