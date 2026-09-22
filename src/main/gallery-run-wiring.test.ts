import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 服务型作品「运行」的接线契约（源码断言型测试，2026-09-23）。
 *
 * 为什么是源码断言：这条链路横跨渲染端 App.tsx、preload、主进程 ipcMain 三处，
 * 而 App.tsx 是全应用最大的组件（渲染它要一整套 store/IPC 假件，测试价值与成本
 * 不成比例）。同先例：gallery-activation.test.ts（pi-runtime 无法 import）、
 * agent-settings-style.test.ts（读渲染端文件）。
 *
 * 这里钉的三条都是**静默失效**类风险——不报错、不崩溃，只是功能不出效果：
 *  1. 服务型作品的终端标签必须走 openPreviewTarget：`openTerminalPreviewRef`
 *     的类型是 (target, id) => void，而 `openTerminalPreview()` 零参数——把两者
 *     接反 **TS 不会报错**（参数少的函数可赋给参数多的类型），运行时 cwd /
 *     initialCommand 被丢掉，于是「运行」只开一个空终端，服务永远起不来。
 *  2. 等待调用必须带 terminalId 与 30 秒预算：不带 terminalId 就失去「启动命令
 *     已退出立即失败」的能力（命令写错也要干等满超时）；不带 timeoutMs 则是无界等待。
 *  3. 通道名必须两端一致：ipcRenderer.invoke 的通道拼错只会在运行时抛
 *     「No handler registered」，Demo 与单测都掩盖不了。
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "../renderer/src/App.tsx"), "utf8");
const preload = readFileSync(join(here, "../preload/index.ts"), "utf8");
const main = readFileSync(join(here, "index.ts"), "utf8");

describe("服务型作品运行接线", () => {
  it("终端标签入口指向 openPreviewTarget（接成 openTerminalPreview 会静默丢 cwd/命令）", () => {
    expect(app).toContain("openTerminalPreviewRef.current = openPreviewTarget;");
    // 反面：接到零参数的 openTerminalPreview 上 TS 不报错，但运行等于没运行
    expect(app).not.toContain("openTerminalPreviewRef.current = openTerminalPreview;");
  });

  it("等待服务就绪时带 terminalId 与预算（退出即失败 + 有界等待）", () => {
    expect(app).toMatch(/galleryAwaitService\(\{\s*url: plan\.url,\s*terminalId,\s*timeoutMs: GALLERY_SERVICE_WAIT_MS\s*\}\)/u);
  });

  it("preload 与主进程共用同一个通道名，且主进程按 exitCode 判「已退出」", () => {
    expect(preload).toContain('ipcRenderer.invoke("gallery:await-service", input)');
    expect(main).toContain('ipcMain.handle("gallery:await-service"');
    // 未创建（status 无 exitCode）不能当成已退出：开标签与等待是两个 IPC
    expect(main).toContain("status.exitCode === undefined ? undefined : {");
  });
});
