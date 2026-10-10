import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 面板作品（kind=panel）的接线契约（源码断言型测试，2026-09-26）。
 *
 * 为什么是源码断言：这条链路横跨 App.tsx / preload / 主进程 / utility 四处，而
 * 四个文件里有三个在 vitest 里起不来（App.tsx 要整套 store 假件、index.ts 与
 * pi-runtime.ts 依赖 Electron 与 utility 宿主）。同先例：gallery-run-wiring.test.ts、
 * session-index-wiring.test.ts。
 *
 * 这里钉的都是**静默失效**类风险——不报错、不崩溃，功能就是不出效果：
 *  1. 面板页必须由 panelProtocolRoute 在固定 origin 上服务（2026-10-10 之前是控制器
 *     自带的 loopback 静态服务，端口每次启动都变 ⇒ 作品数据看着像「丢了」）。
 *  2. 关闭到后台必须有 `quitting` 短路：没有它，`app.quit()` 先走 close 被拦下，
 *     托盘菜单的「退出」永远退不掉。
 *  3. 面板窗口不能带 preload：数据走虚拟端点，带了 preload 等于白白多一个提权面。
 *  4. utility 的 sessions.live 必须在会话建立/销毁与生命周期转换处发出：漏一处就是
 *     「面板永远停在旧状态」或「面板挂着一条幽灵会话」。
 */

const here = dirname(fileURLToPath(import.meta.url));

// 源码行尾在本地工作区（LF）与 CI 检出（CRLF，windows runner 的 core.autocrlf）之间不一致：
// 读入即归一化，否则跨行断言在 CI 上永远匹配不上（同 browser-preview-visibility-wiring 的做法）。
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n/gu, "\n");

const main = read("index.ts");
const preload = read("../preload/index.ts");
const app = read("../renderer/src/App.tsx");
const runtime = read("pi-runtime.ts");
const panelWindow = read("panel-window.ts");
const panelBounds = read("panel-bounds.ts");
const panelCors = read("panel-cors.ts");
const staticServer = read("browser-static-server.ts");
const tray = read("tray.ts");
const sharedPanel = read("../shared/panel.ts");
const protocolRoute = read("panel-protocol.ts");
const storage = read("panel-storage.ts");

