import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_TAB_IDLE_MS,
  armWithTimeout,
  awaitCondition,
  buildElementRectScript,
  CDP_ARM_TIMEOUT_MS,
  DOWNLOAD_START_GRACE_MS,
  needsDownloadStartGrace,
  MAX_EVAL_RESULT_CHARS,
  BrowserAutomationController,
  buildLocateScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
  buildSelectScript,
  classifyUploadFailure,
  elementSignature,
  formatSnapshotLine,
  isSideEffectRejection,
  OBSTRUCTION_PROBE_LIMIT,
  setFileInputFiles,
  UPLOAD_REMOUNT_ATTEMPTS,
  urlPatternMatcher,
  withOpTimeout
} from "./browser-automation.js";
import type { BrowserPreviewController, DownloadInfo } from "./browser-preview.js";
import type { BrowserAutomationResult } from "../shared/protocol.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("marks obstructed elements at the end of the line", () => {
    const line = formatSnapshotLine({ ...element, obstructedBy: "div.modal-mask" }, 0);
    expect(line).toContain("（被 div.modal-mask 遮挡，点击会失败）");
    // 行首必须留给 @eN（模型靠它扫描引用）。
    expect(line.startsWith("@e1 <button")).toBe(true);
  });

  it("keeps an unobstructed line byte-identical to the pre-change format", () => {
    // 防回归：新增字段不得影响普通页面（含显式 null 与缺省两种形态）。
    expect(formatSnapshotLine({ ...element, obstructedBy: null }, 2)).toBe('@e3 <button type="submit"#login.primary.large> "登录"');
    expect(formatSnapshotLine(element, 2)).toBe('@e3 <button type="submit"#login.primary.large> "登录"');
  });

  /**
   * 关键约束回归：遮挡状态绝不能进签名。遮挡随滚动/动画瞬时变化，纳入签名会把
   * 「snapshot 时被遮挡 → 滚动后不再遮挡」判成「页面已变化、引用失效」——比不标注
   * 更糟（一个本可成功的点击被强制重快照）。
   */
  it("never lets obstruction state enter the element signature", () => {
    const clear = { ...element, obstructedBy: null };
    const covered = { ...element, obstructedBy: "div.mask" };
    expect(elementSignature(covered)).toBe(elementSignature(clear));
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

  it("probes obstruction inside the snapshot script itself", () => {
    const script = buildSnapshotScript(200, 3000);
    // 模板拼接漏掉 HIT_TEST_FN 会让整段脚本在页面里 undefined 报错。
    expect(script).toContain("function hitTest(el)");
    expect(script).toContain("obstructedBy");
    expect(script).toContain(`index < ${OBSTRUCTION_PROBE_LIMIT}`);
    expect(script).toContain("el.contains(top)");
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
    isWindowRenderable: () => true,
    // 预置空白文档的等待：测试替身没有真实渲染进程，视为已就绪。
    ensurePageReady: async () => undefined
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
      // 只在操作自身的那条 CDP 命令上触发一次（操作窗口在命令发出前已重置）。
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

/**
 * 页面弹窗自动应答：alert/confirm/beforeunload 会暂停标签页 JS，CDP 求值永不
 * settle——正确行为是自动接受并把内容回传给模型（而不是白等 110s 超时）。
 */
describe("automation dialog auto-answer", () => {
  const controllers: BrowserAutomationController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
  });
  interface FakeDebugger { isAttached: () => boolean; attach: () => void; sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>; on: (event: string, listener: (...args: unknown[]) => void) => void; }
  const debuggerOf = (preview: BrowserPreviewController, tabId: string): FakeDebugger =>
    (preview.webContentsFor(tabId) as unknown as { debugger: FakeDebugger }).debugger;
  /**
   * 单个共享的 contents 替身：`webContentsFor` 必须每次返回**同一个**对象，否则
   * 测试里装的 spy/监听器与控制器内部拿到的不是一份（这条踩过）。
   */
  const makeFake = (): BrowserPreviewController => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const listeners: Array<(...args: unknown[]) => void> = [];
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        sendCommand: async () => ({ result: { value: 1 } }),
        on: (_event: string, listener: (...args: unknown[]) => void) => listeners.push(listener)
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    (preview as unknown as { dialogListeners: unknown[] }).dialogListeners = listeners;
    return preview;
  };
  const listenersOf = (preview: BrowserPreviewController): Array<(...args: unknown[]) => void> =>
    (preview as unknown as { dialogListeners: Array<(...args: unknown[]) => void> }).dialogListeners;
  /**
   * 在当前操作执行期间派发一次弹窗事件（真实时序：事件来自 CDP，不在我们的调用栈里）。
   * 转发必须把参数原样带上——早期版本只转发 method，把后面包上来的 spy 看到成
   * `undefined`，于是测试报「参数丢了」而实际是替身自己吞掉了。
   */
  const dialogDuringNextOp = (preview: BrowserPreviewController, payload: Record<string, unknown>): void => {
    const listeners = listenersOf(preview);
    const contents = preview.webContentsFor("default") as unknown as { debugger: { sendCommand: (...args: unknown[]) => Promise<unknown> } };
    const original = contents.debugger.sendCommand;
    let fired = false;
    contents.debugger.sendCommand = async (...args: unknown[]) => {
      const method = args[0] as string;
      if (!fired && method === "Runtime.evaluate") {
        fired = true;
        for (const listener of listeners) listener({}, "Page.javascriptDialogOpening", payload, "s1");
      }
      return original(...args);
    };
  };
  const newController = (preview: BrowserPreviewController): BrowserAutomationController => {
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return controller;
  };
  const dialogsOf = (result: BrowserAutomationResult) => result.dialogs ?? [];

  it("arms the Page domain once per tab, never per command", async () => {
    const preview = makeFake();
    const controller = newController(preview);
    const calls: string[] = [];
    const contents = preview.webContentsFor("default") as unknown as { debugger: { sendCommand: (method: string) => Promise<unknown> } };
    const original = contents.debugger.sendCommand;
    contents.debugger.sendCommand = async (method: string) => { calls.push(method); return original(method); };
    await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    await controller.handle("s1", { op: "eval", expression: "2", mode: "read" });
    expect(calls.filter((method) => method === "Page.enable")).toHaveLength(1);
    expect(listenersOf(preview)).toHaveLength(1);
  });

  it("auto-accepts a dialog and reports it in the operation receipt", async () => {
    const preview = makeFake();
    const controller = newController(preview);
    const answered: Array<Record<string, unknown>> = [];
    const contents = preview.webContentsFor("default") as unknown as { debugger: { sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown> } };
    const original = contents.debugger.sendCommand;
    contents.debugger.sendCommand = async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.handleJavaScriptDialog") answered.push({ ...(params as Record<string, unknown>) });
      return original(method as never, params as never);
    };
    dialogDuringNextOp(preview, { type: "confirm", message: "确定要删除吗？" });
    const result = await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    expect(answered).toEqual([{ accept: true }]);
    expect(dialogsOf(result)).toEqual([{ type: "confirm", message: "确定要删除吗？", accepted: true }]);
    // 窗口语义：取走即清空（下一次操作不再重复报告）。
    const second = await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    expect(dialogsOf(second)).toEqual([]);
  });

  it("truncates a huge dialog message instead of dumping it into the receipt", async () => {
    const preview = makeFake();
    const controller = newController(preview);
    dialogDuringNextOp(preview, { type: "alert", message: "x".repeat(5000) });
    const dialogs = dialogsOf(await controller.handle("s1", { op: "eval", expression: "1", mode: "read" }));
    expect(dialogs[0]?.message).toHaveLength(200);
  });

  it("ignores unrelated CDP events and malformed payloads", async () => {
    const preview = makeFake();
    const controller = newController(preview);
    dialogDuringNextOp(preview, { type: "alert", message: "real" });
    const listeners = listenersOf(preview);
    for (const listener of listeners) listener({}, "Page.frameNavigated", { frame: {} }, "s1");
    const dialogs = dialogsOf(await controller.handle("s1", { op: "eval", expression: "1", mode: "read" }));
    // 只有真正开过的那个弹窗被记录，且缺 type 时退化为 alert。
    expect(dialogs).toEqual([{ type: "alert", message: "real", accepted: true }]);
  });

  it("keeps dialog records out of unrelated tabs", async () => {
    const preview = makeFake();
    const controller = newController(preview);
    const other = await controller.handle("s2", { op: "tabs", action: "new" });
    if (!other.ok || other.data.kind !== "tabs") throw new Error("tabs new 失败");
    const otherTab = other.data.tabs.find((tab) => tab.active)!.id;
    // s1 绑 default（第一次 eval 时绑过去），s2 绑新建的自动化标签。
    await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    const note = { type: "alert", message: "只属于 default", accepted: true };
    for (const listener of listenersOf(preview)) listener({}, "Page.javascriptDialogOpening", note, "s1");
    const result = await controller.handle("s2", { op: "eval", expression: "1", mode: "read" });
    expect(dialogsOf(result)).toEqual([]);
    expect(otherTab).toMatch(/^pi-browser-/u);
  });

  it("still reports a dialog when the operation itself failed", async () => {
    const preview = makeFake();
    const controller = newController(preview);
    const contents = preview.webContentsFor("default") as unknown as { debugger: { sendCommand: (method: string) => Promise<unknown> } };
    const original = contents.debugger.sendCommand;
    contents.debugger.sendCommand = async (method: string) => {
      if (method === "Runtime.evaluate") {
        for (const listener of listenersOf(preview)) listener({}, "Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, "s1");
        throw new Error("模拟超时");
      }
      return original(method);
    };
    const result = await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    expect(result.ok).toBe(false);
    // 失败回执里的弹窗线报是最有价值的一处：模型能分辨「弹窗阻塞」而不是「页面卡死」。
    expect(dialogsOf(result)).toEqual([{ type: "beforeunload", message: "", accepted: true }]);
  });

  it("drops dialog state when the tab is closed", async () => {
    const preview = makeFake();
    const controller = newController(preview);
    await controller.handle("s1", { op: "tabs", action: "new" });
    const created = preview.tabIds().find((id) => id.startsWith("pi-browser-"))!;
    const note = { type: "alert", message: "残留", accepted: true };
    for (const listener of listenersOf(preview)) listener({}, "Page.javascriptDialogOpening", note, "s1");
    await controller.handle("s1", { op: "tabs", action: "close", tabId: created });
    // 关标签页后再弹窗（残留事件）不产生新记录：该标签的待读队列已随关闭清空。
    for (const listener of listenersOf(preview)) listener({}, "Page.javascriptDialogOpening", note, "s1");
    const result = await controller.handle("s1", { op: "tabs", action: "list" });
    expect(dialogsOf(result)).toEqual([]);
  });

  it("does not let a dialog from outside the operation window leak into the next receipt", async () => {
    const preview = makeFake();
    const controller = newController(preview);
    await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    // 无人操作期间弹的窗（页面自己的定时器定时弹）：照旧会被自动应答，但不粘到
    // 下一个操作的回执上——与下载回执同一窗口语义。
    for (const listener of listenersOf(preview)) listener({}, "Page.javascriptDialogOpening", { type: "alert", message: "空闲期" }, "s1");
    const result = await controller.handle("s1", { op: "eval", expression: "2", mode: "read" });
    expect(dialogsOf(result)).toEqual([]);
  });
});

/**
 * upload 路径：实测（Electron 43）`DOM.setFileInputFiles` 接受 objectId，可跳过
 * 最易失效的 `DOM.requestNode`；降级路径必须先 `DOM.getDocument`（否则 nodeId
 * 恒为 0 → 「Could not find node with given id」）。
 */
describe("automation upload file-input path", () => {
  type Cdp = (method: string, params: Record<string, unknown>) => Promise<unknown>;

  it("uses objectId directly and never touches the DOM domain", async () => {
    const calls: string[] = [];
    const cdp: Cdp = async (method) => { calls.push(method); return {}; };
    await expect(setFileInputFiles(cdp, ["a.txt"], "obj-1")).resolves.toBe("objectId");
    expect(calls).toEqual(["DOM.setFileInputFiles"]);
  });

  it("falls back to requestNode after DOM.getDocument when objectId is rejected", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const cdp: Cdp = async (method, params) => {
      calls.push({ method, params });
      if (method === "DOM.setFileInputFiles" && "objectId" in params) throw new Error("Invalid parameters");
      if (method === "DOM.requestNode") return { nodeId: 7 };
      return {};
    };
    await expect(setFileInputFiles(cdp, ["a.txt"], "obj-1")).resolves.toBe("requestNode");
    expect(calls.map((call) => call.method)).toEqual(["DOM.setFileInputFiles", "DOM.getDocument", "DOM.requestNode", "DOM.setFileInputFiles"]);
    // 关键：降级路径必须先 getDocument，否则 requestNode 返回 nodeId=0（实测）。
    expect(calls[2]!.params).toEqual({ objectId: "obj-1" });
    expect(calls[3]!.params).toEqual({ files: ["a.txt"], nodeId: 7 });
  });

  it("does not retry through requestNode when the target is not a file input", async () => {
    let calls = 0;
    const cdp: Cdp = async (method) => {
      calls += 1;
      if (method === "DOM.setFileInputFiles") throw new Error("Node is not a file input element");
      return {};
    };
    await expect(setFileInputFiles(cdp, ["a.txt"], "btn")).rejects.toThrow(/not a file input/i);
    // 同一节点换路径只会得到同样的错误：不白跑一次 requestNode。
    expect(calls).toBe(1);
  });

  it("gives up when requestNode still yields no usable nodeId", async () => {
    const cdp: Cdp = async (method) => {
      if (method === "DOM.setFileInputFiles") throw new Error("Could not find node with given id");
      if (method === "DOM.requestNode") return { nodeId: 0 };
      return {};
    };
    await expect(setFileInputFiles(cdp, ["a.txt"], "obj")).rejects.toThrow(/Could not find node/);
  });

  it("classifies CDP upload failures into actionable kinds", () => {
    expect(classifyUploadFailure("Node is not a file input element")).toBe("not-file-input");
    expect(classifyUploadFailure("Could not find node with given id")).toBe("stale");
    expect(classifyUploadFailure("Node with given id does not belong to the document")).toBe("stale");
    expect(classifyUploadFailure("something else entirely")).toBe("unknown");
  });

  it("reports both upload preconditions from the locate script", () => {
    const script = buildLocateScript(2);
    expect(script).toContain("isFileInput");
    expect(script).toContain("connected");
  });
});

