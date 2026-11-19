import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 服务型作品「运行」的接线契约（源码断言型测试）。
 *
 * 为什么是源码断言：这条链路横跨渲染端 App.tsx、preload、主进程 ipcMain、主进程的
 * 后台进程管理器与退出钩子五处，而 App.tsx 是全应用最大的组件（渲染它要一整套
 * store/IPC 假件，测试价值与成本不成比例）。同先例：gallery-activation.test.ts。
 *
 * 2026-11-12 重写：服务的进程从「预览面板里的终端标签（PTY）」改到「主进程的后台
 * 进程」（`gallery-service-runner.ts`）。用户的原话是「这些服务不应该占标签页，因为我
 * 很可能会关掉页面；但作为后台进程我没地方能看到」——所以这里钉的是三条**静默失效**
 * 类风险（不报错、不崩溃，只是功能不出效果）：
 *
 *  1. 渲染端不许再为作品开终端标签（`openTerminalPreviewRef` / galleryServiceTerminalId
 *     一旦回来，服务又会被关标签杀掉）；
 *  2. 起服务必须把 cwd / command / url 一起交给主进程（漏字段 = 起错目录或起不来）；
 *  3. 应用退出必须把后台进程全停掉（不留孤儿进程），且状态要能在渲染端重载后恢复。
 *
 * 读入即归一化行尾：CI（core.autocrlf=true）检出 CRLF，硬编码 `\n` 的跨行断言会假红。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n/gu, "\n");
const app = read("../renderer/src/App.tsx");
const preload = read("../preload/index.ts");
const main = read("index.ts");
const protocol = read("../shared/protocol.ts");
const runner = read("gallery-service-runner.ts");
const store = read("../renderer/src/store.ts");

