import { describe, expect, it } from "vitest";
import { isPaletteHotkeyEnabled, normalizePaletteHotkey, normalizeShortcuts, PALETTE_HOTKEY } from "./shortcuts.js";

describe("shortcut normalization", () => {
  it("accepts only the known accelerator", () => {
    expect(normalizePaletteHotkey(PALETTE_HOTKEY)).toBe(PALETTE_HOTKEY);
    expect(normalizePaletteHotkey("CommandOrControl+K")).toBe("");
    expect(normalizePaletteHotkey("")).toBe("");
    expect(normalizePaletteHotkey(undefined)).toBe("");
    expect(normalizePaletteHotkey(42)).toBe("");
  });

  it("normalizes the settings object and drops unknown values", () => {
    expect(normalizeShortcuts({ paletteHotkey: PALETTE_HOTKEY })).toEqual({ paletteHotkey: PALETTE_HOTKEY });
    expect(normalizeShortcuts({ paletteHotkey: "Ctrl+Alt+X" })).toBeUndefined();
    expect(normalizeShortcuts({})).toBeUndefined();
    expect(normalizeShortcuts(undefined)).toBeUndefined();
    expect(normalizeShortcuts("nope")).toBeUndefined();
  });

  it("reads the enabled state from settings", () => {
    expect(isPaletteHotkeyEnabled({ shortcuts: { paletteHotkey: PALETTE_HOTKEY } })).toBe(true);
    expect(isPaletteHotkeyEnabled({ shortcuts: { paletteHotkey: "" } })).toBe(false);
    expect(isPaletteHotkeyEnabled({})).toBe(false);
  });
});
