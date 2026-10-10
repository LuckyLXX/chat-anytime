import type { ITheme, ITerminalOptions } from "@xterm/xterm";

/**
 * 终端（xterm.js）主题与外观参数的单一来源 —— 本地 PTY 终端与 SSH 远程终端共用
 * （XtermView 是两者唯一的 xterm 宿主）。
 *
 * 历史问题（2026-10-10 用户报「SSH 里执行颜色区分不明显、提示符全是白字」）：
 * 改动前只给 xterm 喂了 background/foreground/cursor/selectionBackground 四个键，
 * **没有 ANSI 16 色调色板**。远端 `ls`/`git`/`grep`/提示符吐出的 `\x1b[31m` 这类
 * SGR 于是全部落到 xterm 内置默认色板：那是 1990 年代的 xterm 标准色，深色底上
 * `blue`（#0000ee）、`brightBlack` 几乎看不清，且与主题毫无关系。
 *
 * 本模块补三件事：
 * 1. **完整 16 色板**，按终端背景**实际亮度**（不是 `data-theme-effective` ——
 *    `--code-surface` 在明暗两套内置主题里都是深色 #0b1220，自定义主题才可能改浅）
 *    在暗/亮两套校准色板间切换；
 * 2. `minimumContrastRatio: 4.5` 让 xterm 在渲染时把任何低于 WCAG AA 的前景/ANSI
 *    色提亮到可读（保色相），这样任意自定义主题底色下都不会出现「糊成一团」；
 * 3. 现代观感参数（行高、光标、粗体字重、滚动条滑块配色、选区跟 `--accent`）。
 *
 * 纯函数层（parseCssColor / resolveXtermTheme / …）不碰 DOM，可直接单测；只有
 * `readTerminalTheme` / `readPromptPalette` 是读 CSS 变量的接线层。
 *
 * ⚠️ 主题契约：theme-guide 目前只承诺 `--code-surface` / `--code-text` /
 * `--selection-bg` 驱动终端配色，ANSI 色板尚无 token（未定义 token 时用本模块
 * 内置板）。若将来要开放给主题作者定制，需同时更新五处镜像（AGENTS.md /
 * theme-guide.md / SKILL.md / references/variables.md / check_theme.py）。
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 终端配色输入：全部是 CSS 颜色字符串（已解析成具体值，不含 var()/color-mix()）。 */
export interface TerminalThemeTokens {
  background: string;
  foreground: string;
  accent: string;
  border: string;
}

