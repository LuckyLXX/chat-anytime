import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 「面板作品 + 本地服务」的接线契约（2026-10-11 起，2026-11-12 改写）。
 *
 * 为什么是源码断言型：这条链路横跨渲染端 App.tsx、shared/protocol.ts、preload、
 * main/index.ts 与 main/panel-window.ts 五处，而 App.tsx 与 PanelWindowController
 * 都难以在单测里装配（同先例见 gallery-run-wiring.test.ts 的说明）。
 *
 * 2026-11-12 的关键变化：面板的本地服务不再占用终端会话（`serviceTerminalId` 整套
 * 字段都删了），而是和普通服务型作品一样走主进程的后台进程管理器，用
 * **ownerPanelId** 表达「这个服务属于哪个面板」。窗口关闭时主进程按 owner 停掉它，
 * 看板随之刷新——所以这里钉的是：
 *  1. 面板的服务必须先起（后台）、探活通过再开窗；
 *  2. 开窗失败要立刻停掉刚起的服务（不留没有主人的进程）；
 *  3. 窗口关闭按 owner 停服务，不再有「关终端会话 + 推孤儿标签消息」那套；
 *  4. 旧字段彻底消失（留着它就是两套并行语义，下次谁读到都会猜错）。
 *
 * 读入即归一化行尾：CI（core.autocrlf=true）检出 CRLF，硬编码 `\n` 的跨行断言会假红。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n/gu, "\n");
const app = read("../renderer/src/App.tsx");
const preload = read("../preload/index.ts");
const main = read("index.ts");
const panelWindow = read("panel-window.ts");
const protocol = read("../shared/protocol.ts");

