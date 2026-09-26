/**
 * 面板窗口管理器（main 进程）：作品类型 kind="panel" 的运行通道。
 *
 * 与其它作品的关键区别：面板**不寄生在主界面上**。它开的是一个真正的独立
 * BrowserWindow，因此主窗口关闭（隐藏到托盘）之后它照样在、主进程与 utility
 * 的通信也照样在——这正是「关掉主界面仍能看到谁在跑」的实现方式。
 *
 * 三个刻意的设计：
 * 1. **自带静态服务**。`BrowserAutomationController` 的静态服务随主窗口 dispose，
 *    共用一个实例会让面板在主窗口关闭的那一刻断掉数据（页面还在，fetch 全失败）。
 *    代价只是多一个 loopback 监听。
 * 2. **没有 preload**。面板页靠 `fetch("./__pidesktop_state.json")` 取数（由静态
 *    服务的虚拟端点提供，见 browser-static-server），所以窗口可以是最严的
 *    `sandbox + contextIsolation + 无 nodeIntegration`，也仍然是「一个普通网页」。
 * 3. **同作品复用同一窗口**。重复点「运行」是把它调到前面，而不是叠出一堆窗口。
 *
 * 这个类只做编排（BrowserWindow/屏幕/落盘），可测的判定都在纯函数里：
 * `shared/panel.ts`（入口扩展名、端点契约）与 `panel-bounds.ts`（位置尺寸）。
 */

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { BrowserWindow, screen } from "electron";
import type { GalleryPanelOptions } from "../shared/gallery.js";
import { isPanelEntryFile, type PanelAction } from "../shared/panel.js";
import { BrowserStaticServer, type StaticServerEndpoint } from "./browser-static-server.js";
import { pickPanelBounds, readPanelBounds, writePanelBounds, type PanelBounds } from "./panel-bounds.js";

export interface PanelOpenRequest {
  /** 作品 id：窗口复用与坐标记忆的键。 */
  id: string;
  title: string;
  /** 入口网页的绝对路径（调用方已按 galleryAbsolutePath 拼好）。 */
  filePath: string;
  workspace: string;
  panel?: GalleryPanelOptions;
}

export type PanelOpenResult = { ok: true } | { ok: false; message: string };

export interface PanelWindowDeps {
  /** 面板状态端点的数据源（同步、只读；由 main 的内存缓存提供）。 */
  stateProvider: () => unknown;
  /** 面板页 POST 上来的白名单动作。 */
  onAction: (action: PanelAction) => void;
  /** 坐标表文件（`<agentDir>/pidesktop-panels.json`）。 */
  boundsPath: string;
  /** 面板页里 window.open / target=_blank 一律交系统浏览器。 */
  openExternal: (url: string) => void;
}

/** 位置尺寸落盘防抖：拖动窗口会连续触发 move/resize，别每帧写一次盘。 */
export const PANEL_BOUNDS_SAVE_DEBOUNCE_MS = 400;

export class PanelWindowController {
  private readonly staticFiles = new BrowserStaticServer();
  private readonly windows = new Map<string, BrowserWindow>();
  /** 正在创建的窗口（作品 id → 那次 open 的 Promise）：挡住双击「运行」的并发。 */
  private readonly openings = new Map<string, Promise<PanelOpenResult>>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bounds: Record<string, PanelBounds>;

  constructor(private readonly deps: PanelWindowDeps) {
    this.bounds = readPanelBounds(deps.boundsPath);
    const endpoint: StaticServerEndpoint = {
      state: () => deps.stateProvider(),
      action: (action) => {
        deps.onAction(action);
        return true;
      }
    };
    this.staticFiles.setEndpoint(endpoint);
  }

  /** 打开（或前置）一个面板窗口。 */
  async open(request: PanelOpenRequest): Promise<PanelOpenResult> {
    const existing = this.windows.get(request.id);
    if (existing && !existing.isDestroyed()) {
      // 重新「运行」= 前置 + 按最新声明同步置顶（改了作品配置不必先关窗）。
      if (request.panel?.alwaysOnTop !== undefined && existing.isAlwaysOnTop() !== request.panel.alwaysOnTop) {
        existing.setAlwaysOnTop(request.panel.alwaysOnTop);
      }
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true };
    }
    // 首次打开是异步的（校验入口 + 起静态服务）：双击「运行」两次会在建窗之前
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

  /** 关掉某个作品的面板（作品被删除时用；不存在即 no-op）。 */
  close(id: string): void {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) win.close();
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
    this.staticFiles.dispose();
  }

  private async createPanelWindow(request: PanelOpenRequest): Promise<PanelOpenResult> {
    const validation = await validatePanelEntry(request.workspace, request.filePath);
    if (!validation.ok) return validation;

    let url: string;
    try {
      url = await this.staticFiles.urlForFile(validation.filePath, request.workspace);
    } catch (error) {
      return { ok: false, message: `面板作品的本地服务起不来：${error instanceof Error ? error.message : String(error)}` };
    }

    const bounds = pickPanelBounds(
      this.bounds[request.id],
      request.panel,
      screen.getAllDisplays().map((display) => display.workArea)
    );
    const win = new BrowserWindow({
      ...bounds,
      title: request.title,
      alwaysOnTop: request.panel?.alwaysOnTop === true,
      minWidth: 240,
      minHeight: 200,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    this.windows.set(request.id, win);
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      this.deps.openExternal(target);
      return { action: "deny" };
    });
    const remember = (): void => this.schedulePersist(request.id, win);
    win.on("resize", remember);
    win.on("move", remember);
    // 位置必须在 close（销毁之前）落盘：closed 时窗口已销毁，getBounds 拿不到了。
    win.on("close", () => {
      this.flushPersist(request.id, win);
    });
    win.on("closed", () => {
      if (this.windows.get(request.id) === win) this.windows.delete(request.id);
    });
    try {
      await win.loadURL(url);
    } catch (error) {
      // 加载失败不留一个空白窗口在 map 里（下次「运行」会把它 show 出来）。
      if (!win.isDestroyed()) win.destroy();
      if (this.windows.get(request.id) === win) this.windows.delete(request.id);
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
 * 越出工作区的入口一律拒——面板窗口的静态服务会挂载整个工作区，放一个工作区外的
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