const HEX_COLOR = /^#([0-9a-f]{3,8})$/i;
const FUNCTIONAL_COLOR = /^rgba?\(\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i;

function channel(token: string): number {
  const value = token.endsWith("%") ? (Number(token.slice(0, -1)) / 100) * 255 : Number(token);
  return Number.isFinite(value) ? Math.min(255, Math.max(0, Math.round(value))) : 0;
}

function alphaChannel(token: string | undefined): number {
  if (token === undefined) return 1;
  const value = token.endsWith("%") ? Number(token.slice(0, -1)) / 100 : Number(token);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** 解析 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`；失败返回 undefined。 */
export function parseCssColor(value: string): Rgba | undefined {
  const text = value.trim();
  const hex = HEX_COLOR.exec(text);
  if (hex) {
    const digits = hex[1] ?? "";
    const pair = (index: number): number => parseInt(digits.slice(index, index + 2), 16);
    const expand = (index: number): number => {
      const character = digits.charAt(index);
      return parseInt(character + character, 16);
    };
    if (digits.length === 3 || digits.length === 4) {
      return { r: expand(0), g: expand(1), b: expand(2), a: digits.length === 4 ? expand(3) / 255 : 1 };
    }
    if (digits.length === 6 || digits.length === 8) {
      return { r: pair(0), g: pair(2), b: pair(4), a: digits.length === 8 ? pair(6) / 255 : 1 };
    }
    return undefined;
  }
  const functional = FUNCTIONAL_COLOR.exec(text);
  if (!functional) return undefined;
  return {
    r: channel(functional[1] ?? "0"),
    g: channel(functional[2] ?? "0"),
    b: channel(functional[3] ?? "0"),
    a: alphaChannel(functional[4])
  };
}

/** WCAG 相对亮度（0–1）。 */
export function relativeLuminance(color: Rgba): number {
  const linear = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG 对比度（1–21）。 */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [high, low] = la >= lb ? [la, lb] : [lb, la];
  return (high + 0.05) / (low + 0.05);
}

/** 给任意 CSS 颜色加/改 alpha（解析失败时原样返回，绝不抛）。 */
export function withAlpha(color: string, alpha: number): string {
  const parsed = parseCssColor(color);
  if (!parsed) return color;
  const value = Math.min(1, Math.max(0, Math.round(alpha * 1000) / 1000));
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${value})`;
}

export type AnsiKey =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";

/** 16 个 ANSI 槽位到具体色值的映射（暗/亮两套都符合这个形状）。 */
export type AnsiPalette = Record<AnsiKey, string>;

/**
 * 暗底 ANSI 16 色（Tokyo Night 系，与本项目内置深色主题的青蓝底协调）。
 * 每条都刻意亮于「够用」，把对比度问题交给 minimumContrastRatio 兜底。
 */
export const DARK_ANSI_PALETTE: AnsiPalette = {
  black: "#77828f",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c0caf5",
  brightBlack: "#8b93a7",
  brightRed: "#ff9db1",
  brightGreen: "#b9f27c",
  brightYellow: "#ffd479",
  brightBlue: "#9ab8ff",
  brightMagenta: "#d7b6ff",
  brightCyan: "#aee7ff",
  brightWhite: "#ffffff"
} as const;

/** 亮底 ANSI 16 色：色相不变、亮度压到浅底上可读（yellow 必压到棕黄）。 */
export const LIGHT_ANSI_PALETTE: AnsiPalette = {
  black: "#3b4252",
  red: "#b3261e",
  green: "#2e7d32",
  yellow: "#8a6200",
  blue: "#1d4ed8",
  magenta: "#8e24aa",
  cyan: "#0e7490",
  white: "#d4d8e0",
  brightBlack: "#66707f",
  brightRed: "#d93025",
  brightGreen: "#1b7a34",
  brightYellow: "#966d00",
  brightBlue: "#2563eb",
  brightMagenta: "#a733c4",
  brightCyan: "#0d7d99",
  brightWhite: "#ffffff"
} as const;

/** 终端背景是深色还是浅色（解析失败按深色 —— 项目内置主题的 code-surface 恒为深色）。 */
export function isDarkBackground(background: string): boolean {
  const parsed = parseCssColor(background);
  if (!parsed) return true;
  return relativeLuminance(parsed) < 0.45;
}

export function ansiPaletteFor(background: string): AnsiPalette {
  return isDarkBackground(background) ? DARK_ANSI_PALETTE : LIGHT_ANSI_PALETTE;
}

/**
 * 组装完整 xterm ITheme。纯函数：同样的 tokens 永远得到同样的主题。
 * 选区/滚动条滑块都从 foreground/accent 派生，主题换肤自动跟随。
 */
export function resolveXtermTheme(tokens: TerminalThemeTokens): ITheme {
  const palette = ansiPaletteFor(tokens.background);
  return {
    background: tokens.background,
    foreground: tokens.foreground,
    cursor: tokens.accent,
    cursorAccent: tokens.background,
    selectionBackground: withAlpha(tokens.accent, 0.32),
    selectionInactiveBackground: withAlpha(tokens.accent, 0.16),
    scrollbarSliderBackground: withAlpha(tokens.foreground, 0.14),
    scrollbarSliderHoverBackground: withAlpha(tokens.foreground, 0.3),
    scrollbarSliderActiveBackground: withAlpha(tokens.foreground, 0.45),
    overviewRulerBorder: tokens.border,
    ...palette
  };
}

/**
 * 现代终端观感参数（不含 theme / fontFamily —— 那两个由调用方给）。
 * - `lineHeight 1.3`：默认 1.0 行挨行，长时间看命令输出很累；
 * - `cursorStyle "bar"` + `cursorInactiveStyle "outline"`：失去焦点时留一个空心框，
 *   比默认的「光标直接消失」更容易找回终端；
 * - `minimumContrastRatio 4.5`：xterm 渲染期把不达标的前景/ANSI 色调到 WCAG AA，
 *   这是「任意自定义主题底色下颜色都看得清」的根本保障；
 * - `scrollback 4000` 与 `fontSize 13` 沿用改动前的取值，不变更既有行为。
 */
export const TERMINAL_OPTIONS: Partial<ITerminalOptions> = {
  cursorBlink: true,
  cursorStyle: "bar",
  cursorInactiveStyle: "outline",
  fontSize: 13,
  fontWeight: 400,
  fontWeightBold: 600,
  letterSpacing: 0,
  lineHeight: 1.3,
  minimumContrastRatio: 4.5,
  scrollback: 4000
};

/** CSS 变量取值的兜底（自定义主题把变量清空时不能让终端变透明）。 */
export const TERMINAL_FALLBACK: TerminalThemeTokens = {
  background: "#0b1220",
  foreground: "#e5e7eb",
  accent: "#4f46e5",
  border: "#24444e"
};

/**
 * CSS 变量读到的是**原样文本**（`var(--x)` / `color-mix(...)` 不会被求值），
 * xterm 需要能自己解析的具体色值 —— 用探针元素让浏览器算一次计算色。
 */
function computedColor(value: string): string {
  const text = value.trim();
  if (!text || (!text.includes("var(") && !text.includes("color-mix(") && !text.includes("currentColor"))) return text;
  try {
    const probe = document.createElement("span");
    probe.style.color = text;
    probe.style.display = "none";
    document.documentElement.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved || text;
  } catch {
    return text;
  }
}

/** 从文档 CSS 变量读终端主题（XtermView 用）。 */
export function readTerminalTheme(root: HTMLElement = document.documentElement): ITheme {
  const styles = getComputedStyle(root);
  const read = (name: string, fallback: string): string => {
    const raw = styles.getPropertyValue(name).trim() || fallback;
    return computedColor(raw);
  };
  return resolveXtermTheme({
    background: read("--code-surface", TERMINAL_FALLBACK.background),
    foreground: read("--code-text", TERMINAL_FALLBACK.foreground),
    accent: read("--accent", TERMINAL_FALLBACK.accent),
    border: read("--border", TERMINAL_FALLBACK.border)
  });
}
