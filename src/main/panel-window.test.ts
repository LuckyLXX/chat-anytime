import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelProtocolRoute } from "./panel-protocol.js";

/**
 * 面板窗口控制器的**行为**测试（2026-11-16，计划 4.3）。
 *
 * 为什么要假窗口而不是源码断言：这一段的核心是时序——复用窗口要不要 `loadURL`、
 * reload 失败后窗口还在不在、挂载与关闭回调各自被调几次。源码断言全都能通过而行为
 * 全错（例如「复用窗口时 reload 了但加载的是旧地址」）。做法同
 * `browser-preview-visibility.test.ts`：用假 `electron` 注入可观测的 BrowserWindow，
 * 驱动**真**控制器。
 *
 * 这里钉的四条：
 *  1. 首次运行 = 挂载 + 在固定 origin 上加载入口；
 *  2. `reload !== true`（panel 内部动作/老客户端）= 只前置，**不** loadURL；
 *  3. `reload === true`（作品墙运行）= 复用同一窗口 + 几何不动 + 固定 origin 重新加载
 *     **当前入口**（换入口不换 origin，数据不分裂）；
 *  4. 失败的 reload（加载失败）关掉窗口并摘挂载、不冒充成功；入口校验失败则保留窗口
 *     上一次加载的页面；两种情况都**不**触发关窗收尾（`prepareClosed`，owner 服务收尾由调用方负责）；
 *  5. 带 `runToken` 的迟到运行（服务就绪回来与 open-panel 到达之间用户关了窗）直接判
 *     `stale`，不建窗、不挂载、不推进代际。
 */

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

/** 假窗口的可见状态（测试只读这里）。 */
interface FakeWindowLike {
  readonly webContents: { id: number; reloadCalls: number };
  destroyed: boolean;
  shown: boolean;
  focused: boolean;
  alwaysOnTop: boolean;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  readonly loadAttempts: string[];
  readonly loadedUrls: string[];
  readonly setBoundsCalls: number;
}

const hoisted = vi.hoisted(() => {
  const state = {
    windows: [] as unknown[],
    /** 下一次 loadURL 要抛的错（一次即清）：模拟页面加载失败。 */
    loadError: undefined as string | undefined,
    /** 下一次建窗要抛的错（一次即清）：模拟取屏幕/建窗失败。 */
    constructError: undefined as string | undefined,
    /** 让 loadURL 挂在一个由测试控制的 promise 上：用来模拟「加载期间用户关窗」。 */
    loadGate: undefined as Promise<void> | undefined
  };

  class FakeWebContents {
    id = 900 + state.windows.length;
    reloadCalls = 0;
    setWindowOpenHandler(): void {
      /* 面板的 target=_blank 交系统浏览器：与本文件无关 */
    }
    reload(): void {
      this.reloadCalls += 1;
    }
  }

  class FakeWindow {
    webContents = new FakeWebContents();
    destroyed = false;
    shown = false;
    focused = false;
    minimized = false;
    alwaysOnTop: boolean;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
    loadAttempts: string[] = [];
    loadedUrls: string[] = [];
    setBoundsCalls = 0;
    private readonly listeners = new Map<string, Array<() => void>>();

    constructor(options: Record<string, unknown>) {
      const constructError = state.constructError;
      if (constructError) {
        state.constructError = undefined;
        throw new Error(constructError);
      }
      this.alwaysOnTop = options.alwaysOnTop === true;
      this.title = typeof options.title === "string" ? options.title : "";
      this.bounds = {
        x: Number(options.x ?? 0),
        y: Number(options.y ?? 0),
        width: Number(options.width ?? 800),
        height: Number(options.height ?? 600)
      };
      state.windows.push(this);
    }

    on(event: string, listener: () => void): void {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
    }
    private emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    restore(): void {
      this.minimized = false;
    }
    show(): void {
      this.shown = true;
    }
    focus(): void {
      this.focused = true;
    }
    isAlwaysOnTop(): boolean {
      return this.alwaysOnTop;
    }
    setAlwaysOnTop(next: boolean): void {
      this.alwaysOnTop = next;
    }
    setTitle(title: string): void {
      this.title = title;
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds };
    }
    setBounds(next: { x: number; y: number; width: number; height: number }): void {
      this.setBoundsCalls += 1;
      this.bounds = { ...next };
    }
    async loadURL(url: string): Promise<void> {
      this.loadAttempts.push(url);
      const gate = state.loadGate;
      if (gate) await gate;
      const error = state.loadError;
      if (error) {
        state.loadError = undefined;
        throw new Error(error);
      }
      this.loadedUrls.push(url);
    }
    close(): void {
      if (this.destroyed) return;
      this.emit("close");
      this.destroy();
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }

  const screen = {
    getAllDisplays: () => {
      const error = state.constructError;
      if (error) {
        state.constructError = undefined;
        throw new Error(error);
      }
      return [{ id: 1, workArea: WORK_AREA }];
    },
    getPrimaryDisplay: () => ({ id: 1, workArea: WORK_AREA }),
    getDisplayMatching: () => ({ id: 1, workArea: WORK_AREA })
  };

  return { state, FakeWindow, screen };
});

