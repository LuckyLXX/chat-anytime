import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 预览面板开合的接线契约（2026-10-28）。
 *
 * 用户现场：收起右侧预览面板时，面板先淡出，聊天区要等退场窗口（180ms）结束才
 * 「迟一步」跳宽，滚动条与消息跟着错位跳一下。
 *
 * 为什么放在 main 侧：渲染端 tsconfig 没有 node 类型（不能 import node:fs）。
 * `lib/preview-layout.ts` 的纯函数用例只能证明 class 拼对了，证明不了 CSS 真的
 * 用同一个属性驱动「聊天区变宽 + 面板平移」：删掉 @property、把 transform 加回
 * 进出场 keyframes、或者把布局 class 改回跟着 `useExitPresence.rendered` 走，
 * 纯函数用例都会全绿而现场继续跳。
 */
describe("preview panel open/close transition contract", () => {
  // 行尾归一化：CI（windows runner，core.autocrlf=true）会把源码检出成 CRLF，
  // 跨行断言与服务端切片都必须在 LF 下计算（见仓库既有 wiring 测试的 read() 样板）。
  const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/gu, "\n");
  const styles = read(join(__dirname, "../renderer/src/styles.css"));
  const app = read(join(__dirname, "../renderer/src/App.tsx"));
  // 注释里也提到这些声明，断言前先剥掉注释，避免「注释里写了、代码里没有」也绿。
  const css = styles.replace(/\/\*[\s\S]*?\*\//gu, "");

  /** 从头部字符串起取一条完整 CSS 块（含嵌套，支持单行 keyframes）。 */
  function blockOf(header: string): string {
    const start = css.indexOf(header);
    if (start < 0) return "";
    let depth = 0;
    for (let index = css.indexOf("{", start); index >= 0 && index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) return css.slice(start, index + 1);
      }
    }
    return "";
  }

  it("--preview-open 注册为可插值的 number（否则 transition 逐帧插值不成立）", () => {
    const rule = blockOf("@property --preview-open");
    expect(rule).toContain('syntax: "<number>"');
    expect(rule).toContain("initial-value: 1");
  });

  it("工作区轨道由 --preview-open 驱动，收起态只改属性、不换轨数", () => {
    expect(blockOf(".work-area {")).toContain("transition: --preview-open .18s ease");
    expect(blockOf(".work-area.preview-collapsed")).toContain("--preview-open: 0");
    expect(blockOf(".work-area.with-preview {")).toContain("var(--preview-open)");
    expect(blockOf(".work-area.with-preview-empty {")).toContain("var(--preview-open)");
    // 收起态不允许再出现第二套模板：轨数一变，过渡就退化成离散跳变。
    expect(css).not.toContain(".work-area.with-preview.preview-collapsed");
    expect(css).not.toContain(".work-area.with-preview-empty.preview-collapsed");
  });

  it("面板脱离栅格：固定目标宽度 + 同一属性平移出可视区", () => {
    const shared = blockOf(".work-area.with-preview .content-preview-panel,");
    expect(shared).toContain("position: absolute");
    expect(shared).toContain("transform: translateX(calc((1 - var(--preview-open)) * 100%))");
    expect(css).toContain(".work-area.with-preview .content-preview-panel { width: calc(100% - var(--preview-split, 50%) - 7px)");
    expect(css).toContain(".work-area.with-preview-empty .content-preview-panel { width: max(320px, 30%)");
  });

  it("进出场 keyframes 只动 opacity（带 transform 会覆盖属性驱动的位移）", () => {
    for (const name of ["preview-panel-in", "preview-panel-out"]) {
      const frames = blockOf(`@keyframes ${name}`);
      expect(frames).toContain("opacity");
      expect(frames).not.toContain("transform");
    }
  });

  it("三处时长都是 180ms（轨道过渡 / 进出场 / useExitPresence 窗口）", () => {
    expect(css).toContain("animation: preview-panel-in .18s ease");
    expect(css).toContain("animation: preview-panel-out .18s ease both");
    expect(app).toContain("useExitPresence(previewOpened, 180)");
  });

  it("全屏面板重置宽度与位移（否则被按「右侧一列」定位）", () => {
    const rule = blockOf(".work-area .content-preview-panel.preview-fullscreen");
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("width: auto");
    expect(rule).toContain("transform: none");
  });

  it("竖排（≤760px）把三行同样接到 --preview-open 上，面板贴底下滑", () => {
    const stacked = blockOf(".work-area.with-preview { grid-template-columns: minmax(0, 1fr); grid-template-rows:");
    expect(stacked).toContain("var(--preview-open)");
    expect(blockOf(".work-area.with-preview .content-preview-panel { top: auto;")).toContain("translateY(calc((1 - var(--preview-open)) * 100%))");
  });

  it("App 用 workAreaPreviewClasses 拼布局 class（不再跟着退场窗口走）", () => {
    expect(app).toContain("workAreaPreviewClasses({ open: previewOpened");
    expect(app).not.toContain('previewVisible ? " with-preview-empty"');
    expect(app).not.toContain('previewVisible && preview && preview.tabs.length > 0 ? " with-preview"');
  });
});