describe("服务型作品运行：后台进程（不再有终端标签）", () => {
  it("渲染端把启动命令交给主进程的后台服务通道（appId / 命令 / 目录一个不能少）", () => {
    expect(app).toContain("await window.piDesktop.galleryServiceStart(request);");
    expect(app).toContain("const request = {\n      appId: app.id,\n      title: app.title,\n      command: plan.command,\n      cwd: plan.directory,");
    // 反面：谁把作品服务接回终端标签，服务就又会被「关标签」杀掉
    expect(app).not.toContain('galleryServiceTerminalId');
    expect(app).not.toContain('openTerminalPreviewRef');
  });

  it("就绪后是否开页面由 plan.openPage 决定（纯后台服务不弹页面）", () => {
    expect(app).toMatch(/if \(plan\.openPage && app\.url\) \{/u);
    // 没有页面可开时要记一次运行并指向看板（否则用户点完运行看不到任何反馈）
    expect(app).toContain("可在作品墙「运行中的服务」查看日志、停止或重启");
  });

  it("三条通道名两端一致（拼错只会在运行时抛「No handler registered」）", () => {
    for (const channel of ["gallery:service-start", "gallery:service-stop", "gallery:service-restart"]) {
      expect(preload).toContain(`ipcRenderer.invoke("${channel}"`);
      expect(main).toContain(`ipcMain.handle("${channel}"`);
    }
    expect(protocol).toContain("galleryServiceStart(input: GalleryServiceStartRequest): Promise<GalleryServiceStartResult>;");
    expect(protocol).toContain("galleryServiceStop(id: string): Promise<boolean>;");
    expect(protocol).toContain("galleryServiceRestart(id: string): Promise<GalleryServiceStartResult>;");
  });

  it("主进程侧用注入式启动器与进程树回收（不经过 PTY）", () => {
    expect(main).toContain("launch: createShellLauncher(),");
    expect(main).toContain("killTree: (pid) => killProcessTree(pid),");
    // 旧的终端持有方式是「创作服务标签并等它的退出记录」，那个入口必须消失
    expect(app).not.toContain("galleryAwaitService({ url: plan.url, terminalId");
  });
});

describe("后台服务生命周期", () => {
  it("应用退出（before-quit）把所有后台进程停掉，不留孤儿", () => {
    expect(main).toContain("galleryServices?.disposeAll();");
    // 顺序上必须在 quitting 之后、且与其它 disposer 同处一个钩子（写成独立钩子会漏掉 dev 退出路径）
    expect(main).toMatch(/app\.on\("before-quit", \(\) => \{\n\s+quitting = true;/u);
  });

  it("渲染端订阅 gallery.services 并整表替换；重载后靠 bootstrap 补一帧", () => {
    expect(store).toContain('case "gallery.services":');
    expect(store).toContain("galleryServices: message.services");
    expect(store).toContain("galleryServices: bootstrap.galleryServices ?? get().galleryServices");
    expect(protocol).toContain("galleryServices?: GalleryServiceRecord[];");
    expect(main).toContain("galleryServices: galleryServices?.list() ?? []");
  });

  it("服务状态推送是合并帧（一个话痨 dev server 不能每秒推几十帧）", () => {
    expect(main).toContain("galleryServicesTimer = setTimeout(() => {");
    expect(main).toContain('mainWindow.webContents.send("runtime:message", { type: "gallery.services", services } satisfies RuntimeMessage);');
  });

  it("看板行的四种动作在看板源码里都接上了（停止 / 打开页面 / 日志 / 重启）", () => {
    const board = read("../renderer/src/components/GalleryServicesBoard.tsx");
    for (const control of ["gallery-service-open", "gallery-service-log", "gallery-service-restart", "gallery-service-stop"]) {
      expect(board).toContain(`data-control="${control}"`);
    }
    expect(board).toContain('data-pane="gallery-services"');
    // 已结束的记录也要留在看板上（「为啥没起来」只能从这里看）
    expect(board).toContain('data-status={service.status}');
  });
});

describe("后台服务管理器（runner）自身的硬约束", () => {
  it("同作品同命令复用、命令变了先停旧再起新（避免同端口叠两个进程）", () => {
    expect(runner).toContain("const same = existing.record.command === command && existing.record.cwd === cwd;");
    // 宽限预算走注入值（deps.stopGraceMs，生产缺省 = GALLERY_SERVICE_STOP_GRACE_MS），
    // 否则单测注入的假宽限根本不起作用（2026-11-16 计划 4.4）。
    expect(runner).toContain("this.stop(existing.record.id);\n      await this.awaitExit(existing, this.stopGraceMs);");
  });

  it("地址已可达时不碰别人的进程（external）", () => {
    expect(runner).toContain("return { ok: true, reused: false, external: true };");
  });

  it("停止只走进程树回收（先单杀 shell 会断掉父子关系，孙进程反而活下来）", () => {
    // 2026-11-12 真实进程集成测试逮到的竞态：taskkill /T 是异步 spawn，而
    // child.kill() 是同步的 —— 两条一起发就等于先打死 shell，node 孙子进程变孤儿。
    expect(runner).toContain("this.deps.killTree(pid);");
    // 反证：stop() 里不许出现「killTree 之后又 handle.kill()」的组合
    expect(runner).not.toMatch(/this\.deps\.killTree\(pid\);\s*\}\n\s*try \{\n\s*entry\.handle\?\.kill\(\);/u);
    expect(runner).toContain("停止命令没有生效，进程可能仍在运行");
    expect(runner).toContain("isProcessAlive(entry.record.pid)");
  });

  it("日志走环形缓冲 + 剥 ANSI（看板里放的必须是能读的文本）", () => {
    expect(runner).toContain("entry.buffer = tail(entry.buffer + chunk, this.logBufferChars);");
    expect(runner).toContain("export function galleryServiceLogTail");
    expect(runner).toContain("stripAnsi(buffer)");
  });
});

describe("作品运行的可观测性（不许静默失败、不许无反馈）", () => {
  it("起服务前先给「正在启动…」横幅（就绪预算最长 30 秒，没反馈就是「点了没反应」）", () => {
    expect(app).toContain("正在后台启动本地服务…（最多等 ${GALLERY_SERVICE_WAIT_SECONDS} 秒，就绪后自动打开面板）");
    expect(app).toContain("正在后台启动服务…（最多等 ${GALLERY_SERVICE_WAIT_SECONDS} 秒");
    // 秒数必须与主进程的就绪预算同源（写死数字过段时间就会和真值分叉）
    expect(app).toContain("const GALLERY_SERVICE_WAIT_SECONDS = Math.round(GALLERY_SERVICE_WAIT_MS / 1000);");
  });

  it("失败必提示：先撤「正在启动…」横幅再报错（两条横幅不能同时挂在屏幕上）", () => {
    expect(app).toMatch(/const galleryRunFailed = useCallback\(\(message: string\): void => \{\n\s+setGalleryToast\(undefined\);\n\s+setMessageActionError\(message\);/u);
    expect(app).toContain("galleryRunFailed(plan.message ??");
    // 两条「起服务」失败分支都要走它（只查一处会被另一处的写法掩盖）
    expect(app).toContain("        if (!started.ok) {\n          galleryRunFailed(started.message);\n          return;\n        }\n        if (await openGalleryPanel");
    expect(app).toContain("        if (!started.ok) {\n          galleryRunFailed(started.message);\n          return;\n        }\n        if (plan.openPage && app.url)");
    expect(app).toContain('galleryRunFailed(error instanceof Error ? error.message : "运行作品失败");');
  });

  it("面板这一轮作废（stale）要明说，不能静默 return", () => {
    expect(app).toContain("这一轮运行已作废（面板已关闭或又开了一轮），需要重开请再点一次运行。");
    // 反面：不许再回到「stale 直接 return false」的静默写法
    expect(app).not.toContain("if (result.stale) return false;");
  });

  it("服务日志走 GBK 回退解码（中文路径的报错必须可读）", () => {
    expect(runner).toContain("new GalleryServiceOutputDecoder(legacyEncodings)");
    // 反面：String(chunk) 是「中文日志全变乱码」的根因
    expect(runner).not.toContain("listener(String(chunk))");
  });
});