vi.mock("electron", () => ({
  BrowserWindow: hoisted.FakeWindow,
  screen: hoisted.screen
}));

const { PanelWindowController } = await import("./panel-window.js");

const APP_ID = "g-abc123";

function fakeWindows(): FakeWindowLike[] {
  return hoisted.state.windows as FakeWindowLike[];
}

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pidesktop-panel-window-"));
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return dir;
}

interface FakeRoute {
  mounted: Set<string>;
  mountCalls: Array<{ appId: string; workspace: string }>;
  unmountCalls: string[];
  mount(input: { appId: string; workspace: string }): string;
  unmount(appId: string): void;
  has(appId: string): boolean;
}

interface ClosedCleanup {
  appId: string;
  /** 关窗当拍（同步）看到的「快照值」：用来钉住「快照必须现在取」。 */
  capturedAtClose: number;
  /** 真正执行时再读一次当前值：证明延迟执行用的是快照而不是当时的最新状态。 */
  ranWithLatest?: number;
}

function makeController(workspace: string): {
  controller: InstanceType<typeof PanelWindowController>;
  route: FakeRoute;
  /** 关窗当拍收到的快照请求（时机用）。 */
  prepared: string[];
  /** 已经执行的延迟收尾。 */
  cleanups: ClosedCleanup[];
} {
  const route: FakeRoute = {
    mounted: new Set<string>(),
    mountCalls: [],
    unmountCalls: [],
    mount(input) {
      this.mountCalls.push({ ...input });
      this.mounted.add(input.appId);
      return `w-${input.appId}`;
    },
    unmount(appId) {
      this.unmountCalls.push(appId);
      this.mounted.delete(appId);
    },
    has(appId) {
      return this.mounted.has(appId);
    }
  };
  const prepared: string[] = [];
  const cleanups: ClosedCleanup[] = [];
  // 模拟主进程：关窗当拍同步抓快照（真实实现是 runner.ownerStopTicket），返回延迟收尾
  let generation = 0;
  const controller = new PanelWindowController({
    route: route as unknown as PanelProtocolRoute,
    boundsPath: join(workspace, ".pidesktop", "pidesktop-panels.json"),
    openExternal: vi.fn(),
    prepareClosed: (appId) => {
      prepared.push(appId);
      const capturedAtClose = ++generation;
      const cleanup: ClosedCleanup = { appId, capturedAtClose };
      return () => {
        cleanup.ranWithLatest = generation;
        cleanups.push(cleanup);
      };
    }
  });
  return { controller, route, prepared, cleanups };
}

function openRequest(
  workspace: string,
  entry: string,
  extra: { reload?: boolean; title?: string; runToken?: number } = {}
) {
  return {
    id: APP_ID,
    title: extra.title ?? "状态面板",
    workspace,
    filePath: join(workspace, entry),
    ...(extra.reload === undefined ? {} : { reload: extra.reload }),
    ...(extra.runToken === undefined ? {} : { runToken: extra.runToken })
  };
}

/** 等一次 setImmediate（关窗收尾是推迟到下一个 tick 的）。 */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 等到某个条件成立（建窗是异步的：校验入口要读盘）。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}

beforeEach(() => {
  hoisted.state.windows.length = 0;
  hoisted.state.loadError = undefined;
  hoisted.state.constructError = undefined;
  hoisted.state.loadGate = undefined;
});

