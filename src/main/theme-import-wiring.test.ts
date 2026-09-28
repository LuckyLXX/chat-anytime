import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 主题导入通道的接线契约（2026-09-26 主题资产落磁盘）。
 *
 * 导入的**全部文件工作在主进程**：渲染端只发一个 kind（dir / css），对话框、读盘、
 * 按 CSS 引用收集资产、写进草稿槽都在主进程完成，返回 CSS 文本与统计。
 * 旧链路（`<input webkitdirectory>` → FileReader → data URL → 过 IPC）必须彻底消失，
 * 否则 24MB base64 会从另一条路回来。这些断言是源码级的（与 gallery-run-wiring 同型）。
 */

// 源码行尾在本地工作区（LF）与 CI 检出（CRLF，windows runner 的 core.autocrlf）之间不一致：
// 读入即归一化，否则跨行断言在 CI 上永远匹配不上（同 browser-preview-visibility-wiring 的做法）。
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

const main = read("index.ts");
const preload = read("../preload/index.ts");
const protocol = read("../shared/protocol.ts");
const appearance = read("../renderer/src/AppearanceSettings.tsx");
const demoApi = read("../renderer/src/demo-api.ts");

describe("主进程侧", () => {
  it("提供 theme-import / theme-promote 两个 IPC，且已删掉按需取资产的旧通道", () => {
    expect(main).toContain('ipcMain.handle("appearance:theme-import"');
    expect(main).toContain('ipcMain.handle("appearance:theme-promote"');
    expect(main).not.toContain("appearance:theme-assets");
  });

  it("导入走纯函数模块（对话框与落盘都在主进程）", () => {
    expect(main).toContain("importThemeDirectory(themesDir, picked)");
    expect(main).toContain("importThemeCssFile(themesDir, picked)");
    expect(main).toContain("promoteThemeScope(themeAssetsDirFor(resolveThemeAgentDir()), themeId)");
  });
});

describe("渲染端侧", () => {
  it("preload 暴露 themeImport / themePromote，不再有 themeAssets", () => {
    expect(preload).toContain('ipcRenderer.invoke("appearance:theme-import", kind)');
    expect(preload).toContain('ipcRenderer.invoke("appearance:theme-promote", themeId)');
    expect(preload).not.toContain("themeAssets");
  });

  it("协议层同步：DesktopApi 只有新两个方法", () => {
    expect(protocol).toContain('themeImport(kind: "dir" | "css"): Promise<ThemeImportOutcome>');
    expect(protocol).toContain("themePromote(themeId: string): Promise<void>");
    expect(protocol).not.toContain("themeAssets(themeId: string)");
  });

  it("外观页不再自己读文件（webkitdirectory / FileReader / data URL 收集器全部删除）", () => {
    expect(appearance).toContain("window.piDesktop.themeImport(kind)");
    expect(appearance).toContain("window.piDesktop.themePromote(nextTheme.id)");
    expect(appearance).not.toContain("webkitdirectory");
    expect(appearance).not.toContain("FileReader");
    expect(appearance).not.toContain("readFileAsDataUrl");
    expect(appearance).not.toContain("collectThemeAssets");
  });

  it("保存主题后立刻归位草稿槽（不等保存外观设置，否则中间会 404）", () => {
    expect(appearance).toContain("updateAppearance({ customThemes: nextThemes });\n    setThemeImportNote(undefined);");
    expect(appearance).toContain("void window.piDesktop.themePromote(nextTheme.id)");
  });

  it("演示环境如实降级，不伪造成功的导入", () => {
    expect(demoApi).toContain("async themeImport(): Promise<ThemeImportOutcome>");
    expect(demoApi).toContain("async themePromote(): Promise<void>");
    expect(demoApi).toContain("演示环境不支持主题文件导入");
  });
});
