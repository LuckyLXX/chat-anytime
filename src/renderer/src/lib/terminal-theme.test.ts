import { describe, expect, it } from "vitest";
import {
  DARK_ANSI_PALETTE,
  LIGHT_ANSI_PALETTE,
  TERMINAL_FALLBACK,
  TERMINAL_OPTIONS,
  ansiPaletteFor,
  contrastRatio,
  isDarkBackground,
  parseCssColor,
  relativeLuminance,
  resolveXtermTheme,
  withAlpha
} from "./terminal-theme";

/**
 * 终端主题模块的纯函数契约（2026-10-10 「SSH 终端本地渲染美化」）。
 * 重点是两条不变量：ANSI 色板在暗底上全部达到 WCAG AA（4.5:1），
 * 以及 resolveXtermTheme 永远返回完整的 16 色键（缺一个远端颜色就掉回
 * xterm 内置老色板 —— 那正是这次要修的问题）。
 */

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
] as const;

describe("parseCssColor", () => {
  it("parses hex in all supported lengths", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#0b1220")).toEqual({ r: 11, g: 18, b: 32, a: 1 });
    expect(parseCssColor("#0b122080")).toEqual({ r: 11, g: 18, b: 32, a: 128 / 255 });
    expect(parseCssColor("#1234")).toEqual({ r: 17, g: 34, b: 51, a: 68 / 255 });
  });

  it("parses rgb()/rgba() including modern slash syntax", () => {
    expect(parseCssColor("rgb(11, 18, 32)")).toEqual({ r: 11, g: 18, b: 32, a: 1 });
    expect(parseCssColor("rgb(11 18 32 / 0.5)")).toEqual({ r: 11, g: 18, b: 32, a: 0.5 });
    expect(parseCssColor("rgba(11, 18, 32, 50%)")).toEqual({ r: 11, g: 18, b: 32, a: 0.5 });
  });

  it("returns undefined for values the browser would have to resolve for us", () => {
    expect(parseCssColor("var(--code-surface)")).toBeUndefined();
    expect(parseCssColor("color-mix(in srgb, red, blue)")).toBeUndefined();
    expect(parseCssColor("")).toBeUndefined();
  });
});

describe("luminance / contrast", () => {
  it("ranks black below white and reports symmetric contrast", () => {
    const black = parseCssColor("#000000")!;
    const white = parseCssColor("#ffffff")!;
    expect(relativeLuminance(black)).toBeCloseTo(0, 5);
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, black)).toBeCloseTo(contrastRatio(black, white), 5);
  });

  it("treats a missing color as dark so the built-in dark palettes win", () => {
    expect(isDarkBackground("#0b1220")).toBe(true);
    expect(isDarkBackground("#f7f8fa")).toBe(false);
    expect(isDarkBackground("color-mix(in srgb, a, b)")).toBe(true);
  });
});

describe("withAlpha", () => {
  it("keeps the RGB channels and clamps alpha", () => {
    expect(withAlpha("#4f46e5", 0.32)).toBe("rgba(79, 70, 229, 0.32)");
    expect(withAlpha("rgb(1, 2, 3)", 2)).toBe("rgba(1, 2, 3, 1)");
    expect(withAlpha("nonsense", 0.5)).toBe("nonsense");
  });
});

describe("resolveXtermTheme", () => {
  const theme = resolveXtermTheme({ background: "#0b1220", foreground: "#e5e7eb", accent: "#ffa757", border: "#24444e" });

  it("always ships the full ANSI 16 colour set", () => {
    for (const key of ANSI_KEYS) expect(typeof theme[key]).toBe("string");
  });

  it("derives selection and scrollbar colours from the theme tokens", () => {
    expect(theme.cursor).toBe("#ffa757");
    expect(theme.selectionBackground).toBe("rgba(255, 167, 87, 0.32)");
    expect(theme.selectionInactiveBackground).toBe("rgba(255, 167, 87, 0.16)");
    expect(theme.scrollbarSliderBackground).toBe("rgba(229, 231, 235, 0.14)");
    expect(theme.overviewRulerBorder).toBe("#24444e");
  });

  it("switches palette on the actual background luminance, not the app theme", () => {
    expect(theme.blue).toBe(DARK_ANSI_PALETTE.blue);
    const light = resolveXtermTheme({ ...TERMINAL_FALLBACK, background: "#ffffff" });
    expect(light.blue).toBe(LIGHT_ANSI_PALETTE.blue);
  });
});

describe("ansi palettes", () => {
  it("keeps every dark-palette colour at WCAG AA on the built-in terminal background", () => {
    const background = parseCssColor("#0b1220")!;
    for (const key of ANSI_KEYS) {
      const ratio = contrastRatio(parseCssColor(DARK_ANSI_PALETTE[key])!, background);
      expect(ratio, `${key} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the readable light-palette colours above AA on white (white/brightWhite are reverse-video slots)", () => {
    const background = parseCssColor("#ffffff")!;
    for (const key of ANSI_KEYS) {
      if (key === "white" || key === "brightWhite") continue;
      const ratio = contrastRatio(parseCssColor(LIGHT_ANSI_PALETTE[key])!, background);
      expect(ratio, `${key} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("picks the palette by background", () => {
    expect(ansiPaletteFor("#0b1220")).toBe(DARK_ANSI_PALETTE);
    expect(ansiPaletteFor("rgb(255, 255, 255)")).toBe(LIGHT_ANSI_PALETTE);
  });
});

describe("terminal options", () => {
  it("pins the readability guards the snippet count on", () => {
    expect(TERMINAL_OPTIONS.minimumContrastRatio).toBe(4.5);
    expect(TERMINAL_OPTIONS.lineHeight).toBeGreaterThan(1);
    expect(TERMINAL_OPTIONS.cursorStyle).toBe("bar");
    expect(TERMINAL_OPTIONS.scrollback).toBe(4000);
    expect(TERMINAL_OPTIONS.fontSize).toBe(13);
  });
});