describe("面板窗口：运行 = 确保窗口打开并加载当前入口", () => {
  it("首次运行：先挂载协议路由，再在固定 origin 上加载入口", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route } = makeController(workspace);

    const result = await controller.open(openRequest(workspace, "index.html", { reload: true }));

    expect(result).toEqual({ ok: true });
    const win = fakeWindows()[0]!;
    expect(route.mountCalls).toEqual([{ appId: APP_ID, workspace }]);
    expect(win.loadedUrls).toEqual([`pidesktop-file://w-${APP_ID}/index.html`]);
    expect(win.shown).toBe(true);
    controller.dispose();
  });

  it("再次运行但不 reload（panel 内部动作 / 旧客户端）：只前置，不重新加载", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html"));
    const win = fakeWindows()[0]!;
    win.shown = false;
    win.focused = false;

    const result = await controller.open(openRequest(workspace, "index.html"));

    expect(result).toEqual({ ok: true });
    expect(fakeWindows()).toHaveLength(1);
    expect(win.loadAttempts).toEqual([`pidesktop-file://w-${APP_ID}/index.html`]);
    expect(win.shown).toBe(true);
    expect(win.focused).toBe(true);
    controller.dispose();
  });

  it("再次运行且 reload：复用同一窗口、几何不动，loadURL 当前入口（origin 不变）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));
    const win = fakeWindows()[0]!;
    const boundsBefore = win.bounds;
    const mountsBefore = route.mountCalls.length;

    const result = await controller.open(openRequest(workspace, "index.html", { reload: true }));

    expect(result).toEqual({ ok: true });
    // 复用：没有第二个窗口，几何一次都没被 setBounds 动过
    expect(fakeWindows()).toHaveLength(1);
    expect(win.setBoundsCalls).toBe(0);
    expect(win.bounds).toEqual(boundsBefore);
    // 重新加载了同一个固定 origin 入口
    expect(win.loadAttempts).toHaveLength(2);
    expect(new URL(win.loadAttempts[1]!).host).toBe(`w-${APP_ID}`);
    expect(win.loadAttempts[1]).toBe(win.loadAttempts[0]);
    // 重新挂载（幂等刷新工作区根）：mount/unmount 仍然成对
    expect(route.mountCalls.length).toBe(mountsBefore + 1);
    expect(route.has(APP_ID)).toBe(true);
    controller.dispose();
  });

  it("reload 时入口换了：loadURL 指向新入口，origin 仍是同一作品（数据不分裂）", async () => {
    const workspace = await makeWorkspace({
      "index.html": "<html>v1</html>",
      "panels/status/index.html": "<html>v2</html>"
    });
    const { controller } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));
    const win = fakeWindows()[0]!;

    await controller.open(openRequest(workspace, "panels/status/index.html", { reload: true }));

    expect(win.loadAttempts[1]).toBe(`pidesktop-file://w-${APP_ID}/panels/status/index.html`);
    expect(new URL(win.loadAttempts[1]!).origin).toBe(new URL(win.loadAttempts[0]!).origin);
    controller.dispose();
  });

  it("reload 同步置顶与标题（改了作品配置不必先关窗）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));
    const win = fakeWindows()[0]!;
    expect(win.alwaysOnTop).toBe(false);

    const result = await controller.open({
      ...openRequest(workspace, "index.html", { reload: true, title: "新标题" }),
      panel: { alwaysOnTop: true }
    });

    expect(result).toEqual({ ok: true });
    expect(win.alwaysOnTop).toBe(true);
    expect(win.title).toBe("新标题");
    controller.dispose();
  });
});

