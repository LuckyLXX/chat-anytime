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
 * 4. **「运行」= 确保窗口打开并加载当前入口**（2026-11-16）。复用窗口时，作品墙的
 *    「运行」会带 `reload: true`：重新校验入口、刷新挂载，再 `loadURL` 当前入口地址
 *    （不是 `webContents.reload()`——继续开发可能换过入口文件），origin 仍是
 *    `pidesktop-file://w-<作品>`，localStorage / IndexedDB 不受影响。panel 页面内部
 *    的 show-main / toggle / grow 等动作走 `handleAction`，**永远不 reload**。
 *    窗口外形（frame / transparent / resizable）在窗口生命周期内固定，改了形态要
 *    先关窗再运行。
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
   * 本次「运行」是否要求重新加载入口。
   *
   * 只有作品墙的运行路径传 true（`galleryRunPlan` 的 open-panel / start-panel-service
   * 两支）；panel 页面内部的窗口级动作不经过这里，因此不会把用户正在看的页面刷掉。
   * 缺省 false = 老客户端/内部调用沿用「只前置」的旧语义。
   */
  reload?: boolean;
  /**
   * 这一轮运行在「起服务」那一刻抓到的代际（主进程把 `noteRunStarted()` 的返回值原样传回）。
   *
   * 补的是最后一小段缝隙：服务就绪回来（`ok`）与 `gallery:open-panel` 这个 IPC **到达**
   * 之间还有一拍，用户可能正好在这段里把面板关了。带上来就能在这里一比：这一轮还算不算数。
   * 缺省（不传）= 不做这个校验（直开窗、panel 内部动作、旧客户端）。
   */
  runToken?: number;
}

export type PanelOpenResult = { ok: true } | {
  ok: false;
  message: string;
  /**
   * 这次「运行」已经作废（`runToken` 与当前代际不符：等就绪/传输期间用户把面板关了，
   * 或又开了新的一轮）。
   *
   * 发生作废时控制器**什么都没做**：没建窗、没挂载、没推进代际，也没停任何服务。调用方
   * 因此只需安静收场（不报错弹窗、不再收 owner 服务），也不能把它当成成功。
   */
  stale?: boolean;
  /**
   * 失败原因是「窗口在加载完成前被关掉」（用户亲手关的）。
   *
   * 这种失败已经走完关窗收尾（挂载摘除 + owner 服务清理），调用方**不要**再收一遍；
   * 其余失败（入口校验不过 / 建窗抛错 / 加载失败）才是「这次运行什么都没留下」，
   * 需要调用方把平台为该面板起的本地服务收掉。
   */
  closedDuringOpen?: boolean;
};

export interface PanelWindowDeps {
  /** 面板协议路由（页面/资产/端点全在它手上，见 panel-protocol.ts）。 */
  route: PanelProtocolRoute;
  /** 坐标表文件（`<agentDir>/pidesktop-panels.json`）。 */
  boundsPath: string;
  /** 面板页里 window.open / target=_blank 一律交系统浏览器。 */
  openExternal: (url: string) => void;
  /**
   * 关窗那一刻**同步**取一份延迟收尾句柄（装配方在这里抓「这个窗口拥有什么」的快照）。
   *
   * 契约（2026-11-16 计划 4.3⑥ / 4.4）：
   * 1. 这里只取快照并同步取消在途认领（纯数据），不 kill、不动窗口；
   *    此刻还在 Electron 销毁窗口的同步栈里；
   * 2. 返回的闭包由控制器在**下一个 tick** 执行（结束整棵进程树不能搭在销毁栈上，
   *    2026-10-11 真机堆损坏 0xC0000374 的现场就在这一带）；
   * 3. 闭包**每次关窗都会被调用**（控制器不做「整拍跳过」）：该停谁由快照精确定位——
   *    重开后的新记录 / 重新认领过的记录不在快照里，天然不会被误杀；而关窗时还在途的
   *    那次认领（探活里卡着、entries 里还看不到记录）会被一起取消。跳过整拍反而会让
   *    它探活回来后 spawn 出一个没有主人的进程。
   *
   * 打不开 / 加载失败而被丢弃的窗口（见 `discardWindow`）**不会**触发它：那两条路径的
   * 失败原因会回给调用方，owner 服务的收尾由调用方负责（渲染端「开窗失败就停服务」或
   * 主进程的异常路径），这里再收一次就会把同一个服务停两遍。
   */
  prepareClosed?: (appId: string) => (() => void) | undefined;
}

/** 位置尺寸落盘防抖：拖动窗口会连续触发 move/resize，别每帧写一次盘。 */
export const PANEL_BOUNDS_SAVE_DEBOUNCE_MS = 400;

