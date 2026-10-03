/**
 * 主题运行时共用件（2026-09-23 从 App.tsx 抽出，App 与外观页共用）。
 *
 * `customCssHasWallpaper` 同时被应用外壳（App.tsx 把主题 CSS/壁纸属性写进 `<html>`）
 * 和外观页的实时预览（ThemePreview）消费，放在组件里会形成 App ↔ 外观页的循环依赖，
 * 所以落到 lib 层。
 *
 * 2026-09-26：资产不再经渲染端转换（旧 `themeAssetsForAppearance` /
 * `useThemeAssetUrls` / data URL → blob 的链路已删）。主题引用的相对 `url()` 由
 * `resolveThemeAssetUrls`（`src/shared/theme-assets.ts`）直接改写成
 * `pidesktop-file://theme/<scope>/<relative>`，浏览器自己读盘、解码、缓存。
 *
 * 2026-10-03：新增 `readUiThemeContext`——渲染端是「当前界面长什么样」的唯一事实
 * 来源（OS 深浅由 `matchMedia` 解、自定义主题改了哪些 token 只有计算样式知道），
 * 这份快照经 `ui.themeContext` 命令推给 utility，用于给 Div 气泡提示词补一行主题信息。
 */

import type { AppearanceSettings, UiThemeContext, UiThemePalette } from "../../../shared/protocol.js";

/**
 * 自定义 CSS 是否声明了壁纸（决定 html[data-theme-wallpaper] 与预览的壁纸层）。
 *
 * `\s*` 必须包含在否定预查里面：包在外面的话，`--chat-bg-image: none`（冒号后有空格）
 * 会因 `\s*` 回退成空匹配而误判成壁纸（2026-10-03 修，同时护住上报给模型的那一行）。
 */
export function customCssHasWallpaper(css: string): boolean {
  return /--chat-bg-image\s*:(?!\s*none\b)/iu.test(css);
}

/**
 * 上报给模型的调色板（键 → 主题变量名）。与 `div-prompt.ts` 的
 * `UI_THEME_PALETTE_ORDER` 是同一份键表（那边决定提示词里的书写顺序），改这里要同步。
 */
const UI_THEME_TOKENS: ReadonlyArray<readonly [keyof UiThemePalette, string]> = [
  ["surface", "--surface"],
  ["surfaceRaised", "--surface-raised"],
  ["text", "--text"],
  ["textMuted", "--text-muted"],
  ["border", "--border"],
  ["accent", "--accent"],
  ["accentSoft", "--accent-soft"]
];

/**
 * 当前界面主题快照：明暗模式（按 `appearance.theme` + 系统 `prefers-color-scheme`
 * 解析，与 App 外壳写 `data-theme-effective` 的口径一致）、聊天区是否有壁纸
 * （与 `data-theme-wallpaper` 同一判据）、主题色板（从计算样式读实际值——自定义主题
 * 能改任意 token，读声明值会失真）。读不到的 token 不入表（不编造）。
 */
export function readUiThemeContext(appearance: Pick<AppearanceSettings, "theme" | "customCss">): UiThemeContext {
  const wantsDark = appearance.theme === "dark"
    || (appearance.theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const wallpaper = customCssHasWallpaper(appearance.customCss);
  const palette: Partial<UiThemePalette> = {};
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const computed = getComputedStyle(document.documentElement);
    for (const [key, token] of UI_THEME_TOKENS) {
      const value = computed.getPropertyValue(token).trim();
      if (value) palette[key] = value;
    }
  }
  return { mode: wantsDark ? "dark" : "light", wallpaper, palette };
}
