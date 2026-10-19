import type { ShortcutsSettings } from "./protocol.js";

/**
 * 全局快捷键的固定加速键（v1 只提供开关，不支持自定义组合键）。
 *
 * 为什么固定值：自定义加速键要处理 Electron 的字符串语法、平台差异与冲突回退，
 * 而用户当前的真实需求只是「在任何应用里按一下回到 PiDesktop」。固定一个不常
 * 冲突的组合、用开关控制，是这一版最稳的取舍；注册失败会如实提示。
 */
export const PALETTE_HOTKEY = "CommandOrControl+Shift+Space";

/** 给界面看的平台无关写法（Accelerator 里的 CommandOrControl）。 */
export const PALETTE_HOTKEY_LABEL = "Ctrl+Shift+Space";

/**
 * 只接受已知快捷键：未知值一律视为关闭。
 * settings.json 可被外部改写，白名单之外的值不注册——不能让它变成一个
 * 「任意热键」入口。
 */
export function normalizePaletteHotkey(value: unknown): string {
  return value === PALETTE_HOTKEY ? PALETTE_HOTKEY : "";
}

export function normalizeShortcuts(value: unknown): ShortcutsSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const hotkey = normalizePaletteHotkey((value as Record<string, unknown>).paletteHotkey);
  return hotkey ? { paletteHotkey: hotkey } : undefined;
}

export function isPaletteHotkeyEnabled(settings: { shortcuts?: ShortcutsSettings }): boolean {
  return normalizePaletteHotkey(settings.shortcuts?.paletteHotkey) !== "";
}