describe("面板窗口的主进程接线", () => {
  it("IPC 通道两端同名，且入口路径由主进程复核", () => {
    expect(preload).toContain('ipcRenderer.invoke("gallery:open-panel", input)');
    expect(main).toContain('ipcMain.handle("gallery:open-panel"');
    // 渲染端传来的路径不可全信：面板挂载整个工作区，越界入口必须在主进程被拒
    expect(panelWindow).toContain("validatePanelEntry");
    expect(panelWindow).toContain("面板作品的入口必须在当前工作区内");
  });

  it("面板页由协议路由在固定 origin 上服务（不再用随机端口静态服务）", () => {
    // 挂载先于加载：页面一开就会请求自己的资产与端点
    expect(panelWindow).toContain("this.deps.route.mount({ appId: request.id, workspace: request.workspace })");
    expect(panelWindow).toContain("const url = panelWorkUrl(host, entryRelative);");
    // 反向：面板不能再碰 loopback 静态服务（它是随机端口 origin 的根源）
    expect(panelWindow).not.toContain("BrowserStaticServer");
    expect(panelWindow).not.toContain("urlForFile");
    // 窗口关闭要摘挂载（否则已关窗口的地址继续可服务）
    expect(panelWindow).toContain("this.deps.route.unmount(request.id);");
    // 源上：index.ts 按 host 分流到协议路由，且面板挂载表常驻模块级
    expect(main).toContain("if (isPanelRequest(request.url)) return panelProtocolRoute.handle(request);");
    expect(main).toContain("const panelProtocolRoute = new PanelProtocolRoute({");
    expect(main).toContain("route: panelProtocolRoute,");
    // 固定 origin 的唯一来源（作品 id），不得在别处手拼字符串
    expect(storage).toContain("${PREVIEW_FILE_SCHEME}://${panelWorkHost(appId)}");
  });

  it("面板窗口无 preload（数据走 HTTP 端点，不需要提权面）", () => {
    expect(panelWindow).not.toMatch(/webPreferences:\s*\{[^}]*preload/u);
    expect(panelWindow).toContain("contextIsolation: true");
    expect(panelWindow).toContain("nodeIntegration: false");
    expect(panelWindow).toContain("sandbox: true");
  });

  it("内置浏览器预览也接同一端点（AI 写面板作品时要能当场看到数据）", () => {
    expect(main).toContain("browserAutomationController.setPanelStateEndpoint(panelStateEndpoint());");
  });

  it("utility 推送无条件喂给面板缓存（面板活在「渲染端不在线」的场景里）", () => {
    expect(main).toMatch(/runtimeProcess\.on\("message"[\s\S]*?panelState\.ingest\(message\);/u);
    // 未注册面板窗口时 ingest 也照跑：缓存不能依赖「有人打开了面板」。
    expect(main).not.toMatch(/panelWindows\s*&&[^\n]*panelState\.ingest/u);
  });
});

describe("关闭到后台（关闭主窗口 ≠ 退出应用）", () => {
  it("close 处理器带 quitting 短路 + preventDefault + 懒建托盘", () => {
    expect(main).toContain("if (quitting) return;");
    expect(main).toContain("event.preventDefault();");
    expect(main).toContain("ensureTray().isActive()");
    expect(main).toMatch(/nextWindow\.on\("close", \(event\) => \{/u);
    // 托盘建不起来且也没有活着的面板窗口时不隐藏：隐藏后用户回不去（任务栏也没有按钮了）
    expect(main).toContain("if (!ensureTray().isActive() && !panelWindows?.hasOpenWindows())");
    expect(tray).toContain("isActive(): boolean {");
    expect(panelWindow).toContain("hasOpenWindows(): boolean {");
  });

  it("before-quit 置标志、清理面板与托盘、保留既有清理链", () => {
    expect(main).toContain("quitting = true;");
    expect(main).toContain("panelWindows?.dispose();");
    expect(main).toContain("trayController?.dispose();");
    // 既有链路不能丢（退出时漏掉任何一个都是资源泄漏或数据未落盘）
    for (const kept of ["settingsPersistence?.flush();", "terminalManager.disposeAll();", "runtimeProcess?.kill();"]) {
      expect(main).toContain(kept);
    }
  });

  it("回到主界面只有一条实现（托盘/面板按钮/通知点击都走它）", () => {
    expect(main).toContain("function showMainWindow(): void {");
    // 面板动作白名单在 main 侧落地：show-main 唤回主界面，窗口级动作（close/toggle）
    // 不在这里处理（它们属于面板窗口控制器，预览端点拒绝并回 403）。
    expect(main).toMatch(/if \(action === "show-main"\) \{[\s\S]{0,80}?showMainWindow\(\);[\s\S]{0,80}?return true;[\s\S]{0,80}?\}\s*return false;/u);
    // 三个入口都必须接到它上面（漏一个就是「某个入口回不去」）：通知点击、托盘、面板端点
    expect(main).toContain('notification.on("click", () => showMainWindow());');
    expect(main).toContain("onOpen: () => showMainWindow(),");
  });

  it("publish→persist 不在中途丢掉 panel（对话框/工具声明的窗口偏好必须落盘）", () => {
    // 发布入口有两个（AI 工具与实体对话框）但都汇到 publishGalleryApp；它只往
    // `app` 上拷自己认识的字段，漏一行就是「填了尺寸、存下来没有」的静默失效。
    expect(runtime).toMatch(/if \(draft\.kind === "panel" && draft\.panel\) app\.panel = draft\.panel;/u);
  });

  it("sessions.live 不转发给渲染端（那边零消费，只白付一次结构化克隆）", () => {
    expect(main).toContain('if (message.type !== "sessions.live") mainWindow?.webContents.send("runtime:message", message);');
  });
});

describe("utility 侧的 sessions.live 推送", () => {
  it("生命周期转换跟着 scheduleEmit 走（入口处一次覆盖所有调用点）", () => {
    const body = /function scheduleEmit\(immediate: boolean\): void \{([\s\S]*?)\n\}/u.exec(runtime)?.[1] ?? "";
    expect(body).toContain("scheduleLiveEmit(immediate);");
    // 必须在最前面：放在末尾的话，immediate 分支的早退会把它跳过去。
    expect(body.indexOf("scheduleLiveEmit(immediate);")).toBeLessThan(body.indexOf("if (immediate) {"));
  });

  it("会话建立与销毁立即播一次（否则面板会缺一条或多一条幽灵）", () => {
    expect(runtime).toMatch(/liveSessions\.set\(result\.session\.sessionId, record\);[\s\S]{0,200}?scheduleLiveEmit\(true\);/u);
    expect(runtime).toMatch(/liveSessions\.delete\(record\.session\.sessionId\);[\s\S]{0,600}?scheduleLiveEmit\(true\);/u);
  });

  it("todo 变化与列表刷新也会刷新面板投影", () => {
    const emitTodos = /function emitTodos\(\): void \{([\s\S]*?)\n\}/u.exec(runtime)?.[1] ?? "";
    expect(emitTodos).toContain("scheduleLiveEmit(true);");
    // 列表刷新（重命名/新话题）后也要播一次，否则面板标题要等到下次工具活动才改
    expect(runtime).toMatch(/function performSessionsRefresh\(\)[\s\S]*?scheduleLiveEmit\(true\);/u);
  });

  it("推送载荷是轻量投影（不含消息正文与工具输出）", () => {
    expect(runtime).toContain('post({ type: "sessions.live", sessions: buildLiveSessions() });');
    expect(runtime).toContain("function buildLiveSessions(): PanelSessionLive[] {");
    expect(runtime).toContain("todoSummary: summarizeTodos(todos)");
  });
});

describe("面板窗口的窗口级动作（close / toggle）", () => {
  it("白名单与静态服务：请求 Referer 传给 endpoint（内置浏览器预览那条通路不变）", () => {
    expect(sharedPanel).toContain('"show-main", "close", "toggle", "grow", "shrink", "reset-size", "resize"');
    expect(staticServer).toContain("action: (panelRequest: PanelRequest, context: { referer?: string }) => boolean");
    expect(staticServer).toMatch(/endpoint\.action\(panelRequest, \{ referer:[^}]*\}\)/u);
    // 端点解析出的是「请求」而不是裸动作名：resize 要带尺寸
    expect(staticServer).toContain("const panelRequest = parsePanelRequest(parsed);");
    // 协议路由同样只接受白名单动作（两处共用同一个纯函数，不得各自实现一份）
    expect(protocolRoute).toContain("const panelRequest = parsePanelRequest(parsed);");
  });

  it("控制器按 host 认领窗口级请求（appId 由端点回调传入），show-main 才转主进程回调", () => {
    expect(panelWindow).toContain('handleAction(id: string, request: Exclude<PanelRequest, { action: "show-main" }>): boolean');
    // Referer 定位已废除：自定义协议的请求里拿不到它（真机实测），host 才是唯一确定的身份
    expect(panelWindow).not.toContain("referer");
    expect(main).toContain('if (panelRequest.action === "show-main") return handlePanelAction("show-main");');
    expect(main).toContain("return panelWindows?.handleAction(context.appId, panelRequest) ?? false;");
    // 关错窗比不关更糟：host 对应的窗口不在了就拒绝
    expect(panelWindow).toMatch(/handleAction\(id: string[\s\S]{0,400}?if \(!win \|\| win\.isDestroyed\(\)\) return false;/u);
    // toggle 只属于抽屉：普通窗口/桌宠没有两态，拒绝而不是无声吞掉。
    expect(panelWindow).toContain('if (mode !== "drawer") return false;');
    expect(panelWindow).toMatch(/win\.setBounds\(collapsedNow \? geometry\.expanded : geometry\.collapsed, true\)/u);
  });

  it("预览端点拒绝窗口级请求，但 resize 现在是一条带参数的正路", () => {
    expect(main).toMatch(/function handlePanelAction\(action: PanelAction\): boolean \{[\s\S]{0,200}?\}\s*return false;/u);
    expect(main).toContain('action: (panelRequest) => (panelRequest.action === "show-main" ? handlePanelAction("show-main") : false)');
  });
});

describe("面板窗口的跨域放宽（panel-cors）", () => {
  it("在第一个面板窗口创建时懒装（不开面板的用户不该付网络回调的代价）", () => {
    expect(main).toContain("ensurePanelCorsRelaxation();");
    expect(main).toMatch(/panelWindows \?\?= new PanelWindowController\(\{[\s\S]{0,600}?\}\);\n\s*\/\/[^\n]*\n\s*ensurePanelCorsRelaxation\(\);/u);
    // 幂等：重复调用不会注册第二遍
    expect(main).toContain("if (panelCorsInstalled) return;");
  });

  it("只对面板窗口生效（内置浏览器预览是正常浏览器，不能放宽）", () => {
    expect(main).toContain("isPanelWebContents: (webContentsId) => panelWindows?.isPanelWebContents(webContentsId) ?? false");
    expect(panelCors).toMatch(/details\.webContentsId === undefined \|\| !deps\.isPanelWebContents\(details\.webContentsId\)/u);
    expect(panelWindow).toContain("isPanelWebContents(webContentsId: number): boolean {");
  });

  it("挂在 defaultSession 的 webRequest 上，只筛 http/https，并清掉失败请求的暂存", () => {
    expect(panelCors).toContain("session.defaultSession.webRequest");
    expect(panelCors).toContain('export const PANEL_CORS_URL_FILTER: string[] = ["http://*/*", "https://*/*"]');
    expect(panelCors).toContain("onBeforeSendHeaders({ urls: PANEL_CORS_URL_FILTER }");
    expect(panelCors).toContain("onHeadersReceived({ urls: PANEL_CORS_URL_FILTER }");
    expect(panelCors).toContain("onErrorOccurred({ urls: PANEL_CORS_URL_FILTER }");
  });

  it("onHeadersReceived 永远回调（漏一次就是请求永久挂起）", () => {
    expect(panelCors).toContain("const respond = (patch: HeadersReceivedResponse): void => {");
    // 三个出口：放行 / 改写 / 异常降级——都是 respond(...)
    const handler = /onHeadersReceived\(\{[\s\S]*?\n  \}\);/u.exec(panelCors)?.[0] ?? "";
    expect(handler.match(/respond\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(handler).toContain("respond({})");
  });

  it("面板开发规范里写清「不需要自己搭代理」（否则下一个面板还会重复造）", () => {
    expect(sharedPanel).toContain("跨域由平台在主进程统一处理，不要自己搭本地代理");
  });
});

describe("面板窗口形态（window / pet / drawer）", () => {
  it("非窗口形态开透明无边框不可缩放窗口，不占任务栏（桌宠/抽屉的窗口外形）", () => {
    expect(panelWindow).toContain('...(mode !== "window" ? { transparent: true, frame: false, resizable: false, skipTaskbar: true } : {})');
    // 桌宠缺省置顶（不置顶的桌宠会被普通窗口吞没）；生效值单一来源。
    expect(panelWindow).toContain("alwaysOnTop: panelEffectiveAlwaysOnTop(request.panel)");
  });

  it("minWidth/minHeight 只给普通窗口：抽屉收起态只有窄把手厚，设了下限收起态就永远出不来", () => {
    expect(panelWindow).toContain('...(mode === "window" ? { minWidth: PANEL_MIN_WIDTH, minHeight: PANEL_MIN_HEIGHT } : {})');
  });

  it("桌宠缩放：grow/shrink/reset-size/resize 只对 pet 生效，尺寸经底部中心锚点后 setBounds", () => {
    expect(panelWindow).toContain('if (mode !== "pet") return false;');
    expect(panelWindow).toMatch(/anchoredPanelBounds\(current, \{ width: request\.width, height: request\.height \}, workArea\)/u);
    expect(panelWindow).toMatch(/anchoredPanelBounds\(current, panelWindowSize\(options\), workArea\)/u);
    expect(panelWindow).toMatch(/scaledPanelBounds\(current, request\.action === "grow" \? PANEL_SCALE_STEP : 1 \/ PANEL_SCALE_STEP, workArea\)/u);
    expect(panelWindow).toContain("win.setBounds(next, true);");
    expect(panelBounds).toContain("export function scaledPanelBounds(");
    expect(panelBounds).toContain("export function anchoredPanelBounds(");
  });

  it("抽屉几何来自 drawerBounds 纯函数且不进坐标记忆（贴边位置由 edge 唯一决定）", () => {
    expect(panelWindow).toMatch(/mode === "drawer"[\s\S]{0,220}?drawerBounds\(request\.panel\?\.edge \?\? "right"/u);
    expect(panelWindow).toMatch(/if \(mode !== "drawer"\) \{[\s\S]{0,120}?win\.on\("move"/u);
    expect(panelBounds).toContain("export function drawerBounds(");
    expect(panelBounds).toContain("export const DRAWER_HANDLE_THICKNESS = 40;");
  });
});

describe("渲染端的运行分流", () => {
  it("open-panel 分支调 galleryOpenPanel 并且只在窗口真的开出来后才记录运行", () => {
    expect(app).toContain('if (plan.action === "open-panel") {');
    expect(app).toMatch(/await window\.piDesktop\.galleryOpenPanel\(\{/u);
    // 顺序钉死：失败提示与 return 必须在 gallery.run 之前（打不开就不算跑过）。
    const branch = app.slice(app.indexOf('plan.action === "open-panel"'), app.indexOf('plan.action === "open-file"'));
    expect(branch).toContain("if (!result.ok)");
    expect(branch).toContain("gallery.run");
    expect(branch.indexOf("if (!result.ok)")).toBeLessThan(branch.indexOf("gallery.run"));
  });
});

describe("作品数据（面板专属）：量测 / 清空 / 删除清理", () => {
  it("IPC 两端同名（preload 与主进程各一处，名字不同就是静默失效）", () => {
    expect(preload).toContain('ipcRenderer.invoke("gallery:data-measure", appId)');
    expect(preload).toContain('ipcRenderer.invoke("gallery:data-clear", appId)');
    expect(main).toContain('ipcMain.handle("gallery:data-measure"');
    expect(main).toContain('ipcMain.handle("gallery:data-clear"');
  });

  it("清空后重载该作品的面板页（页面内存里的旧数据会让用户以为没清掉）", () => {
    expect(main).toMatch(/if \(result\.ok\) panelWindows\?\.reload\(appId\);/u);
    expect(panelWindow).toContain("reload(id: string): void {");
  });

  it("作品从清单消失时关窗并清数据（判定挂在 resources 推送这个唯一汇聚点）", () => {
    expect(main).toContain("pruneRemovedPanelWorks(latestResources, message.resources);");
    expect(main).toMatch(/function pruneRemovedPanelWorks[\s\S]{0,700}?panelWindows\?\.close\(app\.id\);[\s\S]{0,400}?clearPanelData\(app\.id, panelDataDeps\(\)\)/u);
    // 只处理面板作品：file / server 作品的数据不在这些 origin 上
    expect(main).toContain('if (alive.has(app.id) || app.kind !== "panel") continue;');
    expect(main).toContain("if (!previous) return;");
  });

  it("量测复用开着的面板窗口，否则开隐藏窗口；两者都不需要 preload", () => {
    expect(main).toContain("openWebContents: (appId) => panelWindows?.contentsFor(appId),");
    expect(storage).toContain("deps.openWebContents?.(appId)");
    expect(storage).toContain("deps.createMeasureWindow?.(panelMeasureUrl(appId))");
    expect(panelWindow).toContain("contentsFor(id: string): BrowserWindow[\"webContents\"] | undefined {");
  });

  it("渲染端的「数据…」入口只给面板作品（file 作品的 origin 每次运行都不同，别让用户误以为能清）", () => {
    const wall = read("../renderer/src/components/GalleryWall.tsx");
    expect(wall).toContain('app.kind === "panel" && (');
    expect(wall).toContain('data-control="gallery-data"');
    const dialogs = read("../renderer/src/components/GalleryDialogs.tsx");
    expect(dialogs).toContain('data-control="gallery-data-clear"');
    expect(dialogs).toContain("window.piDesktop.galleryDataMeasure(app.id)");
    expect(dialogs).toContain("window.piDesktop.galleryDataClear(app.id)");
  });
});
