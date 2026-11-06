import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 安装版单实例锁的接线契约（源码断言型测试，2026-11-07）。
 *
 * 用户报障：双击安装后的 exe 图标会再起一个 ChatAnyTime，而不是回到已经开着的窗口。
 * 这条链路横跨 Electron 的生命周期（index.ts 在 vitest 里起不来，同先例：
 * panel-wiring.test.ts / browser-preview-visibility-wiring.test.ts 都是源码断言），
 * 而这里的每一处都是**静默失效**：顺序错了不报错，只是「第二次双击没反应」或
 * 「两个实例又出现了」。
 *
 * 钉住四件事：
 *  1. 守卫必须在 `app.whenReady()` 之前安装（锁要早抢，second-instance 要早注册）；
 *  2. 只有安装版启用（isPackaged 门）——dev 与安装版并行是日常开发流程；
 *  3. 次实例用 `app.exit(0)` 立即终止（实测 `app.quit()` 之后 whenReady 仍会 resolve，
 *     会继续建 runtime 与窗口）；whenReady 里还要有 primary 守卫做纵深防御；
 *  4. 启动期排队的激活必须在 `createWindow()` 之后补发，激活动作就是 `showMainWindow`。
 */

const here = dirname(fileURLToPath(import.meta.url));

// 源码行尾在本地工作区（LF）与 CI 检出（CRLF）之间不一致：读入即归一化。
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n/gu, "\n");

const main = read("index.ts");
const guard = read("single-instance.ts");

describe("安装版单实例锁的接线", () => {
  it("守卫在 app.whenReady() 之前安装", () => {
    const installAt = main.indexOf("installSingleInstanceGuard({");
    const readyAt = main.indexOf("app.whenReady().then(");
    expect(installAt).toBeGreaterThan(0);
    expect(readyAt).toBeGreaterThan(0);
    expect(installAt).toBeLessThan(readyAt);
    // second-instance 必须在 ready 之前注册：启动早期到达的第二次双击不能丢
    expect(main.indexOf('app.on("second-instance"')).toBeLessThan(readyAt);
  });

  it("只有安装版启用：isPackaged 由 app.isPackaged 注入，模块里是一道门", () => {
    expect(main).toContain("isPackaged: app.isPackaged");
    expect(guard).toContain("if (!host.isPackaged) return");
  });

  it("次实例用 app.exit(0) 立即终止，而不是 app.quit()", () => {
    // 实测（electron 43.2.0）：quit 之后 whenReady 仍会 resolve，次实例会继续建窗口；
    // exit(0) 才不触发 before-quit / will-quit 且其后的代码不再执行。
    expect(main).toContain("exit: (code) => app.exit(code)");
    expect(guard).toContain("host.exit(0)");
    // 模块不接受 quit 注入：只保留「立即终止」这一条退出口径
    expect(guard).not.toContain("host.quit");
    // 次实例不注册 second-instance（它不该被唤起），也不激活任何窗口
    expect(guard).toContain("return { primary: false, flushPendingActivation: noop };");
  });

  it("whenReady 回调首行有 primary 守卫，且早于 createWindow", () => {
    const readyAt = main.indexOf("app.whenReady().then(");
    const primaryAt = main.indexOf("if (!singleInstance.primary) return;");
    const windowAt = main.indexOf("createWindow();", readyAt);
    expect(primaryAt).toBeGreaterThan(readyAt);
    expect(windowAt).toBeGreaterThan(readyAt);
    expect(primaryAt).toBeLessThan(windowAt);
  });

  it("启动期排队的激活在 createWindow 之后补发，激活就是 showMainWindow", () => {
    const readyAt = main.indexOf("app.whenReady().then(");
    const windowAt = main.indexOf("createWindow();", readyAt);
    const flushAt = main.indexOf("singleInstance.flushPendingActivation();", readyAt);
    expect(flushAt).toBeGreaterThan(windowAt);
    expect(main).toContain("activate: () => showMainWindow()");
    // flush 自身也要等 ready：启动完成前补发会在 createWindow 里抛错
    expect(guard).toContain("if (!pending || !host.isReady()) return;");
  });

  it("requestSingleInstanceLock 在 main 里只有一个入口，且挂在这个守卫上", () => {
    // 只数真正调用 Electron API 的地方（注释里提到方法名不算入口）
    expect(main.match(/app\.requestSingleInstanceLock\(/gu) ?? []).toHaveLength(1);
    expect(main).toContain("requestLock: () => app.requestSingleInstanceLock()");
  });

  it("second-instance 经注入点注册，回调忽略参数只做唤回", () => {
    expect(main).toContain('onSecondInstance: (listener) => { app.on("second-instance", () => listener()); }');
    // 排队语义：ready 之前只记标记，ready 之后才激活
    expect(guard).toContain("if (!host.isReady()) {\n      pending = true;\n      return;\n    }\n    host.activate();");
  });
});
