/**
 * 面板窗口管理器（main 进程）：作品类型 kind="panel" 的运行通道。
 *
 * 与其它作品的关键区别：面板**不寄生在主界面上**。它开的是一个真正的独立
 * BrowserWindow，因此主窗口关闭（隐藏到托盘）之后它照样在、主进程与 utility
 * 的通信也照样在——这正是「关掉主界面仍能看到谁在跑」的实现方式。
 *
 * 三个刻意的设计：
 * 1. **承载方式：自定义协议**（2026-10-10 根因修复）。面板页原先由控制器自带的
 *    loopback 静态服务提供（`http://127.0.0.1:<listen(0) 随机端口>/w/<token>/…`），
 *    而 localStorage / IndexedDB 按 origin（含端口）隔离 ⇒ 端口每次启动都变，
 *    作品看着就像「数据丢了」。现在由 `PanelProtocolRoute` 在固定 origin
 *    `pidesktop-file://w-<作品>` 上服务页面与资产，作品代码零改动就获得跨启动
 *    持久、按作品隔离的存储。
 * 2. **没有 preload**。面板页靠 `fetch("./__pidesktop_state.json")` 取数（由协议
 *    路由的虚拟端点提供，见 panel-protocol.ts），所以窗口可以是最严的
 *    `sandbox + contextIsolation + 无 nodeIntegration`，也仍然是「一个普通网页」。
 * 3. **同作品复用同一窗口**。重复点「运行」是把它调到前面，而不是叠出一堆窗口。
 *
 * 窗口形态（panel.mode，缺省 window）：window = 系统边框窗口；pet = 桌宠（透明
 * 无边框固定尺寸，形状由页面自绘，页面 POST close 关窗）；drawer = 贴边抽屉
 * （窄把手 ↔ 完整面板两态，页面 POST toggle 切换，几何由 panel-bounds 的
 * drawerBounds 纯函数决定，不进坐标记忆）。
 *
 * 这个类只做编排（BrowserWindow/屏幕/落盘），可测的判定都在纯函数里：
 * `shared/panel.ts`（入口扩展名、端点契约）、`panel-bounds.ts`（位置尺寸）、
 * `shared/protocol.ts`（origin 与 URL）、`panel-protocol.ts`（请求路由）。
 */

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { BrowserWindow, screen } from "electron";
import { PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, panelEffectiveAlwaysOnTop, panelMode, panelWindowSize, type GalleryPanelEdge, type GalleryPanelOptions } from "../shared/gallery.js";
import { panelWorkUrl } from "../shared/protocol.js";
import { isPanelEntryFile, type PanelRequest } from "../shared/panel.js";
import type { PanelProtocolRoute } from "./panel-protocol.js";
import { anchoredPanelBounds, drawerBounds, pickPanelBounds, readPanelBounds, scaledPanelBounds, writePanelBounds, PANEL_SCALE_STEP, type PanelBounds } from "./panel-bounds.js";

export interface PanelOpenRequest {
  /** 作品 id：窗口复用与坐标记忆的键。 */
  id: string;
  title: string;
  /** 入口网页的绝对路径（调用方已按 galleryAbsolutePath 拼好）。 */
  filePath: string;
  workspace: string;
  panel?: GalleryPanelOptions;
  /**
   * 平台为这个面板拉起的本地服务对应的终端会话 id（2026-10-11：带 command+url 的面板）。
   * 窗口关闭时主进程靠它停掉服务；没声明服务的面板不带。
   */
  serviceTerminalId?: string;
}

export type PanelOpenResult = { ok: true } | { ok: false; message: string };

export interface PanelWindowDeps {
  /** 面板协议路由（页面/资产/端点全在它手上，见 panel-protocol.ts）。 */
  route: PanelProtocolRoute;
  /** 坐标表文件（`<agentDir>/pidesktop-panels.json`）。 */
  boundsPath: string;
  /** 面板页里 window.open / target=_blank 一律交系统浏览器。 */
  openExternal: (url: string) => void;
  /**
   * 窗口真的关掉了（`closed` 触发时，windows/panelOptions 已清理、协议路由已摘除）。
   * 装配方用它给「平台为面板起的本地服务」收尾：kill 终端会话 + 通知渲染端收掉标签。
   * 加载失败走 `destroy()` 不触发 `closed`（见 dispose 的注释），那种情况由渲染端的
   * 「开窗失败就停服务」兜底。回调抛错不影响窗口清理。
   */
  onClosed?: (appId: string, serviceTerminalId?: string) => void;
}

