import { describe, expect, it } from "vitest";
import {
  classifyTerminalPaste,
  countTerminalPasteLines,
  isMacPlatform,
  matchTerminalClipboardShortcut,
  terminalClipboardHints,
  terminalMouseHint,
  type TerminalKeyEventLike
} from "./terminal-clipboard";

/**
 * 终端剪贴板判定矩阵（2026-11-23「SSH 终端选区与剪贴板优化」）。
 * 这些判定直接决定「Ctrl+C 是复制还是中断」，写错就是打断远端命令或者粘不进去，
 * 所以两个平台、输入法、AltGr、长按 repeat 都要逐个钉住。
 */

function key(name: string, overrides: Partial<TerminalKeyEventLike> = {}): TerminalKeyEventLike {
  return { type: "keydown", key: name, ...overrides };
}

describe("isMacPlatform", () => {
  it("recognizes macOS from platform or user agent", () => {
    expect(isMacPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(true);
    expect(isMacPlatform("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36")).toBe(true);
    expect(isMacPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
    expect(isMacPlatform(undefined, undefined)).toBe(false);
  });
});

describe("matchTerminalClipboardShortcut（Windows / Linux）", () => {
  it("maps the copy and paste chords", () => {
    expect(matchTerminalClipboardShortcut(key("c", { ctrlKey: true }), false)).toBe("copy");
    expect(matchTerminalClipboardShortcut(key("C", { ctrlKey: true, shiftKey: true }), false)).toBe("copy");
    expect(matchTerminalClipboardShortcut(key("Insert", { ctrlKey: true }), false)).toBe("copy");
    expect(matchTerminalClipboardShortcut(key("v", { ctrlKey: true }), false)).toBe("paste");
    expect(matchTerminalClipboardShortcut(key("V", { ctrlKey: true, shiftKey: true }), false)).toBe("paste");
    expect(matchTerminalClipboardShortcut(key("Insert", { shiftKey: true }), false)).toBe("paste");
  });

  it("leaves Ctrl+A and everything else to the shell", () => {
    expect(matchTerminalClipboardShortcut(key("a", { ctrlKey: true }), false)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("x", { ctrlKey: true }), false)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("c"), false)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("Insert"), false)).toBeUndefined();
  });

  it("ignores Alt / AltGr / IME and non-keydown phases", () => {
    // AltGr 在 Windows 上表现为 Ctrl+Alt：绝不能把 `AltGr+V` 当成粘贴。
    expect(matchTerminalClipboardShortcut(key("v", { ctrlKey: true, altKey: true }), false)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("AltGraph", { ctrlKey: true, altKey: true }), false)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("v", { ctrlKey: true, getModifierState: (name) => name === "AltGraph" }), false)).toBeUndefined();
    // 输入法合成中的 Ctrl+V 属于输入法，不是粘贴。
    expect(matchTerminalClipboardShortcut(key("v", { ctrlKey: true, isComposing: true }), false)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("Process", { ctrlKey: true }), false)).toBeUndefined();
    // keypress/keyup 阶段不接管：同一次按键只处理一遍。
    expect(matchTerminalClipboardShortcut(key("v", { ctrlKey: true, type: "keypress" }), false)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("c", { ctrlKey: true, type: "keyup" }), false)).toBeUndefined();
  });

  it("does not treat Cmd as the clipboard modifier on Windows/Linux", () => {
    expect(matchTerminalClipboardShortcut(key("c", { metaKey: true }), false)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("v", { metaKey: true }), false)).toBeUndefined();
  });
});

describe("matchTerminalClipboardShortcut（macOS）", () => {
  it("uses Cmd for copy and paste", () => {
    expect(matchTerminalClipboardShortcut(key("c", { metaKey: true }), true)).toBe("copy");
    expect(matchTerminalClipboardShortcut(key("v", { metaKey: true }), true)).toBe("paste");
    expect(matchTerminalClipboardShortcut(key("C", { metaKey: true, shiftKey: true }), true)).toBe("copy");
    expect(matchTerminalClipboardShortcut(key("V", { metaKey: true, shiftKey: true }), true)).toBe("paste");
    expect(matchTerminalClipboardShortcut(key("Insert", { shiftKey: true }), true)).toBe("paste");
  });

  it("keeps plain Ctrl+C and Ctrl+V as terminal control keys", () => {
    // mac 用户的心智模型是 Cmd 管剪贴板：裸 Ctrl+C 必须还是 ^C 中断。
    expect(matchTerminalClipboardShortcut(key("c", { ctrlKey: true }), true)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("v", { ctrlKey: true }), true)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("c", { ctrlKey: true, shiftKey: true }), true)).toBeUndefined();
    expect(matchTerminalClipboardShortcut(key("Insert", { ctrlKey: true }), true)).toBeUndefined();
  });
});

describe("classifyTerminalPaste", () => {
  it("ignores empty clipboard and pastes single lines directly", () => {
    expect(classifyTerminalPaste("")).toBe("ignore");
    expect(classifyTerminalPaste("ls -la")).toBe("paste");
    expect(classifyTerminalPaste("  spaced  ")).toBe("paste");
  });

  it("asks first for any line break, including a trailing one", () => {
    expect(classifyTerminalPaste("ls\n")).toBe("confirm");
    expect(classifyTerminalPaste("a\nb")).toBe("confirm");
    expect(classifyTerminalPaste("a\r\nb")).toBe("confirm");
    expect(classifyTerminalPaste("a\rb")).toBe("confirm");
    expect(classifyTerminalPaste("\n")).toBe("confirm");
  });
});

describe("countTerminalPasteLines", () => {
  it("counts all three line ending flavours", () => {
    expect(countTerminalPasteLines("")).toBe(0);
    expect(countTerminalPasteLines("one")).toBe(1);
    expect(countTerminalPasteLines("one\n")).toBe(2);
    expect(countTerminalPasteLines("one\n two")).toBe(2);
    expect(countTerminalPasteLines("a\r\nb\rc")).toBe(3);
  });
});

describe("terminalClipboardHints", () => {
  it("switches the modifier wording per platform", () => {
    expect(terminalClipboardHints(false)).toMatchObject({ copy: "Ctrl+C", paste: "Ctrl+V" });
    expect(terminalClipboardHints(true)).toMatchObject({ copy: "⌘C", paste: "⌘V" });
    expect(terminalMouseHint(false)).toContain("Shift+拖选");
    expect(terminalMouseHint(true)).toContain("Option+拖选");
  });
});