describe("面板作品的本地服务：运行链路", () => {
  it("start-panel-service 先起服务再开窗，并把服务归属交给主进程", () => {
    expect(app).toContain('plan.action === "start-panel-service"');
    expect(app).toMatch(/ownerPanelId: app\.id/u);
    expect(app).toMatch(/if \(await openGalleryPanel\(app, plan\.absolutePath, plan\.options\)\) \{/u);
  });

  it("开窗失败的收尾只在主进程做（渲染端拿不到旧窗口状态，不能盲停）", () => {
    // 2026-11-16 起：IPC reject / ok:false 时渲染端都不知道那个作品的旧窗口是否还在，
    // 盲停会把用户眼前那个还在显示的面板的服务杀掉。所以 App 只展示错误，
    // 服务收尾一律交主进程（releasePanelOwnerServices 会先看 isOpen）。
    const panel = app.slice(app.indexOf("const openGalleryPanel = useCallback"), app.indexOf("const openGalleryServicePage"));
    expect(panel).toContain("setMessageActionError(result.message");
    expect(panel).toContain("} catch (error) {");
    expect(panel).not.toContain("galleryServiceStop");
    expect(panel).not.toContain("started.service");
    // 连带把「用 galleryServiceStop 兜底」整段从运行分支里去掉
    const run = app.slice(app.indexOf("const runGalleryApp = useCallback"), app.indexOf("const openGalleryPanel = useCallback"));
    expect(run).not.toContain("galleryServiceStop");
    // 主进程侧：!ok（且不是「加载期间被关窗」）与 IPC 抛异常两条路都收
    expect(main).toContain("if (!result.ok && !result.closedDuringOpen && !result.stale) releasePanelOwnerServices(id);");
    expect(main).toMatch(/catch \(error\) \{[\s\S]{0,300}?releasePanelOwnerServices\(id\);/u);
  });

  it("两条开窗路径共用 openGalleryPanel", () => {
    expect(app.match(/await openGalleryPanel\(/gu) ?? []).toHaveLength(2);
  });

  it("旧的 serviceTerminalId / gallery.panel-closed 语义彻底消失（避免两套并行语义）", () => {
    expect(protocol).not.toContain("serviceTerminalId");
    expect(preload).not.toContain("serviceTerminalId");
    expect(main).not.toContain("serviceTerminalId");
    expect(panelWindow).not.toContain("serviceTerminalId");
    expect(protocol).not.toContain("gallery.panel-closed");
    expect(app).not.toContain("gallery.panel-closed");
  });
});

describe("面板窗口关闭 → 停掉平台为它起的服务", () => {
  it("主进程按 owner 快照停服务并刷新看板（不再 kill 终端会话）", () => {
    expect(main).toContain("runner?.stopByOwner(appId, ticket)");
    expect(main).toMatch(/^\s*pushGalleryServices\(\);$/mu);
    // 停服务要有痕迹：看板只剩「服务还在跑」而进程已经没了是用户最难自己发现的一种。
    expect(main).toContain("关闭，已停止 ");
    expect(main).not.toContain('terminalManager.handle({ type: "kill", terminalId: closedTerminalId');
  });

  it("关窗收尾两段式：当拍同步抓快照，下一个 tick 才按快照停", () => {
    expect(panelWindow).toContain("prepareClosed?: (appId: string) => (() => void) | undefined;");
    const closedHandler = panelWindow.slice(panelWindow.indexOf('win.on("closed"'), panelWindow.indexOf("private schedulePersist"));
    // 快照同步取（在 setImmediate 之前）——晚一拍就可能把重开后新认领的服务圈进去
    expect(closedHandler.indexOf("this.deps.prepareClosed?.(request.id)")).toBeLessThan(closedHandler.indexOf("setImmediate(() => {"));
    // 推迟到下一个 tick：closed 还在 Electron 销毁窗口的同步栈里
    expect(closedHandler).toContain("cleanup();");
    // 不再用代际整拍跳过（那会漏掉关窗时在途的那次认领）
    expect(closedHandler).not.toContain("runGeneration(request.id) !==");
    expect(main).toContain("const ticket = runner?.prepareOwnerStop(appId);");
  });

  it("面板入参三处镜像一致：DesktopApi / preload / ipcMain（没有服务会话字段）", () => {
    expect(protocol).toContain("galleryOpenPanel(input: { id: string; title: string; workspace: string; filePath: string; panel?: GalleryPanelOptions; reload?: boolean; runToken?: number }): Promise<{ ok: boolean; message?: string; stale?: boolean }>;");
    expect(preload).toContain('galleryOpenPanel: (input: { id: string; title: string; workspace: string; filePath: string; panel?: GalleryPanelOptions; reload?: boolean; runToken?: number }) => ipcRenderer.invoke("gallery:open-panel", input)');
    expect(main).toContain('ipcMain.handle("gallery:open-panel"');
  });
});

describe("panel 运行与 reload（2026-11-16 计划 4.3）", () => {
  it("「运行」带 reload：preload/protocol 三处镜像，主进程只有显式 true 才 reload", () => {
    expect(protocol).toContain("panel?: GalleryPanelOptions; reload?: boolean");
    expect(preload).toContain("panel?: GalleryPanelOptions; reload?: boolean");
    // fail-closed：只有布尔 true 才当 reload，别的真值/旧客户端一律沿用「只前置」
    expect(main).toContain("const reload = input?.reload === true;");
    expect(main).toMatch(/panel: normalizeGalleryPanelOptions\(input\?\.panel\),\n\s*reload,/u);
  });

  it("已有窗口的 reload 用 loadURL 加载当前入口（不是 webContents.reload 旧地址）", () => {
    // 入口要重新校验、重新挂载（mount 幂等），否则继续开发换了入口文件依旧看不到
    expect(panelWindow).toContain("private async applyToExisting(request: PanelOpenRequest, win: BrowserWindow): Promise<PanelOpenResult>");
    expect(panelWindow).toMatch(/if \(request\.reload !== true\) return \{ ok: true \};/u);
    expect(panelWindow).toContain("await win.loadURL(page.url);");
    // 固定 origin 的唯一来源：host 只由作品 id 决定，入口只影响路径段
    expect(panelWindow).toContain("const host = this.deps.route.mount({ appId: request.id, workspace: request.workspace });");
    expect(panelWindow).toContain("url: panelWorkUrl(host, entryRelative)");
    // 几何不动：复用窗口的路径上不得出现 setBounds / 重建窗口
    const reuse = panelWindow.slice(panelWindow.indexOf("private async applyToExisting"), panelWindow.indexOf("private async preparePanelPage"));
    expect(reuse).not.toContain("setBounds");
    expect(reuse).not.toContain("new BrowserWindow");
  });

  it("panel 页面内部的窗口级动作永远不 reload（那是用户正在看的页面）", () => {
    const start = panelWindow.indexOf("handleAction(id: string");
    // 切到下一个成员声明之前（下一个成员的文档注释就是边界）
    const action = panelWindow.slice(start, panelWindow.indexOf("/**", start));
    expect(action.length).toBeGreaterThan(500);
    expect(action).not.toContain("loadURL");
    expect(action).not.toContain("reload");
  });

  it("开窗/reload 失败：可读原因 + 清掉 owner 服务（只认 owner，不碰外部服务）", () => {
    // IPC 抛异常必须兜住：过去这条路连原因都拿不到，刚起的服务也没人收
    expect(main).toContain("return { ok: false, message: `打开面板窗口失败：${reason}` };");
    expect(main).toContain("function releasePanelOwnerServices(appId: string): void {");
    expect(main).toContain("if (!result.ok && !result.closedDuringOpen && !result.stale) releasePanelOwnerServices(id);");
    // 只停 owner 记录（stopByOwner 只认 ownerPanelId），且窗口还在时不抢先停
    const release = main.slice(main.indexOf("function releasePanelOwnerServices"), main.indexOf("function normalizeServiceRequest"));
    expect(release).toContain("stopByOwner(appId)");
    expect(release).toContain("if (panelWindows?.isOpen(appId)) return;");
    expect(release).not.toContain("disposeAll");
  });

  it("加载期间用户关窗不算成功：返回 closedDuringOpen，让主进程不要再收一遍服务", () => {
    expect(panelWindow).toContain('return { ok: false, message: "面板窗口在加载完成前被关闭", closedDuringOpen: true };');
    // 该标记只为「这次关窗已经收尾过」而存在，不得被当成成功
    expect(panelWindow).toContain("closedDuringOpen?: boolean;");
    expect(main).toContain("!result.closedDuringOpen");
  });

  it("建窗抛错也要摘挂载：取屏幕/建窗/加载全在同一个 try 里", () => {
    // 挂载之后任何一步抛错都必须 unmount（否则地址继续服务一个不存在的窗口）
    expect(panelWindow).toContain("private buildPanelWindow(request: PanelOpenRequest): BrowserWindow {");
    const create = panelWindow.slice(panelWindow.indexOf("private async createPanelWindow"), panelWindow.indexOf("private buildPanelWindow"));
    expect(create).toMatch(/try \{\n\s*win = this\.buildPanelWindow\(request\);\n\s*await win\.loadURL\(page\.url\);/u);
    expect(create).toContain("if (win) this.discardWindow(request.id, win);");
    expect(create).toContain("else this.deps.route.unmount(request.id);");
  });

  it("关窗推进代际并同步封存认领，延迟一拍按快照精确收尾", () => {
    // 不取代际就会把「关掉面板立刻再点运行」刚接手的服务当孤儿收掉
    expect(panelWindow).toContain("private readonly runGenerations = new Map<string, number>();");
    expect(panelWindow).toContain("noteRunStarted(appId: string): number {");
    expect(panelWindow).toContain("isRunCurrent(appId: string, generation: number): boolean {");
    const closedHandler = panelWindow.slice(panelWindow.indexOf('win.on("closed"'), panelWindow.indexOf("private schedulePersist"));
    // 关闭本身就是「这一轮结束」：推进代际（在途的运行据此作废）。停止范围不靠代际，
    // 而是靠当拍抓到的快照（runner 按记录 id + 认领序号排除重开后的新认领）。
    expect(closedHandler).toContain("this.noteRunStarted(request.id);");
    expect(closedHandler).toContain("this.deps.prepareClosed?.(request.id);");
    // 「先起服务再开窗」第一步（start 的 IPC 先到）也必须推进代际，否则那一拍会误杀
    expect(main).toContain("const generation = request.ownerPanelId ? panelWindows?.noteRunStarted(request.ownerPanelId) : undefined;");
  });

  it("服务就绪回来时本轮已作废（等就绪期间用户关窗）→ 返回取消，不去重开刚关的窗口", () => {
    const start = main.slice(main.indexOf('ipcMain.handle("gallery:service-start"'), main.indexOf('ipcMain.handle("gallery:service-stop"'));
    // 代际在 await 之前取、在 await 之后结算：中间可能过了整个「等就绪」预算
    expect(start.indexOf("noteRunStarted")).toBeLessThan(start.indexOf("await ensureGalleryServices().start(request)"));
    expect(start).toContain("if (generation !== undefined && request.ownerPanelId && panelWindows && !panelWindows.isRunCurrent(request.ownerPanelId, generation)) {");
    expect(start).toContain('return { ok: false, message: "面板已经关闭，这次运行不再继续" };');
    // 取消时不去动服务：那一条属于关窗收尾或下一轮运行，这里停会误杀
    expect(start).not.toContain("stopByOwner");
    expect(start).not.toContain("stop(");
  });

  it("服务就绪与开窗之间关窗时传递并验证运行代际，旧请求不能重开窗口", () => {
    expect(main).toContain("{ ...result, panelRunToken: generation }");
    expect(app).toContain("started.panelRunToken");
    expect(app).toContain("...(runToken !== undefined ? { runToken } : {})");
    expect(main).toContain('typeof input?.runToken === "number" ? { runToken: input.runToken } : {}');
    expect(panelWindow).toContain("request.runToken !== this.runGeneration(request.id)");
    expect(main).toContain("!result.stale");
  });

  it("失败路径不冒充「窗口真的关了」：丢弃窗口时抑制关窗收尾（同一服务不能停两遍）", () => {
    expect(panelWindow).toContain("private discardWindow(id: string, win: BrowserWindow): void {");
    expect(panelWindow).toMatch(/if \(this\.windows\.get\(request\.id\) !== win\) return;/u);
    // mount/unmount 成对：丢弃窗口与 closed 两条路径都摘挂载（unmount 幂等，重复摘不会出错）
    const discard = panelWindow.slice(panelWindow.indexOf("private discardWindow"), panelWindow.indexOf("private async createPanelWindow"));
    expect(discard).toContain("this.deps.route.unmount(id);");
    const closedHandler = panelWindow.slice(panelWindow.indexOf('win.on("closed"'), panelWindow.indexOf("private schedulePersist"));
    expect(closedHandler).toContain("this.deps.route.unmount(request.id);");
    expect(closedHandler).toContain("this.deps.prepareClosed?.(request.id);");
  });

  it("核心时序有假窗口行为测试（不只源码断言）", () => {
    const behavior = read("panel-window.test.ts");
    expect(behavior).toContain('vi.mock("electron"');
    expect(behavior).toContain("loadAttempts");
    for (const scenario of ["首次运行", "再次运行但不 reload", "reload 时入口换了", "加载失败", "入口校验失败", "建窗抛错", "加载期间用户关窗", "关窗后立刻重开", "关闭推进代际", "关窗收尾在下一个 tick 执行"]) {
      expect(behavior).toContain(scenario);
    }
  });
});
