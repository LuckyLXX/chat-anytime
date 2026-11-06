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
  const paletteLib = read("../renderer/src/lib/command-palette.ts");
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

  it("渲染端用纯函数判定窗口内快捷键，并分发到真实命令", () => {
    // 新增的直接快捷键（2026-11-05）：Ctrl+N / Ctrl+Shift+B / Ctrl+, 与 Ctrl+K 同一入口。
    expect(app).toContain("matchAppShortcut(event)");
    expect(app).toContain("shortcutActionsRef.current.newSession()");
    expect(app).toContain("shortcutActionsRef.current.browser()");
    expect(app).toContain("setPaletteOpen((open) => !open)");
    // 有对话框/全屏预览时直接动作不触发（否则会在背后开话题、盖掉权限卡）。
    expect(app).toContain("shortcutBlockedRef.current");
    expect(app).toContain("settingsOpenRef.current");
    expect(app).toContain("paletteOpenTick > 0");
    expect(app).toContain("<CommandPalette");
    expect(app).toContain("open={paletteOpen}");
    expect(store).toContain('case "palette.open"');
    expect(store).toContain('case "shortcut.error"');
    // 匹配规则本身在 lib 里可单测（Shift 是硬条件、AltGr 不误触）。
    const shortcutsLib = read("../renderer/src/lib/keyboard-shortcuts.ts");
    expect(shortcutsLib).toContain("export function matchAppShortcut");
    expect(shortcutsLib).toContain('key === "k"');
  });

  it("默认视图只列真入口：模型动作整组移除、低频动作收进 searchOnly", () => {
    expect(app).toContain('title: "打开浏览器"');
    expect(app).toContain('title: "打开终端"');
    expect(app).toContain('title: "打开文件…"');
    expect(app).toContain('title: "打开 SSH 远程终端"');
    expect(app).toContain('id: "session.stop"');
    expect(app).toContain("openBrowserTab()");
    expect(app).toContain("findReusablePreviewTab");
    // 预览面板的顶栏按钮只管开合：不要顺手改成「空面板直接开浏览器」——
    // 快捷开浏览器的是 Ctrl+Shift+B 与面板里的「打开浏览器」（2026-11-05 用户纠正）。
    expect(app).not.toContain("previewHasTabs");
    expect(app).not.toContain("previewToggleLabel");
    // 聊天框里一步就能切换的模型不再进面板（用户 2026-11-05 反馈的直接诉求）。
    expect(app).not.toContain("切换模型：");
    expect(app).not.toContain('type: "model.select"');
    // 低频/重复入口收进搜索：输入关键词仍找得到，不占默认列表。
    expect(app).toContain("searchOnly: true");
    expect(app).toContain('title: `切换助手：${agent.name}`');
    expect(app).toContain('title: `访问模式：${mode.label}`');
    expect(app).toContain('title: `打开设置：${entry.label}`');
  });

  it("面板不提供思考等级切换（2026-10-27 用户要求「思考等级切换这个去掉」）", () => {
    expect(app).not.toContain("thinkingLevelLabels");
    expect(app).not.toContain('type: "thinking.select"');
    expect(paletteLib).not.toContain('"思考"');
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
    // 窗口内快捷键在设置页有一份可发现的清单，文案与面板徽章同源。
    expect(general).toContain("APP_SHORTCUT_LABELS");
    expect(general).toContain("WINDOW_SHORTCUT_ROWS");
  });
});