export class PanelWindowController {
  private readonly windows = new Map<string, BrowserWindow>();
  /** 每个作品的归一化窗口偏好（close/toggle 要按形态/贴边行事）。 */
  private readonly panelOptions = new Map<string, GalleryPanelOptions>();
  /** 正在创建的窗口（作品 id → 那次 open 的 Promise）：挡住双击「运行」的并发。 */
  private readonly openings = new Map<string, Promise<PanelOpenResult>>();
  /**
   * 每个作品「跑到第几轮」的代际：每次 `open`（首次 / 复用 / reload）、「为这个面板起
   * owner 服务」以及「关窗」都推进它。
   *
   * **只有一个用途**：判断一个**在途**的运行是否已被关窗作废。最长的那个 await 是
   * 「先起服务再开窗」里的等就绪（探活预算可以到秒级），它回来时用户可能已经把面板关了
   * ——`isRunCurrent()` 让主进程把那次 start 的 ok 改成「已取消」，而不是拿着 ok 去把用户
   * 刚关掉的窗口重新打开。
   *
   * 与关窗收尾的分工（不要拿代际去管停谁）：
   * - 代际：管「这一轮还算不算数」（在途结果的取舍）；
   * - 关窗时同步抓的服务快照（`prepareClosed` → runner 的 ownerStopTicket）：管「该停谁」。
   *   那一拍**永远执行**，靠记录 id + 认领序号排除重开后的新认领，因此不能改成
   *   「代际变了就整拍跳过」——跳过会让关窗时卡在探活里的旧 start 探活回来后 spawn
   *   出一个没有主人的进程。
   */
  private readonly runGenerations = new Map<string, number>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bounds: Record<string, PanelBounds>;

  constructor(private readonly deps: PanelWindowDeps) {
    this.bounds = readPanelBounds(deps.boundsPath);
  }

  /**
   * 打开（或复用）一个面板窗口。
   *
   * 复用已有窗口时按 `request.reload` 分两种语义：
   * - `reload !== true`：只前置 + 同步置顶/标题（panel 内部动作、老客户端）；
   * - `reload === true`（作品墙的「运行」）：重新校验入口、刷新协议挂载，再
   *   `loadURL` 当前入口——用户点了「运行」就一定看到最新代码。
   *
   * 带 `runToken` 时先结算「这一轮还算不算数」：作废就直接返回 `stale`，什么都动。
   */
  async open(request: PanelOpenRequest): Promise<PanelOpenResult> {
    // 第一件事就是结算本轮身份，**先于代际推进与任何挂载/建窗**：`runToken` 是「起服务」
    // 那一刻的代际，与服务就绪返回之间、以至这个 IPC 到达之前，用户都可能已经把面板关了。
    // 这种迟到的运行必须原地退场——否则会把用户刚关掉的窗口重新开出来（而且会把新的
    // 一轮运行的状态搞乱）。
    if (request.runToken !== undefined && request.runToken !== this.runGeneration(request.id)) {
      return { ok: false, stale: true, message: "面板已经关闭，这次运行不再继续" };
    }
    // 新一轮运行开始（代际推进）：更早的在途运行（如卡在探活里的 owner 服务启动）就此作废，
    // 它们回到主线程时会用 isRunCurrent 结算成「已取消」（见 gallery:service-start）。
    this.noteRunStarted(request.id);
    // 双击「运行」/ 连续两次 reload：进行中的那一次已经在加载当前入口了，跟着它走。
    // （首次打开也是异步的——校验入口 + 挂载协议路由；没有这个占位就会叠出两个窗口，
    // 且后建的那个不受 map 管理。）
    const pending = this.openings.get(request.id);
    if (pending) return pending;
    const existing = this.windows.get(request.id);
    const task = (existing && !existing.isDestroyed() ? this.applyToExisting(request, existing) : this.createPanelWindow(request)).finally(() => {
      this.openings.delete(request.id);
    });
    this.openings.set(request.id, task);
    return task;
  }

  /** 这个作品有没有活着的面板窗口（调用方据此判断 owner 服务「还有没有主人」）。 */
  isOpen(id: string): boolean {
    const win = this.windows.get(id);
    return Boolean(win && !win.isDestroyed());
  }

