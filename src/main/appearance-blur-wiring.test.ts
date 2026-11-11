import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeAppearanceBlur } from "./settings";

/**
 * 毛玻璃降级链路的接线契约（2026-11-11，用户报内网虚拟机设置页卡顿）。
 *
 * 这条链有四个必须同时成立的环节，缺一个就「代码写了但没生效」：
 *  ① 设置字段能存能读（migrateSettings 是唯一读入口，漏读 = 下一次任何写入把它抹掉）；
 *  ② App 把三态 + 检测结果投影成 `<html data-ui-blur="off">`；
 *  ③ styles.css 真有一条能压过主题/壁纸规则的关停规则；
 *  ④ 外观页有让用户强制开/关的控件。
 *
 * 渲染端 tsconfig 不包含在 tsconfig.node.json 里，所以这里只做源码断言，不 import
 * 渲染端模块（同 model-menu-wiring / markdown-window-wiring 先例）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n?/g, "\n");

const appSource = read("../renderer/src/App.tsx");
const appearanceSource = read("../renderer/src/AppearanceSettings.tsx");
const cssSource = read("../renderer/src/styles.css");
const graphicsSource = read("../renderer/src/lib/graphics-tier.ts");

describe("appearance.blur 三态字段", () => {
  it("只接受 auto/on/off，其余（含缺失、脏值）一律丢弃", () => {
    expect(normalizeAppearanceBlur("auto")).toBe("auto");
    expect(normalizeAppearanceBlur("on")).toBe("on");
    expect(normalizeAppearanceBlur("off")).toBe("off");
    expect(normalizeAppearanceBlur(undefined)).toBeUndefined();
    expect(normalizeAppearanceBlur(null)).toBeUndefined();
    expect(normalizeAppearanceBlur("none")).toBeUndefined();
    expect(normalizeAppearanceBlur(true)).toBeUndefined();
    expect(normalizeAppearanceBlur(1)).toBeUndefined();
  });

  it("normalize 被 migrateSettings 真正调用（否则字段重启即丢）", () => {
    const settingsSource = read("./settings.ts");
    expect(settingsSource).toMatch(/const blur = normalizeAppearanceBlur\(appearanceSource\.blur\);/u);
    expect(settingsSource).toMatch(/\.\.\.\(blur \? \{ blur \} : \{\}\)/u);
  });
});

describe("App 把档位投影成 html 属性", () => {
  it("检测只做一次且走 lib/graphics-tier", () => {
    expect(appSource).toContain('import { isSoftwareRenderer, readWebglRenderer, resolveBlurEnabled } from "./lib/graphics-tier";');
    expect(appSource).toMatch(/const \[softwareRendering\] = useState\(\(\) => isSoftwareRenderer\(readWebglRenderer\(\)\)\);/u);
    expect(appSource).toMatch(/const blurEnabled = resolveBlurEnabled\(settings\.appearance\.blur, softwareRendering\);/u);
  });

  it("data-ui-blur / data-ui-render 在主题钩子 effect 里，并进了依赖表", () => {
    expect(appSource).toMatch(/\["data-ui-blur", blurEnabled \? undefined : "off"\]/u);
    expect(appSource).toMatch(/\["data-ui-render", softwareRendering \? "software" : undefined\]/u);
    const deps = /\[settingsOpen, activeWorkspace[^\]]*settings\.appearance\.motion[^\]]*\]/u.exec(appSource)?.[0] ?? "";
    expect(deps).toContain("blurEnabled");
    expect(deps).toContain("softwareRendering");
  });
});

describe("styles.css 的关停规则", () => {
  it("用通配 + !important 压过壁纸模式与主题自己写的 backdrop-filter", () => {
    const block = /html\[data-ui-blur="off"\] \*,[\s\S]{0,220}?backdrop-filter: none !important;[\s\S]{0,120}?-webkit-backdrop-filter: none !important;/u.exec(cssSource)?.[0] ?? "";
    expect(block).toContain('html[data-ui-blur="off"] *::before');
    expect(block).toContain('html[data-ui-blur="off"] *::after');
  });

  it("壁纸模式确实存在被它压制的 backdrop-filter（规则不是为了空目标而存在）", () => {
    expect(cssSource).toMatch(/\[data-theme-wallpaper="true"\] \.settings-dialog,[\s\S]{0,200}?backdrop-filter: blur\(20px\)/u);
  });
});

describe("外观页的用户控件", () => {
  it("三态下拉带 data-control 钩子且写回 appearance.blur", () => {
    expect(appearanceSource).toMatch(/data-control="appearance-blur"/u);
    expect(appearanceSource).toMatch(/value=\{settings\.appearance\.blur \?\? "auto"\}/u);
    expect(appearanceSource).toMatch(/updateAppearance\(\{ blur: event\.target\.value as AppearanceBlurMode \}\)/u);
    expect(appearanceSource).toMatch(/<option value="auto">/u);
    expect(appearanceSource).toMatch(/<option value="on">/u);
    expect(appearanceSource).toMatch(/<option value="off">/u);
  });
});

describe("检测模块本身", () => {
  it("是纯函数模块：不碰 window/store，判据集中在一处", () => {
    expect(graphicsSource).toContain("export function isSoftwareRenderer");
    expect(graphicsSource).toContain("export function readWebglRenderer");
    expect(graphicsSource).toContain("export function resolveBlurEnabled");
    expect(graphicsSource).not.toMatch(/useDesktopStore|window\.piDesktop/u);
  });
});
