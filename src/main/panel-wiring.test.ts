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
 *  1. 面板窗口必须自带静态服务：共用 `BrowserAutomationController` 那个实例的话，
 *     主窗口一关它就 dispose，面板在主界面关掉的瞬间断数据（而那正是它存在的场景）。
 *  2. 关闭到后台必须有 `quitting` 短路：没有它，`app.quit()` 先走 close 被拦下，
 *     托盘菜单的「退出」永远退不掉。
 *  3. 面板窗口不能带 preload：数据走 HTTP 端点，带了 preload 等于白白多一个提权面。
 *  4. utility 的 sessions.live 必须在会话建立/销毁与生命周期转换处发出：漏一处就是
 *     「面板永远停在旧状态」或「面板挂着一条幽灵会话」。
 */

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "index.ts"), "utf8");
const preload = readFileSync(join(here, "../preload/index.ts"), "utf8");
const app = readFileSync(join(here, "../renderer/src/App.tsx"), "utf8");
const runtime = readFileSync(join(here, "pi-runtime.ts"), "utf8");
const panelWindow = readFileSync(join(here, "panel-window.ts"), "utf8");
const panelCors = readFileSync(join(here, "panel-cors.ts"), "utf8");
const tray = readFileSync(join(here, "tray.ts"), "utf8");
const sharedPanel = readFileSync(join(here, "../shared/panel.ts"), "utf8");

describe("面板窗口的主进程接线", () => {
  it("IPC 通道两端同名，且入口路径由主进程复核", () => {
    expect(preload).toContain('ipcRenderer.invoke("gallery:open-panel", input)');
    expect(main).toContain('ipcMain.handle("gallery:open-panel"');
    // 渲染端传来的路径不可全信：面板挂载整个工作区，越界入口必须在主进程被拒
    expect(panelWindow).toContain("validatePanelEntry");
    expect(panelWindow).toContain("面板作品的入口必须在当前工作区内");
  });

  it("面板自带静态服务与状态端点，不共用随主窗口 dispose 的那个实例", () => {
    expect(panelWindow).toContain("private readonly staticFiles = new BrowserStaticServer();");
    expect(panelWindow).toContain("this.staticFiles.setEndpoint(endpoint);");
    // 反向：面板不能去拿 BrowserAutomationController 的静态服务
    expect(panelWindow).not.toContain("browserAutomationController");
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
    // 面板动作白名单在 main 侧落地
    expect(main).toMatch(/if \(action === "show-main"\) showMainWindow\(\);/u);
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