/** 位置尺寸落盘防抖：拖动窗口会连续触发 move/resize，别每帧写一次盘。 */
export const PANEL_BOUNDS_SAVE_DEBOUNCE_MS = 400;

export class PanelWindowController {
  private readonly windows = new Map<string, BrowserWindow>();
  /** 每个作品的归一化窗口偏好（close/toggle 要按形态/贴边行事）。 */
  private readonly panelOptions = new Map<string, GalleryPanelOptions>();
  /**
   * 作品 id → 平台为它起的本地服务终端 id（带 command+url 的面板才有）。
   * 只在建窗时写入，复用已有窗口时不覆盖——服务是同一个，不能被后来的运行改写成别的。
   */
  private readonly services = new Map<string, string>();
  /** 正在创建的窗口（作品 id → 那次 open 的 Promise）：挡住双击「运行」的并发。 */
  private readonly openings = new Map<string, Promise<PanelOpenResult>>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bounds: Record<string, PanelBounds>;

  constructor(private readonly deps: PanelWindowDeps) {
    this.bounds = readPanelBounds(deps.boundsPath);
  }

  /** 打开（或前置）一个面板窗口。 */
  async open(request: PanelOpenRequest): Promise<PanelOpenResult> {
    const existing = this.windows.get(request.id);
    if (existing && !existing.isDestroyed()) {
      // 重新「运行」= 前置 + 按最新声明同步置顶（改了作品配置不必先关窗）。
      const onTop = panelEffectiveAlwaysOnTop(request.panel);
      if (existing.isAlwaysOnTop() !== onTop) existing.setAlwaysOnTop(onTop);
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true };
    }
    // 首次打开是异步的（校验入口 + 挂载协议路由）：双击「运行」两次会在建窗之前
    // 就并发进来，没有这个占位就会叠出两个窗口，且后建的那个不受 map 管理。
    const pending = this.openings.get(request.id);
    if (pending) return pending;
    const task = this.createPanelWindow(request).finally(() => {
      this.openings.delete(request.id);
    });
    this.openings.set(request.id, task);
    return task;
  }

  /** 当前是否有活着的面板窗口（关闭主窗口的「回得去」判据之一）。 */
  hasOpenWindows(): boolean {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) return true;
    }
    return false;
  }

  /**
   * 这个 webContents 属于本控制器管理的面板窗口吗？
   * 跨域放宽（panel-cors）据此把「只给面板」落到实处——别的窗口哪怕发同一个请求也原样放行。
   */
  isPanelWebContents(webContentsId: number): boolean {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed() && win.webContents.id === webContentsId) return true;
    }
    return false;
  }

  /** 关掉某个作品的面板（作品被删除时用；不存在即 no-op）。挂载由窗口的 closed 处理器摘除。 */
  close(id: string): void {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) win.close();
  }

  /** 重载某个作品的面板页（清空数据后要把页面内存里的旧数据一并丢掉）。 */
  reload(id: string): void {
    const win = this.windows.get(id);
    if (!win || win.isDestroyed()) return;
    win.webContents.reload();
  }

  /** 该作品活着的面板页（数据量测优先复用它，省一次窗口创建）。 */
  contentsFor(id: string): BrowserWindow["webContents"] | undefined {
    const win = this.windows.get(id);
    if (!win || win.isDestroyed()) return undefined;
    return win.webContents;
  }

  dispose(): void {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    for (const [id, win] of this.windows) {
      if (win.isDestroyed()) continue;
      // destroy() 不触发 close，所以最后一次位置必须在这里主动落盘。
      this.flushPersist(id, win);
      win.destroy();
    }
    this.windows.clear();
    this.panelOptions.clear();
  }

  /**
   * 窗口级动作（close / toggle / grow / shrink / reset-size / resize）：作用于
   * **发出请求的那个作品**。
   *
   * 定位靠 host（协议请求的 host 就是作品身份，见 shared/protocol.ts 的 panelWorkHost），
   * 由 index.ts 的端点回调把 appId 传进来——不再有原先那套「Referer 路径匹配 +
   * 唯一活窗退化 + 多窗分不清就 403」的判据：自定义协议的请求里 Referer 头根本拿不到
   * （真机实测），而 host 本身就唯一确定。
   */
  handleAction(id: string, request: Exclude<PanelRequest, { action: "show-main" }>): boolean {
    const win = this.windows.get(id);
    if (!win || win.isDestroyed()) return false;
    if (request.action === "close") {
      win.close();
      return true;
    }
    const options = this.panelOptions.get(id);
    const mode = panelMode(options);
    if (request.action === "toggle") {
      // toggle 只属于抽屉：普通窗口与桌宠没有两态，拒绝而不是无声吞掉。
      if (mode !== "drawer") return false;
      const edge: GalleryPanelEdge = options?.edge ?? "right";
      const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
      const geometry = drawerBounds(edge, options, workArea);
      const current = win.getBounds();
      const collapsedNow = current.width === geometry.collapsed.width && current.height === geometry.collapsed.height;
      win.setBounds(collapsedNow ? geometry.expanded : geometry.collapsed, true);
      return true;
    }
    // grow / shrink / reset-size / resize：只对桌宠有意义——透明窗口不能由用户拖
    // 边框缩放，尺寸只能由页面发动作、这里 setBounds 定；其它形态拒绝（普通窗口本来就能拖）。
    // resize 是「按页面的整数倍档位精确设尺寸」的正路（避免窗口与猫各变各的）。
    if (mode !== "pet") return false;
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
    const current = win.getBounds();
    const next =
      request.action === "resize"
        ? anchoredPanelBounds(current, { width: request.width, height: request.height }, workArea)
        : request.action === "reset-size"
          ? anchoredPanelBounds(current, panelWindowSize(options), workArea)
          : scaledPanelBounds(current, request.action === "grow" ? PANEL_SCALE_STEP : 1 / PANEL_SCALE_STEP, workArea);
    // 已到尺寸上下限：幂等返回成功（页面不因“到顶了”收到 403），只是不再变。
    if (next.width === current.width && next.height === current.height) return true;
    // setBounds 会触发 move/resize → 既有的 remember 逻辑把它写进位置尺寸记忆，
    // 所以下一次“运行”还是用户调好的大小。
    win.setBounds(next, true);
    return true;
  }

  private async createPanelWindow(request: PanelOpenRequest): Promise<PanelOpenResult> {
    const validation = await validatePanelEntry(request.workspace, request.filePath);
    if (!validation.ok) return validation;

    // 先挂载再加载：页面一开就会请求自己的资产与端点，挂载表必须已经就位。
    // 挂载根 = 工作区（与原先静态服务的口径一致，入口在子目录里时相对/根相对路径都照旧可用）。
    const host = this.deps.route.mount({ appId: request.id, workspace: request.workspace });
    const entryRelative = relative(resolve(request.workspace), resolve(validation.filePath));
    const url = panelWorkUrl(host, entryRelative);

    const mode = panelMode(request.panel);
    const displays = screen.getAllDisplays().map((display) => display.workArea);
    // 抽屉的几何由「贴哪条边」唯一决定，不吃坐标记忆（拖不走、不缩放）；
    // 普通窗口与桌宠沿用记忆（桌宠 resizable: false 拉不了，但拖动位置仍值得记）。
    const bounds: PanelBounds =
      mode === "drawer"
        ? drawerBounds(request.panel?.edge ?? "right", request.panel, displays[0] ?? screen.getPrimaryDisplay().workArea).collapsed
        : pickPanelBounds(this.bounds[request.id], request.panel, displays);
    // 桌宠/抽屉是无边框透明窗口：没有标题栏（关闭靠页面 POST close），Windows 下
    // 透明窗口本就不可缩放；尺寸下限不设——抽屉收起态只有窄把手厚，设了下限会把
    // setBounds 悄悄抬回去，收起态就永远出不来。
    const win = new BrowserWindow({
      ...bounds,
      title: request.title,
      alwaysOnTop: panelEffectiveAlwaysOnTop(request.panel),
      ...(mode !== "window" ? { transparent: true, frame: false, resizable: false, skipTaskbar: true } : {}),
      ...(mode === "window" ? { minWidth: PANEL_MIN_WIDTH, minHeight: PANEL_MIN_HEIGHT } : {}),
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    this.windows.set(request.id, win);
    this.panelOptions.set(request.id, request.panel ?? {});
    if (request.serviceTerminalId) this.services.set(request.id, request.serviceTerminalId);
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      this.deps.openExternal(target);
      return { action: "deny" };
    });
    const remember = (): void => this.schedulePersist(request.id, win);
    if (mode !== "drawer") {
      win.on("resize", remember);
      win.on("move", remember);
    }
    // 位置必须在 close（销毁之前）落盘：closed 时窗口已销毁，getBounds 拿不到了。
    if (mode !== "drawer") {
      win.on("close", () => {
        this.flushPersist(request.id, win);
      });
    }
    win.on("closed", () => {
      if (this.windows.get(request.id) === win) this.windows.delete(request.id);
      this.panelOptions.delete(request.id);
      // 窗口没了就不再服务它的地址（重开「运行」时会重新挂载）。
      this.deps.route.unmount(request.id);
      // 平台为这个面板起的本地服务跟着窗口收尾（2026-10-11 用户选定：关窗即停，
      // 不留后台进程）。失败只影响「多留一个服务进程」，绝不能让窗口清理半途而废。
      const serviceTerminalId = this.services.get(request.id);
      this.services.delete(request.id);
      try {
        this.deps.onClosed?.(request.id, serviceTerminalId);
      } catch {
        /* 关闭回调的失败与窗口本身无关 */
      }
    });
    try {
      await win.loadURL(url);
    } catch (error) {
      // 加载失败不留一个空白窗口在 map 里（下次「运行」会把它 show 出来）。
      if (!win.isDestroyed()) win.destroy();
      if (this.windows.get(request.id) === win) this.windows.delete(request.id);
      this.deps.route.unmount(request.id);
      return { ok: false, message: `面板页面加载失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!win.isDestroyed()) win.show();
    return { ok: true };
  }

  private schedulePersist(id: string, win: BrowserWindow): void {
    const pending = this.saveTimers.get(id);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.saveTimers.delete(id);
      this.flushPersist(id, win);
    }, PANEL_BOUNDS_SAVE_DEBOUNCE_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.saveTimers.set(id, timer);
  }

  private flushPersist(id: string, win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const rect = win.getBounds();
    this.bounds[id] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    writePanelBounds(this.deps.boundsPath, this.bounds);
  }
}

/**
 * 入口校验：必须是工作区内的**网页文件**且真实存在。
 *
 * 渲染端传来的路径不可全信（作品清单是用户/AI 写的），所以这里独立复核一遍：
 * 越出工作区的入口一律拒——面板协议路由把整个工作区挂给这个作品，放一个工作区外的
 * 入口进去等于把那个目录也一并挂上。
 */
export async function validatePanelEntry(workspace: string, filePath: string): Promise<{ ok: true; filePath: string } | { ok: false; message: string }> {
  if (!isAbsolute(workspace) || !isAbsolute(filePath)) {
    return { ok: false, message: "面板作品的入口必须是绝对路径（工作区内的网页文件）" };
  }
  const root = resolve(workspace);
  const target = resolve(filePath);
  const relation = relative(root, target);
  // `relative` 跨盘符会返回绝对路径，所以 isAbsolute(relation) 也必须拒。
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    return { ok: false, message: "面板作品的入口必须在当前工作区内" };
  }
  if (!isPanelEntryFile(target)) {
    return { ok: false, message: "面板作品的入口必须是网页文件（.html / .htm / .svg）" };
  }
  const info = await stat(target).catch(() => undefined);
  if (!info || !info.isFile()) return { ok: false, message: `找不到面板作品的入口文件：${target}` };
  return { ok: true, filePath: target };
}
