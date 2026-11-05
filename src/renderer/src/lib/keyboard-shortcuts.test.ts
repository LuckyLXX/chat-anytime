import { describe, expect, it } from "vitest";
import { APP_SHORTCUT_LABELS, matchAppShortcut } from "./keyboard-shortcuts";

function key(keyName: string, overrides: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}): {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
} {
  return {
    key: keyName,
    ctrlKey: overrides.ctrl ?? true,
    metaKey: overrides.meta ?? false,
    altKey: overrides.alt ?? false,
    shiftKey: overrides.shift ?? false
  };
}

describe("matchAppShortcut", () => {
  it("maps the four window shortcuts", () => {
    expect(matchAppShortcut(key("k"))).toBe("palette");
    expect(matchAppShortcut(key("N"))).toBe("new-session");
    expect(matchAppShortcut(key("b", { shift: true }))).toBe("browser");
    expect(matchAppShortcut(key(","))).toBe("settings");
  });

  it("accepts Cmd on macOS and is case-insensitive", () => {
    expect(matchAppShortcut(key("K", { ctrl: false, meta: true }))).toBe("palette");
    expect(matchAppShortcut(key("n", { ctrl: false, meta: true }))).toBe("new-session");
  });

  it("requires the exact shift state", () => {
    // Ctrl+B 不抢（输入框/编辑器里的加粗），Ctrl+Shift+K 也不抢。
    expect(matchAppShortcut(key("b"))).toBeUndefined();
    expect(matchAppShortcut(key("k", { shift: true }))).toBeUndefined();
    expect(matchAppShortcut(key("n", { shift: true }))).toBeUndefined();
  });

  it("ignores bare keys, AltGr and unrelated modifiers", () => {
    expect(matchAppShortcut(key("k", { ctrl: false }))).toBeUndefined();
    expect(matchAppShortcut(key("n", { ctrl: false }))).toBeUndefined();
    // AltGr 在部分布局上表现为 Ctrl+Alt：绝不当作命令。
    expect(matchAppShortcut(key("n", { alt: true }))).toBeUndefined();
    expect(matchAppShortcut(key("b", { shift: true, alt: true }))).toBeUndefined();
    expect(matchAppShortcut(key("x"))).toBeUndefined();
    expect(matchAppShortcut(key("Escape"))).toBeUndefined();
  });
});

describe("APP_SHORTCUT_LABELS", () => {
  it("stays in one place for the palette badge and the settings page", () => {
    expect(APP_SHORTCUT_LABELS).toEqual({
      palette: "Ctrl+K",
      "new-session": "Ctrl+N",
      browser: "Ctrl+Shift+B",
      settings: "Ctrl+,"
    });
  });
});
