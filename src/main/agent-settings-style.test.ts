import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 角色页样式契约（源码断言型测试，2026-09-23）。
 *
 * 为什么放 main 侧：styles.css 在渲染端目录，tsconfig.web 无 node 类型，渲染端
 * 测试读不了文件；跨端断言渲染端文件有 settings-save-contract.test.ts 先例。
 *
 * 为什么是源码断言：happy-dom 不解析外部样式表、也不实现 absolute 包含块与
 * focus-scroll 这些真实布局行为——真值只能在真实 Chromium 里验（2026-09-23
 * 已在 demo 实测：修复前行在 y=218、隐形 checkbox 在 y=957，点击后滚动链乱跳）。
 * 这里只钉「规则存在」，防止未来重构时静默删掉 position: relative。
 *
 * 背景：角色页的勾选行（.agent-check）把原生 checkbox 用 1px absolute 隐藏、
 * 外观由 .agent-check-box 自绘。absolute 元素的包含块是最近的 positioned 祖先——
 * 行不设 relative 时会一路逃到 .settings-dialog（入场动画的 transform 创建），
 * 隐形 checkbox 不再随行滚动，点击 label 聚焦它时 focus-scroll 沿滚动链乱滚，
 * 表现为「一点勾选框页面就变形」。
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../renderer/src/styles.css"), "utf8");

describe("角色页样式契约", () => {
  it(".agent-check 必须自带 position: relative（隐形 checkbox 的包含块不能逃到弹窗）", () => {
    const rule = css.match(/\.agent-settings \.agent-check \{[^}]*\}/);
    expect(rule, "styles.css 里必须存在 .agent-settings .agent-check 规则").not.toBeNull();
    expect(rule![0]).toContain("position: relative");
  });
});
