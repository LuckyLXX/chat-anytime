import type { WebContents } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATION_TAB_IDLE_MS,
  awaitCondition,
  MAX_EVAL_RESULT_CHARS,
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
import type { BrowserPreviewController, DownloadInfo } from "./browser-preview.js";
import type { BrowserAutomationResult } from "../shared/protocol.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("automation download receipts", () => {
  const controllers: BrowserAutomationController[] = [];
  const workspaces: string[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
    workspaces.length = 0;
  });
  const makeController = (preview: BrowserPreviewController): BrowserAutomationController => {
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return controller;
  };
  const makeWorkspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pidesktop-dl-"));
    workspaces.push(dir);
    return dir;
  };
  const boundTab = async (controller: BrowserAutomationController, sessionKey = "s1"): Promise<string> => {
    const result = await controller.handle(sessionKey, { op: "tabs", action: "new" });
    if (!result.ok || result.data.kind !== "tabs") throw new Error("tabs new 失败");
    return result.data.tabs.find((tab) => tab.active)!.id;
  };
  const noticesOf = (result: BrowserAutomationResult) => (result.ok ? result.notices ?? [] : []);

  it("cancels downloads until the session navigated with a workspace", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const tabId = await boundTab(controller);
    expect(controller.downloadPolicy(tabId)).toBe("cancel");
    // navigate 没带 workspace（远程 URL）→ 仍然取消，不是静默，而是会回执的取消。
    await controller.handle("s1", { op: "navigate", url: "https://example.com/" });
    expect(controller.downloadPolicy(tabId)).toBe("cancel");
  });

  it("ignores a workspace that does not exist on disk", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace: join(tmpdir(), "pidesktop-missing-ws") });
    expect(controller.downloadPolicy(tabId)).toBe("cancel");
  });

  it("routes downloads into the workspace once navigate carried one", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const workspace = makeWorkspace();
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    const policy = controller.downloadPolicy(tabId);
    expect(policy).not.toBe("cancel");
    expect((policy as { dir: string }).dir.replaceAll("\\", "/")).toBe(`${workspace.replaceAll("\\", "/")}/.pidesktop/downloads`);
  });

  it("never lets a user-only tab (no bound session) see download receipts", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const tabId = await boundTab(controller);
    const workspace = makeWorkspace();
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    controller.releaseSession("s1");
    const download: DownloadInfo = { tabId, filename: "a.csv", url: "https://example.com/a.csv", status: "cancelled" };
    controller.handleDownload(download);
    // 无人绑定的标签页：下载照旧被取消，但不进任何 AI 回执。
    expect(controller.downloadPolicy(tabId)).toBe("cancel");
    const result = await controller.handle("s1", { op: "tabs", action: "list" });
    expect(noticesOf(result)).toEqual([]);
  });

  /**
   * 让下一次操作在执行期间触发给定下载事件：main 侧只在操作执行中收集下载通知，
   * 把假 debugger 命令换成回调就是在测真实时序。
   */
  const downloadDuringNextOp = (preview: BrowserPreviewController, tabId: string, controller: BrowserAutomationController, infos: DownloadInfo[], method = "Runtime.evaluate"): void => {
    const contents = preview.webContentsFor(tabId) as unknown as { debugger: { sendCommand: (method: string) => Promise<unknown> } };
    let fired = false;
    contents.debugger.sendCommand = async (called) => {
      // 只在操作自身的那条 CDP 命令上触发一次：守卫的 Input.setIgnoreInputEvents
      // 发生在回执窗口重置之前，用方法名把它排除掉（那是真实时序，不是要测的东西）。
      if (!fired && called === method) {
        fired = true;
        for (const info of infos) controller.handleDownload(info);
      }
      return { result: { value: 1 } };
    };
  };

  it("attaches a saved download to the operation window and reports its workspace path", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const workspace = makeWorkspace();
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    const filePath = join(workspace, ".pidesktop", "downloads", "a.csv");
    const downloadsDir = join(workspace, ".pidesktop", "downloads");
    downloadDuringNextOp(preview, tabId, controller, [
      { tabId, filename: "a.csv", url: "https://example.com/a.csv", status: "started", filePath, directory: downloadsDir },
      { tabId, filename: "a.csv", url: "https://example.com/a.csv", status: "saved", bytes: 4, filePath, directory: downloadsDir },
      { tabId, filename: "b.csv", url: "https://example.com/b.csv", status: "saved", filePath: join(tmpdir(), "elsewhere", "b.csv") },
      { tabId, filename: "c.csv", url: "https://example.com/c.csv", status: "cancelled", reason: "limit", limitReached: true }
    ]);
    const result = await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    const notices = noticesOf(result);
    expect(notices[0]).toEqual({ kind: "download", filename: "a.csv", url: "https://example.com/a.csv", saved: true, bytes: 4, relativePath: ".pidesktop/downloads/a.csv" });
    // 落在下载目录之外的“已保存”不谎报工作区相对路径（但仍如实告知）。
    expect(notices[1]).toEqual({ kind: "download", filename: "b.csv", url: "https://example.com/b.csv", saved: true });
    expect(notices[2]).toEqual({ kind: "download", filename: "c.csv", url: "https://example.com/c.csv", saved: false, reason: "limit", limitReached: true });
    // 窗口语义：取走即清空（下一次操作不再重复报告）。
    const second = await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    expect(noticesOf(second)).toEqual([]);
  });

  /** started 占位必须被 done 终态**原地替换**（不是追加一条、也不留中间态字段）。 */
  it("upgrades the started placeholder in place when the download finishes", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const workspace = makeWorkspace();
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    const downloadsDir = join(workspace, ".pidesktop", "downloads");
    const filePath = join(downloadsDir, "a.csv");
    downloadDuringNextOp(preview, tabId, controller, [
      { tabId, filename: "a.csv", url: "https://example.com/a.csv", status: "started", filePath, directory: downloadsDir },
      { tabId, filename: "a.csv", url: "https://example.com/a.csv", status: "saved", bytes: 12, filePath, directory: downloadsDir }
    ]);
    const notices = noticesOf(await controller.handle("s1", { op: "eval", expression: "1", mode: "read" }));
    expect(notices).toHaveLength(1);
    // 占位里的 relativePath 保留，终态补上 bytes，且不留 reason 等占位字段。
    expect(notices[0]).toEqual({ kind: "download", filename: "a.csv", url: "https://example.com/a.csv", saved: true, bytes: 12, relativePath: ".pidesktop/downloads/a.csv" });
  });

  /** 下载未在预算内完成：如实说「已开始、结果未知」，不谎报成功也不谎报失败。 */
  it("keeps a still-running download as an honest unknown", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const workspace = makeWorkspace();
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    const downloadsDir = join(workspace, ".pidesktop", "downloads");
    downloadDuringNextOp(preview, tabId, controller, [
      { tabId, filename: "big.zip", url: "https://example.com/big.zip", status: "started", filePath: join(downloadsDir, "big.zip"), directory: downloadsDir }
    ]);
    const notices = noticesOf(await controller.handle("s1", { op: "eval", expression: "1", mode: "read" }));
    expect(notices).toEqual([{ kind: "download", filename: "big.zip", url: "https://example.com/big.zip", saved: false, reason: "interrupted", relativePath: ".pidesktop/downloads/big.zip" }]);
  });

  it("does not report a download that happened outside the current operation window", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const workspace = makeWorkspace();
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    // 无人操作期间发生的下载（例如用户在页面里点了什么、或上个操作的超时僵尸）
    // 不应粘到下一个操作的回执上。
    controller.handleDownload({ tabId, filename: "stale.csv", url: "u", status: "cancelled" });
    const result = await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    expect(noticesOf(result)).toEqual([]);
  });

  it("keeps traffic from other sessions out of the receipt", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const tabId = await boundTab(controller);
    controller.handleDownload({ tabId: "unrelated-tab", filename: "x.csv", url: "u", status: "cancelled" });
    const result = await controller.handle("s1", { op: "tabs", action: "list" });
    expect(noticesOf(result)).toEqual([]);
  });

  it("drops download state when the tab is closed or swept", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const workspace = makeWorkspace();
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    await controller.handle("s1", { op: "tabs", action: "close", tabId });
    expect(controller.downloadPolicy(tabId)).toBe("cancel");
  });
});

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

