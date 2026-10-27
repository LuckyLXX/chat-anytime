import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 命令面板的接线契约（2026-10-19）。
 *
 * 面板组件自己的测试只能证明「过滤/键盘/执行」正确，证明不了主进程真的注册了
 * 全局快捷键、渲染端真的响应了 Ctrl/Cmd+K 与主进程的 palette.open 推送、
 * settings.save 真的把 shortcuts 镜像到两个进程。三处断一处，功能就静默失效。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

describe("command palette wiring contract", () => {
  const index = read("index.ts");
  const runtime = read("pi-runtime.ts");
  const app = read("../renderer/src/App.tsx");
  const store = read("../renderer/src/store.ts");
  const protocol = read("../shared/protocol.ts");

  it("主进程注册/注销全局快捷键，并把呼出信号推回渲染端", () => {
    expect(index).toContain("globalShortcut.register(accelerator, requestPalette)");
    expect(index).toContain("globalShortcut.unregister(paletteHotkeyRegistered)");
    expect(index).toContain('app.on("will-quit", () => { globalShortcut.unregisterAll(); })');
    expect(index).toContain("applyPaletteHotkey();");
    expect(index).toContain('type: "palette.open"');
    expect(index).toContain('type: "shortcut.error"');
  });

  it("settings.save 把 shortcuts 镜像到主进程与 utility", () => {
    expect(index).toContain("settings.shortcuts = command.settings.shortcuts");
    expect(runtime).toContain("settings.shortcuts = command.settings.shortcuts");
    expect(protocol).toMatch(/settings\.save[^\n]*"shortcuts"/u);
  });

  it("渲染端响应 Ctrl/Cmd+K 与主进程推送", () => {
    expect(app).toContain("event.ctrlKey || event.metaKey");
    expect(app).toContain("paletteOpenTick > 0");
    expect(app).toContain("<CommandPalette");
    expect(app).toContain("open={paletteOpen}");
    expect(store).toContain('case "palette.open"');
    expect(store).toContain('case "shortcut.error"');
  });

  it("「搜索会话内容」在面板内进入检索模式，而不是关掉面板去跳侧栏", () => {
    expect(app).toContain('title: "搜索会话内容"');
    expect(app).toContain("enterSearch: true");
    // 面板要拿到检索结果与命中打开回调，否则检索模式只有输入框没有结果。
    expect(app).toContain("sessionSearch={paletteSearch}");
    expect(app).toContain("onOpenHit={openSearchHit}");
    expect(store).toContain("paletteSearch:");
  });

  it("设置页的开关写入固定加速键并随保存提交", () => {
    const general = read("../renderer/src/GeneralSettings.tsx");
    expect(general).toContain("PALETTE_HOTKEY");
    expect(general).toContain("shortcuts: nextSettings.shortcuts");
  });
});
