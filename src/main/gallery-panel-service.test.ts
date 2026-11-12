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
    expect(app).toMatch(/if \(!\(await openGalleryPanel\(app, plan\.absolutePath, plan\.options\)\)\) \{/u);
  });

  it("开窗失败就收掉刚起的服务（不留没有主人的后台进程）", () => {
    expect(app).toMatch(/^\s*if \(started\.service\) void window\.piDesktop\.galleryServiceStop\(started\.service\.id\);$/mu);
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
  it("主进程按 owner 停服务并刷新看板（不再 kill 终端会话）", () => {
    expect(main).toMatch(/^\s*galleryServices\?\.stopByOwner\(appId\);$/mu);
    expect(main).toMatch(/^\s*pushGalleryServices\(\);$/mu);
    expect(main).not.toContain('terminalManager.handle({ type: "kill", terminalId: closedTerminalId');
  });

  it("窗口控制器的 closed 回调只带作品 id（ownerPanelId 已经表达了归属）", () => {
    expect(panelWindow).toContain("onClosed?: (appId: string) => void;");
    expect(panelWindow).toMatch(/^\s*notify\(request\.id\);$/mu);
    // 推迟到下一个 tick：closed 还在 Electron 销毁窗口的同步栈里
    expect(panelWindow).toContain("setImmediate(() => {");
  });

  it("面板入参三处镜像一致：DesktopApi / preload / ipcMain（没有服务会话字段）", () => {
    expect(protocol).toContain("galleryOpenPanel(input: { id: string; title: string; workspace: string; filePath: string; panel?: GalleryPanelOptions }): Promise<{ ok: boolean; message?: string }>;");
    expect(preload).toContain('galleryOpenPanel: (input: { id: string; title: string; workspace: string; filePath: string; panel?: GalleryPanelOptions }) => ipcRenderer.invoke("gallery:open-panel", input)');
    expect(main).toContain('ipcMain.handle("gallery:open-panel"');
  });
});
