import type { WebContents } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATION_TAB_IDLE_MS,
  awaitCondition,
  BrowserAutomationController,
  buildLocateScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
  elementSignature,
  formatSnapshotLine,
  isSideEffectRejection,
  urlPatternMatcher,
  withOpTimeout
} from "./browser-automation.js";
import type { BrowserPreviewController } from "./browser-preview.js";
import type { BrowserAutomationResult } from "../shared/protocol.js";

describe("browser automation url patterns", () => {
  it("treats patterns without glob characters as substring matches", () => {
    const matcher = urlPatternMatcher("dashboard");
    expect(matcher("https://example.com/app/dashboard")).toBe(true);
    expect(matcher("https://example.com/home")).toBe(false);
  });

  it("keeps * within one path segment and lets ** cross segments", () => {
    const single = urlPatternMatcher("https://example.com/*/page");
    expect(single("https://example.com/a/page")).toBe(true);
    expect(single("https://example.com/a/b/page")).toBe(false);

    const multi = urlPatternMatcher("https://example.com/**/page");
    expect(multi("https://example.com/a/page")).toBe(true);
    expect(multi("https://example.com/a/b/page")).toBe(true);
  });

  it("supports ? as a single-character wildcard", () => {
    const matcher = urlPatternMatcher("https://example.com/page?");
    expect(matcher("https://example.com/page1")).toBe(true);
    expect(matcher("https://example.com/page12")).toBe(false);
  });
});

describe("browser automation snapshot formatting", () => {
  const element = {
    tag: "button",
    role: null,
    type: "submit",
    id: "login",
    cls: "primary large",
    name: "登录",
    text: "登录",
    value: null,
    x: 12,
    y: 34
  };

  it("renders a readable ref line", () => {
    expect(formatSnapshotLine(element, 2)).toBe('@e3 <button type="submit"#login.primary.large> "登录"');
  });

  it("drops the type attribute for non-input elements", () => {
    expect(formatSnapshotLine({ ...element, tag: "a", type: null, id: null, cls: null, name: null }, 0))
      .toBe('@e1 <a> "登录"');
  });

  it("falls back to name then value for the label", () => {
    const named = { ...element, text: null, name: "搜索", value: null };
    expect(formatSnapshotLine(named, 0)).toContain('"搜索"');
    const valued = { ...element, text: null, name: null, value: "hello" };
    expect(formatSnapshotLine(valued, 0)).toContain('"hello"');
  });

  it("derives a stable identity signature from every observed attribute", () => {
    const signature = elementSignature(element);
    expect(signature).toContain("button");
    expect(signature).toContain("login");
    expect(elementSignature(element)).toBe(signature);
    expect(elementSignature({ ...element, text: "退出" })).not.toBe(signature);
  });
});

describe("browser automation page scripts", () => {
  it("caps the snapshot element list and carries page text", () => {
    const script = buildSnapshotScript(200, 3000);
    expect(script).toContain("collectInteractiveElements");
    expect(script).toContain("collectPageText");
    expect(script).toContain("truncated");
  });

  it("pierces open shadow roots and same-origin iframes", () => {
    const snapshot = buildSnapshotScript(200, 3000);
    expect(snapshot).toContain("el.shadowRoot");
    expect(snapshot).toContain("contentDocument");
    expect(snapshot).toContain("cross-origin");
    const locate = buildLocateScript(0);
    expect(locate).toContain("frameElement");
    expect(locate).toContain("viewportPosition");
    expect(locate).toContain("hitTest");
  });

  it("locates an element, scrolls it into view, and returns a signature", () => {
    const script = buildLocateScript(3);
    expect(script).toContain("scrollIntoView");
    expect(script).toContain("elementFromPoint");
    expect(script).toContain("signature");
  });

  it("clears inputs via the native setter in fill mode only", () => {
    const fill = buildTypeScript(0, "fill");
    expect(fill).toContain("getOwnPropertyDescriptor");
    expect(fill).toContain("dispatchEvent");
    const append = buildTypeScript(0, "append");
    expect(append).not.toContain("getOwnPropertyDescriptor");
  });

  it("scrolls by delta without a ref and scrolls an element into view with one", () => {
    const page = buildScrollScript("down", 500);
    expect(page).toContain("scrollBy(0, 500)");
    const up = buildScrollScript("up", 500);
    expect(up).toContain("scrollBy(0, -500)");
    const element = buildScrollScript("down", 500, 2);
    expect(element).toContain("scrollIntoView");
  });
});

describe("read-mode side-effect rejection classifier", () => {
  it("recognizes V8 debug-evaluate rejections across message shapes", () => {
    expect(isSideEffectRejection("EvalError: Possible side-effect in debug-evaluate")).toBe(true);
    expect(isSideEffectRejection("EvalError: Possible side effect in debugger evaluate")).toBe(true);
  });

  it("leaves ordinary script errors alone", () => {
    expect(isSideEffectRejection("TypeError: Cannot read properties of null (reading 'x')")).toBe(false);
    expect(isSideEffectRejection("SyntaxError: Unexpected token")).toBe(false);
  });
});

