import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 预览视图可见性的**接线契约**（2026-09-28 原生视图残留事故）。
 *
 * 行为本身由 `browser-preview-visibility.test.ts` 用假 electron 驱动真控制器覆盖；
 * 这里只钉住两件在 vitest 里跑不到、又只能靠读源码确认的事：
 * ① 主进程入口把「渲染端整体重载/崩溃」接到 `hideAllViews()`；
 * ② `bounds` 分支不得为未知标签建视图（这是最容易被顺手改回 `getOrCreate` 的一行，
 *    改回去就等于关标签后会在窗口上复活一个没人管理的空 webContents）。
 *
 * 源码是 CRLF：读入即归一化，否则多行断言永远匹配不上。
 */
describe("preview view visibility wiring", () => {
  const read = (file: string): string => readFileSync(join(__dirname, file), "utf8").replace(new RegExp("\r\n", "gu"), "\n");
  const index = read("index.ts");
  const preview = read("browser-preview.ts");

  it("主渲染端整页导航（dev 热更新 / Ctrl+R）时摘掉所有预览视图", () => {
    const block = index.slice(index.indexOf('nextWindow.webContents.on("did-start-navigation"'));
    expect(block.slice(0, 400)).toContain("if (details.isMainFrame && !details.isSameDocument) previewController.hideAllViews()");
  });

  it("主渲染端渲染进程崩溃时同样摘掉", () => {
    const block = index.slice(index.indexOf('nextWindow.webContents.on("render-process-gone"'));
    expect(block.slice(0, 200)).toContain("previewController.hideAllViews()");
  });

  it("hideAllViews 复位标志并隐藏视图（不是只 setVisible）", () => {
    const block = preview.slice(preview.indexOf("hideAllViews(): void {"));
    expect(block.slice(0, 400)).toContain("wrapper.visible = false");
    expect(block.slice(0, 400)).toContain("wrapper.view?.setVisible(false)");
  });

  it("bounds 分支不为未知标签建视图", () => {
    const block = preview.slice(preview.indexOf('case "bounds":'), preview.indexOf('case "visible":'));
    expect(block).toContain("this.rememberPendingBounds(tabId, command.bounds)");
    expect(block).not.toContain("getOrCreate");
  });

  it("休眠与新建标签都以「不可见」起步（可见只能由渲染端声明）", () => {
    const hibernate = preview.slice(preview.indexOf("hibernateTab(tabId: string): boolean {"), preview.indexOf("isHibernated("));
    expect(hibernate).toContain("wrapper.visible = false");
    expect(preview).toContain("const wrapper: BrowserTabView = { visible: false, state: emptyBrowserState()");
  });
});