describe("automation upload remount retry", () => {
  const controllers: BrowserAutomationController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
  });
  interface FakeDebugger { isAttached: () => boolean; attach: () => void; sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>; }
  const URL_UNDER_TEST = "https://example.com/form";
  /**
   * 一个「按脚本内容分流」的假 CDP：快照脚本回一条可签名的元素、定位脚本回给定
   * 的 located、DOM 命令按脚本化结果应答。refs 的签名一致性由真实的
   * elementSignature/formatSnapshotLine 逻辑保证，所以这里测的是真链路。
   */
  const snapshotItem = { tag: "input", role: null, type: "file", id: "f", cls: null, name: null, text: null, value: null, checked: null, selected: null, expanded: null, href: null, x: 10, y: 20 };
  const makeHarness = (options: { locate: (attempt: number) => Record<string, unknown>; setFiles: (attempt: number) => "ok" | Error }) => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const contents = {
      isDestroyed: () => false,
      debugger: { isAttached: () => false, attach: () => undefined, sendCommand: async () => ({}) }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    (preview as unknown as { snapshot: () => unknown }).snapshot = () => ({ url: URL_UNDER_TEST, title: "表单" });
    let locateAttempts = 0;
    let setAttempts = 0;
    const methods: string[] = [];
    (contents as unknown as { debugger: FakeDebugger }).debugger.sendCommand = async (method, params) => {
      methods.push(method);
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes("collectInteractiveElements") && expression.includes("pageText")) {
          return { result: { value: { url: URL_UNDER_TEST, title: "表单", pageText: "", items: [snapshotItem], truncated: false } } };
        }
        if (params?.returnByValue === false) return { result: { objectId: `obj-${locateAttempts || 1}` } };
        locateAttempts += 1;
        return { result: { value: { ok: true, x: 10, y: 20, signature: elementSignature(snapshotItem), description: "input#f", isFileInput: true, connected: true, ...options.locate(locateAttempts) } } };
      }
      if (method === "DOM.setFileInputFiles") {
        setAttempts += 1;
        const outcome = options.setFiles(setAttempts);
        if (outcome instanceof Error) throw outcome;
        return {};
      }
      return {};
    };
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return { controller, methods, attempts: () => ({ locate: locateAttempts, set: setAttempts }) };
  };
  const uploadFile = (): string => {
    const file = join(tmpdir(), `pidesktop-upload-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    writeFileSync(file, "payload");
    return file;
  };

  it("retries the whole chain once when the control was remounted", async () => {
    const harness = makeHarness({
      // 第一次定位到的是已卸载的旧节点（瞬态控件刚被替换）
      locate: (attempt) => (attempt === 1 ? { connected: false } : {}),
      setFiles: () => "ok"
    });
    await harness.controller.handle("s1", { op: "snapshot" });
    const result = await harness.controller.handle("s1", { op: "upload", ref: "@e1", files: [uploadFile()] });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.kind !== "upload") throw new Error("upload 返回了意外结果");
    expect(result.data.description).toContain("input#f");
    // 控件被重新挂载 → 必须重新走一遍定位，并在回执里如实说明重试过。
    expect(result.data.description).toContain("已重试一次");
    expect(harness.attempts().locate).toBe(2);
  });

  it("retries once when setFileInputFiles reports a stale node", async () => {
    const harness = makeHarness({
      locate: () => ({}),
      setFiles: (attempt) => (attempt === 1 ? new Error("Could not find node with given id") : "ok")
    });
    await harness.controller.handle("s1", { op: "snapshot" });
    const result = await harness.controller.handle("s1", { op: "upload", ref: "@e1", files: [uploadFile()] });
    expect(result.ok).toBe(true);
    expect(harness.attempts().set).toBe(2);
  });

  it("gives up after the retry budget instead of looping forever", async () => {
    const harness = makeHarness({
      locate: () => ({}),
      setFiles: () => new Error("Could not find node with given id")
    });
    await harness.controller.handle("s1", { op: "snapshot" });
    const result = await harness.controller.handle("s1", { op: "upload", ref: "@e1", files: [uploadFile()] });
    expect(result.ok).toBe(false);
    // 上限 1 次重试（共 2 次尝试），不会变成无限循环。
    expect(harness.attempts().set).toBe(UPLOAD_REMOUNT_ATTEMPTS + 1);
  });

  it("refuses a ref that is not a file input, with the element named", async () => {
    const harness = makeHarness({
      locate: () => ({ isFileInput: false, description: "button#go" }),
      setFiles: () => "ok"
    });
    await harness.controller.handle("s1", { op: "snapshot" });
    const result = await harness.controller.handle("s1", { op: "upload", ref: "@e1", files: [uploadFile()] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("预期失败");
    expect(result.error).toContain("不是文件上传控件");
    expect(result.error).toContain("button#go");
    // 判据在定位阶段就成立：不该白跑一次 setFileInputFiles。
    expect(harness.attempts().set).toBe(0);
  });
});

// —— 元素截图（clip 路径）与 arming 超时容错（2026-09-15 P0+P1） ——

describe("armWithTimeout", () => {
  it("resolves ok when the cdp call settles in time", async () => {
    await expect(armWithTimeout(Promise.resolve({}), 50)).resolves.toBe("ok");
  });

  it("resolves timeout when the cdp call never settles, and swallows the late rejection", async () => {
    let rejectLate!: (reason: Error) => void;
    const never = new Promise<unknown>((_resolve, reject) => { rejectLate = reject; });
    await expect(armWithTimeout(never, 25)).resolves.toBe("timeout");
    // 晚到的拒绝不允许变成 unhandled rejection。
    rejectLate(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("propagates rejections so callers can distinguish unsupported targets", async () => {
    await expect(armWithTimeout(Promise.reject(new Error("not supported")), 50)).rejects.toThrow("not supported");
  });
});

describe("browser automation element screenshots", () => {
  const controllers: BrowserAutomationController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
  });

  it("builds a locator script that deep-queries a selector and reports document coordinates", () => {
    const script = buildElementRectScript(undefined, 'div[data-name="S1"]');
    expect(script).toContain("queryDeep");
    expect(script).toContain('div[data-name=');
    expect(script).toContain("scrollIntoView");
    expect(script).toContain("window.scrollX");
    expect(script).toContain("选择器未命中任何元素");
  });

  it("builds a locator script from a snapshot ref index", () => {
    const script = buildElementRectScript("@e2", undefined, 1);
    expect(script).toContain("collectInteractiveElements");
    expect(script).toContain("元素不存在（页面可能已变化，请重新 browser_snapshot）");
  });

  interface ShotHarness {
    controller: BrowserAutomationController;
    captured: Array<Record<string, unknown>>;
  }
  const makeShotHarness = (rect: Record<string, unknown>): ShotHarness => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    preview.rendered.add("default");
    const captured: Array<Record<string, unknown>> = [];
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            if (expression.includes("scrollIntoView")) return { result: { value: rect } };
            return { result: { value: { width: 1000, height: 800 } } };
          }
          if (method === "Page.captureScreenshot") {
            captured.push(params ?? {});
            return { data: "iVBORw0KGgo=" };
          }
          return {};
        },
        on: () => undefined
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return { controller, captured };
  };

  it("clips the capture to the element rect with scale folded into clip.scale", async () => {
    const harness = makeShotHarness({ ok: true, x: 80, y: 96, width: 390, height: 1300 });
    const result = await harness.controller.handle("s1", { op: "screenshot", selector: 'div[data-name^="S1"]', scale: 2 });
    expect(result.ok).toBe(true);
    const params = harness.captured[0]!;
    expect(params.clip).toEqual({ x: 80, y: 96, width: 390, height: 1300, scale: 2 });
    expect(params.captureBeyondViewport).toBe(true);
    // clip 模式下缩放由 clip.scale 承担，顶层 scale 不叠加。
    expect(params.scale).toBeUndefined();
    expect(params.fromSurface).toBe(true);
    if (result.ok && result.data.kind === "screenshot") {
      expect(result.data.width).toBe(780);
      expect(result.data.height).toBe(2600);
    }
  });

  it("reports a missing selector target as an actionable error", async () => {
    const harness = makeShotHarness({ ok: false, error: "选择器未命中任何元素：.gone" });
    const result = await harness.controller.handle("s1", { op: "screenshot", selector: ".gone" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("选择器未命中");
  });

  it("rejects an invalid ref before touching the page", async () => {
    const harness = makeShotHarness({ ok: true, x: 0, y: 0, width: 1, height: 1 });
    const result = await harness.controller.handle("s1", { op: "screenshot", ref: "@zero" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("无效的元素引用");
    expect(harness.captured).toHaveLength(0);
  });

  it("keeps viewport screenshots free of clip parameters", async () => {
    const harness = makeShotHarness({ ok: true, x: 0, y: 0, width: 1, height: 1 });
    const result = await harness.controller.handle("s1", { op: "screenshot" });
    expect(result.ok).toBe(true);
    const params = harness.captured[0]!;
    expect(params.clip).toBeUndefined();
    expect(params.captureBeyondViewport).toBeUndefined();
  });
});

describe("arming never waits for CDP calls that may never answer", () => {
  const controllers: BrowserAutomationController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
    vi.useRealTimers();
  });

  /**
   * 复现 2026-09-16 事故（P0）：`Page.enable` 在**从未导航过的** renderer 上永不
   * 回包（真 Electron 探针实测：Page.enable / Runtime.enable / Runtime.evaluate /
   * DOM.enable / DOM.getDocument / Accessibility.enable 全部挂住）。旧实现 await 它，
   * 于是「自动化刚建出来的标签页上的第一个操作」直接挂到 110s 看门狗——真实会话
   * browser_navigate 就是这样超时的（审计里 09-14、09-15、09-16 五次全是首次操作）。
   *
   * 现在监听是同步挂的，`Page.enable` 只发不等：整个 handle() 必须在**没有任何
   * 计时器推进**的情况下立即返回。
   */
  it("returns immediately without waiting for a Page.enable that never answers", async () => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const sent: string[] = [];
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        sendCommand: (method: string) => {
          sent.push(method);
          // 无文档 renderer 的真实行为：既不回包也不抛错。
          return method === "Page.enable" ? new Promise(() => undefined) : Promise.resolve({ result: { value: 1 } });
        },
        on: () => undefined
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    // 不用 fake timers、不推进任何时间：还有等待就一定不会 settle。
    const result = await controller.handle("s1", { op: "tabs", action: "list" });
    expect(result.ok).toBe(true);
    if (result.ok && result.data.kind === "tabs") {
      expect(result.data.tabs.map((tab) => tab.id)).toEqual(["default"]);
    }
    // Page.enable 确实发出去了（文档就绪后会生效），只是没人等它。
    expect(sent).toContain("Page.enable");
  });

  it("sends Page.enable once per tab, and re-arms it after a real navigation", async () => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const sendCounts: Record<string, number> = {};
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        sendCommand: (method: string) => {
          sendCounts[method] = (sendCounts[method] ?? 0) + 1;
          return Promise.resolve({ result: { value: 1 } });
        },
        on: () => undefined
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    await controller.handle("s1", { op: "tabs", action: "list" });
    await controller.handle("s1", { op: "tabs", action: "list" });
    // 同一个标签页不重复发（每条命令都 Page.enable 是旧版踩过的坑）。
    expect(sendCounts["Page.enable"]).toBe(1);
    // 导航成功后重新武装：上一次导航可能发生在 renderer 冻死/无文档时，那次命令会被丢弃。
    await controller.handle("s1", { op: "navigate", url: "https://example.com/" });
    expect(sendCounts["Page.enable"]).toBe(2);
  });

  it("never registers two Page listeners for one tab", async () => {
    // 监听器挂两遍会让每个弹窗被应答两次（重复 handleJavaScriptDialog）。
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const listeners: Array<(...args: unknown[]) => void> = [];
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        sendCommand: async () => ({ result: { value: 1 } }),
        on: (_event: string, listener: (...args: unknown[]) => void) => listeners.push(listener)
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/" });
    await controller.handle("s1", { op: "navigate", url: "https://example.com/next" });
    await controller.handle("s1", { op: "tabs", action: "list" });
    expect(listeners).toHaveLength(1);
  });

  it("never blocks a pure-memory op on the page being ready", async () => {
    // 2026-09-15 事故：tabs(list) 这种纯内存操作因为绑到了还没准备好的标签页而白等
    // 到看门狗。这里让 ensurePageReady 永不返回：tabs(list)/attach/读标签地址必须
    // 仍然立即完成（它们由主进程状态回答，不碰页面）。
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    (preview as unknown as { ensurePageReady: () => Promise<void> }).ensurePageReady = () => new Promise(() => undefined);
    (preview as unknown as { webContentsFor: () => unknown }).webContentsFor = () => ({
      isDestroyed: () => false,
      getURL: () => "https://example.com/",
      getTitle: () => "页",
      debugger: { isAttached: () => false, attach: () => undefined, sendCommand: async () => ({ result: { value: 1 } }), on: () => undefined }
    });
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    const tabs = await controller.handle("s1", { op: "tabs", action: "list" });
    expect(tabs.ok).toBe(true);
    const attach = await controller.handle("s2", { op: "attach" });
    expect(attach.ok).toBe(true);
    const getUrl = await controller.handle("s1", { op: "get", what: "url" });
    expect(getUrl.ok).toBe(true);
    if (getUrl.ok && getUrl.data.kind === "get") expect(getUrl.data.value).toBe("https://example.com/");
  });

  it("still gates page-touching ops on the page being ready", async () => {
    // 反向保证：上面的「不过关」不能扩成「全都不过关」——页面类操作必须等待，
    // 否则又会回到「CDP 命令永不回包」的 110s 挂起。
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    let called = 0;
    (preview as unknown as { ensurePageReady: () => Promise<void> }).ensurePageReady = async () => { called += 1; };
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    await controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    expect(called).toBe(1);
    await controller.handle("s1", { op: "get", what: "text" });
    expect(called).toBe(2);
  });
});

/**
 * T2 回归网（2026-09-17）：`Input.setIgnoreInputEvents` 守卫已删除。
 *
 * 历史：守卫本意是「AI 操作期间忽略真人输入」，实际效果是 **CDP 合成的鼠标事件
 * 在渲染器侧完全不派发**——browser_click 回执说成功、页面 onclick 不动、下载不
 * 发生（T2，P0）。真机探针（2026-09 三组，环境归一化后 3×3 对照）实测：
 * 守卫 ON 时 0/3 次点击落点，守卫 OFF 时 3/3 落点；删除守卫后点击与下载都恢复。
 *
 * 这条测试用「记录 sendCommand 方法名」的替身跑真实操作，断言整套输入路径
 * 再也不会发出该命令（防回归：任何未来重新引入守卫的改动都会在这里转红），
 * 并同时断言点击的三个鼠标事件按序派发（mouseMoved → mousePressed → mouseReleased）。
 */
describe("input guard removal (T2 regression)", () => {
  const controllers: BrowserAutomationController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
  });

  interface RecorderHarness {
    controller: BrowserAutomationController;
    methods: string[];
    mouseEvents: Array<Record<string, unknown>>;
    keyEvents: Array<Record<string, unknown>>;
  }

  /**
   * 记录型替身：按脚本内容分流 evaluate（snapshot / locate / type / select），
   * 其余 CDP 方法只记名字并返回空结果。签名用真实的 elementSignature 生成，
   * 所以走的是真链路（verifyRef 是同一份逻辑）。
   */
  const makeRecorder = (): RecorderHarness => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const methods: string[] = [];
    const mouseEvents: Array<Record<string, unknown>> = [];
    const keyEvents: Array<Record<string, unknown>> = [];
    const item = { tag: "button", role: null, type: null, id: "go", cls: null, name: null, text: "点我", value: null, checked: null, selected: null, expanded: null, href: null, x: 10, y: 20 };
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        on: () => undefined,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          methods.push(method);
          if (method === "Input.dispatchMouseEvent") mouseEvents.push({ ...(params as Record<string, unknown>) });
          if (method === "Input.dispatchKeyEvent") keyEvents.push({ ...(params as Record<string, unknown>) });
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            if (expression.includes("collectInteractiveElements") && expression.includes("pageText")) {
              return { result: { value: { url: "https://example.com/", title: "页", pageText: "", items: [item], truncated: false } } };
            }
            if (expression.includes("scrollIntoView")) {
              return { result: { value: { ok: true, x: 10, y: 20, signature: elementSignature(item), description: "button#go", isFileInput: false, connected: true } } };
            }
            return { result: { value: { ok: true, x: 10, y: 20, signature: elementSignature(item), description: "button#go", cleared: true } } };
          }
          return {};
        }
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return { controller, methods, mouseEvents, keyEvents };
  };

  it("never sends Input.setIgnoreInputEvents for click / type / press / eval / snapshot", async () => {
    const harness = makeRecorder();
    await harness.controller.handle("s1", { op: "snapshot" });
    await harness.controller.handle("s1", { op: "click", ref: "@e1" });
    await harness.controller.handle("s1", { op: "type", ref: "@e1", text: "hi", mode: "fill" });
    await harness.controller.handle("s1", { op: "press", key: "Enter" });
    await harness.controller.handle("s1", { op: "eval", expression: "1", mode: "read" });
    expect(harness.methods).not.toContain("Input.setIgnoreInputEvents");
    // 顺带保证替身确实跑到了输入路径（否则这条断言可能是空转）。
    expect(harness.mouseEvents.length).toBeGreaterThanOrEqual(3);
    expect(harness.methods).toContain("Input.insertText");
  });

  it("dispatches the three mouse events in order for one click", async () => {
    const harness = makeRecorder();
    await harness.controller.handle("s1", { op: "snapshot" });
    const result = await harness.controller.handle("s1", { op: "click", ref: "@e1" });
    expect(result.ok).toBe(true);
    expect(harness.mouseEvents.map((event) => event.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    // 坐标来自 locate（视口中心），三个事件必须落在同一坐标（否则 Chromium 会
    // 视为「按在别处、松在别处」，真实页面里通常表现为点击丢失）。
    for (const event of harness.mouseEvents) {
      expect(event.x).toBe(10);
      expect(event.y).toBe(20);
    }
  });
});

/**
 * press 发法（2026-09-17 真机定案）：`rawKeyDown → char? → keyUp`。
 *
 * 旧实现只发 keyDown/keyUp 且不带 `text`——实测（真 Electron + 真 CDP + 本地 http）
 * 结果是「有 keydown/keyup 事件、但默认行为不发生」：`<input>` 里 Enter 不提交表单、
 * `<textarea>` 里不换行。本项是「输提示词 → 回车发送」链路的最后一环。
 */
describe("press key dispatch semantics", () => {
  const controllers: BrowserAutomationController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
  });

  const makePressHarness = () => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const events: Array<Record<string, unknown>> = [];
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        on: () => undefined,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          if (method === "Input.dispatchKeyEvent" || method === "Input.insertText") events.push({ method, ...(params as Record<string, unknown>) });
          return { result: { value: 1 } };
        }
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return { controller, events };
  };

  it("sends Enter as rawKeyDown + char(CR) + keyUp (default action fires, no double text)", async () => {
    const harness = makePressHarness();
    await harness.controller.handle("s1", { op: "press", key: "Enter" });
    expect(harness.events.map((event) => event.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
    const [down, char, up] = harness.events;
    // 只有 char 事件带 text：同时在 keyDown 与 char 给 text 会让表单提交两次（实测）。
    expect(down!.text).toBeUndefined();
    expect(char!.text).toBe("\r");
    expect(char!.unmodifiedText).toBe("\r");
    expect(up!.text).toBeUndefined();
    for (const event of harness.events) {
      expect(event.key).toBe("Enter");
      expect(event.code).toBe("Enter");
      expect(event.windowsVirtualKeyCode).toBe(13);
      expect(event.nativeVirtualKeyCode).toBe(13);
    }
  });

  it("sends Space with a literal space and Tab with a tab character", async () => {
    const harness = makePressHarness();
    await harness.controller.handle("s1", { op: "press", key: "Space" });
    expect(harness.events.find((event) => event.type === "char")?.text).toBe(" ");
    harness.events.length = 0;
    await harness.controller.handle("s1", { op: "press", key: "Tab" });
    // Tab 也不带 text 不会移动焦点？——真实键盘的 Tab 带制表符风格 text，
    // Chromium 在 input 内不会把制表符写进 value（探针实测），但焦点前移依赖 keydown。
    expect(harness.events.map((event) => event.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
    expect(harness.events.find((event) => event.type === "char")?.text).toBe("\t");
  });

  it("keeps non-text keys as rawKeyDown + keyUp without a char event", async () => {
    const harness = makePressHarness();
    await harness.controller.handle("s1", { op: "press", key: "Escape" });
    expect(harness.events.map((event) => event.type)).toEqual(["rawKeyDown", "keyUp"]);
    expect(harness.events.every((event) => event.text === undefined)).toBe(true);
  });

  it("names the cardinal arrow keys with their real key/code", async () => {
    const harness = makePressHarness();
    await harness.controller.handle("s1", { op: "press", key: "ArrowDown" });
    expect(harness.events[0]!.key).toBe("ArrowDown");
    expect(harness.events[0]!.code).toBe("ArrowDown");
    expect(harness.events[0]!.windowsVirtualKeyCode).toBe(40);
  });

  it("falls back to insertText for a plain character", async () => {
    const harness = makePressHarness();
    await harness.controller.handle("s1", { op: "press", key: "x" });
    expect(harness.events).toEqual([{ method: "Input.insertText", text: "x" }]);
  });
});

/**
 * 签名采集顺序回归（2026-09-17，探针实测的既有缺陷）：
 * fill 清空 / select 改值必须发生在**签名采集之后**，否则与快照比对必然失配，
 * 模型被告知「引用失效」而操作其实已经生效。
 */
describe("type/select capture the signature before mutating the value", () => {
  it("buildTypeScript computes the signature before the fill-clear block", () => {
    const script = buildTypeScript(0, "fill");
    const signatureAt = script.indexOf("const signature = ");
    const clearAt = script.indexOf("const setter = Object.getOwnPropertyDescriptor");
    expect(signatureAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(-1);
    // 关键次序：签名先于清空（同一脚本里的文本位置即执行顺序）。
    expect(signatureAt).toBeLessThan(clearAt);
    // description 也必须采在清空前（清空会改 value，DESCRIBE_EL 含值）。
    expect(script.indexOf("const description = ")).toBeLessThan(clearAt);
  });

  it("buildTypeScript append mode still captures the signature first", () => {
    const script = buildTypeScript(0, "append");
    // 只看返回对象之前的那段（COLLECT_CORE/REVEAL_FN 等注入的辅助代码里也有同名属性）。
    const returnAt = script.indexOf("return { ok: true, cleared");
    const sigAt = script.indexOf("const signature = ");
    expect(sigAt).toBeGreaterThan(-1);
    expect(sigAt).toBeLessThan(returnAt);
    // append 模式没有清空块，不能残留 getOwnPropertyDescriptor。
    expect(script).not.toContain("getOwnPropertyDescriptor");
  });

  it("buildSelectScript captures the signature before setting the value", () => {
    const script = buildSelectScript(0, ["red"]);
    const signatureAt = script.indexOf("const signature = ");
    const assignAt = script.indexOf("el.value = next");
    const multiAt = script.indexOf("option.selected = wanted.includes");
    expect(signatureAt).toBeGreaterThan(-1);
    expect(signatureAt).toBeLessThan(assignAt);
    expect(signatureAt).toBeLessThan(multiAt);
    // 返回的对象里不能现场重算签名（那正是旧缺陷）。
    expect(script).toContain("return { ok: true, signature, description };");
  });
});

/**
 * 下载回执的「等下载开始」宽限（2026-09-17 真机实测新增；用户决策）。
 * click/press 后在宽限期内轮询下载事件：出现就等它落盘（回执带路径），
 * 没出现就立即返回——不把异步事件与回执的 4–60ms 竞态留给模型去猜。
 */
describe("download start grace after click/press", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "pidesktop-grace-"));
    workspaces.push(dir);
    return dir;
  };
  const boundTab = async (controller: BrowserAutomationController, sessionKey = "s1"): Promise<string> => {
    const result = await controller.handle(sessionKey, { op: "tabs", action: "new" });
    if (!result.ok || result.data.kind !== "tabs") throw new Error("tabs new 失败");
    return result.data.tabs.find((tab) => tab.active)!.id;
  };
  const noticesOf = (result: BrowserAutomationResult) => (result.ok ? result.notices ?? [] : []);

  /** 装一个「可点击元素」页面替身，返回控制下载事件时序的钩子。 */
  const clickablePreview = () => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const item = { tag: "a", role: null, type: null, id: "dl", cls: null, name: null, text: "下载", value: null, checked: null, selected: null, expanded: null, href: "https://example.com/late.png", x: 1, y: 1 };
    const contents: { isDestroyed: () => boolean; debugger: { isAttached: () => boolean; attach: () => void; on: () => void; sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown> } } = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        on: () => undefined,
        sendCommand: async (method, params) => {
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            if (expression.includes("collectInteractiveElements") && expression.includes("pageText")) {
              return { result: { value: { url: "https://example.com/", title: "页", pageText: "", items: [item], truncated: false } } };
            }
            return { result: { value: { ok: true, x: 1, y: 1, signature: elementSignature(item), description: "a#dl" } } };
          }
          return {};
        }
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    // 生产语义：awaitDownloadsSettled 轮询到 done 事件为止（fake preview 缺这个
    // 方法时 handle() 会跳过它，本测试必须补上，否则回执停在 started 占位态）。
    let running = 0;
    (preview as unknown as { awaitDownloadsSettled: (id: string) => Promise<void> }).awaitDownloadsSettled = async () => {
      const deadline = Date.now() + 2_000;
      while (running > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    /** 让「下一次 mouseReleased」之后 delayMs 派发一次下载事件（真实时序：操作返回后才有 will-download）。 */
    const scheduleDownloadAfterClick = (controller: BrowserAutomationController, tabId: string, filePath: string, directory: string, delayMs = 30) => {
      const original = contents.debugger.sendCommand;
      contents.debugger.sendCommand = async (method, params) => {
        const result = await original(method, params);
        if (method === "Input.dispatchMouseEvent" && (params as { type?: string })?.type === "mouseReleased") {
          running += 1;
          setTimeout(() => controller.handleDownload({ tabId, filename: "late.png", url: "https://example.com/late.png", status: "started", filePath, directory }), delayMs);
          setTimeout(() => {
            controller.handleDownload({ tabId, filename: "late.png", url: "https://example.com/late.png", status: "saved", bytes: 7, filePath, directory });
            running -= 1;
          }, delayMs + 60);
        }
        return result;
      };
    };
    return { preview, scheduleDownloadAfterClick };
  };

  it("waits for a download that starts shortly AFTER a click returns, then reports it", async () => {
    const { preview, scheduleDownloadAfterClick } = clickablePreview();
    const workspace = makeWorkspace();
    const downloadsDir = join(workspace, ".pidesktop", "downloads");
    const controller = makeController(preview);
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    await controller.handle("s1", { op: "snapshot" });
    scheduleDownloadAfterClick(controller, tabId, join(downloadsDir, "late.png"), downloadsDir, 30);
    const result = await controller.handle("s1", { op: "click", ref: "@e1" });
    expect(noticesOf(result)).toEqual([
      { kind: "download", filename: "late.png", url: "https://example.com/late.png", saved: true, bytes: 7, relativePath: ".pidesktop/downloads/late.png" }
    ]);
  });

  it("reports the started placeholder honestly when the download is still in flight", async () => {
    const { preview, scheduleDownloadAfterClick } = clickablePreview();
    const workspace = makeWorkspace();
    const downloadsDir = join(workspace, ".pidesktop", "downloads");
    const controller = makeController(preview);
    const tabId = await boundTab(controller);
    await controller.handle("s1", { op: "navigate", url: "https://example.com/", workspace });
    await controller.handle("s1", { op: "snapshot" });
    // 只派发 started（done 永不到）：宽限要抓得住它；落盘等待预算（fake 里 2s，
    // 生产 3s）内没完成则如实报「已开始、结果未知」而不是谎报成功或失败。
    const original = (preview.webContentsFor(tabId) as unknown as { debugger: { sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown> } }).debugger.sendCommand;
    (preview.webContentsFor(tabId) as unknown as { debugger: { sendCommand: unknown } }).debugger.sendCommand = async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params);
      if (method === "Input.dispatchMouseEvent" && (params as { type?: string })?.type === "mouseReleased") {
        setTimeout(() => controller.handleDownload({ tabId, filename: "late.png", url: "https://example.com/late.png", status: "started", filePath: join(downloadsDir, "late.png"), directory: downloadsDir }), 20);
      }
      return result;
    };
    const result = await controller.handle("s1", { op: "click", ref: "@e1" });
    expect(noticesOf(result)).toEqual([
      { kind: "download", filename: "late.png", url: "https://example.com/late.png", saved: false, reason: "interrupted", relativePath: ".pidesktop/downloads/late.png" }
    ]);
  }, 10_000);

  it("returns immediately when a click triggers no download", async () => {
    const { preview } = clickablePreview();
    const controller = makeController(preview);
    await boundTab(controller);
    await controller.handle("s1", { op: "snapshot" });
    const started = Date.now();
    const result = await controller.handle("s1", { op: "click", ref: "@e1" });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    // 宽限是**有界**的：无下载时最多等 DOWNLOAD_START_GRACE_MS 就返回（用户已接受
    // 每次点击最多 0.8s 的代价），绝不能无限等或拖到看门狗。
    expect(elapsed).toBeLessThan(DOWNLOAD_START_GRACE_MS + 400);
    expect(noticesOf(result)).toEqual([]);
  });

  it("does not add the grace to non-input operations", () => {
    // 纯判据：只有 click/press 付费，其它操作不该被延迟。
    expect(needsDownloadStartGrace({ op: "click", ref: "@e1" })).toBe(true);
    expect(needsDownloadStartGrace({ op: "press", key: "Enter" })).toBe(true);
    expect(needsDownloadStartGrace({ op: "snapshot" })).toBe(false);
    expect(needsDownloadStartGrace({ op: "eval", expression: "1", mode: "read" })).toBe(false);
    expect(needsDownloadStartGrace({ op: "navigate", url: "https://example.com/" })).toBe(false);
    expect(needsDownloadStartGrace({ op: "wait", wait: { kind: "ms", ms: 10 } })).toBe(false);
    expect(needsDownloadStartGrace({ op: "screenshot" })).toBe(false);
  });
});

/**
 * browser_save_image 的主进程分流（2026-09-17）。
 * 真机探针钉死的口径：data: 主进程解码；blob: 页面内 fetch；http(s) 主通道
 * `session.fetch({credentials:"include"})`（同源才附 Referer，跨源附了会被
 * `net::ERR_BLOCKED_BY_CLIENT` 拦截）；取不到字节时降级 `downloadURL`。
 */
describe("automation saveImage dispatch", () => {
  const controllers: BrowserAutomationController[] = [];
  const workspaces: string[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
    workspaces.length = 0;
  });
  const makeWorkspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pidesktop-saveimage-"));
    workspaces.push(dir);
    return dir;
  };

  interface SaveImageHarness {
    controller: BrowserAutomationController;
    fetchCalls: Array<{ url: string; options?: { credentials?: string; headers?: Record<string, string> } }>;
    downloadCalls: Array<{ url: string; options?: { headers?: Record<string, string> } }>;
    /** 让下一次 session.fetch 以给定结果应答（undefined = 拒绝）。 */
    setFetch: (result: undefined | { ok: boolean; status?: number; bytes?: Buffer; contentType?: string }) => void;
    setPageScriptResult: (result: unknown) => void;
    setPageUrl: (url: string) => void;
  }

  const makeHarness = (): SaveImageHarness => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const fetchCalls: SaveImageHarness["fetchCalls"] = [];
    const downloadCalls: SaveImageHarness["downloadCalls"] = [];
    let fetchResult: undefined | { ok: boolean; status?: number; bytes?: Buffer; contentType?: string } = { ok: true, status: 200, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
    let pageScriptResult: unknown = { ok: true, source: "element", url: "https://example.com/photo.png", element: "img#hero", width: 10, height: 20 };
    let pageUrl = "https://example.com/page";
    const contents = {
      getURL: () => pageUrl,
      isDestroyed: () => false,
      focus: () => undefined,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        on: () => undefined,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            if (expression.includes("collectInteractiveElements") && expression.includes("pageText")) {
              return { result: { value: { url: pageUrl, title: "页", pageText: "", items: [], truncated: false } } };
            }
            if (expression.includes("naturalWidth") || expression.includes("toDataURL") || expression.includes("backgroundImage")) {
              return { result: { value: pageScriptResult } };
            }
            return { result: { value: { ok: true } } };
          }
          return {};
        }
      },
      session: {
        fetch: async (url: string, options?: { credentials?: string; headers?: Record<string, string> }) => {
          fetchCalls.push({ url, options });
          const result = fetchResult;
          if (!result) throw new Error("net::ERR_FAILED");
          const bytes = result.bytes ?? Buffer.alloc(0);
          return {
            ok: result.ok,
            status: result.status ?? 200,
            headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? result.contentType ?? null : null) },
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          };
        }
      },
      downloadURL: (url: string, options?: { headers?: Record<string, string> }) => {
        downloadCalls.push({ url, options });
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return {
      controller,
      fetchCalls,
      downloadCalls,
      setFetch: (result) => { fetchResult = result; },
      setPageScriptResult: (result) => { pageScriptResult = result; },
      setPageUrl: (url) => { pageUrl = url; }
    };
  };

  const bindWithWorkspace = async (harness: SaveImageHarness, workspace: string) => {
    await harness.controller.handle("s1", { op: "tabs", action: "new" });
    await harness.controller.handle("s1", { op: "navigate", url: "https://example.com/page", workspace });
  };

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("fetches an http image through the partition session and writes it to the downloads dir", async () => {
    const harness = makeHarness();
    const workspace = makeWorkspace();
    await bindWithWorkspace(harness, workspace);
    harness.setFetch({ ok: true, status: 200, bytes: pngBytes });
    const result = await harness.controller.handle("s1", { op: "saveImage", selector: "img#hero" });
    if (!result.ok) throw new Error(result.error);
    if (result.data.kind !== "saveImage") throw new Error("意外结果");
    expect(result.data.mode).toBe("inline");
    expect(result.data.relativePath).toBe(".pidesktop/downloads/photo.png");
    expect(result.data.mime).toBe("image/png");
    expect(result.data.source).toBe("http");
    // 同源请求带上了 Referer（跨源会被 ERR_BLOCKED_BY_CLIENT 拦截，见下一个用例）。
    expect(harness.fetchCalls[0]!.options?.credentials).toBe("include");
    expect(harness.fetchCalls[0]!.options?.headers?.Referer).toBe("https://example.com/page");
    expect(readFileSync(join(workspace, ".pidesktop", "downloads", "photo.png"))).toEqual(pngBytes);
  });

  it("omits the Referer for a cross-origin image (attaching it would be blocked)", async () => {
    const harness = makeHarness();
    const workspace = makeWorkspace();
    await bindWithWorkspace(harness, workspace);
    harness.setPageScriptResult({ ok: true, source: "element", url: "https://cdn.example.com/x.png", element: "img" });
    harness.setFetch({ ok: true, status: 200, bytes: pngBytes });
    const result = await harness.controller.handle("s1", { op: "saveImage", selector: "img" });
    expect(result.ok).toBe(true);
    expect(harness.fetchCalls[0]!.options?.credentials).toBe("include");
    expect(harness.fetchCalls[0]!.options?.headers).toBeUndefined();
  });

  it("falls back to the browser download channel when the fetch fails", async () => {
    const harness = makeHarness();
    const workspace = makeWorkspace();
    await bindWithWorkspace(harness, workspace);
    harness.setFetch({ ok: false, status: 403 });
    const result = await harness.controller.handle("s1", { op: "saveImage", selector: "img" });
    if (!result.ok) throw new Error(result.error);
    if (result.data.kind !== "saveImage") throw new Error("意外结果");
    expect(result.data.mode).toBe("download");
    expect(harness.downloadCalls).toHaveLength(1);
    expect(harness.downloadCalls[0]!.url).toBe("https://example.com/photo.png");
  });

  it("decodes a data: URL in the main process without touching the network", async () => {
    const harness = makeHarness();
    const workspace = makeWorkspace();
    await bindWithWorkspace(harness, workspace);
    harness.setPageScriptResult({ ok: true, source: "element", url: `data:image/png;base64,${pngBytes.toString("base64")}`, element: "img" });
    const result = await harness.controller.handle("s1", { op: "saveImage", ref: "@e1", });
    if (!result.ok) throw new Error(result.error);
    if (result.data.kind !== "saveImage") throw new Error("意外结果");
    expect(result.data.source).toBe("data");
    // data:/blob: 的 basename 无意义 → 时间戳命名。
    expect(result.data.filename).toMatch(/^image-\d{8}-\d{6}\.png$/u);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(result.data.bytes).toBe(pngBytes.length);
  });

  it("reads a blob: image through the page and reports its sniffed format", async () => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const workspace = makeWorkspace();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5]);
    const contents = {
      getURL: () => "https://example.com/page",
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        on: () => undefined,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            if (expression.includes("collectInteractiveElements") && expression.includes("pageText")) {
              return { result: { value: { url: "https://example.com/page", title: "页", pageText: "", items: [], truncated: false } } };
            }
            if (expression.includes("btoa")) return { result: { value: `data:;base64,${png.toString("base64")}` } };
            return { result: { value: { ok: true, source: "element", url: "blob:https://example.com/abc", element: "img", width: 3, height: 4 } } };
          }
          return {};
        }
      },
      session: { fetch: async () => { throw new Error("blob must not go through session.fetch"); } },
      downloadURL: () => undefined
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    await controller.handle("s1", { op: "tabs", action: "new" });
    await controller.handle("s1", { op: "navigate", url: "https://example.com/page", workspace });
    const result = await controller.handle("s1", { op: "saveImage", selector: "img" });
    if (!result.ok) throw new Error(result.error);
    if (result.data.kind !== "saveImage") throw new Error("意外结果");
    expect(result.data.source).toBe("blob");
    expect(result.data.mime).toBe("image/png");
    expect(result.data.relativePath).toMatch(/^\.pidesktop\/downloads\/image-\d{8}-\d{6}\.png$/u);
  });

  it("keeps the canvas branch and surfaces a tainted-canvas error verbatim", async () => {
    const harness = makeHarness();
    const workspace = makeWorkspace();
    await bindWithWorkspace(harness, workspace);
    harness.setPageScriptResult({ ok: true, source: "canvas", url: `data:image/png;base64,${pngBytes.toString("base64")}`, element: "canvas#c", width: 32, height: 16 });
    const okResult2 = await harness.controller.handle("s1", { op: "saveImage", selector: "canvas#c" });
    if (!okResult2.ok) throw new Error(okResult2.error);
    if (okResult2.data.kind !== "saveImage") throw new Error("意外结果");
    expect(okResult2.data.source).toBe("canvas");

    // 污染画布：页面脚本给出可行动错误，主进程原样上抛。
    harness.setPageScriptResult({ ok: false, error: "canvas 内容无法导出（跨域图片污染了画布，浏览器安全策略不允许读取像素）。可改用 browser_screenshot 截取该区域，或让页面在画布未被污染时导出。" });
    const failed = await harness.controller.handle("s1", { op: "saveImage", selector: "canvas#c" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain("canvas 内容无法导出");
  });

  it("requires a workspace-bound tab and says how to get one", async () => {
    const harness = makeHarness();
    await harness.controller.handle("s1", { op: "tabs", action: "new" });
    const result = await harness.controller.handle("s1", { op: "saveImage", selector: "img" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("browser_navigate");
  });

  it("refuses a non-image element with the element named", async () => {
    const harness = makeHarness();
    const workspace = makeWorkspace();
    await bindWithWorkspace(harness, workspace);
    harness.setPageScriptResult({ ok: false, error: "该元素不是图片（<button#go>）：请选择 <img>、<canvas> 或有 background-image 的元素，或改用 url 参数直接指定图片地址" });
    const result = await harness.controller.handle("s1", { op: "saveImage", selector: "button#go" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("该元素不是图片");
      expect(result.error).toContain("button#go");
    }
  });

  it("rejects an oversized inline image instead of writing it", async () => {
    const harness = makeHarness();
    const workspace = makeWorkspace();
    await bindWithWorkspace(harness, workspace);
    harness.setFetch({ ok: true, status: 200, bytes: Buffer.alloc(20 * 1024 * 1024 + 1) });
    const result = await harness.controller.handle("s1", { op: "saveImage", selector: "img" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("20 MB");
    expect(existsSync(join(workspace, ".pidesktop", "downloads"))).toBe(false);
  });

  it("uses the element's natural size when nativeImage cannot size the buffer", async () => {
    const harness = makeHarness();
    const workspace = makeWorkspace();
    await bindWithWorkspace(harness, workspace);
    // SVG：nativeImage 给 {0,0}，回退到 <img> 的 naturalWidth/Height。
    harness.setPageScriptResult({ ok: true, source: "element", url: "https://example.com/logo.svg", element: "img#logo", width: 120, height: 40 });
    harness.setFetch({ ok: true, status: 200, bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8") });
    const result = await harness.controller.handle("s1", { op: "saveImage", selector: "img#logo" });
    if (!result.ok) throw new Error(result.error);
    if (result.data.kind !== "saveImage") throw new Error("意外结果");
    expect(result.data.width).toBe(120);
    expect(result.data.height).toBe(40);
    expect(result.data.mime).toBe("image/svg+xml");
    expect(result.data.filename).toBe("logo.svg");
  });
});

describe("jev primitives", () => {
  const controllers: BrowserAutomationController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
  });

  /** 假 debugger：记录每一条 CDP 命令，并按表达式返回预置的页面脚本结果。 */
  interface JevHarness {
    controller: BrowserAutomationController;
    commands: Array<{ method: string; params: Record<string, unknown> }>;
    setScriptResult: (value: unknown) => void;
    setScriptError: (message: string) => void;
  }
  const makeJevHarness = (): JevHarness => {
    const preview = makeFakePreview(["default"]) as FakePreview & BrowserPreviewController;
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    let scriptResult: unknown = { ok: true };
    let scriptError: string | undefined;
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          commands.push({ method, params: params ?? {} });
          if (method !== "Runtime.evaluate") return {};
          if (scriptError) return { exceptionDetails: { exception: { description: scriptError } } };
          return { result: { value: scriptResult } };
        },
        on: () => undefined
      }
    };
    (preview as unknown as { webContentsFor: (id: string) => unknown }).webContentsFor = () => contents;
    const controller = new BrowserAutomationController(preview);
    controllers.push(controller);
    return {
      controller,
      commands,
      setScriptResult: (value) => { scriptResult = value; },
      setScriptError: (message) => { scriptError = message; }
    };
  };

  const observePage = {
    url: "https://example.com/",
    title: "示例",
    pageText: "文本",
    scroll: { y: 0, height: 100, viewH: 100, canDown: false },
    items: [{ nodeId: 5, sig: "sig-5", role: "button", label: "提交", x: 10, y: 10 }]
  };

  it("observes the page and remembers the node signature table", async () => {
    const harness = makeJevHarness();
    harness.setScriptResult(observePage);
    const result = await harness.controller.handle("s1", { op: "jevObserve" });
    if (!result.ok) throw new Error(result.error);
    if (result.data.kind !== "jevObserve") throw new Error("意外结果");
    expect(result.data.page.items[0]!.nodeId).toBe(5);
    // 观察脚本必须来自 buildJevObserveScript（节点身份在页面侧分配）。
    const evaluated = harness.commands.find((command) => command.method === "Runtime.evaluate")!;
    expect(String(evaluated.params.expression)).toContain("__piJev");
  });

  it("rejects a click whose node id was never observed, without dispatching input", async () => {
    const harness = makeJevHarness();
    const result = await harness.controller.handle("s1", { op: "jevAct", nodeId: 99, action: { kind: "click" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("找不到 Jev 元素");
    // 关键：没有任何鼠标事件被派发（模型不能凭猜测点页面）。
    expect(harness.commands.some((command) => command.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("rejects an action whose element signature changed since the observation", async () => {
    const harness = makeJevHarness();
    harness.setScriptResult(observePage);
    await harness.controller.handle("s1", { op: "jevObserve" });
    // 页面脚本报告签名与观察时不同 → 页码已经变了，必须拒绝而不是硬点。
    harness.setScriptResult({ ok: true, x: 10, y: 10, signature: "sig-CHANGED", description: "<button>提交</button>" });
    const result = await harness.controller.handle("s1", { op: "jevAct", nodeId: 5, action: { kind: "click" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("与观察时不一致");
    expect(harness.commands.some((command) => command.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("dispatches real mouse events for a validated click", async () => {
    const harness = makeJevHarness();
    harness.setScriptResult(observePage);
    await harness.controller.handle("s1", { op: "jevObserve" });
    harness.setScriptResult({ ok: true, x: 12, y: 34, signature: "sig-5", description: "<button>提交</button>" });
    const result = await harness.controller.handle("s1", { op: "jevAct", nodeId: 5, action: { kind: "click" } });
    if (!result.ok) throw new Error(result.error);
    if (result.data.kind !== "jevAct") throw new Error("意外结果");
    const events = harness.commands.filter((command) => command.method === "Input.dispatchMouseEvent");
    expect(events.map((event) => event.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(events[1]!.params).toMatchObject({ x: 12, y: 34, button: "left" });
    expect(result.data.description).toContain("提交");
  });

  it("clears then inserts text for a fill action", async () => {
    const harness = makeJevHarness();
    harness.setScriptResult(observePage);
    await harness.controller.handle("s1", { op: "jevObserve" });
    harness.setScriptResult({ ok: true, x: 5, y: 6, signature: "sig-5", description: "<input>搜索" });
    const result = await harness.controller.handle("s1", { op: "jevAct", nodeId: 5, action: { kind: "fill" }, text: "北京" });
    if (!result.ok) throw new Error(result.error);
    const inserted = harness.commands.find((command) => command.method === "Input.insertText");
    expect(inserted?.params.text).toBe("北京");
    // 清空必须发生在插入之前（否则已有内容会与生成值粘连）。
    const order = harness.commands.map((command) => command.method).filter((method) => method === "Runtime.evaluate" || method === "Input.insertText");
    expect(order[order.length - 1]).toBe("Input.insertText");
  });

  it("resolves a select option through the values remembered at observation time", async () => {
    const harness = makeJevHarness();
    harness.setScriptResult({
      ...observePage,
      items: [{ nodeId: 6, sig: "sig-6", role: "combobox", label: "城市", value: "上海", options: [
        { index: "e1:1", label: "北京", value: "bj" },
        { index: "e1:2", label: "广州", value: "gz" }
      ] }]
    });
    await harness.controller.handle("s1", { op: "jevObserve" });
    harness.setScriptResult({ ok: true, x: 5, y: 6, signature: "sig-6", description: "<select>城市" });
    const selectResult = await harness.controller.handle("s1", { op: "jevAct", nodeId: 6, action: { kind: "select", optionIndex: 2 }, text: "" });
    if (!selectResult.ok) throw new Error(selectResult.error);
    expect(selectResult.data.kind === "jevAct" && selectResult.data.description).toContain("gz");
    // 选项索引超出观察到的候选集 → 拒绝（不猜值）。
    harness.setScriptResult({ ok: true, x: 5, y: 6, signature: "sig-6", description: "<select>城市" });
    const bad = await harness.controller.handle("s1", { op: "jevAct", nodeId: 6, action: { kind: "select", optionIndex: 9 }, text: "" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("已不在下拉框中");
  });

  it("drops the node table on reset so a stale id cannot be reused", async () => {
    const harness = makeJevHarness();
    harness.setScriptResult(observePage);
    await harness.controller.handle("s1", { op: "jevObserve" });
    await harness.controller.handle("s1", { op: "jevReset" });
    harness.setScriptResult({ ok: true, x: 1, y: 1, signature: "sig-5", description: "x" });
    const result = await harness.controller.handle("s1", { op: "jevAct", nodeId: 5, action: { kind: "click" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("找不到 Jev 元素");
  });

  it("maps a page-script failure onto an actionable error", async () => {
    const harness = makeJevHarness();
    harness.setScriptResult(observePage);
    await harness.controller.handle("s1", { op: "jevObserve" });
    harness.setScriptError("TypeError: x is not a function");
    const result = await harness.controller.handle("s1", { op: "jevAct", nodeId: 5, action: { kind: "click" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("页面脚本执行失败");
  });

  it("gives a click-triggered download the same start grace as browser_click", () => {
    expect(needsDownloadStartGrace({ op: "jevAct", nodeId: 1, action: { kind: "click" } })).toBe(true);
    expect(needsDownloadStartGrace({ op: "jevAct", nodeId: 1, action: { kind: "fill" } })).toBe(false);
    expect(needsDownloadStartGrace({ op: "jevObserve" })).toBe(false);
  });
});