describe("面板窗口：reload 失败必须如实失败", () => {
  it("加载失败：返回可读原因、关掉窗口并摘挂载，且不冒充关窗（owner 服务由调用方收）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));
    const win = fakeWindows()[0]!;

    hoisted.state.loadError = "ERR_FILE_NOT_FOUND";
    const result = await controller.open(openRequest(workspace, "index.html", { reload: true }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("ERR_FILE_NOT_FOUND");
    expect(result.ok === false && result.message).toContain("已关闭该面板窗口");
    // 窗口没了、挂载也摘了：mount/unmount 成对，不会留一个地址还能服务的孤儿
    expect(win.destroyed).toBe(true);
    expect(controller.isOpen(APP_ID)).toBe(false);
    expect(route.has(APP_ID)).toBe(false);
    // 失败由调用方报告，这里不能再触发一次「窗口真的关了」
    await nextTick();
    expect(cleanups).toHaveLength(0);
    controller.dispose();
  });

  it("入口校验失败（文件被删）：保留上一次加载的页面，不关窗、不摘挂载", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>", "gone.html": "<html></html>" });
    const { controller, route, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "gone.html", { reload: true }));
    const win = fakeWindows()[0]!;

    const result = await controller.open(openRequest(workspace, "missing.html", { reload: true }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("找不到面板作品的入口文件");
    expect(result.ok === false && result.message).toContain("仍显示上一次加载的页面");
    expect(win.destroyed).toBe(false);
    expect(controller.isOpen(APP_ID)).toBe(true);
    expect(route.has(APP_ID)).toBe(true);
    // 只校验、不加载：不会拿一个坏入口去 loadURL
    expect(win.loadAttempts).toHaveLength(1);
    await nextTick();
    expect(cleanups).toHaveLength(0);
    controller.dispose();
  });

  it("首次开窗加载失败同样不留在窗口表里（下次运行会重新建窗）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route, cleanups } = makeController(workspace);

    hoisted.state.loadError = "net::ERR_FAILED";
    const failed = await controller.open(openRequest(workspace, "index.html", { reload: true }));

    expect(failed.ok).toBe(false);
    expect(fakeWindows()[0]!.destroyed).toBe(true);
    expect(controller.isOpen(APP_ID)).toBe(false);
    expect(route.has(APP_ID)).toBe(false);
    await nextTick();
    expect(cleanups).toHaveLength(0);

    const reopened = await controller.open(openRequest(workspace, "index.html", { reload: true }));
    expect(reopened).toEqual({ ok: true });
    expect(fakeWindows()).toHaveLength(2);
    controller.dispose();
  });

  it("建窗抛错：挂载也要摘回去（mount/unmount 严格成对），且不冒充 closed", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route, cleanups } = makeController(workspace);

    // 建窗之前的任何一步（取显示器）与建窗本身抛错，都不能把挂载留在表里
    hoisted.state.constructError = "显示器不可用";
    const screenFailed = await controller.open(openRequest(workspace, "index.html", { reload: true }));
    expect(screenFailed.ok).toBe(false);
    expect(screenFailed.ok === false && screenFailed.message).toContain("显示器不可用");
    expect(route.has(APP_ID)).toBe(false);
    expect(route.unmountCalls).toEqual([APP_ID]);
    expect(fakeWindows()).toHaveLength(0);

    hoisted.state.constructError = "窗口创建失败";
    const constructFailed = await controller.open(openRequest(workspace, "index.html", { reload: true }));
    expect(constructFailed.ok).toBe(false);
    expect(constructFailed.ok === false && constructFailed.message).toContain("窗口创建失败");
    expect(route.has(APP_ID)).toBe(false);
    await nextTick();
    expect(cleanups).toHaveLength(0);
    controller.dispose();
  });

  it("加载期间用户关窗：不冒充成功（closedDuringOpen），挂载已摘、关窗收尾照常", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route, cleanups } = makeController(workspace);

    let releaseLoad = (): void => {};
    hoisted.state.loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const opening = controller.open(openRequest(workspace, "index.html", { reload: true }));
    // 等建窗进到 loadURL（建窗是异步的：校验入口要先读盘）
    await waitUntil(() => fakeWindows().length === 1 && fakeWindows()[0]!.loadAttempts.length === 1);
    const win = fakeWindows()[0]!;

    controller.handleAction(APP_ID, { action: "close" });
    releaseLoad();
    const result = await opening;

    // 不能返回 ok:true：否则渲染端会记一次运行、向用户假报「已打开」
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("加载完成前被关闭");
    expect(result.ok === false && result.closedDuringOpen).toBe(true);
    expect(win.destroyed).toBe(true);
    expect(controller.isOpen(APP_ID)).toBe(false);
    expect(route.has(APP_ID)).toBe(false);
    // 这是真正的关窗：owner 服务收尾必须照常发生（否则就漏了）
    await nextTick();
    expect(cleanups).toHaveLength(1);
    controller.dispose();
  });
});

