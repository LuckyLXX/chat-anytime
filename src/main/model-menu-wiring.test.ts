import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 模型快捷切换两段式菜单的接线契约（2026-11-04）。
 *
 * 这类改造最典型的失败是「组件写好了但 composer 还在渲染旧的平铺列表」，或者
 * 「二级面板被外层 overflow 裁掉」——纯函数与组件单测都发现不了。这里用源码
 * 断言把接线与几何前提钉住。
 *
 * 注意：本目录的 tsconfig 不会包含渲染端源文件，所以纯函数只从源码里取值
 * 校验，不 import（否则 tsc -p tsconfig.node.json 报 TS6307）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n?/g, "\n");

const paneSource = read("../renderer/src/ConversationPane.tsx");
const menuSource = read("../renderer/src/components/ModelMenu.tsx");
const libSource = read("../renderer/src/lib/model-menu.ts");
const cssSource = read("../renderer/src/styles.css");
/** 二级面板间距常量（CSS 与纯函数必须同源）。 */
const menuGap = Number(/export const MODEL_MENU_GAP = (\d+)/u.exec(libSource)?.[1]);

describe("model menu wiring", () => {
  it("composer 渲染两段式组件，不再自己拼平铺模型列表", () => {
    expect(menuSource).toMatch(/export function ModelMenu/u);
    expect(paneSource).toContain('import { ModelMenu } from "./components/ModelMenu"');
    const render = paneSource.slice(paneSource.indexOf('composerMenu === "model" && <ModelMenu'));
    expect(render.slice(0, 400)).toMatch(/models=\{availableModels\}/u);
    expect(render.slice(0, 400)).toMatch(/providers=\{providers\}/u);
    expect(render.slice(0, 400)).toMatch(/value=\{selectedModel\}/u);
    expect(render.slice(0, 400)).toMatch(/onSelect=\{\(value\) => void selectModel\(value\)\}/u);
    expect(render.slice(0, 400)).toMatch(/onClose=\{\(\) => setComposerMenu\(undefined\)\}/u);
    // 旧平铺列表的指纹：按供应商分组后直接铺模型按钮
    expect(paneSource).not.toMatch(/availableModels\.filter\(\(model\) => model\.provider === providerId\)/u);
    // 滚动定位已交给组件：父级不再自己 query button.active
    expect(paneSource).not.toContain('querySelector<HTMLButtonElement>("button.active")');
  });

  it("组件走纯函数：供应商分组、搜索过滤、展开方向判定都有单一来源", () => {
    expect(menuSource).toContain("providerMenuEntries(models, providers, value)");
    expect(menuSource).toContain("filterProviderModels(openEntry.models, search)");
    expect(menuSource).toContain("modelMenuPlacement({");
    expect(menuSource).toContain("MODEL_MENU_SEARCH_MIN");
    // Esc 必须抢在父级 document 监听之前（否则按一次就把整个菜单关了）
    expect(menuSource).toMatch(/event\.stopPropagation\(\)/u);
  });

  it("CSS：外层不裁切二级面板，两档变体与动效关停都登记了", () => {
    const start = cssSource.indexOf(".model-select-menu {");
    const base = cssSource.slice(start, cssSource.indexOf("\n", start));
    expect(base).toContain("overflow: visible");
    expect(base).not.toContain("overflow-y: auto");
    expect(cssSource).toContain(".model-menu-panel.flip");
    expect(cssSource).toContain(".model-menu-panel.inline");
    expect(cssSource).toContain(".model-menu-compact .model-menu-providers");
    // 动效关停的两处清单（prefers-reduced-motion / 用户关闭界面动效）
    expect(cssSource).toContain(".composer-select-menu, .model-menu-panel, .slash-menu");
    expect(cssSource).toContain('html[data-ui-motion="off"] .model-menu-panel');
    // 二级面板的横向间距与纯函数常量同源，改 CSS 必须改常量
    expect(menuGap).toBe(4);
    expect(cssSource).toContain(`left: calc(100% + ${menuGap}px)`);
    expect(cssSource).toContain(`right: calc(100% + ${menuGap}px)`);
  });
});
