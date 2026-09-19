/**
 * 终端（xterm.js）字体链。
 *
 * Nerd Font 的图标字形占用**私用区**（PUA `U+E000–U+F8FF`）。Windows 自带字体
 * （Cascadia Mono/Code、Consolas、Courier New）与浏览器兜底字体都不含这些码位，
 * 于是整链走到底只有豆腐块——这就是「内置终端里 git 分支/文件夹/时钟图标显示为
 * 方块」的根因（2026-09-19 修复）。对照终端（Windows Terminal）正常，只是因为它
 * 自己的 `font.face` 就是某个 Nerd Font。
 *
 * 因此 Nerd Font 名必须排在系统等宽字体**之前**：
 * - CSS 对**未安装**的字体名静默跳过，链会继续往下走系统等宽字体，
 *   所以没装 Nerd Font 的用户视觉零变化、无需任何运行时探测；
 * - 必须用 `Mono` 变体——`Propo` 是比例宽度，在 xterm 的等宽网格里会错位；
 * - `@font-face` + `src: local(...)` 兜底**不可行**：family 名 / full name /
 *   PostScript 名 / 多候选 `local()` 四种写法实测全部仍是方块，
 *   只有字面系统 family 名能解析（故这里写死名字，不做探测）。
 *
 * 本模块保持零依赖（不引 xterm / CSS），便于单测钉住这条契约。
 */
export const TERMINAL_FONT_FAMILY =
  '"CaskaydiaCove Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace';

/** 字体链里作为「图标兜底」的 Nerd Font 名（加载顺序即优先级）。 */
export const TERMINAL_NERD_FONT_FAMILIES = ["CaskaydiaCove Nerd Font Mono", "JetBrainsMono Nerd Font Mono"] as const;