describe("面板窗口：关闭语义与内部动作", () => {
  it("内部 close 动作不 reload；正常关闭才触发关窗收尾与摘挂载", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));
    const win = fakeWindows()[0]!;

    expect(controller.handleAction(APP_ID, { action: "close" })).toBe(true);

    // 关闭不是「运行」：一次额外的 loadURL 都不该有
    expect(win.loadAttempts).toHaveLength(1);
    expect(win.webContents.reloadCalls).toBe(0);
    expect(route.has(APP_ID)).toBe(false);
    await nextTick();
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]!.appId).toBe(APP_ID);
    controller.dispose();
  });

  it("窗口控制器的 reload（清数据用）走 webContents.reload，不重新校验入口", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));
    const win = fakeWindows()[0]!;

    controller.reload(APP_ID);

    expect(win.webContents.reloadCalls).toBe(1);
    expect(win.loadAttempts).toHaveLength(1);
    controller.dispose();
  });

  it("并发两次运行只开一个窗口（reload 也共用同一次进行中的加载）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller } = makeController(workspace);

    const [first, second] = await Promise.all([
      controller.open(openRequest(workspace, "index.html", { reload: true })),
      controller.open(openRequest(workspace, "index.html", { reload: true }))
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(fakeWindows()).toHaveLength(1);
    expect(fakeWindows()[0]!.loadAttempts).toHaveLength(1);
    controller.dispose();
  });
});

describe("面板窗口：关窗收尾与重开（快照 + 代际）", () => {
  it("关窗收尾在下一个 tick 执行，但快照是关窗当拍同步取的", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, prepared, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));

    controller.handleAction(APP_ID, { action: "close" });

    // 当拍就拿到了快照（main 侧在这里抓 runner.ownerStopTicket），但还没执行停止
    expect(prepared).toEqual([APP_ID]);
    expect(cleanups).toHaveLength(0);
    await nextTick();
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]!.appId).toBe(APP_ID);
    controller.dispose();
  });

  it("关窗后立刻重开：收尾仍然执行（不再整拍跳过），用的是关窗那一刻的快照", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route, prepared, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));

    controller.handleAction(APP_ID, { action: "close" });
    // 不做任何等待就重开（真实序列：点关闭 → 立刻点运行）
    const reopened = await controller.open(openRequest(workspace, "index.html", { reload: true }));
    await nextTick();

    expect(reopened).toEqual({ ok: true });
    // 收尾照跑：该停谁由快照精确定位（runner 按记录 id + 认领序号排除重开后的新认领），
    // 跳过整拍反而会把「关窗时卡在探活里的旧 start」留成孤儿。
    expect(prepared).toEqual([APP_ID]);
    expect(cleanups).toHaveLength(1);
    // 执行时看到的是「已经又关/开过一次」的状态：证明用的是快照而非当时最新状态
    expect(cleanups[0]!.ranWithLatest).toBe(1);
    expect(controller.isOpen(APP_ID)).toBe(true);
    expect(route.has(APP_ID)).toBe(true);
    controller.dispose();
  });

  it("关窗后「为这个面板起 owner 服务」也算新一轮：旧轮次失效，但收尾照跑", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));

    const round = controller.noteRunStarted(APP_ID);
    controller.handleAction(APP_ID, { action: "close" });
    // 「先起服务再开窗」的运行路径：start 的 IPC 比 open-panel 先到
    const nextRound = controller.noteRunStarted(APP_ID);
    await nextTick();

    // 旧轮次已作废（主进程据此把这次 start 的 ok 改成「已取消」），新轮次有效
    expect(controller.isRunCurrent(APP_ID, round)).toBe(false);
    expect(controller.isRunCurrent(APP_ID, nextRound)).toBe(true);
    // 但收尾仍然执行：在途的旧认领必须被取消，否则它会探活回来后 spawn 出孤儿进程
    expect(cleanups).toHaveLength(1);
    controller.dispose();
  });

  it("每次关窗都收一次尾（重开再关也照收），作废不等于永久漏掉", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route, prepared, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));

    controller.handleAction(APP_ID, { action: "close" });
    await controller.open(openRequest(workspace, "index.html", { reload: true }));
    await nextTick();
    expect(cleanups).toHaveLength(1);

    controller.handleAction(APP_ID, { action: "close" });
    await nextTick();
    expect(prepared).toEqual([APP_ID, APP_ID]);
    expect(cleanups).toHaveLength(2);
    expect(route.has(APP_ID)).toBe(false);
    expect(controller.isOpen(APP_ID)).toBe(false);
    controller.dispose();
  });

  it("关闭推进代际：在途的「先起服务再开窗」据此知道本轮已作废（不再重开刚关的窗口）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));

    // 渲染端的运行路径：先为面板起 owner 服务，记下本轮代际，然后 await 就绪
    const round = controller.noteRunStarted(APP_ID);
    expect(controller.isRunCurrent(APP_ID, round)).toBe(true);

    // 等就绪期间用户关窗
    controller.handleAction(APP_ID, { action: "close" });
    expect(controller.isRunCurrent(APP_ID, round)).toBe(false);
    await nextTick();
    expect(cleanups).toHaveLength(1);
    controller.dispose();
  });
});