/**
 * 大 eval 结果的落盘与回执：超限时必须同时给出「总量」与「完整路径」，
 * 落盘失败或无工作区时才降级为纯截断。落盘本身是增强，绝不阻塞 eval。
 */
describe("automation eval result spill", () => {
  const controllers: BrowserAutomationController[] = [];
  const workspaces: string[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
    workspaces.length = 0;
  });
  const makeController = (preview: BrowserPreviewController): BrowserAutomationController => {
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return controller;
  };
  const makeWorkspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pidesktop-evalspill-"));
    workspaces.push(dir);
    return dir;
  };
  /** 让下一次 eval 返回给定长度的字符串（假 debugger 只回一个 value）。 */
  const evalReturns = (preview: BrowserPreviewController, tabId: string, value: unknown): void => {
    const contents = preview.webContentsFor(tabId) as unknown as { debugger: { sendCommand: (method: string) => Promise<unknown> } };
    contents.debugger.sendCommand = async (method) => (method === "Runtime.evaluate" ? { result: { value } } : {});
  };
  const boundTab = async (controller: BrowserAutomationController, sessionKey = "s1"): Promise<string> => {
    const result = await controller.handle(sessionKey, { op: "tabs", action: "new" });
    if (!result.ok || result.data.kind !== "tabs") throw new Error("tabs new 失败");
    return result.data.tabs.find((tab) => tab.active)!.id;
  };
  const evalData = (result: BrowserAutomationResult) => {
    if (!result.ok || result.data.kind !== "eval") throw new Error(`eval 返回了意外结果：${result.ok ? "" : result.error}`);
    return result.data;
  };

  it("leaves a small result byte-identical (no new fields)", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const workspace = makeWorkspace();
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    evalReturns(preview, tabId, 42);
    const data = evalData(await controller.handle("s1", { op: "eval", expression: "42", mode: "read", workspace }));
    expect(data).toEqual({ kind: "eval", value: "42" });
    expect(() => readdirSync(join(workspace, ".pidesktop", "eval"))).toThrow();
  });

  it("spills an oversized result and reports the total size plus the path", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const workspace = makeWorkspace();
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    const rows = Array.from({ length: 2000 }, (_, index) => ({ id: index, name: `item${index}` }));
    evalReturns(preview, tabId, rows);
    const full = JSON.stringify(rows);
    const data = evalData(await controller.handle("s1", { op: "eval", expression: "rows", mode: "read", workspace }));
    expect(data.totalChars).toBe(full.length);
    // 预览 = 前 MAX_EVAL_RESULT_CHARS 字符 + truncate 自带的截断标记。
    expect(data.value.length).toBeGreaterThanOrEqual(MAX_EVAL_RESULT_CHARS);
    expect(data.value.length).toBeLessThan(MAX_EVAL_RESULT_CHARS + 20);
    expect(data.value).toContain("已截断");
    expect(data.savedPath).toMatch(/^\.pidesktop\/eval\/eval-.*\.json$/u);
    // 落盘的必须是**完整**内容（可 JSON.parse），而回执里的只是预览。
    const spilled = readFileSync(join(workspace, ...data.savedPath!.split("/")), "utf8");
    expect(spilled).toBe(full);
    expect(JSON.parse(spilled)).toHaveLength(2000);
  });

  it("degrades to truncation-only without a workspace", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    const tabId = await boundTab(controller);
    evalReturns(preview, tabId, "x".repeat(9000));
    const data = evalData(await controller.handle("s1", { op: "eval", expression: "big", mode: "read" }));
    // 回执里的长度是**序列化后**的字符数（字符串值 JSON 序列化会多一对引号）。
    expect(data.totalChars).toBe(9002);
    expect(data.savedPath).toBeUndefined();
    expect(data.value.length).toBeGreaterThanOrEqual(MAX_EVAL_RESULT_CHARS);
  });

  it("degrades to truncation-only when the spill itself fails", async () => {
    const preview = makeFakePreview(["default"]);
    const controller = makeController(preview);
    // 工作区存在（downloadPolicy 认它），但把文件写盘前的 realpath 目标做成不可写：
    // 用一个同名文件冒充工作区目录，saveBrowserEvalResult 的 mkdir 会失败。
    const workspaceFile = join(tmpdir(), `pidesktop-evalspill-file-${Date.now()}`);
    writeFileSync(workspaceFile, "not a directory");
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace: workspaceFile });
    evalReturns(preview, tabId, "y".repeat(9000));
    const data = evalData(await controller.handle("s1", { op: "eval", expression: "big", mode: "read", workspace: workspaceFile }));
    expect(data.totalChars).toBe(9002);
    expect(data.savedPath).toBeUndefined();
    rmSync(workspaceFile, { force: true });
  });
});