  /**
   * 标记「这个作品又开始了一轮运行」（或这一轮已经结束），返回新的代际。
   *
   * 装配方在两个地方叫它：
   * 1. 为这个面板起 owner 服务（`ownerPanelId` = 作品 id）——「先起服务再开窗」的第一步，
   *    比 open 更早到达，主进程要在那里记下本轮代际、等就绪回来后再结算；
   * 2. （控制器内部）`open()` 与**关窗**：开窗 = 新一轮开始，关窗 = 这一轮结束，两者都
   *    让更早的在途运行作废。
   */
  noteRunStarted(appId: string): number {
    const next = (this.runGenerations.get(appId) ?? 0) + 1;
    this.runGenerations.set(appId, next);
    return next;
  }

  /** 当前代际（在途运行开工时记一次，回到主线程时再比一次）。 */
  runGeneration(appId: string): number {
    return this.runGenerations.get(appId) ?? 0;
  }

  /**
   * 这一轮运行还是最新的吗？
   *
   * 「先起服务再开窗」那条路要在**等就绪回来之后**拿它结算：本轮若已被用户关窗
   *（或下一轮运行）作废，就不能再拿 ok 回去把用户刚关掉的窗口重新打开。
   */
  isRunCurrent(appId: string, generation: number): boolean {
    return this.runGeneration(appId) === generation;
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

  /**
   * 重载某个作品的面板页（清空数据后要把页面内存里的旧数据一并丢掉）。
   *
   * 与「运行」的 reload 分工不同：入口没有变，只是要让页面重新读一次存储，所以直接
   * `webContents.reload()`；「运行」走 `open({ reload: true })`，它会重新校验入口并
   * `loadURL` 当前入口地址。
   */
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

  /**
   * 已有窗口的「运行」：先前置，再（仅在 `reload === true` 时）重新加载当前入口。
   *
   * 几何一律不动：用户拖过、缩过的位置尺寸不能被一次「运行」重置；置顶与标题按
   * 最新声明同步（改了作品配置不必先关窗）。
   */
  private async applyToExisting(request: PanelOpenRequest, win: BrowserWindow): Promise<PanelOpenResult> {
    // 窗口偏好同步：close / toggle / grow 这些窗口级动作读的就是这一份。
    this.panelOptions.set(request.id, request.panel ?? {});
    const onTop = panelEffectiveAlwaysOnTop(request.panel);
    if (win.isAlwaysOnTop() !== onTop) win.setAlwaysOnTop(onTop);
    if (request.title) win.setTitle(request.title);
    if (win.isMinimized()) win.restore();
    // 先前置再 reload：点了「运行」先看到窗口（它确实响应了），再看到它刷新。
    win.show();
    win.focus();
    if (request.reload !== true) return { ok: true };

    const page = await this.preparePanelPage(request);
    if (!page.ok) {
      // 入口校验没过：不动窗口——用户眼前那个页面不该被一次失败的「运行」抹掉，
      // 而平台为它起的本地服务也仍然有主人。只把原因报回去（由调用方决定怎么提示）。
      return { ok: false, message: `${page.message}（面板窗口仍显示上一次加载的页面）` };
    }
    if (win.isDestroyed()) {
      // 入口已经挂上去了，而窗口在等待期间被关掉（或程序化销毁）：把挂载摘回去
      // （unmount 是幂等的，closed 处理器已经摘过也不会出错）。
      this.deps.route.unmount(request.id);
      return { ok: false, message: "面板窗口已经关闭，无法重新加载" };
    }
    try {
      // 必须以 loadURL 加载「当前入口」而不是 webContents.reload() 旧地址：继续开发
      // 可能把入口文件换了（同作品 id），而 origin 仍由作品 id 唯一决定
      // （`pidesktop-file://w-<作品>`），所以换入口不会把数据分裂到新 origin。
      await win.loadURL(page.url);
    } catch (error) {
      // 页面加载失败 = 这个窗口已经没有可用内容：连协议挂载一起丢掉（mount/unmount
      // 成对），失败原因如实报给调用方（它负责收掉平台为该面板起的本地服务）。
      this.discardWindow(request.id, win);
      return { ok: false, message: `面板页面重新加载失败，已关闭该面板窗口：${errorText(error)}` };
    }
    return { ok: true };
  }

  /**
   * 入口校验 + 挂载协议路由 + 算出固定 origin 上的页面地址（首次开窗与 reload 共用）。
   *
   * 三个不变量都在这里一次做完，两条路径就不会跑偏：
   * 1. 入口先复核（越界/不是网页/文件不在都不许进挂载表）；
   * 2. 先挂载再加载（页面一开就会请求自己的资产与端点）；mount 是幂等的，重复挂载
   *    等于刷新工作区根，host/origin 不变；
   * 3. origin 只由作品 id 决定，入口只影响路径段。
   */
  private async preparePanelPage(request: PanelOpenRequest): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
    const validation = await validatePanelEntry(request.workspace, request.filePath);
    if (!validation.ok) return validation;
    // 挂载根 = 工作区（与原先静态服务的口径一致，入口在子目录里时相对/根相对路径都照旧可用）。
    const host = this.deps.route.mount({ appId: request.id, workspace: request.workspace });
    const entryRelative = relative(resolve(request.workspace), resolve(validation.filePath));
    return { ok: true, url: panelWorkUrl(host, entryRelative) };
  }

