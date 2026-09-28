import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 浏览器标签面板恢复的接线契约（2026-09-28 用户报告的修复）。
 *
 * 用户实测：AI 绑定标签后（bind 时 reveal 一次）后续 navigate 全走快速路径，
 * 面板一旦被关/渲染端重载丢状态，AI 的浏览器操作对用户完全不可见。修复分三处，
 * 其中渲染端与主进程 handler 都没有可跑的单测环境（App 是大组件、index.ts 依赖
 * Electron）——这里用源断言钉住三件事：bootstrap 带标签清单、store 水合、App
 * 一次性恢复且不自动开面板。reveal 档位语义由 browser-automation.test.ts 与
 * lib/browser-reveal.test.ts 覆盖。
 */
describe("browser tabs bootstrap wiring contract", () => {
  // 源码是 CRLF：读入即归一化，否则多行断言永远匹配不上。
  const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(new RegExp("\r\n", "gu"), "\n");
  const mainIndex = read("index.ts");
  const store = read("../renderer/src/store.ts");
  const app = read("../renderer/src/App.tsx");

  it("主进程 bootstrap 回传主进程存活的浏览器标签清单", () => {
    const block = mainIndex.slice(mainIndex.indexOf('ipcMain.handle("desktop:bootstrap"'), mainIndex.indexOf('ipcMain.handle("appearance:theme-import"'));
    expect(block).toContain("browserTabs: browserPreviewController?.tabIds() ?? []");
  });

  it("store 水合 restoredBrowserTabs（bootstrap.browserTabs 缺省为空数组）", () => {
    const block = store.slice(store.indexOf("async initialize()"));
    expect(block).toContain("restoredBrowserTabs: bootstrap.browserTabs ?? []");
  });

  it("App 启动时一次性把缺失的标签补回面板，且不自动开面板（when-hidden reveal 兜底）", () => {
    const block = app.slice(app.indexOf("browserTabsRestoreDoneRef"));
    expect(block).toContain("restoredBrowserTabs");
    expect(block).toContain("setPreview((current)");
    // 不自动开面板：恢复块里不许碰 setPreviewOpened。
    const effectBody = block.slice(0, block.indexOf("}, [ready]);"));
    expect(effectBody).not.toContain("setPreviewOpened");
  });

  it("automation-started 事件按 reveal 档位条件展开（when-hidden 不拉回正在看其他标签的用户）", () => {
    const block = app.slice(app.indexOf("onBrowserTabsChanged"), app.indexOf("onSshReveal"));
    expect(block).toContain('event.reveal !== "force"');
    expect(block).toContain("shouldRevealBrowserTab");
  });
});
