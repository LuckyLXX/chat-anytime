import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 界面主题上下文的接线契约（2026-10-03）。
 *
 * 这条链有四段，任何一段断了都不报错、只是「模型又看不到界面」——正是这一轮的原始
 * 症状（气泡配色瞎猜）。源码级断言把四段钉住（与 gallery-run-wiring / theme-import-wiring
 * 同型）：
 *   渲染端读计算样式 → 经 ui.themeContext 命令上报 → utility 内存镜像 → 每回合注入。
 *
 * 行尾：本地工作区 LF、CI 检出 CRLF，读入即归一化，否则跨行断言在 CI 上永远匹配不上。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

const protocol = read("../shared/protocol.ts");
const runtime = read("pi-runtime.ts");
const app = read("../renderer/src/App.tsx");
const themeRuntime = read("../renderer/src/lib/theme-runtime.ts");

describe("协议层", () => {
  it("定义主题快照与命令，且命令在 RuntimeCommand 联合里", () => {
    expect(protocol).toContain("export interface UiThemeContext {");
    expect(protocol).toContain("export interface UiThemePalette {");
    expect(protocol).toContain('| { type: "ui.themeContext"; context: UiThemeContext }');
  });
});

describe("utility 侧", () => {
  it("有内存镜像，并在命令 switch 里归一化写入", () => {
    expect(runtime).toContain("let uiThemeContext: UiThemeContext | undefined;");
    expect(runtime).toContain('case "ui.themeContext":');
    expect(runtime).toContain("uiThemeContext = normalizeUiThemeContext(command.context);");
  });

  it("内联扩展按本会话的 divMode 与最新快照注入", () => {
    expect(runtime).toContain("createUiThemeExtension({");
    expect(runtime).toContain("divMode: () => recordAgent.divMode");
    expect(runtime).toContain("context: () => uiThemeContext");
    // Div 气泡规范本身仍走会话创建时的系统提示词覆盖（两处职责不同，不要合并）
    expect(runtime).toContain("buildDivModePrompt(recordAgent.divMode)");
  });
});

describe("渲染端侧", () => {
  it("从计算样式读快照，色板键与提示词侧同序", () => {
    expect(themeRuntime).toContain("export function readUiThemeContext(");
    for (const token of ["--surface", "--surface-raised", "--text", "--text-muted", "--border", "--accent", "--accent-soft"]) {
      expect(themeRuntime).toContain(`"${token}"`);
    }
  });

  it("App 外壳上报快照，并放在主题 effect 之后（读到的才是刚生效的样式）", () => {
    const themeEffect = app.indexOf("delete root.dataset.themeWallpaper;");
    const push = app.indexOf('window.piDesktop.send({ type: "ui.themeContext", context });');
    expect(themeEffect).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(themeEffect);
    // 去重：主题不变时零命令（否则每次设置页保存都会推一次）
    expect(app).toContain("if (key === uiThemeKeyRef.current) return;");
    // 系统深浅变化（theme=system）也要重新上报
    expect(app).toContain('media.addEventListener("change", push);');
  });
});