  /**
   * 丢弃一个打不开 / 加载失败的窗口，并**抑制它的 `closed` 收尾**。
   *
   * 为什么不用 `close()`：close 会等页面的 beforeunload，一个加载失败或卡住的页面能把
   * 关窗拖住，而这条路径上的窗口也没有需要保存的内容。内存表先摘掉，`closed` 处理器
   * 看到「表里已经不是它」就直接返回，所以这里一次把两件事做净：
   * 1. 摘掉协议挂载（mount/unmount 成对）；
   * 2. 不让关窗收尾（`prepareClosed` → runner 快照）再跑一遍——这次失败的原因由调用方
   *    报给用户，owner 服务也由调用方收，两边都收就是双杀。
   */
  private discardWindow(id: string, win: BrowserWindow): void {
    if (this.windows.get(id) === win) this.windows.delete(id);
    this.panelOptions.delete(id);
    // 窗口没了就不再服务它的地址（重开「运行」时会重新挂载）：mount/unmount 成对。
    this.deps.route.unmount(id);
    if (!win.isDestroyed()) win.destroy();
  }

  private async createPanelWindow(request: PanelOpenRequest): Promise<PanelOpenResult> {
    const page = await this.preparePanelPage(request);
    if (!page.ok) return page;
    // 从这一行起，**挂载已经生效**：下面任何一步抛错（取显示器、建窗、接线、加载）都
    // 必须把挂载摘回去，否则这个作品的地址会继续对外服务一个不存在的窗口——
    // mount/unmount 必须成对。所以建窗与加载全部包在同一个 try 里。
    let win: BrowserWindow | undefined;
    try {
      win = this.buildPanelWindow(request);
      await win.loadURL(page.url);
    } catch (error) {
      if (win) this.discardWindow(request.id, win);
      else this.deps.route.unmount(request.id);
      return { ok: false, message: `面板页面加载失败：${errorText(error)}` };
    }
    if (win.isDestroyed()) {
      // 用户在加载期间关掉了窗口：挂载已由 closed 收尾摘掉，owner 服务也在关窗收尾队列
      // 里。这不能算作「运行成功」——否则渲染端会记一次运行、向用户假报「已打开」。
      return { ok: false, message: "面板窗口在加载完成前被关闭", closedDuringOpen: true };
    }
    win.show();
    return { ok: true };
  }

  /** 取屏幕、定几何、建窗、接线（同步；抛错由 createPanelWindow 统一清挂载）。 */
  private buildPanelWindow(request: PanelOpenRequest): BrowserWindow {
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
      // 已经被失败路径丢弃的窗口（见 discardWindow）：那里的收尾已经做完了（挂载摘除 +
      // 由调用方收 owner 服务），这里再做一遍就会把同一个服务停两次。
      if (this.windows.get(request.id) !== win) return;
      this.windows.delete(request.id);
      this.panelOptions.delete(request.id);
      // 窗口没了就不再服务它的地址（重开「运行」时会重新挂载）。
      this.deps.route.unmount(request.id);
      // 关闭本身就是「这一轮运行结束了」的边界：推进代际，让在途的「先起服务再开窗」
      // 那一轮（isRunCurrent）知道自己已作废。（该停哪些服务不靠代际判断，而是靠下面
      // 同步抓到的快照——两者分工：代际管「这轮还算不算数」，快照管「该停谁」。）
      this.noteRunStarted(request.id);
      // 关窗当拍**同步**取收尾句柄（装配方在这里抓服务归属快照；只取快照，不 kill）。
      // 晚一拍取就可能把重开后新认领的服务圈进去。
      const cleanup = this.deps.prepareClosed?.(request.id);
      if (!cleanup) return;
      setImmediate(() => {
        // **不做代际跳过**：该停谁由快照精确定位（新记录/新认领不在快照里），而关窗时
        // 在途的那次认领必须被取消——整拍跳过会让它探活回来后 spawn 出没有主人的进程。
        try {
          cleanup();
        } catch {
          /* 关闭收尾的失败与窗口本身无关 */
        }
      });
    });
    return win;
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

/** 把任意异常转成一句能直接给用户看的话（IPC 结果里的 message）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
