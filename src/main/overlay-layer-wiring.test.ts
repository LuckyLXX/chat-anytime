import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 全屏 DOM 弹层 → 挂起原生浏览器视图的接线契约（源码断言型，2026-09-26）。
 *
 * 为什么要源码断言：`browserSuspended` 这一路上全是测试环境跑不出来的东西——
 * 真正的遮挡者是主进程里的 `WebContentsView`（原生视图，渲染端测试跑在 happy-dom
 * 上，根本没有原生视图；`browser-preview.ts` 也没有单测，同先例）。能钉的只有写法，
 * 而恰恰是写法最容易漏：登记了组件侧却忘了接进 `browserSuspended`，功能看起来
 * 完整、bug 一模一样。计数语义本身由 `src/renderer/src/lib/overlay-layers.test.tsx`
 * 覆盖。
 *
 * 三处缺一不可：
 *  1. `ImageLightbox`（气泡图片 / 附件预览）登记；
 *  2. `RichContent` 的 Mermaid 放大弹窗登记；
 *  3. App 读回计数并把它接进发给预览面板的 `browserSuspended`。
 */

const here = dirname(fileURLToPath(import.meta.url));
// 源码是 CRLF：读入即归一化，否则多行片段永远匹配不上（仓库里已有先例的坑）。
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(new RegExp("\r\n", "gu"), "\n");

const imageLightbox = read("../renderer/src/components/ImageLightbox.tsx");
const richContent = read("../renderer/src/components/RichContent.tsx");
const app = read("../renderer/src/App.tsx");

describe("弹层挂起原生浏览器视图的接线契约", () => {
  it("气泡图片放大层登记（登记窗口覆盖退场动画）", () => {
    expect(imageLightbox).toContain('from "../lib/overlay-layers"');
    expect(imageLightbox).toContain("useOverlayLayer(presence.rendered)");
    // 不能用 expanded/value 之类的业务开关：退场那 160ms 放大图还在屏幕上。
    expect(imageLightbox).not.toContain("useOverlayLayer(open)");
  });

  it("Mermaid 放大弹窗登记", () => {
    expect(richContent).toContain('from "../lib/overlay-layers"');
    expect(richContent).toContain("useOverlayLayer(expanded)");
  });

  it("App 把计数接进 browserSuspended（只 import 不接是最容易犯的假绿）", () => {
    expect(app).toContain('from "./lib/overlay-layers"');
    expect(app).toContain("const overlayLayerOpen = useOverlayLayersOpen()");
    const flag = app.slice(app.indexOf("browserSuspended={"));
    expect(flag.slice(0, flag.indexOf("}"))).toContain("overlayLayerOpen");
  });
});