describe("withOpTimeout", () => {
  it("passes through the operation result when it settles in time", async () => {
    const result = await withOpTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  it("rejects with a retryable error and swallows the zombie outcome", async () => {
    let release: (value: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });
    await expect(withOpTimeout(slow, 20)).rejects.toThrow(/超时（0 秒无响应）/);
    release("late");
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("honours a custom timeout message (screenshot capture guidance)", async () => {
    const hanging = new Promise<string>(() => undefined);
    await expect(withOpTimeout(hanging, 20, "截图超时（30 秒未出帧）")).rejects.toThrow("截图超时（30 秒未出帧）");
  });
});

describe("awaitCondition", () => {
  it("resolves true once the predicate flips within the budget", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 30);
    await expect(awaitCondition(() => ready, 1000, 5)).resolves.toBe(true);
  });

  it("resolves false when the budget runs out first", async () => {
    await expect(awaitCondition(() => false, 25, 5)).resolves.toBe(false);
  });
});

// —— 会话销毁释放自动化标签（隐藏 pi-browser-* 标签泄漏治理） ——

interface FakePreview {
  closed: string[];
  rendered: Set<string>;
}

function makeFakePreview(initialTabs: string[]): FakePreview & BrowserPreviewController {
  const tabs = [...initialTabs];
  const closed: string[] = [];
  const rendered = new Set<string>();
  const fakeContents = {
    isDestroyed: () => false,
    debugger: { isAttached: () => false, attach: () => undefined, sendCommand: async () => ({}) }
  };
  const state = () => ({ attached: true, url: "https://example.com/", title: "页", loading: false, canGoBack: false, canGoForward: false });
  const preview: FakePreview & BrowserPreviewController = {
    closed,
    rendered,
    tabIds: () => tabs.filter((id) => !closed.includes(id)),
    foregroundTab: () => tabs[0] ?? "default",
    ensureTab: (id: string) => {
      if (!tabs.includes(id)) tabs.push(id);
    },
    webContentsFor: () => fakeContents as unknown as WebContents,
    snapshot: () => state() as never,
    setAutomating: () => undefined,
    handle: async (command: { type: string; tabId?: string }) => {
      if (command.type === "close" && command.tabId) closed.push(command.tabId);
      return state() as never;
    },
    isTabRendered: (id: string) => rendered.has(id),
    isWindowRenderable: () => true
  } as unknown as FakePreview & BrowserPreviewController;
  return preview;
}

describe("automation tab release on session dispose", () => {
  const controllers: BrowserAutomationController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
  });
  const makeController = (preview: BrowserPreviewController): BrowserAutomationController => {
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return controller;
  };
  const activeTabOf = (result: BrowserAutomationResult): string => {
    if (!result.ok || result.data.kind !== "tabs") throw new Error(`tabs 操作意外失败：${result.ok ? "" : result.error}`);
    return result.data.tabs.find((tab) => tab.active)!.id;
  };

  it("closes the session's bound automation tab but never a user tab", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    // attach 绑前台用户标签 default，tabs new 再建 pi-browser-* 并改绑它。
    const created = activeTabOf(await controller.handle("s1", { op: "tabs", action: "new" }));
    expect(created).toMatch(/^pi-browser-/u);
    controller.releaseSession("s1");
    expect(preview.closed).toEqual([created]);
  });

  it("keeps the bound user tab untouched on release", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    await controller.handle("s1", { op: "attach" });
    controller.releaseSession("s1");
    expect(preview.closed).toEqual([]);
  });

  it("keeps a shared tab until the last bound session goes away", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const tabId = activeTabOf(await controller.handle("s1", { op: "tabs", action: "new" }));
    await controller.handle("s2", { op: "tabs", action: "switch", tabId });
    controller.releaseSession("s1");
    expect(preview.closed).toEqual([]);
    controller.releaseSession("s2");
    expect(preview.closed).toEqual([tabId]);
  });

  it("sweeps orphaned automation tabs only past the idle threshold", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    // 两次 tabs new：第一次的标签被改绑抛弃，成为孤儿。
    const orphan = activeTabOf(await controller.handle("s1", { op: "tabs", action: "new" }));
    const bound = activeTabOf(await controller.handle("s1", { op: "tabs", action: "new" }));
    controller.sweepIdleAutomationTabs();
    expect(preview.closed).toEqual([]);
    controller.sweepIdleAutomationTabs(Date.now() + AUTOMATION_TAB_IDLE_MS + 60_000);
    expect(preview.closed).toEqual([orphan]);
    expect(preview.tabIds()).toContain(bound);
  });

  it("never sweeps the tab the user is currently looking at", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const orphan = activeTabOf(await controller.handle("s1", { op: "tabs", action: "new" }));
    controller.releaseSession("s1");
    preview.closed.length = 0; // 模拟释放时忙锁未关、留给清扫的场景
    preview.rendered.add(orphan);
    controller.sweepIdleAutomationTabs(Date.now() + AUTOMATION_TAB_IDLE_MS + 60_000);
    expect(preview.closed).toEqual([]);
  });
});
