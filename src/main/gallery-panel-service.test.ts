import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 「面板作品 + 本地服务」的接线契约（2026-10-11，Git 管理器带出）。
 *
 * 为什么是源码断言型：这条链路横跨渲染端 App.tsx、shared/protocol.ts、preload、
 * main/index.ts 与 main/panel-window.ts 五处，而 App.tsx 与 PanelWindowController
 * 都难以在单测里装配（同先例见 gallery-run-wiring.test.ts 的说明）。
 *
 * 钉住的都是**静默失效**类风险——不报错、不崩溃，只是功能不出效果：
 *  1. 面板的服务必须「探活通过再开窗」（先开窗则页面首次请求必然失败）；
 *  2. 服务会话 id 必须从渲染端交到主进程，否则窗口关闭时无从 kill，服务变成
 *     没人回收的后台进程（用户明确选了「关窗即停」）；
 *  3. kill 之后必须推 `gallery.panel-closed`，否则主界面会留一个「已退出」的孤儿标签；
 *  4. 字段三处镜像（DesktopApi / preload / ipcMain 入参）任何一处拼错都只在运行时炸。
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
  it("start-panel-service 先起服务再开窗，并把服务会话交给主进程", () => {
    expect(app).toContain('plan.action === "start-panel-service"');
    expect(app).toMatch(/if \(!\(await openGalleryPanel\(app, plan\.absolutePath, plan\.options, started\.terminalId\)\)\)/u);
  });

  it("开窗失败就收掉刚起的服务（不留没有主人的后台进程）", () => {
    expect(app).toMatch(/^\s*closePreviewTabRef\.current\(started\.terminalId\);$/mu);
  });

  it("两条开窗路径共用 openGalleryPanel，且服务地址的探测不再写死 server", () => {
    // 面板的 url 同样是探活地址，所以起点探测的判据从 kind==="server" 放开成「有 url」
    expect(app).toContain("const reachable = app.url ? (await window.piDesktop.galleryAwaitService({ url: app.url })).ok : false;");
    expect(app).not.toContain('app.kind === "server" && app.url ?');
    // 直开窗与「先起服务再开窗」共用同一个 helper（否则两处会各自漂）
    expect(app.match(/await openGalleryPanel\(/gu) ?? []).toHaveLength(2);
  });

  it("渲染端订阅 gallery.panel-closed，把残留的服务标签收掉", () => {
    expect(app).toMatch(/^\s*if \(message\.type !== "gallery\.panel-closed" \|\| !message\.terminalId\) return;$/mu);
    expect(app).toMatch(/^\s*closePreviewTabRef\.current\(message\.terminalId\);$/mu);
  });
});

describe("面板窗口关闭 → 停掉平台为它起的服务", () => {
  it("主进程 kill 服务会话并推 gallery.panel-closed 给渲染端", () => {
    // 一律用行首锚定的多行正则：toContain 连「被注释掉的那一行」也算命中，那样反向验证会假绿。
    expect(main).toMatch(/^\s*terminalManager\.handle\(\{ type: "kill", terminalId: closedTerminalId \}\);$/mu);
    expect(main).toMatch(/^\s*mainWindow\.webContents\.send\("runtime:message", \{ type: "gallery\.panel-closed", id: appId, terminalId: closedTerminalId \} satisfies RuntimeMessage\);$/mu);
    // 主界面退到托盘时窗口未销毁，推送照样发得出去；已销毁则不发（否则 send 抛错）
    expect(main).toMatch(/^\s*if \(mainWindow && !mainWindow\.isDestroyed\(\)\) \{$/mu);
  });

  it("窗口控制器在 closed 时回调装配方（推到下一个 tick，不留在窗口销毁栈里），并带上 serviceTerminalId", () => {
    expect(panelWindow).toMatch(/this\.services\.get\(request\.id\);\n\s*this\.services\.delete\(request\.id\);\n\s*if \(notify\) \{\n\s*setImmediate\(\(\) => \{\n\s*try \{\n\s*notify\(request\.id, serviceTerminalId\);/u);
  });

  it("服务会话只在建窗时写入（复用已有窗口不能把服务改写掉）", () => {
    // 复用分支（open 命中已有窗口）里没有写入点：同一个窗口的服务会话是同一个，
    // 后来的「运行」只前置窗口、不重启服务，服务会话必须保持原值。
    expect(panelWindow.match(/this\.services\.set\(/gu) ?? []).toHaveLength(1);
    expect(panelWindow).toMatch(/^\s*if \(request\.serviceTerminalId\) this\.services\.set\(request\.id, request\.serviceTerminalId\);$/mu);
    expect(panelWindow).toMatch(/^\s*this\.services\.delete\(request\.id\);$/mu);
    // closed 回调失败不能影响窗口清理：必须包在 try 里，且不在窗口销毁的同步栈里执行
    expect(panelWindow).toContain("const notify = this.deps.onClosed;");
    expect(panelWindow).toMatch(/setImmediate\(\(\) => \{\n\s*try \{\n\s*notify\(request\.id, serviceTerminalId\);\n\s*\} catch \{/u);
  });

  it("字段三处镜像一致：DesktopApi / preload / ipcMain 入参", () => {
    expect(protocol).toContain("serviceTerminalId?: string }): Promise<{ ok: boolean; message?: string }>;");
    expect(preload).toContain('serviceTerminalId?: string }) => ipcRenderer.invoke("gallery:open-panel", input)');
    expect(main).toContain("serviceTerminalId?: unknown");
    expect(main).toContain("serviceTerminalId\n    });");
  });
});