describe("面板窗口：一整轮运行的身份（runToken）", () => {
  it("fresh：runToken 与当前代际一致 → 正常开窗，之后代际再推进一次", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller } = makeController(workspace);

    // 主进程在「为面板起 owner 服务」那一刻抓到的代际
    const token = controller.noteRunStarted(APP_ID);
    const result = await controller.open(openRequest(workspace, "index.html", { reload: true, runToken: token }));

    expect(result).toEqual({ ok: true });
    expect(fakeWindows()).toHaveLength(1);
    expect(controller.runGeneration(APP_ID)).toBe(token + 1);
    controller.dispose();
  });

  it("两个 IPC 之间关窗（start 已 ok、open-panel 还没到）→ stale：不重开刚关的窗口", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route, prepared, cleanups } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));
    const win = fakeWindows()[0]!;

    // 这一轮：先起服务（拿到代际），服务就绪返回 ok —— 然后 open-panel 才到
    const token = controller.noteRunStarted(APP_ID);
    // 就在这两拍之间，用户把面板关了
    controller.handleAction(APP_ID, { action: "close" });
    await nextTick();
    expect(prepared).toHaveLength(1);
    expect(cleanups).toHaveLength(1);
    const mountsBefore = route.mountCalls.length;
    const loadsBefore = win.loadAttempts.length;

    const result = await controller.open(openRequest(workspace, "index.html", { reload: true, runToken: token }));

    expect(result).toEqual({ ok: false, stale: true, message: "面板已经关闭，这次运行不再继续" });
    // 什么都没做：没有新窗口、没有重新挂载、没有额外 loadURL、也没有推进代际
    expect(fakeWindows()).toHaveLength(1);
    expect(controller.isOpen(APP_ID)).toBe(false);
    expect(route.mountCalls).toHaveLength(mountsBefore);
    expect(route.has(APP_ID)).toBe(false);
    expect(win.loadAttempts).toHaveLength(loadsBefore);
    expect(controller.runGeneration(APP_ID)).toBe(token + 1);
    await nextTick();
    // 也没有额外的关窗收尾（stale 不是关窗，它自己什么都不收）
    expect(cleanups).toHaveLength(1);
    controller.dispose();
  });

  it("stale 的请求连挂载都不碰（首次运行就作废时也不会留下可服务的地址）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller, route } = makeController(workspace);

    // 伪造/过期的代际：控制器从没跑过这一轮
    const result = await controller.open(openRequest(workspace, "index.html", { reload: true, runToken: 5 }));

    expect(result).toEqual({ ok: false, stale: true, message: "面板已经关闭，这次运行不再继续" });
    expect(fakeWindows()).toHaveLength(0);
    expect(route.mountCalls).toHaveLength(0);
    expect(route.unmountCalls).toHaveLength(0);
    expect(controller.runGeneration(APP_ID)).toBe(0);
    controller.dispose();
  });

  it("新一轮拿自己的 token 照常开窗（作废只针对旧的那一轮）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller } = makeController(workspace);
    await controller.open(openRequest(workspace, "index.html", { reload: true }));

    const staleToken = controller.noteRunStarted(APP_ID);
    controller.handleAction(APP_ID, { action: "close" });
    await nextTick();
    expect(await controller.open(openRequest(workspace, "index.html", { reload: true, runToken: staleToken }))).toMatchObject({ ok: false, stale: true });

    // 重开之后用户又点了一次运行：新的代际、新的 token
    const freshToken = controller.noteRunStarted(APP_ID);
    const reopened = await controller.open(openRequest(workspace, "index.html", { reload: true, runToken: freshToken }));

    expect(reopened).toEqual({ ok: true });
    expect(controller.isOpen(APP_ID)).toBe(true);
    controller.dispose();
  });

  it("不带 runToken 永远是 fresh（直开窗 / panel 内部动作 / 旧客户端）", async () => {
    const workspace = await makeWorkspace({ "index.html": "<html>v1</html>" });
    const { controller } = makeController(workspace);

    expect(await controller.open(openRequest(workspace, "index.html", { reload: true }))).toEqual({ ok: true });
    expect(await controller.open(openRequest(workspace, "index.html"))).toEqual({ ok: true });
    expect(fakeWindows()).toHaveLength(1);
    controller.dispose();
  });
});
