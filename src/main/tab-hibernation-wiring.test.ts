import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 标签休眠/复活的接线契约（T12a）。
 *
 * `browser-preview.ts` 直接持有 `WebContentsView`，无法在 vitest 里跑真进程（本文件
 * 所在仓库也没有它的单测）。策略与清扫接线已由 `tab-hibernation.test.ts`（纯函数）与
 * `browser-automation.test.ts`（假预览）覆盖，这里钉住真正容易写错、又只能靠读源码
 * 确认的四件事：休眠时保留地址、复活时把视图与事件接线一起重建、任何命令都打活动
 * 时间戳、以及 dispose 要容忍「没有视图的标签」。
 */
describe("tab hibernation wiring contract", () => {
  // 源码是 CRLF：读入即归一化，否则多行断言永远匹配不上（首版就栽在这）。
  const read = (file: string): string => readFileSync(join(__dirname, file), "utf8").replace(new RegExp("\r\n", "gu"), "\n");
  const preview = read("browser-preview.ts");
  const automation = read("browser-automation.ts");

  it("休眠保留地址与记录，只拆视图（否则复活就无从回到原页面）", () => {
    const block = preview.slice(preview.indexOf("hibernateTab(tabId: string): boolean {"));
    expect(block).toContain("wrapper.hibernated = true");
    expect(block).toContain("wrapper.view = undefined");
    expect(block).not.toContain("this.tabs.delete(tabId)");
  });

  it("三条不可休眠的硬约束都在：正在渲染 / 没有可恢复地址 / 还有待决策的人工下载", () => {
    const block = preview.slice(preview.indexOf("hibernateTab(tabId: string): boolean {"), preview.indexOf("private touchTab("));
    expect(block).toContain("if (wrapper.visible && wrapper.bounds) return false");
    expect(block).toContain('if (!url || url === "about:blank") return false');
    expect(block).toContain("if (record.tabId === tabId) return false");
  });

  it("复活复用 createViewFor（视图与事件接线必须一起重建）", () => {
    const revive = preview.slice(preview.indexOf("private reviveTabIfHibernated("), preview.indexOf("private tryCommand("));
    expect(revive).toContain("this.createViewFor(tabId, wrapper)");
    expect(revive).toContain("wrapper.restoreUrl = url");
    // createTab 也走同一条路（唯一创建视图的地方，避免接线两处漂移）
    expect(preview.indexOf("this.createViewFor(tabId, wrapper)")).toBeLessThan(preview.indexOf("private createViewFor("));
  });

  it("AI 复活的地址恢复由 ensurePageReady await（避免 snapshot 读到半加载页面）", () => {
    const ready = preview.slice(preview.indexOf("async ensurePageReady("), preview.indexOf("isTabRendered(tabId: string)"));
    expect(ready).toContain("await this.navigateTab(tabId, restoreUrl)");
  });

  it("复活挂在「该标签要显示」与「AI 显式要它」两个入口上", () => {
    expect(preview).toContain("if (command.visible) this.reviveTabIfHibernated(tabId, { navigate: true })");
    const ensure = preview.slice(preview.indexOf("ensureTab(tabId: string): BrowserTabView {"));
    expect(ensure.slice(0, 400)).toContain("this.reviveTabIfHibernated(tabId, { navigate: false })");
  });

  it("任何针对标签的命令都刷新活动时间（休眠策略的 LRU 依据）", () => {
    const handle = preview.slice(preview.indexOf("async handle(command: BrowserPreviewCommand)"));
    expect(handle.slice(0, 300)).toContain("this.touchTab(tabId)");
  });

  it("dispose 容忍休眠标签（没有视图可拆）", () => {
    const dispose = preview.slice(preview.indexOf("private disposeTab("), preview.indexOf("private tryCommand("));
    expect(dispose).toContain("const view = tab.view;");
    expect(dispose).toContain("if (view) {");
  });

  it("清扫定时器同时跑「关闭闲置自动化标签」与「休眠闲置用户标签」", () => {
    expect(automation).toContain("this.sweepIdleAutomationTabs();\n      this.hibernateIdleTabs();");
  });

  it("绑定/执行中的标签被算作 inUse（绝不休眠）", () => {
    const sweep = automation.slice(automation.indexOf("hibernateIdleTabs(now = Date.now())"));
    expect(sweep).toContain("inUse: bound.has(info.tabId) || this.busyTabs.has(info.tabId)");
  });
});
