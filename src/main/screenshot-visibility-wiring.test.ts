import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 「主窗口不可见时截图仍能出帧」的两条接线契约（源码断言型测试，2026-09-24）。
 *
 * 为什么要源码断言：这两处都是**跨进程、测试环境跑不出来**的行为——
 *  1. `app.commandLine.appendSwitch("disable-features", …)` 必须在 app ready 前执行，
 *     且只能在整个主进程启动一次；vitest 里 import index.ts 会拉起整棵 Electron 依赖树
 *     （同先例：pi-runtime 相关契约只能读源码文本）。
 *  2. 预览面板的首帧量测发生在真实 DOM 布局里，而渲染端测试跑在 happy-dom 上
 *     （不实现布局，getBoundingClientRect 恒 0/不支持 ResizeObserver）——布局行为在
 *     测试环境里没有真值，只能钉「写法」。
 *
 * 背景（2026-09-24 真机探针 p6/p7，两条事实决定了这里的写法）：
 *  - 主窗口被别的应用完全遮挡时 `document.visibilityState === "hidden"`，**rAF 与
 *    ResizeObserver 回调全停**（rAF 3 秒不落、RO 只回 stall），而隐藏页里
 *    `getBoundingClientRect()` 仍返回真实尺寸。若首帧量测只挂在 rAF 上，预览面板
 *    打开后永远不回送 bounds，浏览器自动化标签页拿不到原生视图尺寸 →
 *    browser_screenshot 8 秒「标签页未能变为可见」超时（用户报的高频失败）。
 *  - 关闭 Chromium 的 `CalculateNativeWinOcclusion` 后，遮挡中的渲染端保持
 *    visible、rAF/RO 照常；且**出帧本身从来不是问题**（遮挡中 CDP 截图 65ms 出真帧，
 *    字节数与可见时一致）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "index.ts"), "utf8");
const browserPreview = readFileSync(join(here, "../renderer/src/components/BrowserPreview.tsx"), "utf8");

describe("遮挡下的截图可用性接线", () => {
  it("主进程启动期关掉 Chromium 遮挡检测（否则遮挡时渲染端整条量测停摆）", () => {
    // 开关值必须在数组里（不是在注释里提一句就行）。
    expect(main).toMatch(/const disabledFeatures = \["CalculateNativeWinOcclusion"\]/u);
    expect(main).toContain('app.commandLine.appendSwitch("disable-features"');
    // 合并而不是覆盖：别处若也追加 disable-features，不能把它的值顶掉。
    expect(main).toContain('app.commandLine.getSwitchValue("disable-features")');
  });

  it("预览面板首帧量测是同步的，不依赖 requestAnimationFrame", () => {
    // 同步路径：commit 在 rAF 回调之外也被直接调用（隐藏页里只有这条能落定）。
    expect(browserPreview).toContain("const commit = (bounds: DOMRect)");
    expect(browserPreview).toContain("const measureNow = (): void => {");
    expect(browserPreview).toContain("commit(viewport.getBoundingClientRect())");
    // 反向：只留 rAF 那种写法（把 requestAnimationFrame 当成唯一入口）必须消失。
    expect(browserPreview).not.toMatch(/frame = requestAnimationFrame\(\(\) => \{\s*const bounds = viewport\.getBoundingClientRect\(\);/u);
  });

  it("挂载时先跑同步量测、再挂观察者，且零尺寸时用定时器补测（rAF 在隐藏页不跑）", () => {
    expect(browserPreview).toMatch(/observer\.observe\(viewport\);[\s\S]{0,400}measureNow\(\);/u);
    // 补测必须是 setTimeout：rAF 在 hidden 页里永远不回。
    expect(browserPreview).toContain("window.setTimeout(measureNow, 120)");
  });
});
